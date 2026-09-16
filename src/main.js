/**
 * 翻译小卡片 - Electron 主进程
 * - 主窗口:单词本 / 背单词 / 统计 / 设置
 * - 划词弹卡:全局鼠标钩子捕获选词手势 → 模拟 Ctrl+C 取词 → 豆包风格小卡片(翻译 / 存储)
 * - 托盘常驻;存储与翻译在独立模块,将来云同步只需替换存储适配层
 */
const { app, BrowserWindow, ipcMain, screen, globalShortcut, Tray, Menu, clipboard, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const Store = require('./store');
const Translator = require('./translate');
const Account = require('./account');
const WebdavSync = require('./webdav');
const { servicesMeta, testService } = require('./services');
const { Dicts } = require('./dicts');
const { createCapture, captureSelection, prewarmCopy, sleep } = require('./capture');

const DEMO = process.argv.includes('--demo-popup');
const DEMO_WORD = 'resilience';
// 测试隔离:CARD_E2E 自检时可指定独立数据目录,与正在运行的正式实例并存
// (Electron 单实例锁按 userData 区分;必须在下方读取 userData 之前设置)
if (process.env.CARD_USER_DATA) app.setPath('userData', process.env.CARD_USER_DATA);
const PILL = { w: 208, h: 52 };   // 划词小卡片(翻译 | 存储)
const PANEL = { w: 360, h: 262 }; // 翻译结果面板

let mainWin = null;
let popupWin = null;
let tray = null;
let capture = null;
let watchdogTimer = null;    // 弹卡看门狗定时器,退出时清除

let popupMode = 'pill';     // 'pill' | 'panel'
let popupShownAt = 0;
let popupText = '';
let lastResult = null;

let restoreTimer = null;
let prevClipboard = null;

app.quitting = false;
// 防止后台/被遮挡时合成器限流(弹卡常驻顶层也依赖这一点)
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// 某些显卡/远程环境下 Chromium 硬件合成会输出空白帧;可用环境变量强制软件渲染
if (process.env.CARD_DISABLE_GPU) {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
}

const userData = app.getPath('userData');
const store = new Store(path.join(userData, 'wordbook.json'));
const translator = new Translator(path.join(userData, 'translate-cache.json'), () => store.settings.services);
const account = new Account(path.join(userData, 'account.json'));
const webdav = new WebdavSync(path.join(userData, 'webdav.json'));
const dicts = new Dicts(path.join(userData, 'dicts'));

// 当前生效的同步后端:'server' 自建服务器账号 | 'webdav' 坚果云 | null 未启用。
// 显式选择(settings.syncBackend)优先;未选择时谁连着用谁(都连着保持服务器优先的旧行为)。
function activeSyncBackend() {
  const pref = store.settings.syncBackend;
  if (pref === 'webdav' && webdav.configured) return 'webdav';
  if (pref === 'server' && account.loggedIn) return 'server';
  if (account.loggedIn) return 'server';
  if (webdav.configured) return 'webdav';
  return null;
}

function setSyncBackend(mode) {
  if (mode) store.setSettings({ syncBackend: mode });
  else if (store.settings.syncBackend) { delete store.settings.syncBackend; store.saveSoon(); }
}

function runSyncOnce(label) {
  const backend = label || activeSyncBackend();
  return backend === 'webdav' ? webdav.syncNow(store) : account.syncNow(store);
}

// 词库一有变化(划词存词、复习作答等)就预约一次云同步;合并结果回写时不会再触发
let cloudSyncTimer = null;
function scheduleCloudSync() {
  if (!activeSyncBackend()) return;
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(async () => {
    const backend = activeSyncBackend();
    if (!backend || (backend === 'webdav' ? webdav._syncing : account._syncing)) return;
    try {
      const r = await runSyncOnce(backend);
      console.log('[cloud] 自动同步完成(' + backend + '):', r.total, '词');
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('book:changed');
    } catch (e) {
      console.warn('[cloud] 自动同步失败(' + backend + '):', e.message);
    }
  }, 5000);
}
store.onChanged = scheduleCloudSync;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (e, argv) => {
    showMain();
    if (argv && argv.includes('--demo-popup')) showDemo();
  });
  app.whenReady().then(init);
}

