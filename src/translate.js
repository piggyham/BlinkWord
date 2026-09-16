/**
 * 翻译调度:按服务池(用户可排序/开关/配 key,pot 式)取译文,带本地磁盘缓存;
 * 传统服务只给译文,英文单词再由 dictionaryapi.dev 补音标;
 * LLM 服务(DeepSeek/智谱/自定义 OpenAI 兼容)一次返回音标+释义+例句,命中时跳过词典补充。
 */
const fs = require('fs');
const { runPool } = require('./services');

class Translator {
  constructor(cacheFile, getServicesSettings) {
    this.file = cacheFile;
    this.getServicesSettings = typeof getServicesSettings === 'function' ? getServicesSettings : () => null;
    this.cache = {};
    try { this.cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) || {}; } catch (e) { /* ignore */ }
    this._saveTimer = null;
    this._dictFailUntil = 0; // 词典接口连不上时的熔断截止时刻
  }

  saveSoon() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try { fs.writeFileSync(this.file, JSON.stringify(this.cache), 'utf8'); } catch (e) { /* ignore */ }
    }, 500);
  }

  clearCache() {
    this.cache = {};
    try { fs.writeFileSync(this.file, '{}', 'utf8'); } catch (e) { /* ignore */ }
  }

  async dictionary(word) {
    if (Date.now() < this._dictFailUntil) return null; // 熔断中,不白等超时
    let j = null;
    try {
      const { fetchTimeout } = require('./services/util');
      const r = await fetchTimeout('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word.toLowerCase()), {}, 3000);
      if (!r.ok) return null; // 查无此词属正常未命中,不熔断
      j = await r.json();
    } catch (e) {
      this._dictFailUntil = Date.now() + 10 * 60 * 1000; // 超时/网络不通:熔断 10 分钟
      console.warn('[translate] 词典不可达,熔断10分钟:', e.message);
      return null;
    }
    if (!Array.isArray(j) || !j[0]) return null;
    const e = j[0];
    const phonetic = e.phonetic || (e.phonetics && e.phonetics.map(p => p.text).find(Boolean)) || '';
    const senses = [];
    for (const m of e.meanings || []) {
      if (senses.length >= 3) break;
      if (m.definitions && m.definitions[0]) senses.push(m.partOfSpeech + '. ' + m.definitions[0].definition);
    }
    const example = (e.meanings && e.meanings[0] && e.meanings[0].definitions && e.meanings[0].definitions[0].example) || '';
    return { phonetic, senses, example };
  }

  async translate(text) {
    text = String(text || '').trim();
    if (!text) throw new Error('empty');
    const isEnWord = /^[A-Za-z][A-Za-z'\-]*$/.test(text);
    const key = 'v2|' + text.toLowerCase();
    if (this.cache[key]) return this.cache[key];

    const hit = await runPool(text, this.getServicesSettings());
    if (!hit) throw new Error('翻译服务暂不可用,请检查网络或在设置中启用其他翻译服务');

    const out = {
      text: hit.result.text,
      from: hit.result.from || '',
      provider: hit.provider
    };

    if (out.text && /[\u4e00-\u9fff]/.test(out.text) && isEnWord) {
      // 英文单词→中文:优先用 LLM 附带的音标/释义;否则查 dictionaryapi.dev
      if (hit.result.isLLM) {
        out.phonetic = hit.result.phonetic || '';
        out.senses = hit.result.senses || [];
        out.example = hit.result.example || '';
      } else {
        const d = await this.dictionary(text).catch(() => null);
        if (d) {
          out.phonetic = d.phonetic;
          out.senses = d.senses;
          out.example = d.example;
        }
      }
    }

    out.query = text;
    this.cache[key] = out;
    this.saveSoon();
    return out;
  }
}

module.exports = Translator;
