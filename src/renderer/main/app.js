/* 翻译小卡片 - 主窗口逻辑 */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

let wordsCache = [];
let filter = 'all';
let session = null; // { items, idx, correct }

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function showToast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.add('hidden'), 2000);
}

const shuffle = arr => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };

/* ———————————————— 单词本 ———————————————— */

/** FSRS 口径的学习阶段:稳定性≥21天=已掌握,复习过=学习中,否则新词 */
function stage(w) {
  if ((w.stability || 0) >= 21) return 'mastered';
  if ((w.reps || 0) > 0 || (w.reviewCount || 0) > 0) return 'learning';
  return 'fresh';
}

function badge(w) {
  const imp = (w.saveCount || 1) >= 2 ? `<span class="badge imp">重要 ×${w.saveCount}</span>` : '';
  const st = stage(w);
  if (st === 'mastered') return `<span class="badge mastered">已掌握</span>${imp}`;
  if (st === 'learning') return `<span class="badge learning">学习中</span>${imp}`;
  return `<span class="badge fresh">新词</span>${imp}`;
}

function dueText(w) {
  if (w.dueAt <= Date.now()) return stage(w) === 'fresh' ? '待学习' : '待复习';
  const d = new Date(w.dueAt);
  return `${d.getMonth() + 1}/${d.getDate()} 复习`;
}

function renderBook() {
  const q = ($('#search-input').value || '').trim().toLowerCase();
  let list = wordsCache;
  if (filter === 'due') list = list.filter(w => w.dueAt <= Date.now());
  else if (filter === 'learning') list = list.filter(w => stage(w) === 'learning');
  else if (filter === 'mastered') list = list.filter(w => stage(w) === 'mastered');
  if (q) list = list.filter(w => w.word.toLowerCase().includes(q) || (w.translation || '').toLowerCase().includes(q));

  $('#book-count').textContent = wordsCache.length ? `共 ${wordsCache.length} 词` : '';
  $('#book-empty').classList.toggle('hidden', wordsCache.length !== 0);
  $('#book-list').innerHTML = list.map(w => {
    const senses = (w.senses || []).slice(0, 3);
    const detail = `
      <div class="w-detail hidden">
        ${senses.length ? `<div class="w-senses">${senses.map(s => `<div>• ${esc(s)}</div>`).join('')}</div>` : ''}
        ${w.example
          ? `<div class="w-example">例:${esc(w.example)}<button class="icon-btn ex-speak" title="朗读例句">🔊</button></div>`
          : '<button class="btn small ghost ex-fetch">🈶 获取例句</button><span class="ex-msg muted small"></span>'}
      </div>`;
    return `
    <div class="word-card card" data-id="${w.id}">
      <div class="w-top"><span class="w-word">${esc(w.word)}</span>${badge(w)}</div>
      <div class="w-pho">${esc(w.phonetic || '')}</div>
      <div class="w-trans">${esc(w.translation || '（暂无释义）')}</div>
      ${detail}
      <div class="w-foot">
        <span class="muted small">${dueText(w)}</span>
        <span class="w-actions">
          <button class="icon-btn act-speak" title="朗读">🔊</button>
          <button class="icon-btn act-reset" title="重置进度">↺</button>
          <button class="icon-btn act-del" title="删除">🗑</button>
        </span>
      </div>
    </div>`;
  }).join('');
}

async function loadBook() {
  wordsCache = await window.cardAPI.list();
  renderBook();
  refreshDue();
  renderStats();
}

async function addWordFlow() {
  const v = $('#add-input').value.trim();
  if (!v) return;
  const r = await window.cardAPI.add(v);
  $('#add-input').value = '';
  if (!r) return;
  showToast(r.already ? `「${r.word}」已在单词本,重要度提升至 ×${r.saveCount || 1}` : `已添加「${r.word}」`);
  loadBook();
}

/* ———————————————— 背单词 ———————————————— */

async function refreshDue() {
  const n = await window.cardAPI.dueCount();
  $('#side-due').textContent = n;
  $('#review-due-text').textContent = `今日待学 ${n} 词`;
  const btn = $('#start-review');
  btn.disabled = n === 0;
  btn.textContent = n === 0 ? '今天都学完啦 🎉' : '开始学习';
  refreshReviewHint();
}