// —————————————————————————————— 窗口 ——————————————————————————————

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1040, height: 720,
    minWidth: 880, minHeight: 600,
    backgroundColor: '#f5f7fb',
    title: '翻译小卡片',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  mainWin.loadFile(path.join(__dirname, 'renderer/main/index.html'));
  if (process.env.CARD_E2E) {
    // 自检模式:校验页面加载并在启动 2.5s 后保存一张应用内截图
    mainWin.webContents.on('did-finish-load', () => {
      mainWin.webContents.executeJavaScript('document.body.children.length')
        .then(n => console.log('[diag] bodyChildren=' + n))
        .catch(e => console.log('[diag-err]', e.message));
      setTimeout(async () => {
        try {
          const img = await mainWin.webContents.capturePage();
          fs.writeFileSync(path.join(userData, 'capture.png'), img.toPNG());
          console.log('[diag] capture saved', JSON.stringify(img.getSize()));
        } catch (e) { console.log('[diag] capture fail', e.message); }
      }, 2500);
    });
    mainWin.webContents.on('did-fail-load', (e, code, desc, url) => console.log('[did-fail-load]', code, desc, url));
    mainWin.webContents.on('console-message', (e, level, message) => console.log('[renderer]', message));
  }
  mainWin.on('close', (e) => {
    if (!app.quitting) { e.preventDefault(); mainWin.hide(); } // 关闭即驻留托盘
  });
  mainWin.on('closed', () => { mainWin = null; });
}

