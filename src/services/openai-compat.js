/**
 * 自定义 OpenAI 兼容服务(填 base URL + key + 模型名):
 * 可接 Kimi / GLM / 通义 / DeepSeek 自部署 / 本地 Ollama 等任何 OpenAI 协议端点。
 */
const { openaiChatTranslate } = require('./openai-chat');

module.exports = {
  id: 'openai',
  name: '自定义 OpenAI 兼容 (LLM)',
  needsKey: true,
  hint: '填任意 OpenAI 协议端点:Kimi(https://api.moonshot.cn)、GLM(https://open.bigmodel.cn/api/paas)、Ollama(http://127.0.0.1:11434)等。',
  cfgFields: [
    { key: 'baseUrl', label: 'Base URL', placeholder: 'https://api.moonshot.cn' },
    { key: 'apiKey', label: 'API Key', password: true, placeholder: 'sk-…(Ollama 可随便填)' },
    { key: 'model', label: '模型名', placeholder: '如 moonshot-v1-8k / glm-4 / qwen2.5' }
  ],
  ready(cfg) { return !!(cfg && cfg.baseUrl && cfg.model); },
  defaultCfg: { baseUrl: '', apiKey: 'sk-nokey', model: '' },
  async translate(text, cfg) {
    return openaiChatTranslate(cfg.baseUrl, cfg.apiKey || 'sk-nokey', cfg.model, text);
  }
};
