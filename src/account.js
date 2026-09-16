/**
 * 账号与云同步客户端(运行在主进程):
 * - 登录/注册走同步服务器,令牌落盘实现免重复登录;
 * - syncNow 把本地词库推给服务器合并,并拿回合并后的全量词库覆盖本地。
 */
const fs = require('fs');

class Account {
  constructor(file) {
    this.file = file;
    this.state = { serverUrl: 'http://127.0.0.1:7788', username: null, token: null, lastSyncAt: 0 };
    this._syncing = false;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && raw.serverUrl) this.state = { ...this.state, ...raw };
    } catch (e) { /* 首次运行 */ }
  }

  get loggedIn() { return !!(this.state.token && this.state.username); }

  publicState() {
    return { serverUrl: this.state.serverUrl, username: this.state.username, lastSyncAt: this.state.lastSyncAt, loggedIn: this.loggedIn };
  }

  persist() { try { fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2)); } catch (e) { /* ignore */ } }

  setServer(url) {
    const u = String(url || '').trim();
    if (u) this.state.serverUrl = u.replace(/\/+$/, '');
    this.persist();
  }

  logout() { this.state.token = null; this.state.username = null; this.state.lastSyncAt = 0; this.persist(); }

  async fetchTimeout(url, opts = {}, ms = 8000) {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), ms);
    try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
    finally { clearTimeout(id); }
  }

  async _auth(action, username, password) {
    let r;
    try {
      r = await this.fetchTimeout(this.state.serverUrl + '/api/' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
    } catch (e) {
      throw new Error('无法连接服务器,请确认服务器已启动、地址正确');
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || '请求失败(' + r.status + ')');
    this.state.username = j.username;
    this.state.token = j.token;
    this.persist();
    return { username: j.username };
  }

  register(username, password) { return this._auth('register', username, password); }
  login(username, password) { return this._auth('login', username, password); }

  async syncNow(store) {
    if (!this.loggedIn) throw new Error('尚未登录');
    if (this._syncing) throw new Error('同步正在进行中');
    this._syncing = true;
    try {
      let r;
      try {
        r = await this.fetchTimeout(this.state.serverUrl + '/api/sync', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + this.state.token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ words: store.data.words })
        }, 10000);
      } catch (e) {
        throw new Error('无法连接服务器,请确认服务器已启动');
      }
      if (r.status === 401) { this.logout(); throw new Error('登录已过期,请重新登录'); }
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || '同步失败(' + r.status + ')');
      store.replaceAllWords(j.words || []);
      this.state.lastSyncAt = Date.now();
      this.persist();
      return { total: (j.words || []).length };
    } finally {
      this._syncing = false;
    }
  }
}

module.exports = Account;
