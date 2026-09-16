/**
 * 坚果云 WebDAV 同步客户端(运行在主进程):
 * - 词库存为网盘上的单个 JSON 文件(translate-card/wordbook.json),先拉取远端、
 *   与本地按单词级字段合并,再把合并结果写回——两端都只会"合入",不会互相覆盖丢数据;
 * - 应用密码用 Electron safeStorage 加密落盘(Windows 下走 DPAPI),可随时在
 *   坚果云网页端撤销;合并规则与自建服务器完全一致(src/merge-words.js)。
 */
const fs = require('fs');
const crypto = require('crypto');
const { mergeWords } = require('./merge-words');

const DEFAULT_SERVER = 'https://dav.jianguoyun.com/dav/';
const FILE_NAME = 'wordbook.json';

/** 纯 Node 环境下(单测)require('electron') 会失败,此时回退明文存储 */
function safeStorageApi() {
  try {
    const api = require('electron').safeStorage;
    return api && api.isEncryptionAvailable() ? api : null;
  } catch (e) { return null; }
}

class WebdavSync {
  constructor(file) {
    this.file = file;
    this.state = { serverUrl: DEFAULT_SERVER, username: '', passwordEnc: null, password: null, remoteDir: 'translate-card/', lastSyncAt: 0 };
    this._syncing = false;
    this._dirOk = false;      // 本次运行内已确认目录存在
    this._pwCache = undefined;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw) this.state = { ...this.state, ...raw };
    } catch (e) { /* 首次运行 */ }
  }

  get password() {
    if (this._pwCache !== undefined) return this._pwCache;
    const s = this.state;
    let pw = '';
    if (s.passwordEnc) {
      const api = safeStorageApi();
      if (api) { try { pw = api.decryptString(Buffer.from(s.passwordEnc, 'base64')) || ''; } catch (e) { pw = ''; } }
    }
    if (!pw && s.password) pw = s.password;
    this._pwCache = pw;
    return pw;
  }

  get configured() { return !!(this.state.username && this.password && this.state.serverUrl); }

  publicState() {
    const s = this.state;
    return { configured: this.configured, serverUrl: s.serverUrl, username: s.username, remoteDir: s.remoteDir, lastSyncAt: s.lastSyncAt };
  }

  persist() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2)); } catch (e) { /* ignore */ }
  }

  _normalizeDir(dir) {
    return String(dir || '').trim().replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/') + '/';
  }

  _filePath() { return this.state.remoteDir + FILE_NAME; }

  saveCfg(cfg = {}) {
    const serverUrl = String(cfg.serverUrl || this.state.serverUrl || DEFAULT_SERVER).trim().replace(/\/+$/, '') + '/';
    const username = String(cfg.username || '').trim();
    const remoteDir = this._normalizeDir(cfg.remoteDir != null ? cfg.remoteDir : this.state.remoteDir);
    if (!/^https?:\/\//i.test(serverUrl)) throw new Error('服务器地址需以 http(s):// 开头');
    if (!username) throw new Error('请填写坚果云账号邮箱');
    const newPassword = String(cfg.password || '');
    const cur = { ...this.state, serverUrl, username, remoteDir };
    if (newPassword) { // 留空 = 保持已保存的密码不变
      const api = safeStorageApi();
      cur.passwordEnc = api ? api.encryptString(newPassword).toString('base64') : null;
      cur.password = api ? null : newPassword;
    } else if (!this.password) {
      throw new Error('请填写应用密码');
    }
    this.state = cur;
    this._pwCache = undefined;
    this._dirOk = false; // 目录可能换了
    this.persist();
  }

  disconnect() {
    this.state = { ...this.state, username: '', passwordEnc: null, password: null, lastSyncAt: 0 };
    this._pwCache = undefined;
    this._dirOk = false;
    this.persist();
  }

  async fetchTimeout(url, opts = {}, ms = 15000) {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), ms);
    try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
    finally { clearTimeout(id); }
  }

  _authHeader(cfg) {
    const user = (cfg && cfg.username) || this.state.username;
    const pass = (cfg && cfg.password) ? String(cfg.password) : this.password;
    return 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
  }

  _url(cfg, p) {
    const base = ((cfg && cfg.serverUrl) || this.state.serverUrl).replace(/\/+$/, '') + '/';
    return base + p;
  }

  /** 测试连通性与凭据:PROPFIND 网盘根目录(Depth 0),401/403 = 密码错,其余按可达处理 */
  async test(cfg) {
    let r;
    try {
      r = await this.fetchTimeout(this._url(cfg, ''), {
        method: 'PROPFIND',
        headers: { Authorization: this._authHeader(cfg), Depth: '0' }
      }, 10000);
    } catch (e) {
      throw new Error('无法连接服务器,请检查网络与地址');
    }
    if (r.status === 401 || r.status === 403) throw new Error('账号或应用密码不正确');
    if (r.status !== 207 && !r.ok) throw new Error('服务器响应异常(HTTP ' + r.status + ')');
    return true;
  }

  async _ensureDir() {
    const segs = this.state.remoteDir.split('/').filter(Boolean);
    let cur = '';
    for (const seg of segs) {
      cur += seg + '/';
      let r;
      try {
        r = await this.fetchTimeout(this._url(null, cur), { method: 'MKCOL', headers: { Authorization: this._authHeader() } });
      } catch (e) { throw new Error('无法连接坚果云服务器,请检查网络'); }
      if (r.status === 401 || r.status === 403) throw new Error('账号或应用密码不正确,请重新保存');
      // 201 已创建 / 405 已存在 都算成功;其他状态(如父目录缺失 409)逐级创建后自然覆盖
      if (r.status !== 201 && r.status !== 405 && !r.ok) throw new Error('创建同步目录失败(HTTP ' + r.status + ')');
    }
    this._dirOk = true;
  }

  /** GET 远端词库文件:200 → {etag, words};404 → 视为空库(首次同步) */
  async _getFile() {
    let r;
    try {
      r = await this.fetchTimeout(this._url(null, this._filePath()), { headers: { Authorization: this._authHeader() } });
    } catch (e) { throw new Error('无法连接坚果云服务器,请检查网络'); }
    if (r.status === 404) return { etag: null, words: [] };
    if (r.status === 401 || r.status === 403) throw new Error('账号或应用密码不正确,请重新保存');
    if (!r.ok) throw new Error('读取云端词库失败(HTTP ' + r.status + ')');
    const etag = r.headers.get('etag');
    const raw = await r.json().catch(() => null);
    const words = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.words) ? raw.words : null);
    if (!words) throw new Error('云端文件不是有效的词库格式(路径被其他数据占用?)');
    return { etag, words };
  }

  async syncNow(store) {
    if (!this.configured) throw new Error('尚未配置坚果云账号');
    if (this._syncing) throw new Error('同步正在进行中');
    this._syncing = true;
    try {
      if (!this._dirOk) await this._ensureDir();
      // 最多两轮:PUT 撞上 If-Match 冲突(读取期间其他设备写过)时,重拉重合并一次,
      // 第二轮不再带 If-Match(此时已把对方的改动合进来,可以落盘)
      let merged = null;
      for (let attempt = 0; ; attempt++) {
        const remote = await this._getFile();
        merged = mergeWords(remote.words, store.data.words);
        store.replaceAllWords(merged);
        if (JSON.stringify(merged) === JSON.stringify(remote.words)) {
          break; // 合并后与远端一致(本地无新增改动),跳过上传,省流量
        }
        const body = JSON.stringify({ app: 'translate-card', version: 2, exportedAt: new Date().toISOString(), words: merged });
        const headers = { Authorization: this._authHeader(), 'Content-Type': 'application/json' };
        if (remote.etag && attempt === 0) headers['If-Match'] = remote.etag;
        let r;
        try {
          r = await this.fetchTimeout(this._url(null, this._filePath()), { method: 'PUT', headers, body });
        } catch (e) { throw new Error('无法连接坚果云服务器,请检查网络'); }
        if (r.status === 401 || r.status === 403) throw new Error('账号或应用密码不正确,请重新保存');
        if (r.status === 412 && attempt === 0) continue;
        if (!r.ok && r.status !== 201 && r.status !== 204) throw new Error('上传词库失败(HTTP ' + r.status + ')');
        break;
      }
      this.state.lastSyncAt = Date.now();
      this.persist();
      return { total: merged.length };
    } finally {
      this._syncing = false;
    }
  }
}

module.exports = WebdavSync;
