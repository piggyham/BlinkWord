/** MyMemory 翻译记忆库(免 key),Edge 不可用时的兜底 */
const { fetchTimeout, isChinese } = require('./util');

module.exports = {
  id: 'mymemory',
  name: 'MyMemory',
  needsKey: false,
  cfgFields: [],
  async translate(text) {
    const pair = isChinese(text) ? 'zh-CN|en' : 'en|zh-CN';
    const r = await fetchTimeout('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=' + pair, {}, 7000);
    if (!r.ok) throw new Error('mymemory ' + r.status);
    const j = await r.json();
    const t = j && j.responseData && j.responseData.translatedText;
    if (!t) throw new Error('mymemory empty');
    return { text: t };
  }
};
