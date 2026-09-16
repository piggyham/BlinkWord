/**
 * 本地存储:单词本 + 设置 + FSRS 记忆算法调度
 * 数据为纯 JSON;words[] 的字段同时是云同步的合并单元。
 * FSRS(ts-fsrs,MIT):认识→Good、没记住→Again,默认参数;旧数据按 Leitner box 播种迁移。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fsrs, generatorParameters, Rating, State } = require('ts-fsrs');

const DAY = 24 * 3600 * 1000;
// 旧版 Leitner 间隔,仅用于旧数据播种与 box 兼容字段维护
const INTERVALS = [1, 2, 4, 7, 15, 30, 60];
const FSRS = fsrs(generatorParameters()); // FSRS-5 默认权重,目标记忆保持率 0.9

const { DEFAULT_SERVICES } = require('./services');

const DEFAULT_SETTINGS = {
  captureEnabled: true,   // 划词小卡片总开关
  triggerMode: 'auto',    // auto: 鼠标划词自动弹出 | hotkey: 选中后按热键
  hotkey: 'Alt+Q',
  hotkeyEnabled: true,
  dailyGoal: 10,          // 每日学习量
  // 翻译服务池(pot 式):enabled/order/cfg 见 src/services/index.js
  services: JSON.parse(JSON.stringify(DEFAULT_SERVICES))
};

/** 单词条目 → ts-fsrs 卡片(elapsed_days 必须按真实复习间隔计算,否则间隔不增长) */
function toCard(w) {
  const lastReview = w.lastReview ? new Date(Number(w.lastReview)) : null;
  return {
    due: new Date(Number(w.dueAt) || Date.now()),
    stability: Number(w.stability) || 0,
    difficulty: Number(w.difficulty) || 0,
    elapsed_days: lastReview ? Math.max(0, Math.round((Date.now() - lastReview.getTime()) / DAY)) : 0,
    scheduled_days: 0,
    reps: Number(w.reps) || 0,
    lapses: Number(w.lapses) || 0,
    state: (Number(w.reps) || 0) === 0 ? State.New : State.Review,
    last_review: lastReview || undefined
  };
}

