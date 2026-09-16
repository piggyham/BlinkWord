/**
 * 翻译小卡片 - 同步服务器(零依赖,Node 内置模块即可运行)
 *   node server/server.js        默认端口 7788(PORT 环境变量可改)
 * 接口:
 *   GET  /api/ping                       健康检查
 *   POST /api/register {username,password}
 *   POST /api/login    {username,password}  → {token}
 *   POST /api/sync     {words:[...]}        (Bearer token) → {words: 合并后的全量词库}
 * 数据落盘:server/data/(users.json + words_<用户名>.json)
 * 安全:密码 scrypt 加盐散列;令牌为 HMAC 签名(30 天有效);公网部署请挂 HTTPS 反向代理。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 7788;
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
const TOKEN_DAYS = 30;

fs.mkdirSync(DATA_DIR, { recursive: true });
let users = {};
try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) || {}; } catch (e) { /* 首次运行 */ }
let SECRET;
try { SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (e) {
  SECRET = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, SECRET);
}

const saveUsers = () => fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
const userFile = u => path.join(DATA_DIR, 'words_' + u + '.json');
const loadWords = u => { try { return JSON.parse(fs.readFileSync(userFile(u), 'utf8')) || []; } catch (e) { return []; } };
const saveWords = (u, w) => fs.writeFileSync(userFile(u), JSON.stringify(w));

function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 32).toString('hex'); }

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}

function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i <= 0) return null;
  const body = token.slice(0, i);
  const mac = Buffer.from(token.slice(i + 1));
  const expect = Buffer.from(crypto.createHmac('sha256', SECRET).update(body).digest('base64url'));
  if (mac.length !== expect.length || !crypto.timingSafeEqual(mac, expect)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.exp || Date.now() > payload.exp || !payload.u) return null;
    return payload;
  } catch (e) { return null; }
}

/** 词库合并:按单词小写去重;学习进度取两边较大值(FSRS 字段取"更熟练"一侧),释义取非空者 */
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 2 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];
  try {
    if (req.method === 'GET' && (url === '/api/ping' || url === '/')) {
      return send(res, 200, { ok: true, service: 'translate-card-sync', users: Object.keys(users).length });
    }

    if (req.method === 'POST' && (url === '/api/register' || url === '/api/login')) {
      const body = await readBody(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!/^[a-zA-Z0-9_\-]{2,24}$/.test(username)) return send(res, 400, { ok: false, error: '用户名需为 2-24 位字母/数字/下划线' });
      if (password.length < 6) return send(res, 400, { ok: false, error: '密码至少 6 位' });

      if (url === '/api/register') {
        if (users[username]) return send(res, 409, { ok: false, error: '用户名已被注册' });
        const salt = crypto.randomBytes(16).toString('hex');
        users[username] = { salt, hash: hashPw(password, salt), createdAt: Date.now() };
        saveUsers();
        console.log('[register]', username, '(共', Object.keys(users).length, '个用户)');
      } else {
        const u = users[username];
        const ok = u && crypto.timingSafeEqual(Buffer.from(u.hash), Buffer.from(hashPw(password, u.salt)));
        if (!ok) return send(res, 401, { ok: false, error: '用户名或密码不正确' });
        console.log('[login]', username);
      }
      const token = sign({ u: username, exp: Date.now() + TOKEN_DAYS * 24 * 3600 * 1000 });
      return send(res, 200, { ok: true, username, token });
    }

    if (req.method === 'POST' && url === '/api/sync') {
      const auth = String(req.headers.authorization || '');
      const payload = verifyToken(auth.startsWith('Bearer ') ? auth.slice(7) : '');
      if (!payload || !users[payload.u]) return send(res, 401, { ok: false, error: '未登录或登录已过期' });
      const body = await readBody(req);
      const merged = mergeWords(loadWords(payload.u), body.words);
      saveWords(payload.u, merged);
      return send(res, 200, { ok: true, words: merged });
    }

    return send(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    console.error('[error]', e.message);
    return send(res, 500, { ok: false, error: '服务器内部错误' });
  }
});

server.listen(PORT, () => {
  console.log('翻译小卡片同步服务器已启动: http://127.0.0.1:' + PORT);
  console.log('数据目录:', DATA_DIR, '; 已有用户:', Object.keys(users).length, '个');
});
