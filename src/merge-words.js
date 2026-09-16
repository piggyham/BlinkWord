/**
 * 词库合并规则(客户端版,WebDAV 同步使用):
 * 与 server/server.js 的 mergeWords 保持一致——按单词小写去重;学习进度取两边
 * 较大值(FSRS 字段取"更熟练"一侧),释义取非空者。两边改动时请同步修改。
 */
function mergeWords(existing, incoming) {
  const map = new Map();
  for (const w of existing || []) if (w && w.word) map.set(w.word.toLowerCase(), { ...w });
  for (const w of incoming || []) {
    if (!w || !w.word) continue;
    const key = w.word.toLowerCase();
    const cur = map.get(key);
    if (!cur) { map.set(key, { ...w }); continue; }
    cur.translation = w.translation || cur.translation || '';
    cur.phonetic = w.phonetic || cur.phonetic || '';
    cur.senses = w.senses && w.senses.length ? w.senses : (cur.senses || []);
    cur.source = cur.source || w.source || '';
    cur.box = Math.max(cur.box || 0, w.box || 0);
    cur.saveCount = Math.max(cur.saveCount || 1, w.saveCount || 1);
    cur.reviewCount = Math.max(cur.reviewCount || 0, w.reviewCount || 0);
    cur.correctCount = Math.max(cur.correctCount || 0, w.correctCount || 0);
    cur.dueAt = Math.max(cur.dueAt || 0, w.dueAt || 0);
    cur.createdAt = Math.min(cur.createdAt || Date.now(), w.createdAt || Date.now());
    // FSRS:稳定性/次数取较大,difficulty 随"更熟练"一侧,上次复习取较新
    const curPro = (cur.stability || 0) + (cur.reps || 0);
    const incPro = (w.stability || 0) + (w.reps || 0);
    const src = incPro > curPro ? w : cur;
    cur.stability = Math.max(cur.stability || 0, w.stability || 0);
    cur.reps = Math.max(cur.reps || 0, w.reps || 0);
    cur.difficulty = src.difficulty != null ? src.difficulty : cur.difficulty;
    cur.lapses = src.lapses != null ? src.lapses : cur.lapses;
    cur.lastReview = Math.max(cur.lastReview || 0, w.lastReview || 0) || null;
  }
  return [...map.values()];
}

module.exports = { mergeWords };
