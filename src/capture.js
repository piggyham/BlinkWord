/**
 * 全局划词捕获:
 * 1. uiohook-napi 全局鼠标钩子,识别"拖拽选择"和"双击选词"手势;
 * 2. 取词优先走 UI Automation 直读选区(TextPattern.GetSelection,不碰剪贴板;
 *    浏览器/Office/记事本/终端等主流应用均支持,同 EasyDict/Bob 的无障碍取词思路);
 * 3. 目标应用不支持 UIA 时,退回常驻 PowerShell 发送 Ctrl+C 模拟复制 + 轮询剪贴板,
 *    期间保存原文,由调用方稍后恢复剪贴板。
 * 若 uiohook-napi 不可用,available=false,应用自动退化为"热键触发"模式。
 */
const { clipboard } = require('electron');
const { spawn } = require('child_process');

const sleep = ms => new Promise(r => setTimeout(r, ms));

let hookLib = null;
try { hookLib = require('uiohook-napi'); } catch (e) {
  console.warn('[capture] uiohook-napi 加载失败:', e.message);
}

// 常驻 PowerShell:启动时预载 UIA 程序集,之后从 stdin 逐行接收指令:
//   'c' → 模拟一次 Ctrl+C(兜底取词)
//   'u' → UIA 直读当前选区,结果以行协议回写 stdout:'R\t文本' 成功 / 'E' 无选区或不支持
const RESIDENT_PS = `
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms | Out-Null
try { Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes | Out-Null } catch {}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Get-Sel {
  try {
    $el = [System.Windows.Automation.AutomationElement]::FocusedElement
    for ($i = 0; $i -lt 4 -and $null -ne $el; $i++) {
      $tp = $null
      try { $tp = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern) } catch {}
      if ($tp) {
        $txt = ''
        foreach ($r in $tp.GetSelection()) { $txt += $r.GetText(600) }
        $txt = ($txt -replace "[\\r\\n]", ' ').Trim()
        if ($txt.Length -gt 500) { $txt = $txt.Substring(0, 500) }
        return $txt
      }
      $el = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($el)
    }
    return ''
  } catch { return '' }
}
[Console]::Out.WriteLine('READY')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq 'c') { [System.Windows.Forms.SendKeys]::SendWait('^c') }
  elseif ($line -eq 'u') {
    $s = Get-Sel
    if ($s) { [Console]::Out.WriteLine('R' + [char]9 + $s) } else { [Console]::Out.WriteLine('E') }
  }
}`;

/** 兜底:每次冷启动一个 PowerShell 发送 Ctrl+C(常驻进程不可用时使用) */
function copyViaKeyboard() {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => finish(false), 1600);
    try {
      const ps = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
         'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^c")'],
        { windowsHide: true });
      ps.on('exit', () => { clearTimeout(timer); finish(true); });
      ps.on('error', () => { clearTimeout(timer); finish(false); });
    } catch (e) { clearTimeout(timer); finish(false); }
  });
}

class CopySender {
  constructor() {
    this.child = null;
    this._booting = null;
    this._buf = '';        // stdout 半行缓冲
    this._lines = [];      // 已收到未消费的完整行
    this._waiters = [];    // 等待 'u' 应答的请求(串行,实际同时最多一个)
  }

  /** 持续解析 stdout 行:READY 完成启动,其余行分发给等待者 */
  _attach(child) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      this._buf += chunk;
      let i;
      while ((i = this._buf.indexOf('\n')) >= 0) {
        const line = this._buf.slice(0, i).replace(/\r$/, '');
        this._buf = this._buf.slice(i + 1);
        if (line === 'READY') {
          if (this._readyResolve) { this._readyResolve(true); this._readyResolve = null; }
          continue;
        }
        this._lines.push(line);
        this._dispatch();
      }
    });
  }

  _dispatch() {
    while (this._waiters.length && this._lines.length) {
      const line = this._lines.shift();
      const w = this._waiters.shift();
      clearTimeout(w.timer);
      if (line.startsWith('R\t')) w.resolve(line.slice(2));
      else w.resolve(''); // 'E' 或未知行:无选区/不支持
    }
  }

  /** 确保常驻进程存活;首次启动约需几百毫秒,应用启动时应调用 prewarmCopy 预热 */
  ensure() {
    if (this.child && this.child.exitCode === null && this.child.stdin && !this.child.stdin.destroyed) return Promise.resolve(true);
    if (!this._booting) {
      this._booting = new Promise(resolve => {
        this._readyResolve = resolve;
        try {
          const child = spawn('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', RESIDENT_PS],
            { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
          child.on('exit', () => {
            if (this.child === child) this.child = null;
            if (this._readyResolve) { this._readyResolve(false); this._readyResolve = null; }
            while (this._waiters.length) this._waiters.shift().resolve(null); // 进程没了,等待者直接失败
          });
          child.once('error', () => {
            if (this.child === child) this.child = null;
            if (this._readyResolve) { this._readyResolve(false); this._readyResolve = null; }
          });
          setTimeout(() => { if (this._readyResolve) { this._readyResolve(false); this._readyResolve = null; } }, 3000); // 超时兜底
          this._attach(child);
          this.child = child;
        } catch (e) { resolve(false); }
      }).then(ok => { this._booting = null; return ok; });
    }
    return this._booting;
  }

  async send() {
    const ok = await this.ensure();
    if (!ok || !this.child) return false;
    try { this.child.stdin.write('c\n'); return true; }
    catch (e) { this.child = null; return false; }
  }

  /** UIA 直读选区:成功返回文本,无选区/不支持返回 '',进程异常或超时返回 null */
  async uia(ms = 450) {
    const ok = await this.ensure();
    if (!ok || !this.child) return null;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this._waiters = this._waiters.filter(w => w.resolve !== resolve);
        resolve(null);
      }, ms);
      this._waiters.push({ resolve, timer });
      try { this.child.stdin.write('u\n'); }
      catch (e) { clearTimeout(timer); this._waiters = this._waiters.filter(w => w.resolve !== resolve); resolve(null); }
    });
  }
}

