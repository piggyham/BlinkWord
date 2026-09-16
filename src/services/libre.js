/** 自建 LibreTranslate(填服务器地址即可,可部署在自己/NAS 的 Docker 上) */
const { fetchTimeout, isChinese } = require('./util');

module.exports = {
  id: 'libre',
  name: 'LibreTranslate (自建)',
  needsKey: true,
  hint: '开源翻译引擎,用 Docker 一行命令即可自部署;填服务地址如 http://192.168.1.10:5000。',
  cfgFields: [
    { key: 'url', label: '服务地址', placeholder: 'http://127.0.0.1:5000' },
    { key: 'apiKey', label: 'API Key', password: true, placeholder: '(未设 key 可留空)' }
  ],
  ready(cfg) { return !!(cfg && cfg.url); },
  defaultCfg: { url: '', apiKey: '' },
  async translate(text, cfg) {
    const r = await fetchTimeout(String(cfg.url).replace(/\/+$/, '') + '/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: text, source: 'auto', format: 'text',
        target: isChinese(text) ? 'en' : 'zh',
        api_key: cfg.apiKey || ''
      })
    }, 10000);
    if (!r.ok) throw new Error('libre ' + r.status);
    const j = await r.json();
    if (!j.translatedText) throw new Error('libre empty');
    return { text: j.translatedText };
  }
};
