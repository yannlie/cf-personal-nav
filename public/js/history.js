// 使用记录：只存在本机 localStorage，用来生成「最近访问 / 最常访问」。
// 键用规范化 URL 而不是站点 id —— id 由服务端生成，导入导出后还会变，URL 才稳定。
export const HISTORY_KEY = 'nav-history';
export const MAX_ENTRIES = 300;
export const RECENT_LIMIT = 10;
export const FREQUENT_LIMIT = 8;
// 只访问过一次的不算「最常访问」，否则和「最近访问」完全重合。
export const FREQUENT_MIN_COUNT = 2;

export function siteKey(url) {
  const raw = String(url == null ? '' : url).trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    // 末尾斜杠归一，避免 https://x.com 与 https://x.com/ 记成两条
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${host}${path}${parsed.search}`.toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

function storageOf(storage) {
  return storage === undefined ? globalThis.localStorage : storage;
}

export function readHistory(storage) {
  const store = storageOf(storage);
  if (!store) return {};
  try {
    const parsed = JSON.parse(store.getItem(HISTORY_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeHistory(map, storage) {
  const store = storageOf(storage);
  if (!store) return;
  try {
    store.setItem(HISTORY_KEY, JSON.stringify(map));
  } catch {
    // 配额写满/隐私模式禁写就放弃：使用记录不是关键数据，不能影响正常使用
  }
}

// 只保留最近使用的前 max 条，避免 localStorage 无限膨胀。
export function prune(map, max = MAX_ENTRIES) {
  const entries = Object.entries(map || {});
  if (entries.length <= max) return map || {};
  return Object.fromEntries(
    entries
      .sort((a, b) => (Number(b[1] && b[1].lastAt) || 0) - (Number(a[1] && a[1].lastAt) || 0))
      .slice(0, max)
  );
}

export function recordVisit(url, now = Date.now(), storage) {
  const key = siteKey(url);
  if (!key) return readHistory(storage);

  const map = readHistory(storage);
  const current = map[key] && typeof map[key] === 'object' ? map[key] : {};
  const previous = Number(current.count);
  map[key] = {
    count: Number.isFinite(previous) && previous > 0 ? previous + 1 : 1,
    lastAt: now,
    url: String(url == null ? '' : url).trim(),
  };

  const next = prune(map);
  writeHistory(next, storage);
  return next;
}

export function recentUrls(storage, limit = RECENT_LIMIT) {
  return Object.values(readHistory(storage))
    .filter((entry) => entry && Number.isFinite(entry.lastAt) && entry.url)
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, limit)
    .map((entry) => entry.url);
}

export function frequentUrls(storage, limit = FREQUENT_LIMIT, minCount = FREQUENT_MIN_COUNT) {
  return Object.values(readHistory(storage))
    .filter((entry) => entry && Number.isFinite(entry.count) && entry.count >= minCount && entry.url)
    .sort((a, b) => b.count - a.count || (b.lastAt || 0) - (a.lastAt || 0))
    .slice(0, limit)
    .map((entry) => entry.url);
}

// 把记录里的 URL 映射回当前站点：已删除或改过地址的条目自动消失。
export function resolveSites(sites, urls) {
  const index = new Map();
  for (const site of Array.isArray(sites) ? sites : []) {
    const key = siteKey(site && site.url);
    if (key) index.set(key, site);
  }

  const seen = new Set();
  const out = [];
  for (const url of Array.isArray(urls) ? urls : []) {
    const key = siteKey(url);
    if (!key || seen.has(key)) continue;
    const site = index.get(key);
    if (!site) continue;
    seen.add(key);
    out.push(site);
  }
  return out;
}

export function clearHistory(storage) {
  const store = storageOf(storage);
  if (!store) return;
  try {
    store.removeItem(HISTORY_KEY);
  } catch {
    // 同上，忽略
  }
}