function showMain() {
  if (!mainWin) { createMainWindow(); return; }
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

function ensurePopup() {
  if (popupWin) return popupWin;
  popupWin = new BrowserWindow({
    width: PILL.w, height: PILL.h,
    frame: false, transparent: true, resizable: false,
    movable: false, minimizable: false, maximizable: false,
    skipTaskbar: true, alwaysOnTop: true, show: false,
    hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  popupWin.setAlwaysOnTop(true, 'screen-saver');
  popupWin.loadFile(path.join(__dirname, 'renderer/popup/popup.html'));
  popupWin.on('blur', () => {
    setTimeout(() => {
      if (popupWin && popupMode === 'panel' && !popupWin.isFocused()) hidePopup();
    }, 130);
  });
  // 退出时窗口被销毁后置空,避免看门狗等定时器再访问已销毁对象(Object has been destroyed)
  popupWin.on('closed', () => { popupWin = null; });
  return popupWin;
}

function clampRect(x, y, w, h) {
  const display = screen.getDisplayNearestPoint({ x: Math.round(x + w / 2), y: Math.round(y + h / 2) });
  const wa = display.workArea;
  x = Math.min(Math.max(Math.round(x), wa.x + 8), wa.x + wa.width - w - 8);
  y = Math.min(Math.max(Math.round(y), wa.y + 8), wa.y + wa.height - h - 8);
  return { x, y, width: w, height: h };
}

/** 弹卡出现在光标上方,越界自动翻转到下方并夹紧到工作区 */
function popupBounds(dipPt, size) {
  const display = screen.getDisplayNearestPoint(dipPt);
  const wa = display.workArea;
  let x = Math.round(dipPt.x - size.w / 2);
  let y = Math.round(dipPt.y - size.h - 14);
  if (y < wa.y + 8) y = Math.round(dipPt.y + 24);
  return clampRect(x, y, size.w, size.h);
}

function showPopup(dipPt, text = null) {
  popupInteracted = false;
  popupMode = 'pill';
  pillOutsideSince = 0;
  if (text != null) popupText = text;
  lastResult = null; // 新词弹卡,清掉上一轮的翻译结果,防串词
  const win = ensurePopup();
  win.setBounds(popupBounds(dipPt, PILL));
  win.webContents.send('popup:show', { text: popupText });
  win.showInactive();
  popupShownAt = Date.now();
  if (process.env.CARD_E2E) e2eShot(win, 'capture-pill.png', 600);
}

/** E2E 自检:在胶囊上依次触发 翻译 → 截图 → 存储,并打印单词本内容(仅 CARD_E2E=1 时) */
function e2eShot(win, name, delay) {
  setTimeout(async () => {
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(userData, name), img.toPNG());
      console.log('[e2e] shot saved:', name, JSON.stringify(img.getSize()));
    } catch (e) { console.log('[e2e] shot fail:', name, e.message); }
  }, delay);
}

function e2eRun() {
  const wc = popupWin.webContents;
  setTimeout(async () => {
    try {
      await wc.executeJavaScript('document.querySelector("#btn-translate").click()');
      console.log('[e2e] clicked 翻译');
      await sleep(6000); // 等待翻译接口返回并展开面板
      console.log('[e2e] panel:', JSON.stringify(await wc.executeJavaScript('({ word: document.querySelector("#p-word").innerText, main: document.querySelector("#p-main").innerText, senses: document.querySelector("#p-senses").innerText.slice(0, 120) })')));
      e2eShot(popupWin, 'capture-panel.png', 0);
      await sleep(600);
      await wc.executeJavaScript('document.querySelector("#p-save") && document.querySelector("#p-save").click()');
      console.log('[e2e] clicked 存入单词本');
      await sleep(1500);
      e2eShot(popupWin, 'capture-saved.png', 0);
      await sleep(800);
      if (mainWin) e2eShot(mainWin, 'capture-book.png', 500);
      await sleep(1200);
      // 单词卡点开:展开详情,断言例句/获取按钮
      const expand = await mainWin.webContents.executeJavaScript(`(async () => {
        document.querySelector('[data-view=book]').click();
        await new Promise(r => setTimeout(r, 500));
        const card = document.querySelector('.word-card');
        card.click();
        await new Promise(r => setTimeout(r, 150));
        const d = card.querySelector('.w-detail');
        return { word: card.querySelector('.w-word').innerText, open: !!d && !d.classList.contains('hidden'), example: (card.querySelector('.w-example') || {}).innerText || '', hasFetch: !!card.querySelector('.ex-fetch') };
      })()`);
      console.log('[e2e] 卡片展开:', JSON.stringify(expand));
      e2eShot(mainWin, 'capture-card-detail.png', 200);
      await sleep(600);
      console.log('[e2e] words:', JSON.stringify(store.all().map(w => ({ word: w.word, trans: (w.translation || '').slice(0, 40), phonetic: w.phonetic }))));

      // 第二轮:换一个词库里没有的词,验证面板"存入"按钮不残留上一轮的已存入态,并观察新翻译链路
      const { workArea } = screen.getPrimaryDisplay();
      showPopup({ x: workArea.x + workArea.width / 2, y: workArea.y + 320 }, 'ephemeral');
      await sleep(1200);
      await wc.executeJavaScript('document.querySelector("#btn-translate").click()');
      await sleep(9000);
      console.log('[e2e] panel2:', JSON.stringify(await wc.executeJavaScript('({ word: document.querySelector("#p-word").innerText, main: document.querySelector("#p-main").innerText, save: document.querySelector("#p-save").innerText, savedCls: document.querySelector("#p-save").classList.contains("saved") })')));
      const w2 = store.findWord('ephemeral'); // 清理本轮测试痕迹
      if (w2) store.remove(w2.id);
      translator.clearCache();
      console.log('[e2e] cleanup done');
      console.log('[e2e] done');
    } catch (e) { console.log('[e2e] fail:', e.message); }
  }, 1200);
}

/** E2E 自检:注册→同步→截图账号页→退出登录(仅 CARD_E2E=1 时) */
async function e2eAccount() {
  try {
    const name = 'e2e_' + Math.random().toString(36).slice(2, 8);
    console.log('[e2e-acct] register:', JSON.stringify(await account.register(name, 'pass123456')));
    await sleep(300);
    console.log('[e2e-acct] sync:', JSON.stringify(await account.syncNow(store)));
    mainWin.webContents.executeJavaScript("document.querySelector('[data-view=account]').click()");
    await sleep(500);
    e2eShot(mainWin, 'capture-account.png', 0);
    await sleep(600);
    console.log('[e2e-acct] state:', JSON.stringify(account.publicState()));
    await account.logout();
    console.log('[e2e-acct] logged out ok');
  } catch (e) { console.log('[e2e-acct] fail:', e.message); }
}

/** E2E 自检:设置页(服务池卡片 + 词库卡片)与四选一干扰项;结束后还原用户原设置 */
async function e2eSettings() {
  const backup = JSON.parse(JSON.stringify(store.settings.services || {}));
  try {
    const wc = mainWin.webContents;
    await wc.executeJavaScript("document.querySelector('[data-view=settings]').click()");
    await sleep(500);
    e2eShot(mainWin, 'capture-settings.png', 0);
    console.log('[e2e-set] services meta:', await wc.executeJavaScript(
      'window.cardAPI.servicesMeta().then(m => m.map(s => s.id).join(","))'));
    // 词库:下载最小的 926 词库 → 验证干扰项
    console.log('[e2e-set] dict download:', JSON.stringify(await wc.executeJavaScript(
      'window.cardAPI.dictDownload("926")')));
    await sleep(300);
    console.log('[e2e-set] dict list:', await wc.executeJavaScript(
      'window.cardAPI.dictsList().then(l => l.filter(d => d.downloaded).map(d => d.id + ":" + d.count).join(","))'));
    console.log('[e2e-set] distractors:', JSON.stringify(await wc.executeJavaScript(
      'window.cardAPI.reviewDistractors("resilience", "复原力。", 3)')));
    // 服务池:开关 deepseek → 设置落盘验证 → 还原
    console.log('[e2e-set] toggle deepseek:', await wc.executeJavaScript(`(() => {
      const sw = document.querySelector('.svc-row[data-id=deepseek] .svc-enable');
      sw.checked = true; sw.dispatchEvent(new Event('change'));
      return 'clicked';
    })()`));
    await sleep(400);
    console.log('[e2e-set] deepseek enabled persisted:', store.settings.services && store.settings.services.enabled && store.settings.services.enabled.deepseek === true);
  } catch (e) { console.log('[e2e-set] fail:', e.message); }
  finally { store.setSettings({ services: backup }); console.log('[e2e-set] settings restored'); }
}

function hidePopup() {
  if (popupWin && popupWin.isVisible()) popupWin.hide();
  popupMode = 'pill';
  pillOutsideSince = 0;
}

/** 翻译时小卡片展开为结果面板,保持顶部位置并夹紧 */
function enterPanel() {
  if (!popupWin) return;
  popupMode = 'panel';
  const b = popupWin.getBounds();
  const x = b.x + (b.width - PANEL.w) / 2;
  popupWin.setBounds(clampRect(x, b.y, PANEL.w, PANEL.h));
}

function overOwnWindow(dipPt) {
  for (const win of [mainWin, popupWin]) {
    if (!win || win.isDestroyed() || !win.isVisible()) continue;
    const b = win.getBounds();
    if (dipPt.x >= b.x && dipPt.x <= b.x + b.width && dipPt.y >= b.y && dipPt.y <= b.y + b.height) return true;
  }
  return false;
}

let pillOutsideSince = 0; // 光标连续离开胶囊的起始时刻(快速掠过不撤卡)

/** 弹卡看门狗:胶囊态下鼠标移开约 1 秒即自动消失;面板态点外部即失焦隐藏 */
function popupWatchdog() {
  if (!popupWin || popupWin.isDestroyed() || !popupWin.isVisible()) return;
  if (process.env.CARD_E2E) return; // 自检时无真实鼠标,跳过
  const age = Date.now() - popupShownAt;
  if (popupMode === 'pill') {
    if (popupWin.isFocused()) { pillOutsideSince = 0; return; }
    if (age < 800) return; // 刚弹出,给眼睛一点时间
    try {
      const dip = screen.screenToDipPoint(screen.getCursorScreenPoint());
      const b = popupWin.getBounds();
      // 容差 40px:胶囊悬在光标上方 14px,静止的光标不算"离开"
      const inside = dip.x >= b.x - 40 && dip.x <= b.x + b.width + 40 &&
                     dip.y >= b.y - 40 && dip.y <= b.y + b.height + 40;
      if (inside) { pillOutsideSince = 0; return; }
      if (!pillOutsideSince) {
        pillOutsideSince = Date.now(); // 开始离开,连续 600ms 才撤,避免挥过误杀
      } else if (Date.now() - pillOutsideSince > 600) {
        hidePopup();
      }
    } catch (e) { /* ignore */ }
  } else if (age > 25 * 1000) {
    hidePopup();
  }
}

// —————————————————————————————— 划词取词 ——————————————————————————————

let capturing = false;        // 取词流程进行中
let pendingGesturePt = null;  // 取词期间又来了新手势,排队处理
let currentCapture = null;    // 进行中的取词 Promise(弹卡按钮会等它)
let popupInteracted = false;  // 用户已点过弹卡按钮(即使没取到词也不撤卡)

function handleGesture(physPt) {
  if (!store.settings.captureEnabled || store.settings.triggerMode !== 'auto') return;
  let dip;
  try { dip = screen.screenToDipPoint(physPt); } catch (e) { dip = physPt; }
  if (overOwnWindow(dip)) return;
  if (capturing) { pendingGesturePt = dip; return; }
  beginCapture(dip);
}

/**
 * 划词流程:手势命中 → 先取词,确认抓到文字才弹卡。
 * UIA 直读(~60ms)命中时出卡极快且文字就绪;取不到文字(点图标/拖窗口等
 * 非文字手势)则完全不弹卡,杜绝误弹。仅非 UIA 应用走 Ctrl+C 兜底后弹卡(约 0.3~0.5s)。
 */
async function beginCapture(dipPt) {
  capturing = true;
  try {
    do {
      pendingGesturePt = null;
      const t0 = Date.now();

      currentCapture = captureSelection();
      const res = await currentCapture;
      currentCapture = null;
      if (process.env.CARD_E2E) console.log('[e2e] 取词耗时 ms:', Date.now() - t0, 'ok:', res.ok, 'via:', res.via);

      if (res.ok) {
        const clean = res.text.replace(/\s+/g, ' ').slice(0, 120);
        if (/[\u4e00-\u9fff\w]/.test(clean)) {
          prevClipboard = res.prev;
          if (res.prev) scheduleRestore();
          showPopup(dipPt, clean); // 文字已就绪,弹卡即显示
        }
      }
      // 取词失败(非文字手势):什么都不弹

      dipPt = pendingGesturePt; // 处理取词期间到来的新手势
    } while (dipPt);
  } finally {
    capturing = false;
    currentCapture = null;
  }
}

/** 稍后恢复用户剪贴板(UIA 直读命中时不触发;仅兜底 Ctrl+C 借用剪贴板后还原);弹卡内点"复制"会取消本次恢复 */
function scheduleRestore() {
  clearTimeout(restoreTimer);
  restoreTimer = setTimeout(() => {
    const p = prevClipboard;
    prevClipboard = null;
    if (!p) return;
    try {
      if (p.image && !p.image.isEmpty()) clipboard.writeImage(p.image);
      else if (p.text) clipboard.writeText(p.text);
      else clipboard.clear();
    } catch (e) { /* ignore */ }
  }, 800);
}

// —————————————————————————————— 其他 ——————————————————————————————

function showDemo() {
  const { workArea } = screen.getPrimaryDisplay();
  showPopup({ x: workArea.x + workArea.width / 2, y: workArea.y + Math.min(Math.round(workArea.height * 0.6), 480) }, DEMO_WORD);
}

/** 后台为无释义的词补翻译,完成后通知主窗口刷新 */
function enrichAsync(text) {
  const exist = store.findWord(text);
  if (!exist || exist.translation) return;
  translator.translate(text).then(r => {
    store.updateWord(exist.id, { translation: r.text, phonetic: r.phonetic || '', senses: r.senses || [], example: r.example || '' });
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('book:changed');
  }).catch(() => { /* 网络不可用时保持空释义 */ });
}

function applySettings() {
  globalShortcut.unregisterAll();
  const s = store.settings;
  if (s.hotkeyEnabled && s.hotkey) {
    try {
      globalShortcut.register(s.hotkey, () => {
        try {
          const dip = screen.getCursorScreenPoint(); // Electron 光标坐标即 DIP
          if (!overOwnWindow(dip)) beginCapture(dip);
        } catch (e) { /* ignore */ }
      });
    } catch (e) { console.warn('[hotkey] 注册失败:', e.message); }
  }
}

// 托盘图标:首次运行用 PowerShell System.Drawing 生成一张渐变小卡片 PNG
function getTrayIcon() {
  const iconPath = path.join(userData, 'tray.png');
  try {
    if (!fs.existsSync(iconPath)) {
      const script = [
        'Add-Type -AssemblyName System.Drawing',
        '$bmp = New-Object System.Drawing.Bitmap(32,32)',
        '$g = [System.Drawing.Graphics]::FromImage($bmp)',
        "$g.SmoothingMode = 'AntiAlias'",
        '$g.Clear([System.Drawing.Color]::Transparent)',
        '$r = New-Object System.Drawing.Rectangle(0,0,32,32)',
        '$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($r, [System.Drawing.Color]::FromArgb(255,99,102,241), [System.Drawing.Color]::FromArgb(255,139,92,246), 45)',
        '$g.FillRectangle($brush, 2, 4, 28, 24)',
        "$font = New-Object System.Drawing.Font('Arial',14,([System.Drawing.FontStyle]::Bold))",
        '$sf = New-Object System.Drawing.StringFormat',
        "$sf.Alignment = 'Center'",
        "$sf.LineAlignment = 'Center'",
        "$g.DrawString('A', $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF(0,2,32,28)), $sf)",
        '$bmp.Save($args[0], [System.Drawing.Imaging.ImageFormat]::Png)'
      ].join(";\n");
      const ps1 = path.join(userData, 'make-icon.ps1');
      fs.writeFileSync(ps1, script, 'utf8');
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, iconPath],
        { windowsHide: true, timeout: 10000, stdio: 'ignore' });
    }
    const img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) return img;
  } catch (e) { console.warn('[tray] 图标生成失败:', e.message); }
  return nativeImage.createEmpty();
}

