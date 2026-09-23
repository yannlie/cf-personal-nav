// 搜索：查询解析、匹配、排序、高亮、分组。全部是纯函数，便于测试。
import { DOMAIN_ALIASES } from './aliases.js';

export const SEARCH_ENGINES = {
  g: { name: 'Google', url: 'https://www.google.com/search?q=' },
  b: { name: 'Bing', url: 'https://www.bing.com/search?q=' },
  d: { name: '百度', url: 'https://www.baidu.com/s?wd=' },
};

// 支持 `!g 关键词` 这类直通搜索引擎的写法。
export function parseQuery(raw) {
  const text = String(raw == null ? '' : raw).trim();
  const matched = /^!([a-z])\s+(\S.*)$/i.exec(text);
  if (matched) {
    const key = matched[1].toLowerCase();
    if (SEARCH_ENGINES[key]) return { engine: key, term: matched[2].trim() };
  }
  return { engine: null, term: text };
}

export function engineUrl(engine, term) {
  const target = SEARCH_ENGINES[engine] || SEARCH_ENGINES.g;
  return target.url + encodeURIComponent(String(term || ''));
}

export function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

// 标签以逗号分隔存成一个字符串；解析成数组，去掉空白与空项。
export function parseTags(value) {
  return String(value == null ? '' : value)
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function siteFields(site) {
  return [site.name, site.desc, site.category, site.url, site.keywords, site.tags, site.note]
    .filter((value) => typeof value === 'string' && value)
    .map((value) => value.toLowerCase());
}

export function matchesSite(site, term) {
  if (!site) return false;
  const raw = String(term == null ? '' : term).trim();
  if (!raw) return true;

  // `#标签` 精确按标签筛选，避免和普通关键词搜索混淆
  if (raw.startsWith('#')) {
    const wanted = raw.slice(1).trim().toLowerCase();
    if (!wanted) return true;
    return parseTags(site.tags).some((tag) => tag.toLowerCase() === wanted);
  }

  const needle = raw.toLowerCase();
  if (siteFields(site).some((field) => field.includes(needle))) return true;

  // 别名命中：例如 zh → zhihu.com
  const alias = DOMAIN_ALIASES[needle];
  if (!alias) return false;
  const host = hostOf(site.url);
  return host === alias || host.endsWith(`.${alias}`);
}

export function scoreSite(site, needle) {
  if (!matchesSite(site, needle)) return 0;
  const name = String(site.name || '').toLowerCase();
  if (name === needle) return 4;
  if (name.startsWith(needle)) return 3;
  if (name.includes(needle)) return 2;
  return 1;
}

// 按相关度排序，同级保持原有顺序。
export function rankSites(sites, term) {
  const needle = String(term == null ? '' : term).trim().toLowerCase();
  const list = Array.isArray(sites) ? sites : [];
  if (!needle) return list.slice();

  return list
    .map((site, index) => ({ site, index, score: scoreSite(site, needle) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((row) => row.site);
}

// 把文本切成命中/未命中的片段，交给渲染层生成 <mark>。
export function highlight(text, term) {
  const source = String(text == null ? '' : text);
  const needle = String(term == null ? '' : term).trim();
  if (!needle) return [{ text: source, hit: false }];

  const lower = source.toLowerCase();
  const target = needle.toLowerCase();
  const parts = [];
  let cursor = 0;
  let at = lower.indexOf(target);

  while (at !== -1) {
    if (at > cursor) parts.push({ text: source.slice(cursor, at), hit: false });
    parts.push({ text: source.slice(at, at + target.length), hit: true });
    cursor = at + target.length;
    at = lower.indexOf(target, cursor);
  }
  if (cursor < source.length) parts.push({ text: source.slice(cursor), hit: false });

  return parts.length ? parts : [{ text: source, hit: false }];
}

// 按分类分组，分类顺序 = 首次出现顺序；置顶站点在同组内排前面。
export function groupSites(sites) {
  const order = [];
  const map = new Map();

  for (const site of Array.isArray(sites) ? sites : []) {
    const category = site.category || '常用';
    if (!map.has(category)) {
      map.set(category, []);
      order.push(category);
    }
    map.get(category).push(site);
  }

  return order.map((category) => {
    const list = map.get(category).slice();
    list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    return { category, sites: list };
  });
}

export function countSites(groups) {
  return groups.reduce((total, group) => total + group.sites.length, 0);
}
