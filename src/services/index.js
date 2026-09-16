/**
 * 翻译服务池(pot 式):所有服务模块注册于此,按用户设置的顺序与开关遍历执行,
 * 第一个成功者胜出;缺 key 的服务自动跳过。设置存于 store.settings.services。
 */
const edge = require('./edge');
const mymemory = require('./mymemory');
const deepseek = require('./deepseek');
const openaiCompat = require('./openai-compat');
const deepl = require('./deepl');
const baidu = require('./baidu');
const youdao = require('./youdao');
const libre = require('./libre');

const SERVICES = [edge, mymemory, deepseek, openaiCompat, deepl, baidu, youdao, libre];
const byId = id => SERVICES.find(s => s.id === id);

const DEFAULT_SERVICES = {
  enabled: { edge: true, mymemory: true },
  order: ['edge', 'mymemory', 'deepseek', 'openai', 'deepl', 'baidu', 'youdao', 'libre'],
  cfg: Object.fromEntries(SERVICES.map(s => [s.id, { ...(s.defaultCfg || {}) }]))
};

/** 把用户设置与注册表对齐:过滤失效 id、补齐缺失项,避免设置文件陈旧时报错 */
function normalizeServices(raw) {
  const s = { ...DEFAULT_SERVICES, ...(raw || {}) };
  const validIds = new Set(SERVICES.map(x => x.id));
  const order = (Array.isArray(s.order) ? s.order : []).filter(id => validIds.has(id));
  for (const id of DEFAULT_SERVICES.order) if (!order.includes(id)) order.push(id);
  const enabled = { ...s.enabled };
  for (const id of Object.keys(enabled)) if (!validIds.has(id)) delete enabled[id];
  const cfg = { ...s.cfg };
  for (const svc of SERVICES) {
    cfg[svc.id] = { ...(svc.defaultCfg || {}), ...(cfg[svc.id] || {}) };
  }
  return { enabled, order, cfg };
}

/** 渲染层展示用的服务元信息(不含 key 值) */
function servicesMeta() {
  return SERVICES.map(s => ({
    id: s.id, name: s.name, needsKey: !!s.needsKey, hint: s.hint || '',
    cfgFields: s.cfgFields || []
  }));
}

/** 429/限流类错误后的服务级冷却,期间跳过该服务快速走下一个 */
const cooldownUntil = new Map();

/**
 * 按序执行服务池。
 * @returns {Promise<{result, provider}|null> 第一个成功的服务结果;全部失败返回 null
 */
async function runPool(text, servicesSettings) {
  const s = normalizeServices(servicesSettings);
  for (const id of s.order) {
    if (!s.enabled[id]) continue;
    const svc = byId(id);
    if (!svc) continue;
    if ((cooldownUntil.get(id) || 0) > Date.now()) {
      console.warn('[services]', svc.name, '限流冷却中,跳过');
      continue;
    }
    if (svc.needsKey && typeof svc.ready === 'function' && !svc.ready(s.cfg[id])) {
      console.warn('[services]', svc.name, '已启用但缺少配置,跳过');
      continue;
    }
    try {
      const result = await svc.translate(text, s.cfg[id] || {});
      console.log('[services] 命中:', svc.name);
      return { result, provider: svc.name, id };
    } catch (e) {
      console.warn('[services]', svc.name, '失败:', e.message);
      if (/\b429\b|1302|1305|rate\s?limit/i.test(String(e.message))) {
        cooldownUntil.set(id, Date.now() + 60 * 1000);
      }
    }
  }
  return null;
}

/** 设置页「测试连接」:对指定服务跑一次固定例句翻译 */
async function testService(id, cfg) {
  const svc = byId(id);
  if (!svc) return { ok: false, error: '未知服务' };
  if (svc.needsKey && typeof svc.ready === 'function' && !svc.ready(cfg)) {
    return { ok: false, error: '请先填写 ' + (svc.cfgFields || []).map(f => f.label).join('/') };
  }
  try {
    const r = await svc.translate('hello world', cfg || {});
    return { ok: true, sample: String(r.text).slice(0, 60), provider: svc.name };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

module.exports = { SERVICES, runPool, servicesMeta, normalizeServices, testService, DEFAULT_SERVICES };