/** 单词本释义不足且没下载任何词库时,提示去设置下载词库(解锁四选一) */
async function refreshReviewHint() {
  try {
    const [translated, dicts] = await Promise.all([
      Promise.resolve(wordsCache.filter(w => w.translation).length),
      window.cardAPI.dictsList()
    ]);
    const hasDict = dicts.some(d => d.downloaded);
    $('#review-hint').classList.toggle('hidden', hasDict || translated >= 4);
  } catch (e) { /* ignore */ }
}

async function startReview() {
  const batch = await window.cardAPI.batch();
  if (!batch.length) { showToast('今天没有待学的单词 🎉'); return; }
  session = { items: batch, idx: 0, correct: 0 };
  $('#review-idle').classList.add('hidden');
  $('#review-done').classList.add('hidden');
  $('#review-session').classList.remove('hidden');
  const cardEl = $('#review-card');
  cardEl.dataset.state = '';
  cardEl.classList.remove('revealed');
  renderItem();
}

async function renderItem() {
  const s = session;
  $('#progress-bar').style.width = `${(s.idx / s.items.length) * 100}%`;
  $('#progress-text').textContent = `${s.idx + 1} / ${s.items.length}`;
  const w = s.items[s.idx];
  const cardEl = $('#review-card');
  cardEl.dataset.state = '';
  cardEl.classList.remove('revealed');

  const head = `
    <div class="rc-word">${esc(w.word)}<button class="icon-btn rc-speak" title="朗读">🔊</button></div>
    <div class="rc-pho">${esc(w.phonetic || '')}</div>`;

  // 四选一:干扰项由主进程合并(单词本释义优先、词库补齐);凑不满 3 个退回翻卡模式
  let distractors = [];
  if (w.translation) {
    try { distractors = await window.cardAPI.reviewDistractors(w.word, w.translation, 3); }
    catch (e) { /* ignore */ }
  }
  if (w.translation && distractors.length >= 3) {
    const opts = shuffle([{ text: w.translation, ok: true }, ...distractors.map(t => ({ text: t, ok: false }))]);
    cardEl.innerHTML = head + `
      <div class="rc-prompt">选择正确的释义</div>
      <div class="rc-opts">${opts.map(o => `<button class="rc-opt" data-ok="${o.ok}">${esc(o.text)}</button>`).join('')}</div>`;
  } else {
    cardEl.innerHTML = head + `
      <div class="rc-prompt rc-reveal-hint">点击卡片任意处查看释义</div>
      <div class="rc-flip">
        <div class="rc-trans">${esc(w.translation || '（暂无释义，去单词本看看吧）')}</div>
        <div class="row-btns">
          <button class="btn primary" data-r="1">认识 ✅</button>
          <button class="btn ghost" data-r="0">没记住 ❌</button>
        </div>
      </div>`;
  }
}

async function nextItem() {
  session.idx++;
  if (session.idx >= session.items.length) return finishSession();
  renderItem();
}

async function finishSession() {
  const n = session.items.length, c = session.correct;
  session = null;
  $('#review-session').classList.add('hidden');
  $('#review-done').classList.remove('hidden');
  $('#done-title').textContent = `本轮完成,答对 ${c} / ${n} 词`;
  $('#done-sub').textContent = n ? `正确率 ${Math.round(c / n * 100)}%。答错的词稍后会自动重现。` : '';
  refreshDue();
}

function setupReview() {
  $('#start-review').addEventListener('click', startReview);
  $('#again-btn').addEventListener('click', startReview);
  $('#done-back').addEventListener('click', () => {
    $('#review-done').classList.add('hidden');
    $('#review-idle').classList.remove('hidden');
    refreshDue();
  });
  $('#quit-session').addEventListener('click', () => {
    const done = session ? session.idx : 0;
    session = null;
    $('#review-session').classList.add('hidden');
    if (done > 0) { finishSession(); }
    else { $('#review-idle').classList.remove('hidden'); refreshDue(); }
  });

  const cardEl = $('#review-card');
  cardEl.addEventListener('click', async (e) => {
    if (!session) return;
    const w = session.items[session.idx];
    if (!w) return;

    if (e.target.closest('.rc-speak')) { window.cardAPI.speak(w.word); return; }
    if (cardEl.dataset.state === 'answering') return;

    const opt = e.target.closest('.rc-opt');
    if (opt) {
      cardEl.dataset.state = 'answering';
      const ok = opt.dataset.ok === 'true';
      cardEl.querySelectorAll('.rc-opt').forEach(b => { if (b.dataset.ok === 'true') b.classList.add('right'); });
      if (!ok) opt.classList.add('wrong');
      await window.cardAPI.answer(w.id, ok);
      if (ok) session.correct++;
      setTimeout(nextItem, 950);
      return;
    }

    // 翻转模式
    if (!cardEl.classList.contains('revealed')) { cardEl.classList.add('revealed'); return; }
    const rb = e.target.closest('[data-r]');
    if (rb) {
      cardEl.dataset.state = 'answering';
      const ok = rb.dataset.r === '1';
      await window.cardAPI.answer(w.id, ok);
      if (ok) session.correct++;
      nextItem();
    }
  });
}

