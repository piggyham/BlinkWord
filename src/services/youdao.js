/** 有道智云翻译 API(需要应用 ID + 密钥,SHA256 签名) */
const crypto = require('crypto');
const { fetchTimeout, isChinese } = require('./util');

module.exports = {
  id: 'youdao',
  name: '有道智云',
  needsKey: true,
  hint: '在 ai.youdao.com 创建"文本翻译"应用,填应用 ID 和应用密钥;新用户有免费体验额度。',
  cfgFields: [
    { key: 'appKey', label: '应用 ID', placeholder: '' },
    { key: 'key', label: '应用密钥', password: true, placeholder: '' }
  ],
  ready(cfg) { return !!(cfg && cfg.appKey && cfg.key); },
  defaultCfg: { appKey: '', key: '' },
  async translate(text, cfg) {
    const curtime = Math.floor(Date.now() / 1000);
    const salt = curtime;
    const input = text.length <= 20 ? text : text.slice(0, 10) + text.length + text.slice(-10);
    const sign = crypto.createHash('sha256').update(cfg.appKey + input + salt + curtime + cfg.key).digest('hex');
    const r = await fetchTimeout('https://openapi.youdao.com/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'q=' + encodeURIComponent(text) +
        '&from=auto&to=' + (isChinese(text) ? 'en' : 'zh-CHS') +
        '&appKey=' + encodeURIComponent(cfg.appKey) + '&salt=' + salt + '&curtime=' + curtime + '&sign=' + sign +
        '&signType=v3&strict=true'
    }, 10000);
    if (!r.ok) throw new Error('youdao ' + r.status);
    const j = await r.json();
    if (j.errorCode && j.errorCode !== '0') throw new Error('youdao ' + j.errorCode);
    const t = (j.translation || []).join(' ');
    if (!t) throw new Error('youdao empty');
    return { text: t };
  }
};
