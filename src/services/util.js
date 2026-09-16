/** 服务模块共用工具 */
function fetchTimeout(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    return fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

const isChinese = text => /[\u4e00-\u9fff]/.test(text);

/** 目标语言:中文→英,其他→中 */
const targetLang = text => (isChinese(text) ? 'en' : 'zh-CN');

module.exports = { fetchTimeout, isChinese, targetLang };
