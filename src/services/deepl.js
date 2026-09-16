/** DeepL 官方 API(需要 key;免费 key 以 :fx 结尾自动走免费端点) */
const { fetchTimeout, isChinese } = require('./util');

module.exports = {
  id: 'deepl',
  name: 'DeepL',
  needsKey: true,
  hint: 'API key 在 deepl.com/pro 的免费套餐里申请(免费 key 以 :fx 结尾,每月 50 万字符)。',
  cfgFields: [{ key: 'key', label: 'Auth Key', password: true, placeholder: 'xxxxxxxx-…-fx' }],
  ready(cfg) { return !!(cfg && cfg.key); },
  defaultCfg: { key: '' },
  async translate(text, cfg) {
    const host = String(cfg.key).trim().endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
    const r = await fetchTimeout(host + '/v2/translate', {
      method: 'POST',
      headers: { Authorization: 'DeepL-Auth-Key ' + cfg.key.trim(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: [text], target_lang: isChinese(text) ? 'EN' : 'ZH' })
    }, 10000);
    if (!r.ok) throw new Error('deepl ' + r.status);
    const j = await r.json();
    const t = j.translations && j.translations[0] && j.translations[0].text;
    if (!t) throw new Error('deepl empty');
    return { text: t };
  }
};
