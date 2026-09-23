import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FREQUENT_MIN_COUNT,
  HISTORY_KEY,
  MAX_ENTRIES,
  clearHistory,
  frequentUrls,
  prune,
  readHistory,
  recentUrls,
  recordVisit,
  resolveSites,
  siteKey,
  writeHistory,
} from '../public/js/history.js';

// 最小 localStorage 替身：可控、可断言、可选择在写入时抛错。
function makeStorage(initial) {
  const map = new Map();
  if (initial !== undefined) map.set(HISTORY_KEY, typeof initial === 'string' ? initial : JSON.stringify(initial));
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
    raw() {
      return map.get(HISTORY_KEY);
    },
  };
}

test('siteKey 规范化：忽略大小写与末尾斜杠，保留查询串', () => {
  assert.equal(siteKey('https://GitHub.com'), 'github.com');
  assert.equal(siteKey('https://github.com/'), 'github.com');
  assert.equal(siteKey('https://github.com///'), 'github.com');
  assert.equal(siteKey('https://github.com/a/b?q=1'), 'github.com/a/b?q=1');
  assert.equal(siteKey('  https://GitHub.com/A  '), 'github.com/a');
  // 非法输入退回原始小写，至少不会崩
  assert.equal(siteKey('not a url'), 'not a url');
  assert.equal(siteKey(''), '');
  assert.equal(siteKey(null), '');
});

test('recordVisit 累加次数并刷新时间', () => {
  const store = makeStorage();

  recordVisit('https://github.com', 1000, store);
  assert.deepEqual(readHistory(store)['github.com'], {
    count: 1,
    lastAt: 1000,
    url: 'https://github.com',
  });

  recordVisit('https://github.com', 2000, store);
  assert.equal(readHistory(store)['github.com'].count, 2);
  assert.equal(readHistory(store)['github.com'].lastAt, 2000);

  // 末尾斜杠/大小写不同视为同一个站点
  recordVisit('https://GitHub.com/', 3000, store);
  assert.equal(Object.keys(readHistory(store)).length, 1);
  assert.equal(readHistory(store)['github.com'].count, 3);
});

test('recordVisit 对空 URL 不做任何改动', () => {
  const store = makeStorage();
  recordVisit('', 1000, store);
  recordVisit(null, 2000, store);
  recordVisit(undefined, 3000, store);
  assert.deepEqual(readHistory(store), {});
});

test('recentUrls 按时间倒序并遵守上限', () => {
  const store = makeStorage();
  recordVisit('https://a.com', 1000, store);
  recordVisit('https://b.com', 3000, store);
  recordVisit('https://c.com', 2000, store);

  assert.deepEqual(recentUrls(store), ['https://b.com', 'https://c.com', 'https://a.com']);
  assert.deepEqual(recentUrls(store, 2), ['https://b.com', 'https://c.com']);
});

test('frequentUrls 只收访问两次以上的，按次数排序', () => {
  const store = makeStorage();
  const hit = (url, times) => {
    for (let i = 0; i < times; i += 1) recordVisit(url, 1000 + i, store);
  };
  hit('https://once.com', 1);
  hit('https://twice.com', 2);
  hit('https://often.com', 5);

  const urls = frequentUrls(store);
  assert.deepEqual(urls, ['https://often.com', 'https://twice.com']);
  assert.equal(urls.includes('https://once.com'), false, '只访问过 1 次的不该出现');
  assert.equal(FREQUENT_MIN_COUNT, 2);
});

test('prune 超出上限时保留最近使用的', () => {
  const map = {};
  for (let i = 0; i < 10; i += 1) {
    map[`s${i}.com`] = { count: 1, lastAt: i, url: `https://s${i}.com` };
  }
  const pruned = prune(map, 3);
  assert.deepEqual(Object.keys(pruned).sort(), ['s7.com', 's8.com', 's9.com']);
  // 未超上限时原样返回
  assert.equal(prune(map, 100), map);
});

test('使用记录不会无限增长', () => {
  const store = makeStorage();
  for (let i = 0; i < MAX_ENTRIES + 20; i += 1) {
    recordVisit(`https://s${i}.com`, i + 1, store);
  }
  assert.equal(Object.keys(readHistory(store)).length, MAX_ENTRIES);
  // 最旧的被丢掉，最新的还在
  assert.equal(readHistory(store)[`s0.com`], undefined);
  assert.ok(readHistory(store)[`s${MAX_ENTRIES + 19}.com`]);
});

test('resolveSites 把 URL 映射回站点，丢弃已不存在的记录', () => {
  const sites = [
    { id: '1', name: 'GitHub', url: 'https://github.com' },
    { id: '2', name: '知乎', url: 'https://zhihu.com' },
  ];
  const resolved = resolveSites(sites, [
    'https://zhihu.com',
    'https://deleted.com',
    'https://github.com',
    'https://github.com',
  ]);
  assert.deepEqual(resolved.map((site) => site.name), ['知乎', 'GitHub']);
});

test('resolveSites 容忍末尾斜杠等写法差异', () => {
  const sites = [{ id: '1', name: 'GitHub', url: 'https://github.com' }];
  assert.equal(resolveSites(sites, ['https://GitHub.com/']).length, 1);
  assert.equal(resolveSites(sites, ['https://github.com/some/path']).length, 0, '路径不同视为不同站点');
  assert.deepEqual(resolveSites(sites, []), []);
  assert.deepEqual(resolveSites(null, null), []);
});

test('readHistory 能容忍损坏数据', () => {
  assert.deepEqual(readHistory(makeStorage('不是 JSON')), {});
  assert.deepEqual(readHistory(makeStorage([1, 2, 3])), {});
  assert.deepEqual(readHistory(makeStorage('null')), {});
  assert.deepEqual(readHistory(makeStorage()), {});
  assert.deepEqual(readHistory(null), {});
  assert.deepEqual(readHistory(undefined), {});
});

test('recent/frequent 会跳过结构不完整的记录', () => {
  const store = makeStorage({
    'good.com': { count: 3, lastAt: 500, url: 'https://good.com' },
    'no-time.com': { count: 2, url: 'https://no-time.com' },
    'no-url.com': { count: 2, lastAt: 600 },
    'bad.com': 'oops',
  });
  // recent 需要 lastAt；frequent 只看次数，所以没时间戳的条目仍算「最常访问」
  assert.deepEqual(recentUrls(store), ['https://good.com']);
  assert.deepEqual(frequentUrls(store), ['https://good.com', 'https://no-time.com']);
});

test('writeHistory 在配额写满时静默失败', () => {
  const throwing = {
    getItem: () => null,
    setItem() {
      throw new Error('QuotaExceededError');
    },
    removeItem() {},
  };
  assert.doesNotThrow(() => writeHistory({ a: { count: 1 } }, throwing));
  assert.doesNotThrow(() => recordVisit('https://github.com', 1, throwing));
  assert.doesNotThrow(() => clearHistory(throwing));
});

test('clearHistory 清空记录且不影响其它键', () => {
  const store = makeStorage();
  store.setItem('nav-theme', 'dark');
  recordVisit('https://github.com', 1000, store);
  assert.notEqual(store.raw(), undefined);

  clearHistory(store);
  assert.equal(store.raw(), undefined);
  assert.deepEqual(readHistory(store), {});
  assert.equal(store.getItem('nav-theme'), 'dark');
});