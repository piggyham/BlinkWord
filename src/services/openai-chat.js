/**
 * OpenAI 兼容协议的 LLM 翻译(DeepSeek / 智谱 GLM / Kimi / 通义 / Ollama 等共用):
 * 一次调用返回译文 + 音标 + 释义 + 例句(严格 JSON),temperature 0 保证稳定。
 */
const { fetchTimeout } = require('./util');

const SYSTEM_PROMPT =
  '你是翻译引擎。把用户输入的文本翻译成另一种语言:英文→简体中文,中文→英文;其他语言→简体中文。' +
  '同时提供词条信息。只输出一个 JSON 对象,不要任何解释、markdown 或多余文本,格式:' +
  '{"translation":"译文","phonetic":"国际音标,仅当输入是单个英文单词/短语时给出,否则空字符串",' +
  '"senses":["词性. 中文释义或英文释义", ...最多3条,仅英文单词时给出,否则空数组],' +
  '"example":"一个包含该英文单词的英文例句,仅英文单词时给出,否则空字符串"}';

/** 从 LLM 输出中剥掉可能的 markdown 代码块再解析 JSON */
function parseLLMJson(content) {
  let s = String(content || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

/** 容忍用户填裸域名或带版本号的 base URL,统一补全到 /chat/completions */
function chatEndpoint(baseUrl) {
  let b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!b) throw new Error('未填写接口地址');
  if (/\/chat\/completions$/.test(b)) return b;
  if (/\/v\d+$/.test(b) || /\/api\/paas\/v\d+$/.test(b)) return b + '/chat/completions';
  return b + '/v1/chat/completions';
}

/**
 * @param {string} baseUrl 如 https://api.deepseek.com(内部自动补全路径,兼容 /v4、/api/paas/v4 等)
 * @param {string} apiKey
 * @param {string} model
 */
async function openaiChatTranslate(baseUrl, apiKey, model, text) {
  const url = chatEndpoint(baseUrl);
  const r = await fetchTimeout(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text }
      ],
      temperature: 0,
      max_tokens: 600
    })
  }, 15000);
  if (!r.ok) {
    let detail = '';
    try { const e = await r.json(); detail = (e.error && e.error.message) || ''; } catch (e) { /* ignore */ }
    throw new Error('LLM ' + r.status + (detail ? ': ' + detail : ''));
  }
  const j = await r.json();
  const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!content) throw new Error('LLM empty');
  let out;
  try {
    out = parseLLMJson(content);
  } catch (e) {
    return { text: content.trim() }; // 模型没按 JSON 输出时,把整段当译文兜底
  }
  if (!out.translation) throw new Error('LLM no translation');
  return {
    text: String(out.translation),
    phonetic: String(out.phonetic || ''),
    senses: Array.isArray(out.senses) ? out.senses.map(String).slice(0, 3) : [],
    example: String(out.example || ''),
    isLLM: true
  };
}

module.exports = { openaiChatTranslate, chatEndpoint, parseLLMJson, SYSTEM_PROMPT };