class Store {
  constructor(file) {
    this.file = file;
    this.data = { words: [], settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) };
    this._timer = null;
    /** 数据变化回调(宿主用于触发云同步),由 main.js 设置 */
    this.onChanged = null;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && Array.isArray(raw.words)) {
        this.data.words = raw.words;
        this.data.settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}) };
        this.migrateLegacyAI(raw.settings || {});
      }
    } catch (e) { /* 首次运行尚无数据文件 */ }
    // FSRS 字段播种:旧数据按 Leitner box 折算,不丢进度
    for (const w of this.data.words) {
      if (typeof w.stability === 'number' && w.stability > 0) continue;
      w.stability = INTERVALS[Math.min(Number(w.box) || 0, INTERVALS.length - 1)];
      w.difficulty = 5;
      w.reps = Number(w.reviewCount) || 0;
      w.lapses = Math.max(0, (Number(w.reviewCount) || 0) - (Number(w.correctCount) || 0));
      w.lastReview = w.reps > 0 ? (Number(w.dueAt) || Date.now()) - w.stability * DAY : null;
    }
  }

  /**
   * 旧版"AI 大模型翻译"单选设置(aiEnabled / aiApiKey 等)→ 服务池:
   * 按旧地址判定归属(DeepSeek 单列,其余进"自定义 OpenAI 兼容"),保留原开关与排序偏好(AI 优先)。
   */
  migrateLegacyAI(old) {
    if (old.services) return; // 已是服务池设置
    const s = JSON.parse(JSON.stringify(DEFAULT_SERVICES));
    const key = String(old.aiApiKey || '').trim();
    if (key) {
      const url = String(old.aiBaseUrl || '').trim();
      const model = String(old.aiModel || '').trim();
      let id = 'openai';
      if (/deepseek\.com/i.test(url)) {
        id = 'deepseek';
        s.cfg.deepseek = { apiKey: key, model: model || 'deepseek-chat' };
      } else {
        s.cfg.openai = { baseUrl: url || 'https://open.bigmodel.cn/api/paas/v4', apiKey: key, model: model || 'glm-4-flash' };
      }
      s.enabled[id] = old.aiEnabled !== false; // 原本就没开 AI 的,迁移后保持关闭
      s.order = [id, ...DEFAULT_SERVICES.order.filter(x => x !== id)];
    }
    this.data.settings.services = s;
  }

  saveSoon() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 300);
    if (typeof this.onChanged === 'function') this.onChanged();
  }

  flush() {
    clearTimeout(this._timer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error('[store] 保存失败:', e.message); }
  }

  get settings() { return this.data.settings; }

  setSettings(patch) {
    Object.assign(this.data.settings, patch || {});
    this.saveSoon();
    return this.settings;
  }

  all() { return [...this.data.words].sort((a, b) => b.createdAt - a.createdAt); }

  /** 用服务器合并后的全量词库覆盖本地(云同步用) */
  replaceAllWords(words) {
    if (!Array.isArray(words)) return;
    this.data.words = words.filter(w => w && w.word).map(w => ({ ...w }));
    this.flush();
  }

  findWord(word) {
    const w = String(word).trim().toLowerCase();
    return this.data.words.find(x => x.word.toLowerCase() === w) || null;
  }

  /** 存词:重复时提升重要度并提前进入复习队列,释义照常补充 */
  addWord(word, extra = {}) {
    word = String(word || '').trim();
    if (!word) return null;
    const patch = {};
    if (extra.translation) patch.translation = extra.translation;
    if (extra.phonetic) patch.phonetic = extra.phonetic;
    if (extra.senses && extra.senses.length) patch.senses = extra.senses;
    if (extra.example) patch.example = extra.example;

    const exist = this.findWord(word);
    if (exist) {
      exist.saveCount = (exist.saveCount || 1) + 1;
      const pullIn = Date.now() + DAY;
      if (exist.dueAt > pullIn) exist.dueAt = pullIn;
      this.updateWord(exist.id, { ...patch, saveCount: exist.saveCount, dueAt: exist.dueAt });
      return { ...exist, ...patch, already: true };
    }
    const item = {
      id: crypto.randomBytes(8).toString('hex'),
      word,
      translation: '', phonetic: '', senses: [], example: '',
      source: extra.source || '',
      createdAt: Date.now(),
      saveCount: 1,
      box: 0,                 // 兼容字段,调度已由 FSRS 接管
      stability: 0, difficulty: 0, reps: 0, lapses: 0, lastReview: null,
      dueAt: Date.now(),
      reviewCount: 0,
      correctCount: 0
    };
    this.data.words.push(item);
    this.updateWord(item.id, patch);
    this.saveSoon();
    return { ...item, ...patch, already: false };
  }

  updateWord(id, patch) {
    const w = this.data.words.find(x => x.id === id);
    if (!w) return null;
    Object.assign(w, patch);
    this.saveSoon();
    return w;
  }

  remove(id) {
    const i = this.data.words.findIndex(x => x.id === id);
    if (i >= 0) { this.data.words.splice(i, 1); this.saveSoon(); }
  }

  resetProgress(id) {
    return this.updateWord(id, {
      box: 0, stability: 0, difficulty: 0, reps: 0, lapses: 0, lastReview: null,
      dueAt: Date.now(), reviewCount: 0, correctCount: 0
    });
  }

  /** 复习作答(FSRS):认识→Good,没记住→Again;box 仅作展示兼容 */
  answer(id, correct) {
    const w = this.data.words.find(x => x.id === id);
    if (!w) return;
    try {
      const { card } = FSRS.next(toCard(w), new Date(), correct ? Rating.Good : Rating.Again);
      w.stability = card.stability;
      w.difficulty = card.difficulty;
      w.reps = card.reps;
      w.lapses = card.lapses;
      w.lastReview = Date.now();
      w.dueAt = card.due.getTime();
    } catch (e) {
      // FSRS 异常时的保底:答对明天见,答错 10 分钟后见
      console.warn('[fsrs] 调度异常,走保底间隔:', e.message);
      w.dueAt = Date.now() + (correct ? DAY : 10 * 60 * 1000);
    }
    w.reviewCount += 1;
    if (correct) w.correctCount += 1;
    w.box = correct ? Math.min((w.box || 0) + 1, INTERVALS.length - 1) : Math.max(0, (w.box || 0) - 1);
    this.saveSoon();
  }

  dueWords(now = Date.now()) {
    return this.data.words.filter(w => w.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt);
  }

  dueCount() { return this.dueWords().length; }

  reviewBatch() {
    const goal = this.settings.dailyGoal || 10;
    // 重要词(重复记录多)优先出队,其余按到期先后
    return this.dueWords()
      .sort((a, b) => (b.saveCount || 1) - (a.saveCount || 1) || a.dueAt - b.dueAt)
      .slice(0, goal)
      .map(w => ({ ...w }));
  }

  stats() {
    const words = this.data.words;
    const due = this.dueWords().length;
    let mastered = 0, learning = 0, reviewsTotal = 0;
    for (const w of words) {
      reviewsTotal += w.reviewCount || 0;
      // FSRS 口径:记忆稳定性 ≥21 天视为已掌握,复习过至少一次视为学习中
      if ((w.stability || 0) >= 21) mastered += 1;
      else if ((w.reps || 0) > 0 || (w.reviewCount || 0) > 0) learning += 1;
    }
    // 未来 7 天每天到期的词数(今天一栏含逾期)
    const upcoming = [];
    const start = new Date(); start.setHours(0, 0, 0, 0);
    for (let d = 0; d < 7; d++) {
      const from = d === 0 ? start.getTime() - 365 * DAY : start.getTime() + d * DAY;
      const to = start.getTime() + (d + 1) * DAY;
      upcoming.push(words.filter(w => w.dueAt < to && w.dueAt >= from).length);
    }
    return {
      total: words.length, due, learning, mastered, reviewsTotal, upcoming,
      important: words.filter(w => (w.saveCount || 1) >= 2).length
    };
  }

  exportData() {
    return JSON.stringify({
      app: 'translate-card', version: 2,
      exportedAt: new Date().toISOString(),
      words: this.data.words
    }, null, 2);
  }

  importData(json) {
    const raw = JSON.parse(json);
    const words = Array.isArray(raw) ? raw : raw.words;
    if (!Array.isArray(words)) throw new Error('文件格式不正确');
    let added = 0;
    for (const w of words) {
      if (!w || !w.word) continue;
      const exist = this.findWord(w.word);
      if (exist) {
        this.updateWord(exist.id, {
          translation: w.translation || exist.translation,
          phonetic: w.phonetic || exist.phonetic,
          senses: w.senses && w.senses.length ? w.senses : exist.senses
        });
      } else {
        this.data.words.push({
          id: crypto.randomBytes(8).toString('hex'),
          word: String(w.word),
          translation: w.translation || '',
          phonetic: w.phonetic || '',
          senses: Array.isArray(w.senses) ? w.senses : [],
          example: w.example || '',
          source: w.source || '',
          createdAt: w.createdAt || Date.now(),
          saveCount: Number(w.saveCount) || 1,
          box: Number(w.box) || 0,
          stability: Number(w.stability) || 0,
          difficulty: Number(w.difficulty) || 0,
          reps: Number(w.reps) || 0,
          lapses: Number(w.lapses) || 0,
          lastReview: Number(w.lastReview) || null,
          dueAt: Number(w.dueAt) || Date.now(),
          reviewCount: Number(w.reviewCount) || 0,
          correctCount: Number(w.correctCount) || 0
        });
        added += 1;
      }
    }
    this.saveSoon();
    return { added, total: this.data.words.length };
  }
}

module.exports = Store;