/* ———————————————— 统计 ———————————————— */

async function renderStats() {
  const st = await window.cardAPI.stats();
  $('#stat-cards').innerHTML = [
    ['总词汇', st.total], ['待复习', st.due], ['学习中', st.learning], ['已掌握', st.mastered], ['重点词 ⭐', st.important]
  ].map(([l, v]) => `<div class="card stat"><div class="stat-v">${v}</div><div class="muted">${l}</div></div>`).join('');

  const max = Math.max(1, ...st.upcoming);
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const labels = st.upcoming.map((_, i) => {
    const d = new Date(Date.now() + i * 864e5);
    return i === 0 ? '今天' : i === 1 ? '明天' : names[d.getDay()];
  });
  $('#due-chart').innerHTML = st.upcoming.map((v, i) => `
    <div class="bar-col">
      <div class="bar-v">${v || ''}</div>
      <div class="bar" style="height:${Math.max(4, Math.round(v / max * 96))}px"></div>
      <div class="bar-l">${labels[i]}</div>
    </div>`).join('');
}

/* ———————————————— 设置 ———————————————— */

async function loadSettings() {
  const s = await window.cardAPI.settingsGet();
  const env = await window.cardAPI.env();
  $('#set-capture').checked = s.captureEnabled;
  $('#set-mode').value = s.triggerMode;
  $('#set-hotkey').value = s.hotkey;
  $('#set-goal').value = String(s.dailyGoal);
  $('#goal-select').value = String(s.dailyGoal);
  renderServices(s.services || {});
  renderDicts();
  const warn = $('#capture-warn');
  if (!env.captureAvailable) {
    warn.classList.remove('hidden');
    warn.textContent = '⚠️ 鼠标监听模块不可用,自动划词可能失效;建议使用「选中后按热键弹出」。';
  }
}

/* —— 翻译服务池卡片 —— */

let svcMeta = [];

async function renderServices(services) {
  if (!svcMeta.length) svcMeta = await window.cardAPI.servicesMeta();
  const svc = services;
  const order = (svc.order && svc.order.length ? svc.order : svcMeta.map(m => m.id));
  const enabled = svc.enabled || {};
  const cfg = svc.cfg || {};
  $('#svc-list').innerHTML = order.map((id, i) => {
    const m = svcMeta.find(x => x.id === id);
    if (!m) return '';
    const fields = (m.cfgFields || []).map(f => `
      <label class="svc-field"><span>${f.label}</span>
        <input type="${f.password ? 'password' : 'text'}" data-f="${f.key}" placeholder="${f.placeholder || ''}"
          value="${esc((cfg[id] && cfg[id][f.key]) || '')}"></label>`).join('');
    return `
      <div class="svc-row" data-id="${id}">
        <div class="svc-line">
          <button class="icon-btn svc-move" data-d="-1" title="上移" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="icon-btn svc-move" data-d="1" title="下移" ${i === order.length - 1 ? 'disabled' : ''}>↓</button>
          <input type="checkbox" class="switch svc-enable" ${enabled[id] ? 'checked' : ''}>
          <span class="svc-name">${esc(m.name)}${m.needsKey ? ' <span class="svc-key-badge">需配置</span>' : ''}</span>
          ${m.needsKey ? '<button class="btn small ghost svc-test">测试</button>' : ''}
        </div>
        ${fields ? `<div class="svc-cfg">${fields}</div>` : ''}
        ${m.hint ? `<p class="svc-hint muted small">${esc(m.hint)}</p>` : ''}
      </div>`;
  }).join('');
}

