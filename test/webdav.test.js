/**
 * WebDAV 同步逻辑自测(纯 Node,不依赖 Electron):
 * 用一个内存 mock WebDAV 服务器模拟坚果云,验证:
 *   1. 首次同步:建目录 + 上传本地词库
 *   2. 双端合并:释义/进度按规则合并,不互相覆盖
 *   3. 无改动时跳过上传(省流量)
 *   4. PUT 撞上 If-Match 冲突(读取期间其他设备写过)→ 重拉重合并后成功
 * 运行:node test/webdav.test.js
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const WebdavSync = require('../src/webdav');

const USER = 'u@example.com', PASS = 'pw123';
const files = new Map();   // 路径 → 内容(目录记 null)
const etags = new Map();   // 路径 → etag
let putCount = 0;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const auth = req.headers.authorization || '';
  if (auth !== 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64')) {
    res.writeHead(401); return res.end();
  }
  if (req.method === 'PROPFIND') { res.writeHead(207); return res.end('<multistatus/>'); }
  if (req.method === 'MKCOL') {
    res.writeHead(files.has(url) ? 405 : 201);
    files.set(url, null);
    return res.end();
  }
  if (req.method === 'GET') {
    if (!files.has(url) || files.get(url) === null) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { etag: etags.get(url) || '"e0"' });
    return res.end(files.get(url));
  }
  if (req.method === 'PUT') {
    const im = req.headers['if-match'];
    const cur = etags.get(url);
    if (im && cur && im !== cur) { res.writeHead(412); return res.end(); } // 并发写冲突
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      files.set(url, body);
      etags.set(url, '"e' + (putCount += 1) + '"');
      res.writeHead(201); res.end();
    });
    return;
  }
  res.writeHead(404); res.end();
});

/** 模拟"另一台设备在别处写入":直接改写远端文件并更新 etag */
function writeRemoteAsOtherDevice(words) {
  const p = '/dav/translate-card/wordbook.json';
  files.set(p, JSON.stringify({ app: 'translate-card', version: 2, exportedAt: new Date().toISOString(), words }));
  etags.set(p, '"e' + (putCount += 1) + '"');
}

function newClient(name) {
  const cfgFile = path.join(os.tmpdir(), 'wdtest-' + name + '.json');
  try { fs.unlinkSync(cfgFile); } catch (e) { /* ignore */ }
  return new WebdavSync(cfgFile);
}

function fakeStore(words) {
  return { data: { words }, replaceAllWords(ws) { this.data.words = ws.map(w => ({ ...w })); } };
}

const w = (word, extra = {}) => ({
  id: word, word, translation: '', phonetic: '', senses: [], example: '', source: '',
  createdAt: 1700000000000, saveCount: 1, box: 0, stability: 0, difficulty: 0,
  reps: 0, lapses: 0, lastReview: null, dueAt: 1700000000000, reviewCount: 0, correctCount: 0,
  ...extra
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/dav/';
  console.log('mock WebDAV:', base);

  const A = newClient('a'), B = newClient('b');
  for (const c of [A, B]) c.saveCfg({ serverUrl: base, username: USER, password: PASS, remoteDir: 'translate-card/' });

  // 1. 首次同步:建目录 + 上传
  const sa = fakeStore([
    w('alpha', { translation: '阿尔法', stability: 3, reps: 1 }),
    w('beta', { translation: '贝塔' })
  ]);
  let r = await A.syncNow(sa);
  assert.strictEqual(r.total, 2);
  assert.ok(files.has('/dav/translate-card/wordbook.json'), '远端文件应已创建');
  assert.strictEqual(putCount, 1);
  console.log('✓ 1 首次同步:目录 + 上传,', r.total, '词');

  // 2. 双端合并:B 有 beta 的更深进度 + 新词 gamma
  const sb = fakeStore([
    w('beta', { translation: '贝塔', stability: 10, reps: 2, dueAt: 1800000000000 }),
    w('gamma', { translation: '伽马' })
  ]);
  r = await B.syncNow(sb);
  assert.strictEqual(r.total, 3);
  const betaB = sb.data.words.find(x => x.word === 'beta');
  assert.strictEqual(betaB.stability, 10, 'B 应拿到自己的更深进度');
  assert.ok(sb.data.words.some(x => x.word === 'alpha'), 'B 应合入 A 的 alpha');
  assert.strictEqual(putCount, 2);
  console.log('✓ 2 双端合并:3 词,beta 进度取较深侧,双方词条都保留');

  // 3. 无改动再同步:跳过上传
  r = await B.syncNow(sb);
  assert.strictEqual(r.total, 3);
  assert.strictEqual(putCount, 2, '无改动不应触发 PUT');
  console.log('✓ 3 无改动同步:跳过上传(省流量)');

  // 4. 冲突重试:A 本地有新词 epsilon(必触发 PUT);挂钩 _getFile,在 A 拿到旧
  //    etag 之后、"另一台设备"抢先写入 delta → A 的 PUT 收到 412 → 重拉重合并后成功
  const sa2 = fakeStore([...sa.data.words, w('epsilon', { translation: '艾普西龙' })]);
  const origGetFile = A._getFile.bind(A);
  let armed = true;
  A._getFile = async function () {
    const r = await origGetFile();
    if (armed) {
      armed = false;
      writeRemoteAsOtherDevice([...r.words, w('delta', { translation: '德尔塔' })]); // 抢先写入
    }
    return r; // A 仍持有读取时的旧 etag
  };
  r = await A.syncNow(sa2);
  const remote = JSON.parse(files.get('/dav/translate-card/wordbook.json'));
  assert.deepStrictEqual(
    remote.words.map(x => x.word).sort(),
    ['alpha', 'beta', 'delta', 'epsilon', 'gamma'],
    '冲突重试后远端应含全部 5 词'
  );
  assert.ok(sa2.data.words.some(x => x.word === 'delta'), 'A 本地也应合入 delta');
  console.log('✓ 4 If-Match 冲突:重拉重合并后成功,5 词全保留');

  // 5. 认证失败路径
  const D = newClient('d');
  D.saveCfg({ serverUrl: base, username: USER, password: 'wrong', remoteDir: 'translate-card/' });
  await assert.rejects(() => D.syncNow(fakeStore([])), /不正确/);
  console.log('✓ 5 错误密码被正确拒绝');

  server.close();
  console.log('\n全部通过 ✔');
})().catch(e => { console.error('✗ 测试失败:', e); server.close(); process.exit(1); });
