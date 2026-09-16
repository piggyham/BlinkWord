/** 百度翻译开放平台 API(需要 appid + 密钥,MD5 签名) */
const crypto = require('crypto');
const { fetchTimeout, isChinese } = require('./util');

module.exports = {
  id: 'baidu',
  name: '百度翻译',
  needsKey: true,
  hint: '在 fanyi-api.baidu.com 注册并实名后,标准版每月 5 万字符免费;填 AppID 和密钥。',
  cfgFields: [
    { key: 'appid', label: 'AppID', placeholder: '2024xxxx' },
    { key: 'secret', label: '密钥', password: true, placeholder: '' }
  ],
  ready(cfg) { return !!(cfg && cfg.appid && cfg.secret); },
  defaultCfg: { appid: '', secret: '' },
  async translate(text, cfg) {
    const salt = Date.now();
    const sign = crypto.createHash('md5').update(cfg.appid + text + salt + cfg.secret).digest('hex');
    const q = 'q=' + encodeURIComponent(text) +
      '&from=auto&to=' + (isChinese(text) ? 'en' : 'zh') +
      '&appid=' + encodeURIComponent(cfg.appid) + '&salt=' + salt + '&sign=' + sign;
    const r = await fetchTimeout('https://fanyi-api.baidu.com/api/trans/vip/translate?' + q, {}, 8000);
    if (!r.ok) throw new Error('baidu ' + r.status);
    const j = await r.json();
    if (j.error_code) throw new Error('baidu ' + j.error_code + ' ' + (j.error_msg || ''));
    const lines = (j.trans_result || []).map(x => x.dst).join(' ');
    if (!lines) throw new Error('baidu empty');
    return { text: lines };
  }
};