function readServicesFromUI() {
  const enabled = {};
  const cfg = {};
  const order = [];
  $$('#svc-list .svc-row').forEach(row => {
    const id = row.dataset.id;
    order.push(id);
    enabled[id] = row.querySelector('.svc-enable').checked;
    const c = {};
    row.querySelectorAll('.svc-cfg input').forEach(inp => { c[inp.dataset.f] = inp.value.trim(); });
    cfg[id] = c;
  });
  return { enabled, order, cfg };
}

function saveServices() {
  window.cardAPI.settingsSet({ services: readServicesFromUI() });
}

function setupServices() {
  $('#svc-list').addEventListener('change', e => {
    if (e.target.classList.contains('svc-enable')) saveServices();
    if (e.target.closest('.svc-cfg')) saveServices();
  });
  $('#svc-list').addEventListener('click', async e => {
    const move = e.target.closest('.svc-move');
    if (move) {
      const row = move.closest('.svc-row');
      const d = Number(move.dataset.d);
      const rows = [...$$('#svc-list .svc-row')];
      const i = rows.indexOf(row);
      const j = i + d;
      if (j < 0 || j >= rows.length) return;
      if (d < 0) rows[j].parentNode.insertBefore(row, rows[j]);      // 上移
      else rows[j].parentNode.insertBefore(rows[j], row);            // 下移
      saveServices();
      renderServices(readServicesFromUI()); // 重画以刷新首末行的箭头可用态
      return;
    }
    const test = e.target.closest('.svc-test');
    if (test) {
      const row = test.closest('.svc-row');
      const id = row.dataset.id;
      test.disabled = true;
      const old = test.textContent;
      test.textContent = '测试中…';
      const cfg = {};
      row.querySelectorAll('.svc-cfg input').forEach(inp => { cfg[inp.dataset.f] = inp.value.trim(); });
      const r = await window.cardAPI.serviceTest(id, cfg);
      test.disabled = false;
      test.textContent = old;
      showToast(r.ok ? `✓ ${r.provider} 连接正常:「hello world」→「${r.sample}」` : '✗ ' + r.error);
    }
  });
  $('#svc-clear-cache-btn').addEventListener('click', async () => {
    await window.cardAPI.clearTranslateCache();
    showToast('已清除翻译缓存,下次翻译将重新请求');
  });
}

/* —— 词库卡片 —— */

async function renderDicts() {
  const list = await window.cardAPI.dictsList();
  $('#dict-list').innerHTML = list.map(d => `
    <div class="dict-row" data-id="${d.id}">
      <span class="dict-name">${esc(d.name)}</span>
      <span class="muted small">${d.downloaded ? `已下载 ${d.count} 词` : '未下载'}</span>
      ${d.downloaded
        ? '<button class="btn small ghost dict-del">删除</button>'
        : '<button class="btn small dict-dl">下载</button>'}
    </div>`).join('');
}

function setupDicts() {
  $('#dict-list').addEventListener('click', async e => {
    const row = e.target.closest('.dict-row');
    if (!row) return;
    const id = row.dataset.id;
    if (e.target.closest('.dict-dl')) {
      const btn = e.target.closest('.dict-dl');
      btn.disabled = true;
      btn.textContent = '下载中…';
      const r = await window.cardAPI.dictDownload(id);
      if (r.ok) showToast(`词库下载完成,共 ${r.count} 词`);
      else { showToast('下载失败:' + r.error); btn.disabled = false; btn.textContent = '下载'; }
      renderDicts();
      refreshReviewHint();
    } else if (e.target.closest('.dict-del')) {
      await window.cardAPI.dictRemove(id);
      showToast('已删除词库');
      renderDicts();
    }
  });
}

/* ———————————————— 输入翻译 ———————————————— */

