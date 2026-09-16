/* 划词小卡片逻辑:胶囊(翻译/存储) ⇄ 结果面板 */
let text = '';
let saved = false;

const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const ICON_CHECK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';

function setSaveLabel(already, count) {
  const n = count > 1 ? ` ×${count}` : '';
  $('#btn-save').innerHTML = ICON_CHECK + `<span>${already ? '已在单词本' : '已存入'}${n}</span>`;
  $('#btn-save').classList.add('saved');
  const ps = $('#p-save');
  if (ps) {
    ps.textContent = '✓ ' + (already ? '已在单词本' : '已存入单词本') + n;
    ps.classList.add('saved');
  }
}

function hide() { window.cardAPI.popupHide(); }

window.cardAPI.onPopupShow(data => {
  text = data.text;
  saved = false;
  $('#panel').classList.add('hidden');
  $('#pill').classList.remove('hidden');
  $('#btn-translate').innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0 0 14.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/></svg><span>翻译</span>';
  $('#btn-save').innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M17 3H7a2 2 0 0 0-2 2v16l7-3 7 3V5a2 2 0 0 0-2-2zm-2 9h-2v2h-2v-2H9v-2h2V8h2v2h2v2z"/></svg><span>存储</span>';
  $('#btn-save').classList.remove('saved');
  // 面板按钮也要复位,否则上一轮的"已存入单词本"会残留到新词上
  const ps = $('#p-save');
  ps.textContent = '＋ 存入单词本';
  ps.classList.remove('saved');
  $('#p-copy').textContent = '复制';
});

/* 胶囊先弹出、取词并行完成:文本就绪后由主进程推送 */
if (window.cardAPI.onPopupText) {
  window.cardAPI.onPopupText(data => { text = data.text; });
}

/* 存储:立即收进单词本,稍后由主进程自动补释义;重复记录会提升重要度 */
$('#btn-save').addEventListener('click', async () => {
  if (saved) { hide(); return; }
  saved = true;
  const r = await window.cardAPI.popupSave();
  setSaveLabel(r.already, r.saveCount);
  setTimeout(hide, 500);
});

/* 翻译:立即展开为结果面板并显示加载态,译文到了再填充(体感更快) */
$('#btn-translate').addEventListener('click', async () => {
  const btn = $('#btn-translate');
  if (btn.dataset.busy === '1') return;
  btn.dataset.busy = '1';
  btn.innerHTML = '<span class="spin"></span><span>翻译中…</span>';
  window.cardAPI.popupEnterPanel(); // 主进程把窗口放大为面板尺寸
  $('#pill').classList.add('hidden');
  const panel = $('#panel');
  panel.classList.remove('hidden');
  $('#p-word').textContent = text;
  $('#p-pho').textContent = '';
  $('#p-main').innerHTML = '<span class="spin"></span>';
  $('#p-senses').innerHTML = '';
  const r = await window.cardAPI.popupTranslate();
  btn.dataset.busy = '0';
  if (!r.ok) {
    renderError(r.error);
    return;
  }
  renderResult(r.result);
  window.cardAPI.popupCheckSaved().then(already => { if (already) setSaveLabel(true); });
});

function renderError(msg) {
  $('#p-word').textContent = text;
  $('#p-pho').textContent = '';
  $('#p-main').innerHTML = `⚠️ ${esc(msg || '翻译失败')}`;
  $('#p-senses').innerHTML = '';
}

function renderResult(r) {
  $('#p-word').textContent = r.query || text;
  $('#p-pho').textContent = r.phonetic || '';
  // note 透出降级原因(如 AI限流/AI超时),让"via MyMemory"有据可查
  $('#p-main').innerHTML = `${esc(r.text)}<span class="provider">via ${esc(r.provider || '')}${r.note ? ' · ' + esc(r.note) : ''}</span>`;
  const senses = (r.senses || []).slice(0, 3);
  $('#p-senses').innerHTML =
    (r.example ? `<div>例:${esc(r.example)}</div>` : '') +
    senses.map(s => `<div>• ${esc(s)}</div>`).join('');
}

$('#p-save').addEventListener('click', async () => {
  if (saved) return;
  saved = true;
  const r = await window.cardAPI.popupSave();
  setSaveLabel(r.already, r.saveCount);
});
$('#p-copy').addEventListener('click', async () => {
  await window.cardAPI.popupCopy();
  $('#p-copy').textContent = '已复制 ✓';
  setTimeout(hide, 400);
});
$('#p-speak').addEventListener('click', () => window.cardAPI.speak(text));
$('#p-close').addEventListener('click', hide);
window.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
