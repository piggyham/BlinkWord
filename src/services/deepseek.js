/**
 * DeepSeek 翻译(需要 API key,platform.deepseek.com 申请):
 * LLM 翻译质量好、能联系语境,并一次返回音标/释义/例句;延迟 1~3 秒,适合质量优先或作高质量回退。
 * Key 未配置时会被服务池自动跳过。
 */
const { openaiChatTranslate } = require('./openai-chat');

module.exports = {
  id: 'deepseek',
  name: 'DeepSeek (LLM)',
  needsKey: true,
  hint: '质量更好但稍慢;结果带音标与释义。api-key 在 platform.deepseek.com 申请,按量计费约 1~2 元/百万 token,翻译结果有本地缓存。',
  cfgFields: [
    { key: 'apiKey', label: 'API Key', password: true, placeholder: 'sk-…' },
    { key: 'model', label: '模型', placeholder: 'deepseek-chat' }
  ],
  ready(cfg) { return !!(cfg && cfg.apiKey); },
  defaultCfg: { apiKey: '', model: 'deepseek-chat' },
  async translate(text, cfg) {
    return openaiChatTranslate('https://api.deepseek.com', cfg.apiKey, cfg.model || 'deepseek-chat', text);
  }
};