function setupTranslate() {
  const $input = $('#tr-input'), $go = $('#tr-go'), $dir = $('#tr-dir');
  let last = null; // { text, result }

  const isChinese = s => /[\u4e00-\u9fff]/.test(s);

  function renderResult(r) {
    $('#tr-trans').textContent = r.text || '';
    $('#tr-pho').textContent = r.phonetic || '';
    $('#tr-senses').innerHTML = (r.senses || []).slice(0, 3).map(s => `<div>• ${esc(s)}</div>`).join('');
    $('#tr-example').textContent = r.example ? `例:${r.example}` : '';
    $('#tr-provider').textContent = r.provider ? `via ${r.provider}` : '';
    $('#tr-result').classList.remove('hidden');
  }

  async function go() {
    const text = $input.value.trim();
    if (!text) { $dir.textContent = '请输入内容'; return; }
    $dir.textContent = '翻译中…';
    $go.disabled = true;
    const r = await window.cardAPI.translateText(text);
    $go.disabled = false;
    if (!r.ok) { $dir.textContent = '✗ ' + r.error; return; }
    last = { text, result: r.result };
    $dir.textContent = isChinese(text) ? '中 → 英' : '英 → 中';
    renderResult(r.result);
    $('#tr-speak-src').disabled = false;
  }

  $go.addEventListener('click', go);
  $input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); }
  });
  $('#tr-speak-src').addEventListener('click', () => { if ($input.value.trim()) window.cardAPI.speak($input.value.trim()); });
  $('#tr-speak-dst').addEventListener('click', () => { if (last) window.cardAPI.speak(last.result.text); });
  $('#tr-save').addEventListener('click', async () => {
    if (!last) return;
    const r = last.result;
    const saved = await window.cardAPI.add(last.text, {
      translation: r.text, phonetic: r.phonetic || '', senses: r.senses || [], example: r.example || ''
    });
    if (!saved) return;
    showToast(saved.already ? `「${saved.word}」已在单词本,重要度提升至 ×${saved.saveCount || 1}` : `已存入「${saved.word}」,进入复习计划`);
    loadBook();
  });
}

function setupSettings() {
  const save = patch => window.cardAPI.settingsSet(patch);
  $('#set-capture').addEventListener('change', e => save({ captureEnabled: e.target.checked }));
  $('#set-mode').addEventListener('change', e => save({ triggerMode: e.target.value }));
  $('#set-hotkey').addEventListener('change', e => save({ hotkey: e.target.value }));
  $('#set-goal').addEventListener('change', e => {
    save({ dailyGoal: Number(e.target.value) });
    $('#goal-select').value = e.target.value;
  });
  $('#goal-select').addEventListener('change', e => {
    save({ dailyGoal: Number(e.target.value) });
    $('#set-goal').value = e.target.value;
    refreshDue();
  });
  setupServices();
  setupDicts();
  $('#export-btn').addEventListener('click', async () => {
    const r = await window.cardAPI.exportData();
    if (r.ok) showToast('已导出到 ' + r.path);
  });
  $('#import-btn').addEventListener('click', async () => {
    const r = await window.cardAPI.importData();
    if (r.ok) { showToast(`导入完成,新增 ${r.added} 词,共 ${r.total} 词`); loadBook(); }
  });
}

/* ———————————————— 账号 / 云同步 ———————————————— */

let refreshAccount = () => {}; // 供导航切换时刷新(含坚果云卡片)