const copySender = new CopySender();

/** 应用启动时调用,提前把常驻进程(含 UIA 程序集)拉起来 */
function prewarmCopy() { copySender.ensure(); }

/**
 * 取当前选中内容:
 * 1. 优先 UIA 直读(不占用剪贴板,典型 10-80ms);
 * 2. 应用不支持 UIA 时,模拟 Ctrl+C 并轮询剪贴板(典型 ~100-250ms,上限 450ms),
 *    返回 prev 供调用方延迟恢复剪贴板。
 * 返回 { ok, text?, prev, via }。
 */
async function captureSelection() {
  const sel = await copySender.uia();
  if (sel && sel.trim()) return { ok: true, text: sel.trim(), prev: null, via: 'uia' };

  const prev = { text: clipboard.readText(), image: clipboard.readImage() };
  let ok = await copySender.send();
  if (!ok) ok = await copyViaKeyboard();
  if (!ok) return { ok: false, prev, via: 'none' };
  const prevText = (prev.text || '').trim();
  for (let t = 35; t <= 450; t += 35) {
    await sleep(35);
    let text = '';
    try { text = (clipboard.readText() || '').trim(); } catch (e) { /* ignore */ }
    if (text && text !== prevText) return { ok: true, text, prev, via: 'ctrlc' };
  }
  return { ok: false, prev, via: 'none' };
}

function createCapture({ onGesture }) {
  const state = {
    down: null,       // 当前按下的鼠标位置
    lastDown: null,   // 上一次按下(用于识别双击)
    clicks: 0,        // 连击计数
    started: false
  };

  function gesture(x, y) {
    // 短暂等待选区稳定后交给主进程(弹卡在主进程中即时出现,取词并行)
    setTimeout(() => { try { onGesture({ x, y }); } catch (e) { /* ignore */ } }, 100);
  }

  if (hookLib) {
    const { uIOhook } = hookLib;
    uIOhook.on('mousedown', e => {
      if (e.button !== 1) return; // 仅左键
      const now = Date.now();
      if (state.lastDown && now - state.lastDown.t < 450 &&
          Math.hypot(e.x - state.lastDown.x, e.y - state.lastDown.y) < 8) {
        state.clicks += 1;
      } else {
        state.clicks = 1;
      }
      state.lastDown = { x: e.x, y: e.y, t: now };
      state.down = { x: e.x, y: e.y, t: now };
    });
    uIOhook.on('mouseup', e => {
      if (e.button !== 1 || !state.down) return;
      const dist = Math.hypot(e.x - state.down.x, e.y - state.down.y);
      const dt = Date.now() - state.down.t;
      const isDrag = dist >= 10 && dt >= 40 && dt <= 4000;       // 拖拽划词
      const isDbl = state.clicks >= 2 && dist < 10 && dt <= 500; // 双击选词
      if (isDrag || isDbl) gesture(e.x, e.y);
      state.down = null;
    });
    try { uIOhook.start(); state.started = true; }
    catch (e) { console.warn('[capture] 钩子启动失败:', e.message); }
  }

  return {
    available: state.started,
    stop() { try { if (state.started) hookLib.uIOhook.stop(); } catch (e) { /* ignore */ } }
  };
}

module.exports = { createCapture, captureSelection, prewarmCopy, copyViaKeyboard, sleep };
