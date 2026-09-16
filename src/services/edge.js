/** 微软 Edge 翻译(免 key)——Edge 浏览器"翻译"同款引擎 */
const { fetchTimeout, targetLang } = require('./util');

let token = null;
let tokenExp = 0;

async function edgeToken() {
  if (token && Date.now() < tokenExp) return token;
  const r = await fetchTimeout('https://edge.microsoft.com/translate/auth', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  }, 6000);
  if (!r.ok) throw new Error('edge auth ' + r.status);
  token = (await r.text()).trim();
  tokenExp = Date.now() + 8 * 60 * 1000;
  return token;
}

module.exports = {
  id: 'edge',
  name: '微软翻译 (Edge)',
  needsKey: false,
  cfgFields: [],
  async translate(text) {
    const bearer = await edgeToken();
    const r = await fetchTimeout('https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=' + targetLang(text), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ Text: text }])
    }, 7000);
    if (!r.ok) throw new Error('edge ' + r.status);
    const j = await r.json();
    const item = j && j[0];
    if (!item || !item.translations || !item.translations[0]) throw new Error('edge empty');
    return {
      text: item.translations[0].text,
      from: item.detectedLanguage && item.detectedLanguage.language
    };
  }
};
