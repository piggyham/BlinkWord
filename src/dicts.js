/**
 * qwerty-learner 词库管理:仅用作背单词"四选一"题型的干扰项来源。
 * 词库按需从 jsDelivr CDN 下载(国内可达),校验 [{name, trans[]}] 格式后落盘
 * userData/dicts/,首次使用时载入内存缓存。
 */
const fs = require('fs');
const path = require('path');

const CDN_BASE = 'https://cdn.jsdelivr.net/gh/RealKai42/qwerty-learner@master/public/dicts/';

// 精选目录;id 即文件名去扩展名
const CATALOG = [
  { id: 'CET4_T', name: '大学英语四级' },
  { id: 'CET6_T', name: '大学英语六级' },
  { id: 'GaoKao_3500', name: '高考 3500 词' },
  { id: '2025KaoYanHongBaoShu', name: '考研红宝书 2025' },
  { id: 'Categorized_TOEFL_Vocabulary_by_Zhanghongyan', name: '托福词汇(张红岩)' },
  { id: 'GRE3000_3_T', name: 'GRE 3000' },
  { id: 'BEC_3_T', name: 'BEC 商务英语' },
  { id: '926', name: '考研核心 926(小词库)' }
];

class Dicts {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this._cache = new Map(); // id → [{name, trans: [..]}](仅含释义非空的词条)
  }

  fileOf(id) { return path.join(this.dir, id + '.json'); }

  list() {
    return CATALOG.map(c => {
      let count = 0, downloaded = false;
      try {
        downloaded = fs.existsSync(this.fileOf(c.id));
        if (downloaded) count = this.load(c.id).length;
      } catch (e) { /* 单个词库损坏不影响列表 */ }
      return { ...c, downloaded, count };
    });
  }

  downloadedCount() {
    return this.list().filter(d => d.downloaded).length;
  }

  /** 载入词库(含内存缓存);文件损坏时抛错由调用方处理 */
  load(id) {
    if (this._cache.has(id)) return this._cache.get(id);
    const raw = JSON.parse(fs.readFileSync(this.fileOf(id), 'utf8'));
    if (!Array.isArray(raw)) throw new Error('词库格式不正确');
    const entries = raw
      .filter(e => e && typeof e.name === 'string' && Array.isArray(e.trans) && e.trans.length)
      .map(e => ({ name: e.name, trans: e.trans[0] }));
    this._cache.set(id, entries);
    return entries;
  }

  async download(id) {
    const meta = CATALOG.find(c => c.id === id);
    if (!meta) throw new Error('未知词库: ' + id);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    let j;
    try {
      const r = await fetch(CDN_BASE + encodeURIComponent(id) + '.json', { signal: ctrl.signal });
      if (!r.ok) throw new Error('CDN 返回 ' + r.status);
      j = await r.json();
    } finally { clearTimeout(timer); }
    if (!Array.isArray(j) || !j.length || typeof j[0].name !== 'string') {
      throw new Error('词库内容校验失败');
    }
    fs.writeFileSync(this.fileOf(id), JSON.stringify(j), 'utf8');
    const count = this.load(id).length; // 顺手热缓存
    return { id, count };
  }

  remove(id) {
    try { fs.unlinkSync(this.fileOf(id)); } catch (e) { /* ignore */ }
    this._cache.delete(id);
  }

  /** 从所有已下载词库随机抽 n 个干扰项释义:排除原词本身、与正确释义相同/过于相似的 */
  randomDistractors(excludeWord, excludeTrans, n) {
    const excludeNorm = String(excludeTrans || '').replace(/\s+/g, '').toLowerCase();
    const wordNorm = String(excludeWord || '').toLowerCase();
    const pool = [];
    for (const d of this.list()) {
      if (!d.downloaded) continue;
      try {
        for (const e of this.load(d.id)) {
          if (e.name.toLowerCase() === wordNorm) continue;
          const t = String(e.trans).trim();
          if (!t || t.replace(/\s+/g, '').toLowerCase() === excludeNorm) continue;
          pool.push(t);
        }
      } catch (e) { /* 词库文件损坏则跳过 */ }
    }
    // 洗牌后取互不重复的 n 个
    for (let i = pool.length - 1; i > 0; i--) {
      const jdx = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[jdx]] = [pool[jdx], pool[i]];
    }
    const seen = new Set();
    const out = [];
    for (const t of pool) {
      const k = t.replace(/\s+/g, '');
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
      if (out.length >= n) break;
    }
    return out;
  }
}

module.exports = { Dicts, CATALOG };