function initTray() {
  try {
    tray = new Tray(getTrayIcon());
    tray.setToolTip('翻译小卡片');
    tray.on('double-click', showMain);
    rebuildTrayMenu();
  } catch (e) { console.warn('[tray] 初始化失败:', e.message); }
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开单词本', click: showMain },
    { type: 'separator' },
    {
      label: '划词翻译', type: 'checkbox', checked: store.settings.captureEnabled,
      click: (mi) => { store.setSettings({ captureEnabled: mi.checked }); applySettings(); }
    },
    { type: 'separator' },
    { label: '退出', click: () => { app.quitting = true; app.quit(); } }
  ]));
}

// —————————————————————————————— IPC ——————————————————————————————

function registerIpc() {
  // 单词本 / 学习
  ipcMain.handle('book:list', () => store.all());
  ipcMain.handle('book:add', (e, word) => {
    const info = store.addWord(String(word || '').trim(), {});
    if (info && !info.already) enrichAsync(info.word);
    return info;
  });
  ipcMain.handle('book:remove', (e, id) => { store.remove(id); return { ok: true }; });
  ipcMain.handle('book:reset', (e, id) => { store.resetProgress(id); return { ok: true }; });
  /** 补全例句(翻译有缓存时几乎瞬时;DeepSeek 服务会一并返回例句) */
  ipcMain.handle('book:fetch-example', async (e, id) => {
    const w = store.data.words.find(x => x.id === id);
    if (!w) return { ok: false, error: '词条不存在' };
    if (w.example) return { ok: true, example: w.example };
    try {
      const r = await translator.translate(w.word);
      if (!r.example) return { ok: false, error: '当前翻译服务未返回例句,换用 DeepSeek 等服务再试' };
      store.updateWord(id, { example: r.example });
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('book:changed');
      return { ok: true, example: r.example };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });
  ipcMain.handle('book:stats', () => store.stats());
  ipcMain.handle('review:due-count', () => store.dueCount());
  ipcMain.handle('review:batch', () => store.reviewBatch());
  ipcMain.handle('review:answer', (e, id, correct) => { store.answer(id, correct); return store.dueCount(); });

  // 设置 / 环境 / 数据
  ipcMain.handle('settings:get', () => store.settings);
  ipcMain.handle('settings:set', (e, patch) => {
    store.setSettings(patch || {});
    applySettings();
    rebuildTrayMenu();
    return store.settings;
  });
  ipcMain.handle('env:info', () => ({ captureAvailable: capture ? capture.available : false, version: app.getVersion() }));
  // 翻译服务池:元信息(渲染层画卡片)与「测试连接」;以及清除翻译缓存
  ipcMain.handle('services:meta', () => servicesMeta());
  ipcMain.handle('services:test', (e, id, cfg) => testService(id, cfg || {}));
  ipcMain.handle('translate:clear-cache', () => { translator.clearCache(); return { ok: true }; });
  // 词库(四选一干扰项)
  ipcMain.handle('dict:list', () => dicts.list());
  ipcMain.handle('dict:download', async (e, id) => {
    try { const r = await dicts.download(id); return { ok: true, ...r }; }
    catch (err) { return { ok: false, error: String(err.message || err) }; }
  });
  ipcMain.handle('dict:remove', (e, id) => { dicts.remove(id); return { ok: true }; });
  /** 四选一干扰项:本单词本释义优先,不足时用已下载词库补齐 */
  ipcMain.handle('review:distractors', (e, word, correctTrans, n) => {
    const norm = String(correctTrans || '').replace(/\s+/g, '').toLowerCase();
    const fromBook = [];
    for (const w of store.all()) {
      if (!w.translation) continue;
      if (w.word.toLowerCase() === String(word || '').toLowerCase()) continue;
      if (w.translation.replace(/\s+/g, '').toLowerCase() === norm) continue;
      fromBook.push(w.translation);
      if (fromBook.length >= (n || 3)) break;
    }
    const need = (n || 3) - fromBook.length;
    const seen = new Set(fromBook.map(t => t.replace(/\s+/g, '')));
    const extras = need > 0 ? dicts.randomDistractors(word, correctTrans, need + 4).filter(t => {
      const k = t.replace(/\s+/g, '');
      if (seen.has(k)) return false;
      seen.add(k); return true;
    }).slice(0, need) : [];
    return [...fromBook, ...extras];
  });
  ipcMain.handle('data:export', async () => {
    const r = await dialog.showSaveDialog(mainWin, {
      title: '导出单词本备份',
      defaultPath: '单词本备份-' + new Date().toISOString().slice(0, 10) + '.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false };
    fs.writeFileSync(r.filePath, store.exportData(), 'utf8');
    return { ok: true, path: r.filePath };
  });
  ipcMain.handle('data:import', async () => {
    const r = await dialog.showOpenDialog(mainWin, {
      title: '导入单词本备份',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    const res = store.importData(fs.readFileSync(r.filePaths[0], 'utf8'));
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('book:changed');
    return { ok: true, ...res };
  });

  // 账号 / 云同步(自建服务器 + 坚果云 WebDAV 两种后端)
  ipcMain.handle('account:get', () => ({ ...account.publicState(), active: activeSyncBackend() === 'server' }));
  ipcMain.handle('account:set-server', (e, url) => { account.setServer(url); return account.publicState(); });
  const authHandler = action => async (e, username, password) => {
    try {
      const r = await account[action](username, password);
      setSyncBackend('server'); // 最近连接的后端生效
      scheduleCloudSync(); // 登录/注册成功后 shortly 自动同步一次
      return { ok: true, state: account.publicState(), ...r };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  };
  ipcMain.handle('account:login', authHandler('login'));
  ipcMain.handle('account:register', authHandler('register'));
  ipcMain.handle('account:logout', () => {
    account.logout();
    if (store.settings.syncBackend === 'server') setSyncBackend(null); // 让位给坚果云(若已配置)
    return account.publicState();
  });
  ipcMain.handle('account:sync', async () => {
    try {
      const r = await account.syncNow(store);
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('book:changed');
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // 坚果云 WebDAV 同步
  ipcMain.handle('webdav:get', () => ({ ...webdav.publicState(), active: activeSyncBackend() === 'webdav' }));
  ipcMain.handle('webdav:test', async (e, cfg) => {
    try { await webdav.test(cfg || {}); return { ok: true }; }
    catch (err) { return { ok: false, error: String(err.message || err) }; }
  });
  ipcMain.handle('webdav:save', async (e, cfg) => {
    try {
      const merged = { ...webdav.publicState(), ...cfg }; // 密码留空 = 沿用已保存的
      await webdav.test(merged);
      webdav.saveCfg(merged);
      setSyncBackend('webdav'); // 最近连接的后端生效
      scheduleCloudSync();
      return { ok: true, state: webdav.publicState() };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });
  ipcMain.handle('webdav:disconnect', () => {
    webdav.disconnect();
    if (store.settings.syncBackend === 'webdav') setSyncBackend(null); // 让位给自建服务器(若已登录)
    return webdav.publicState();
  });
  ipcMain.handle('webdav:sync', async () => {
    try {
      const r = await webdav.syncNow(store);
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('book:changed');
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // 划词弹卡(胶囊即时弹出,以下操作都先等并行中的取词完成)
  const awaitCapture = async () => { try { if (currentCapture) await currentCapture; } catch (e) { /* ignore */ } };
  ipcMain.handle('popup:translate', async () => {
    popupInteracted = true;
    await awaitCapture();
    if (!popupText) return { ok: false, error: '未识别到选中文本' };
    try {
      const r = await translator.translate(popupText);
      lastResult = r;
      return { ok: true, result: r };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });
  ipcMain.handle('popup:save', async () => {
    popupInteracted = true;
    await awaitCapture();
    const extra = lastResult ? { translation: lastResult.text, phonetic: lastResult.phonetic || '', senses: lastResult.senses || [], example: lastResult.example || '' } : {};
    const info = store.addWord(popupText, extra);
    if (info && !info.already) enrichAsync(info.word);
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('book:changed');
    return { ok: true, already: !!(info && info.already), total: store.all().length, saveCount: info ? (info.saveCount || 1) : 1 };
  });
  ipcMain.handle('popup:check-saved', async () => {
    popupInteracted = true;
    await awaitCapture();
    return !!store.findWord(popupText);
  });
  ipcMain.handle('popup:copy', async () => {
    popupInteracted = true;
    await awaitCapture();
    clearTimeout(restoreTimer);
    restoreTimer = null;
    prevClipboard = null;
    if (popupText) clipboard.writeText(popupText);
    return { ok: true };
  });
  ipcMain.on('popup:hide', hidePopup);
  ipcMain.on('popup:enter-panel', enterPanel);
}

// —————————————————————————————— 启动 ——————————————————————————————

function init() {
  registerIpc();
  createMainWindow();
  initTray();
  capture = createCapture({ onGesture: handleGesture });
  applySettings();
  watchdogTimer = setInterval(popupWatchdog, 200);
  // 预热:弹卡窗口预创建、常驻取词进程预启动,首次划词即可全速弹卡
  ensurePopup();
  prewarmCopy();
  // 已连接同步后端则启动后自动同步一次
  if (activeSyncBackend()) {
    setTimeout(async () => {
      try {
        const r = await runSyncOnce();
        console.log('[cloud] 启动同步完成:', r.total, '词');
        if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('book:changed');
      } catch (e) { console.warn('[cloud] 启动同步失败:', e.message); }
    }, 3000);
  }
  if (DEMO) setTimeout(() => { showDemo(); if (process.env.CARD_E2E) { e2eRun(); e2eAccount().then(e2eSettings); } }, 900);
  console.log('[translate-card] ready; 划词钩子可用:', capture.available, '; 数据目录:', userData);
}

app.on('before-quit', () => { app.quitting = true; });
app.on('will-quit', () => {
  clearInterval(watchdogTimer);
  try { capture && capture.stop(); } catch (e) { /* ignore */ }
  globalShortcut.unregisterAll();
  store.flush();
});
app.on('window-all-closed', () => { /* 关闭窗口后驻留托盘,不退出 */ });
app.on('activate', showMain);