function setupAccount() {
  let mode = 'login';
  const $msg = $('#acct-msg');

  async function refresh() {
    const [st, wd] = await Promise.all([window.cardAPI.accountGet(), window.cardAPI.webdavGet()]);
    // 自建服务器卡片
    $('#acct-logged-out').classList.toggle('hidden', st.loggedIn);
    $('#acct-logged-in').classList.toggle('hidden', !st.loggedIn);
    $('#acct-active-badge').classList.toggle('hidden', !st.active);
    $('#acct-set-active').classList.toggle('hidden', !(st.loggedIn && !st.active && wd.configured));
    if (st.loggedIn) {
      $('#acct-name').textContent = st.username;
      $('#acct-avatar').textContent = (st.username[0] || '?').toUpperCase();
      $('#acct-server-line').textContent = '服务器:' + st.serverUrl;
      $('#acct-sync-line').textContent = st.lastSyncAt
        ? '上次同步:' + new Date(st.lastSyncAt).toLocaleString('zh-CN')
        : '登录成功,尚未同步过';
    } else {
      $('#acct-server').value = st.serverUrl;
    }
    // 坚果云 WebDAV 卡片
    $('#webdav-form').classList.toggle('hidden', wd.configured);
    $('#webdav-info').classList.toggle('hidden', !wd.configured);
    $('#webdav-active-badge').classList.toggle('hidden', !wd.active);
    $('#webdav-set-active').classList.toggle('hidden', !(wd.configured && !wd.active && st.loggedIn));
    if (wd.configured) {
      $('#wd-name').textContent = wd.username;
      $('#wd-dir-line').textContent = '位置:' + wd.serverUrl + wd.remoteDir;
      $('#wd-sync-line').textContent = wd.lastSyncAt
        ? '上次同步:' + new Date(wd.lastSyncAt).toLocaleString('zh-CN')
        : '已连接,尚未同步过';
    } else if (!$('#wd-dir').value) {
      $('#wd-dir').value = wd.remoteDir || 'translate-card/';
    }
  }
  refreshAccount = refresh;

  function setMode(m) {
    mode = m;
    $('#tab-login').classList.toggle('active', m === 'login');
    $('#tab-register').classList.toggle('active', m === 'register');
    $('#acct-submit').textContent = m === 'login' ? '登录' : '注册并登录';
    $msg.textContent = '';
  }
  $('#tab-login').addEventListener('click', () => setMode('login'));
  $('#tab-register').addEventListener('click', () => setMode('register'));

  async function submit() {
    const username = $('#acct-user').value.trim();
    const password = $('#acct-pass').value;
    await window.cardAPI.accountSetServer($('#acct-server').value.trim());
    if (!username || !password) { $msg.textContent = '请填写用户名和密码'; return; }
    $msg.textContent = '连接中…';
    const r = mode === 'login'
      ? await window.cardAPI.accountLogin(username, password)
      : await window.cardAPI.accountRegister(username, password);
    if (!r.ok) { $msg.textContent = r.error || '操作失败'; return; }
    $msg.textContent = '';
    showToast(mode === 'login' ? `欢迎回来,${username}!正在同步…` : `注册成功,欢迎 ${username}!正在同步…`);
    await refresh();
    const s = await window.cardAPI.accountSync();
    if (s.ok) { showToast(`同步完成,共 ${s.total} 词`); loadBook(); }
    else showToast(s.error || '首次同步失败,可稍后手动同步');
  }
  $('#acct-submit').addEventListener('click', submit);
  $('#acct-pass').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });

  $('#acct-sync-btn').addEventListener('click', async () => {
    showToast('同步中…');
    const r = await window.cardAPI.accountSync();
    if (r.ok) { showToast(`同步完成,共 ${r.total} 词`); loadBook(); refresh(); }
    else showToast(r.error || '同步失败');
  });
  $('#acct-logout').addEventListener('click', async () => {
    await window.cardAPI.accountLogout();
    await refresh();
    showToast('已退出登录(本地数据保留)');
  });
  $('#acct-set-active').addEventListener('click', async () => {
    await window.cardAPI.settingsSet({ syncBackend: 'server' });
    await refresh();
    showToast('已切换:当前通过自建服务器同步');
  });
}

/* ———————————————— 坚果云 WebDAV 同步 ———————————————— */

function setupWebdav() {
  const $msg = $('#wd-msg');

  function cfgFromForm() {
    return {
      username: $('#wd-user').value.trim(),
      password: $('#wd-pass').value,
      remoteDir: $('#wd-dir').value.trim() || 'translate-card/'
    };
  }

  $('#wd-test').addEventListener('click', async () => {
    const cfg = cfgFromForm();
    if (!cfg.username) { $msg.textContent = '请填写账号邮箱'; return; }
    if (!cfg.password) { $msg.textContent = '请填写应用密码'; return; }
    $msg.textContent = '连接中…';
    const r = await window.cardAPI.webdavTest(cfg);
    $msg.textContent = r.ok ? '✓ 连接成功' : (r.error || '连接失败');
  });

  $('#wd-save').addEventListener('click', async () => {
    const cfg = cfgFromForm();
    if (!cfg.username) { $msg.textContent = '请填写账号邮箱'; return; }
    $msg.textContent = '保存中…';
    const r = await window.cardAPI.webdavSave(cfg);
    if (!r.ok) { $msg.textContent = r.error || '保存失败'; return; }
    $msg.textContent = '';
    $('#wd-pass').value = '';
    showToast('坚果云已连接,正在同步…');
    await refreshAccount();
    const s = await window.cardAPI.webdavSync();
    if (s.ok) { showToast(`同步完成,共 ${s.total} 词`); loadBook(); refreshAccount(); }
    else showToast(s.error || '首次同步失败,可稍后手动同步');
  });
  $('#wd-pass').addEventListener('keydown', e => { if (e.key === 'Enter') $('#wd-save').click(); });

  $('#wd-sync-btn').addEventListener('click', async () => {
    showToast('同步中…');
    const r = await window.cardAPI.webdavSync();
    if (r.ok) { showToast(`同步完成,共 ${r.total} 词`); loadBook(); refreshAccount(); }
    else showToast(r.error || '同步失败');
  });
  $('#wd-disconnect').addEventListener('click', async () => {
    await window.cardAPI.webdavDisconnect();
    await refreshAccount();
    showToast('已断开坚果云(本地与云端数据均保留)');
  });
  $('#webdav-set-active').addEventListener('click', async () => {
    await window.cardAPI.settingsSet({ syncBackend: 'webdav' });
    await refreshAccount();
    showToast('已切换:当前通过坚果云同步');
  });
}

