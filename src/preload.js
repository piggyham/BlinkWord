/**
 * 预加载脚本:向两个渲染进程(主窗口 / 划词弹卡)暴露安全的 IPC 接口。
 */
const { contextBridge, ipcRenderer } = require('electron');

function speakLocal(text, lang) {
  try {
    const u = new SpeechSynthesisUtterance(String(text || ''));
    u.lang = lang || (/[\u4e00-\u9fff]/.test(text) ? 'zh-CN' : 'en-US');
    u.rate = 0.9;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch (e) { /* 朗读为附加功能,失败静默 */ }
}

contextBridge.exposeInMainWorld('cardAPI', {
  // —— 单词本 / 学习 ——
  list: () => ipcRenderer.invoke('book:list'),
  add: (word, extra) => ipcRenderer.invoke('book:add', word, extra),
  remove: (id) => ipcRenderer.invoke('book:remove', id),
  reset: (id) => ipcRenderer.invoke('book:reset', id),
  fetchExample: (id) => ipcRenderer.invoke('book:fetch-example', id),
  stats: () => ipcRenderer.invoke('book:stats'),
  dueCount: () => ipcRenderer.invoke('review:due-count'),
  batch: () => ipcRenderer.invoke('review:batch'),
  answer: (id, correct) => ipcRenderer.invoke('review:answer', id, correct),
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  env: () => ipcRenderer.invoke('env:info'),
  servicesMeta: () => ipcRenderer.invoke('services:meta'),
  serviceTest: (id, cfg) => ipcRenderer.invoke('services:test', id, cfg),
  translateText: (text) => ipcRenderer.invoke('translate:text', text),
  dictsList: () => ipcRenderer.invoke('dict:list'),
  dictDownload: (id) => ipcRenderer.invoke('dict:download', id),
  dictRemove: (id) => ipcRenderer.invoke('dict:remove', id),
  reviewDistractors: (word, correctTrans, n) => ipcRenderer.invoke('review:distractors', word, correctTrans, n),
  clearTranslateCache: () => ipcRenderer.invoke('translate:clear-cache'),
  exportData: () => ipcRenderer.invoke('data:export'),
  importData: () => ipcRenderer.invoke('data:import'),
  speak: speakLocal,
  onBookChanged: (cb) => ipcRenderer.on('book:changed', () => cb()),

  // —— 账号 / 云同步(自建服务器 + 坚果云 WebDAV) ——
  accountGet: () => ipcRenderer.invoke('account:get'),
  accountSetServer: (url) => ipcRenderer.invoke('account:set-server', url),
  accountLogin: (u, p) => ipcRenderer.invoke('account:login', u, p),
  accountRegister: (u, p) => ipcRenderer.invoke('account:register', u, p),
  accountLogout: () => ipcRenderer.invoke('account:logout'),
  accountSync: () => ipcRenderer.invoke('account:sync'),
  webdavGet: () => ipcRenderer.invoke('webdav:get'),
  webdavTest: (cfg) => ipcRenderer.invoke('webdav:test', cfg),
  webdavSave: (cfg) => ipcRenderer.invoke('webdav:save', cfg),
  webdavDisconnect: () => ipcRenderer.invoke('webdav:disconnect'),
  webdavSync: () => ipcRenderer.invoke('webdav:sync'),

  // —— 划词弹卡 ——
  popupTranslate: () => ipcRenderer.invoke('popup:translate'),
  popupSave: () => ipcRenderer.invoke('popup:save'),
  popupCheckSaved: () => ipcRenderer.invoke('popup:check-saved'),
  popupCopy: () => ipcRenderer.invoke('popup:copy'),
  popupHide: () => ipcRenderer.send('popup:hide'),
  popupEnterPanel: () => ipcRenderer.send('popup:enter-panel'),
  onPopupShow: (cb) => ipcRenderer.on('popup:show', (e, data) => cb(data)),
  onPopupText: (cb) => ipcRenderer.on('popup:text', (e, data) => cb(data))
});