/* ———————————————— 导航与初始化 ———————————————— */

function setupNav() {
  $('#nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-btn');
    if (!btn) return;
    $$('.nav-btn').forEach(b => b.classList.toggle('active', b === btn));
    $$('.view').forEach(v => v.classList.add('hidden'));
    $('#view-' + btn.dataset.view).classList.remove('hidden');
    if (btn.dataset.view === 'book') loadBook();
    if (btn.dataset.view === 'stats') renderStats();
    if (btn.dataset.view === 'review') refreshDue();
    if (btn.dataset.view === 'settings') loadSettings();
    if (btn.dataset.view === 'account') refreshAccount();
    if (btn.dataset.view === 'translate') setTimeout(() => $('#tr-input').focus(), 60);
  });
}

function setupBook() {
  $('#add-btn').addEventListener('click', addWordFlow);
  $('#add-input').addEventListener('keydown', e => { if (e.key === 'Enter') addWordFlow(); });
  $('#search-input').addEventListener('input', renderBook);
  $('#book-filters').addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    filter = chip.dataset.f;
    $$('#book-filters .chip').forEach(c => c.classList.toggle('active', c === chip));
    renderBook();
  });
  $('#book-list').addEventListener('click', async (e) => {
    const cardEl = e.target.closest('.word-card');
    if (!cardEl) return;
    const id = cardEl.dataset.id;
    const w = wordsCache.find(x => x.id === id);
    if (!w) return;
    if (e.target.closest('.act-speak')) { window.cardAPI.speak(w.word); return; }
    if (e.target.closest('.act-del')) {
      await window.cardAPI.remove(id);
      showToast(`已删除「${w.word}」`);
      loadBook();
      return;
    }
    if (e.target.closest('.act-reset')) {
      await window.cardAPI.reset(id);
      showToast(`已重置「${w.word}」的学习进度`);
      loadBook();
      return;
    }
    // 朗读例句
    const exSpeak = e.target.closest('.ex-speak');
    if (exSpeak) { window.cardAPI.speak(w.example); return; }
    // 获取例句:走翻译服务(有缓存时瞬时),DeepSeek 等服务会一并返回例句
    const exFetch = e.target.closest('.ex-fetch');
    if (exFetch) {
      exFetch.disabled = true;
      exFetch.textContent = '获取中…';
      const r = await window.cardAPI.fetchExample(id);
      if (r.ok) {
        const msg = cardEl.querySelector('.ex-msg');
        const detail = cardEl.querySelector('.w-detail');
        if (msg) msg.remove();
        exFetch.remove();
        const div = document.createElement('div');
        div.className = 'w-example';
        div.innerHTML = `例:${esc(r.example)}<button class="icon-btn ex-speak" title="朗读例句">🔊</button>`;
        detail.appendChild(div);
      } else {
        exFetch.disabled = false;
        exFetch.textContent = '🈶 获取例句';
        const msg = cardEl.querySelector('.ex-msg');
        if (msg) msg.textContent = r.error || '获取失败';
      }
      return;
    }
    // 点击卡片其他区域:展开/收起详情(释义 + 例句)
    if (e.target.closest('button')) return;
    const detail = cardEl.querySelector('.w-detail');
    if (detail) detail.classList.toggle('hidden');
  });
}

async function init() {
  setupNav();
  setupBook();
  setupReview();
  setupSettings();
  setupAccount();
  setupTranslate();
  setupWebdav();
  await loadSettings();
  await loadBook();
  window.cardAPI.onBookChanged(() => loadBook());
}

init();
