// 前端测试：纯函数 + 用最小 DOM 桩真实执行 public/js 下的模块。
// 这里会解析真实的 index.html，因此 index.html 与 JS 之间的 id/class 写错也会被这条测试抓到。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  groupSites,
  highlight,
  matchesSite,
  parseTags,
  parseQuery,
  engineUrl,
  rankSites,
} from '../public/js/search.js';
import {
  dissolveGroup,
  dropIndexInGroup,
  groupEditableSites,
  moveItem,
  moveSiteIntoGroup,
  renameGroup,
} from '../public/js/editor.js';
import { DENSITIES, mergeSettings } from '../public/js/store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

/* ================= 最小 DOM 桩 ================= */

const VOID_TAGS = new Set([
  'meta', 'link', 'br', 'hr', 'img', 'input', 'source', 'area', 'base', 'col',
  'embed', 'track', 'wbr', 'path', 'circle', 'rect', 'polyline', 'use',
]);

class StubElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this._classes = new Set();
    this._listeners = new Map();
    this._text = '';
    this.value = '';
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.id = '';
    this.href = '';
    this.title = '';
    this.type = '';
    this.alt = '';
    this.placeholder = '';
    this.disabled = false;
    this.draggable = false;
    this.checked = false;
    this.files = null;
    this.classList = {
      add: (...names) => names.forEach((name) => this._classes.add(name)),
      remove: (...names) => names.forEach((name) => this._classes.delete(name)),
      contains: (name) => this._classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !this._classes.has(name) : Boolean(force);
        if (on) this._classes.add(name);
        else this._classes.delete(name);
        return on;
      },
    };
  }

  set className(value) {
    this._classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get className() {
    return Array.from(this._classes).join(' ');
  }

  set textContent(value) {
    this._text = String(value);
    if (!this._text) this.children = [];
  }

  get textContent() {
    if (this._text) return this._text;
    return this.children.map((child) => child.textContent).join('');
  }

  get innerHTML() {
    return this.textContent;
  }

  append(...kids) {
    for (const kid of kids) {
      const element = typeof kid === 'string' ? new StubElement('#text') : kid;
      if (element) {
        element.parent = this;
        if (element instanceof StubElement && element.tagName === '#TEXT') element._text = String(kid);
        this.children.push(element);
      }
    }
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'id') this.id = String(value);
    if (name === 'class') this.className = value;
    if (name.startsWith('data-')) this.dataset[name.slice(5)] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const list = this._listeners.get(type) || [];
    this._listeners.set(type, list.filter((item) => item !== handler));
  }

  dispatch(type, event = {}) {
    const payload = {
      target: this,
      currentTarget: this,
      preventDefault() {},
      stopPropagation() {},
      ...event,
    };
    for (const handler of this._listeners.get(type) || []) handler(payload);
  }

  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    // 真实 DOM 里移除后 parentNode 会变 null，这里保持一致；
    // 否则断言失败时 Node 会 inspect 这个含循环引用的大对象图，可能直接爆内存。
    this.parent = null;
  }

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  blur() {
    if (this.ownerDocument && this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = null;
    }
  }

  click() {
    this.dispatch('click');
  }

  scrollIntoView() {}

  getBoundingClientRect() {
    return { top: 0, left: 0, right: 120, bottom: 40, width: 120, height: 40 };
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (matchesSelector(node, selector)) return node;
      node = node.parent;
    }
    return null;
  }

  querySelector(selector) {
    return queryAll(this, selector)[0] || null;
  }

  querySelectorAll(selector) {
    return queryAll(this, selector);
  }
}

function matchesSelector(el, selector) {
  const value = selector.trim();
  if (!value) return false;
  if (value.startsWith('.')) return el.classList.contains(value.slice(1));
  if (value.startsWith('#')) return el.id === value.slice(1);
  const withAttr = /^([a-zA-Z][\w-]*)\[data-([\w-]+)="([^"]*)"\]$/.exec(value);
  if (withAttr) {
    return el.tagName === withAttr[1].toUpperCase() && el.dataset[withAttr[2]] === withAttr[3];
  }
  const attr = /^\[data-([\w-]+)="([^"]*)"\]$/.exec(value);
  if (attr) return el.dataset[attr[1]] === attr[2];
  return el.tagName === value.toUpperCase();
}

function queryAll(rootNode, selector) {
  const selectors = String(selector).split(',').map((item) => item.trim()).filter(Boolean);
  const found = [];
  const walk = (node) => {
    for (const child of node.children) {
      if (selectors.some((sel) => matchesSelector(child, sel))) found.push(child);
      walk(child);
    }
  };
  walk(rootNode);
  return found;
}

// 极简 HTML 解析：只取标签、id/class/data-* 与文本，够用来复现 index.html 的结构。
function parseHtml(html) {
  const fragment = new StubElement('#fragment');
  const stack = [fragment];
  const tagRe = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z0-9]+)((?:\s+[^>]*?)?)\s*(\/?)>/gi;
  let cursor = 0;
  let matched;

  const pushText = (text) => {
    const trimmed = text.replace(/\s+/g, ' ').trim();
    if (!trimmed) return;
    const node = new StubElement('#text');
    node._text = trimmed;
    node.parent = stack[stack.length - 1];
    stack[stack.length - 1].children.push(node);
  };

  while ((matched = tagRe.exec(html)) !== null) {
    pushText(html.slice(cursor, matched.index));
    cursor = tagRe.lastIndex;

    if (matched[1]) {
      const closing = matched[1].toUpperCase();
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].tagName === closing) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    if (!matched[2]) continue;

    const element = new StubElement(matched[2]);
    const attrText = matched[3] || '';
    const attrRe = /([a-zA-Z0-9:_-]+)(?:\s*=\s*"([^"]*)")?/g;
    let attr;
    while ((attr = attrRe.exec(attrText)) !== null) {
      element.setAttribute(attr[1], attr[2] === undefined ? '' : attr[2]);
    }

    element.parent = stack[stack.length - 1];
    stack[stack.length - 1].children.push(element);

    if (!VOID_TAGS.has(element.tagName.toLowerCase()) && !matched[4]) {
      stack.push(element);
    }
  }
  pushText(html.slice(cursor));

  return fragment;
}

function createDom() {
  const documentElement = parseHtml(htmlSource);
  const body = findById(documentElement, 'app-view') ? documentElement : documentElement;

  const doc = {
    documentElement,
    body: findTag(documentElement, 'BODY') || documentElement,
    title: '',
    activeElement: null,
    _listeners: new Map(),
    getElementById: (id) => findById(documentElement, id),
    querySelector: (selector) => queryAll(documentElement, selector)[0] || null,
    querySelectorAll: (selector) => queryAll(documentElement, selector),
    created: [],
    createElement(tag) {
      const element = bindOwner(new StubElement(tag), doc);
      doc.created.push(element);
      return element;
    },
    createElementNS(_ns, tag) {
      const element = bindOwner(new StubElement(tag), doc);
      doc.created.push(element);
      return element;
    },
    createTextNode(text) {
      const node = bindOwner(new StubElement('#text'), doc);
      node._text = String(text);
      return node;
    },
    addEventListener: (type, handler) => {
      if (!doc._listeners.has(type)) doc._listeners.set(type, []);
      doc._listeners.get(type).push(handler);
    },
    removeEventListener: (type, handler) => {
      const list = doc._listeners.get(type) || [];
      doc._listeners.set(type, list.filter((item) => item !== handler));
    },
    dispatch: (type, event = {}) => {
      for (const handler of doc._listeners.get(type) || []) {
        handler({ type, target: doc.body, preventDefault() {}, stopPropagation() {}, ...event });
      }
    },
  };

  // 让所有既有节点也能拿到 focus/activeElement
  const bindAll = (node) => {
    node.ownerDocument = doc;
    node.children.forEach(bindAll);
  };
  bindAll(documentElement);

  return { doc, documentElement };
}

function bindOwner(element, doc) {
  element.ownerDocument = doc;
  return element;
}

function findById(node, id) {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

function findTag(node, tag) {
  if (node.tagName === tag) return node;
  for (const child of node.children) {
    const found = findTag(child, tag);
    if (found) return found;
  }
  return null;
}

async function flush(rounds = 12) {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/* ================= 加载 app.js ================= */

let caseCounter = 0;
let objectUrlSeq = 0;

// 有些全局在 Node 里是只读的 getter，直接赋值会抛错，这里统一兜底。
function defineGlobal(name, value) {
  try {
    globalThis[name] = value;
  } catch {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
}

// history: [[url, count, lastAt], ...] —— 预置使用记录，让首屏渲染就带上自动分组
async function loadApp({ config, sites = [], settings = {}, onPut, onFetch, history } = {}) {
  const { doc } = createDom();
  const calls = { puts: [], fetch: [], clipboard: [], revoked: [], blobs: new Map() };
  let putCount = 0;

  const fetchStub = async (url, init = {}) => {
    calls.fetch.push({ url, init });
    const method = (init && init.method) || 'GET';

    // 允许用例如愿让某个接口失败，验证前端错误分支
    const override = onFetch ? onFetch(url, method) : null;
    if (override) {
      return {
        ok: override.status >= 200 && override.status < 300,
        status: override.status,
        json: async () => override.body,
        headers: { get: () => null, getSetCookie: () => [] },
      };
    }
    let body;

    if (method === 'PUT') {
      putCount += 1;
      const parsed = JSON.parse(init.body);
      calls.puts.push(parsed);
      const nextSettings = { ...(parsed.settings || {}) };
      if (!nextSettings.density) delete nextSettings.density;
      body = {
        ok: true,
        sites: parsed.sites.map((site, index) => ({ ...site, id: site.id || `id-${putCount}-${index}` })),
        settings: nextSettings,
      };
      if (onPut) onPut(parsed);
    } else if (url === '/api/config') {
      body = { publicMode: false, readonly: false, ...config };
    } else if (url === '/api/me') {
      body = { username: 'alice' };
    } else if (url === '/api/sites') {
      body = { sites, settings };
    } else {
      body = { ok: true };
    }

    return {
      ok: true,
      status: 200,
      json: async () => body,
      headers: { get: () => null, getSetCookie: () => [] },
    };
  };

  globalThis.document = doc;
  globalThis.window = {
    matchMedia: () => ({ matches: false }),
    addEventListener: () => {},
    open: (...args) => calls.fetch.push({ url: `open:${args[0]}` }),
    innerWidth: 1280,
    innerHeight: 900,
  };
  // 剪贴板：记录调用，便于断言「复制链接」链路
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async (text) => calls.clipboard.push(text) } },
    configurable: true,
    writable: true,
  });
  globalThis.localStorage = {
    _map: new Map(),
    getItem(key) {
      return this._map.has(key) ? this._map.get(key) : null;
    },
    setItem(key, value) {
      this._map.set(key, String(value));
    },
    removeItem(key) {
      this._map.delete(key);
    },
  };

  if (history) {
    const seeded = {};
    for (const [url, count, lastAt] of history) {
      seeded[url] = { count, lastAt, url };
    }
    globalThis.localStorage.setItem('nav-history', JSON.stringify(seeded));
  }
  globalThis.fetch = fetchStub;

  // 导出用的是 Blob + URL.createObjectURL + a[download]；Node 有 Blob，
  // 但没有 createObjectURL，这里补上并把 blob 存起来供测试读取内容。
  globalThis.URL.createObjectURL = (blob) => {
    objectUrlSeq += 1;
    const url = `blob:stub-${objectUrlSeq}`;
    calls.blobs.set(url, blob);
    return url;
  };
  globalThis.URL.revokeObjectURL = (url) => {
    calls.revoked.push(url);
  };

  // FileReader 在 Node 里不存在，用最小实现按 _text 返回内容。
  defineGlobal('FileReader', class StubFileReader {
    readAsText(file) {
      setImmediate(() => {
        try {
          this.result = file && typeof file._text === 'string' ? file._text : '';
          if (this.onload) this.onload({ target: this });
        } catch (error) {
          if (this.onerror) this.onerror(error);
        }
      });
    }
  });

  caseCounter += 1;
  const appUrl = `${pathToFileURL(path.join(root, 'public', 'js', 'app.js')).href}?case=${caseCounter}`;
  const app = await import(appUrl);
  await flush();

  return { doc, app, calls };
}

const SAMPLE_HTML = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3>开发</H3>
    <DL><p>
        <DT><A HREF="https://github.com" ICON="">GitHub</A>
        <DT><A HREF="https://stackoverflow.com">Stack Overflow</A>
    </DL><p>
    <DT><H3>常用</H3>
    <DL><p>
        <DT><A HREF="https://zhihu.com">知乎</A>
        <DT><A HREF="javascript:alert(1)">坏链接</A>
    </DL><p>
</DL><p>`;

/* ================= 纯函数 ================= */

test('parseQuery 支持 !g 直通搜索引擎', () => {
  assert.deepEqual(parseQuery('!g hello world'), { engine: 'g', term: 'hello world' });
  assert.deepEqual(parseQuery('!d 天气'), { engine: 'd', term: '天气' });
  assert.deepEqual(parseQuery('!z 无效'), { engine: null, term: '!z 无效' });
  assert.deepEqual(parseQuery('  github  '), { engine: null, term: 'github' });
  assert.deepEqual(parseQuery(''), { engine: null, term: '' });
});

test('engineUrl 会正确编码中文关键词', () => {
  assert.equal(engineUrl('d', '天气'), 'https://www.baidu.com/s?wd=%E5%A4%A9%E6%B0%94');
});

test('matchesSite 支持名称、描述、分类、别名与拼音简称', () => {
  const github = { name: 'GitHub', url: 'https://github.com', desc: '代码托管', category: '开发' };
  const zhihu = { name: '知乎', url: 'https://www.zhihu.com', category: '常用' };

  assert.equal(matchesSite(github, 'git'), true);
  assert.equal(matchesSite(github, 'gh'), true, '别名 gh 应命中 github');
  assert.equal(matchesSite(github, '开发'), true);
  assert.equal(matchesSite(zhihu, 'zh'), true, '拼音简称 zh 应命中知乎');
  assert.equal(matchesSite(zhihu, 'github'), false);
  assert.equal(matchesSite(github, ''), true, '空关键词应全部命中');
});

test('matchesSite 支持站点自定义 keywords', () => {
  const site = { name: '某站', url: 'https://example.com', keywords: 'k8s,运维' };
  assert.equal(matchesSite(site, 'k8s'), true);
  assert.equal(matchesSite(site, '运维'), true);
  assert.equal(matchesSite(site, 'docker'), false);
});

test('rankSites 把名称命中的排在前面', () => {
  const sites = [
    { name: '别人的 GitHub 镜像', url: 'https://a.com' },
    { name: 'GitHub', url: 'https://github.com' },
    { name: '无关站点', url: 'https://c.com' },
  ];
  const ranked = rankSites(sites, 'github');
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].name, 'GitHub');
});

test('highlight 切出命中片段', () => {
  assert.deepEqual(highlight('GitHub', 'git'), [
    { text: 'Git', hit: true },
    { text: 'Hub', hit: false },
  ]);
  assert.deepEqual(highlight('abc', ''), [{ text: 'abc', hit: false }]);
  assert.deepEqual(highlight('aaa', 'a'), [
    { text: 'a', hit: true },
    { text: 'a', hit: true },
    { text: 'a', hit: true },
  ]);
});

test('groupSites 按首次出现分组，置顶排在同组前面', () => {
  const sites = [
    { name: 'A', url: 'https://a.com', category: '开发' },
    { name: 'B', url: 'https://b.com', category: '常用' },
    { name: 'C', url: 'https://c.com', category: '开发', pinned: true },
    { name: 'D', url: 'https://d.com' },
  ];
  const groups = groupSites(sites);
  assert.deepEqual(groups.map((group) => group.category), ['开发', '常用']);

  const dev = groups.find((group) => group.category === '开发');
  assert.deepEqual(dev.sites.map((site) => site.name), ['C', 'A'], '置顶的 C 应排在 A 前面');
  assert.equal(groups.length, 2, '无分类的站点归入常用');
});

test('mergeSettings 只接受已知密度，其余回退默认', () => {
  assert.equal(mergeSettings({ density: 'comfortable' }).density, 'comfortable');
  assert.equal(mergeSettings({ density: 'weird' }).density, 'compact');
  assert.equal(mergeSettings({}).density, 'compact');
  assert.deepEqual(DENSITIES, ['compact', 'comfortable']);
});

/* ================= 编辑器纯函数 ================= */

test('moveItem 前后移动都正确', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
  assert.deepEqual(moveItem(['a', 'b'], 5, 0), ['a', 'b'], '越界起点不应改动数据');
});

test('moveSiteIntoGroup 会同时改分组与位置', () => {
  const sites = [
    { name: 'A', category: '开发' },
    { name: 'B', category: '常用' },
    { name: 'C', category: '常用' },
  ];
  const moved = moveSiteIntoGroup(sites, 0, '常用', 1);
  assert.deepEqual(moved.map((site) => site.name), ['B', 'A', 'C']);
  assert.equal(moved[1].category, '常用');
});

test('moveSiteIntoGroup 落到空分组时追加到末尾', () => {
  const sites = [{ name: 'A', category: '开发' }, { name: 'B', category: '开发' }];
  const moved = moveSiteIntoGroup(sites, 1, '新组', 0);
  assert.equal(moved.length, 2);
  assert.equal(moved[1].name, 'B');
  assert.equal(moved[1].category, '新组');
});

test('renameGroup 改名作用到整组，空名字回退常用', () => {
  const sites = [
    { name: 'A', category: '开发' },
    { name: 'B', category: '常用' },
  ];
  assert.deepEqual(renameGroup(sites, '开发', '编程').map((s) => s.category), ['编程', '常用']);
  assert.deepEqual(renameGroup(sites, '开发', '   ').map((s) => s.category), ['常用', '常用']);
});

test('dissolveGroup 把站点移回常用而不丢数据', () => {
  const sites = [
    { name: 'A', category: '开发' },
    { name: 'B', category: '开发' },
    { name: 'C', category: '常用' },
  ];
  const next = dissolveGroup(sites, '开发');
  assert.equal(next.length, 3);
  assert.deepEqual(next.map((site) => site.category), ['常用', '常用', '常用']);
});

test('groupEditableSites 保留原始下标，便于按 id 定位', () => {
  const sites = [
    { name: 'A', category: '开发' },
    { name: 'B', category: '常用' },
    { name: 'C', category: '开发' },
  ];
  const groups = groupEditableSites(sites);
  assert.deepEqual(groups.map((g) => g.category), ['开发', '常用']);
  assert.deepEqual(groups[0].rows.map((row) => row.index), [0, 2]);
});

/* ================= DOM 集成 ================= */

test('index.html 里存在 JS 需要的全部 id', () => {
  const required = [
    'nav-brand-text', 'user-name', 'theme-btn', 'density-btn', 'data-btn', 'edit-btn', 'logout-btn',
    'auth-view', 'auth-form', 'username', 'password', 'key-label', 'register-key', 'auth-submit', 'auth-error',
    'app-view', 'hero-title', 'hero-subtitle', 'search', 'search-hint', 'groups', 'onboarding',
    'editor-view', 'settings-title', 'settings-subtitle', 'add-btn', 'cancel-btn', 'save-btn',
    'editor-groups', 'editor-empty', 'footer', 'footer-text',
    'toast', 'context-menu', 'file-input',
  ];
  const { documentElement } = createDom();
  const missing = required.filter((id) => !findById(documentElement, id));
  assert.deepEqual(missing, [], `index.html 缺少这些 id：${missing.join(', ')}`);
});

test('index.html 是干净的 HTML，并以模块方式加载 /js/app.js', () => {
  // 曾经出现过整个文件每行行首多一个 "+" 的事故：那会让 DOCTYPE 失效、
  // 模块脚本变成文本节点，整站直接打不开。
  assert.ok(htmlSource.startsWith('<!doctype html>'), '必须以 DOCTYPE 开头');
  assert.equal(htmlSource.split('\n').some((line) => line.startsWith('+')), false, '不应有行首加号');
  assert.match(htmlSource, /^\s*<script type="module" src="\/js\/app\.js"><\/script>$/m, '模块入口必须独占一行');
  assert.equal(htmlSource.includes('src="/app.js"'), false, '不应再引用旧的 /app.js');
});

test('没有图标的站点会去请求同源图标代理', async () => {
  const { doc } = await loadApp({
    sites: [{ id: '1', name: 'GitHub', url: 'https://github.com', category: '开发' }],
  });

  const images = queryAll(doc.documentElement, 'img');
  assert.equal(images.length, 1);
  assert.equal(images[0].src, '/api/icon?domain=github.com');
});

test('带短图标的站点直接显示字符，不去请求代理', async () => {
  const { doc } = await loadApp({
    sites: [{ id: '1', name: 'GitHub', url: 'https://github.com', category: '开发', icon: '📦' }],
  });

  assert.equal(queryAll(doc.documentElement, 'img').length, 0);
  assert.match(queryAll(doc.documentElement, '.card')[0].textContent, /📦/);
});

test('登录态下渲染分组卡片并应用密度', async () => {
  const sites = [
    { id: '1', name: 'GitHub', url: 'https://github.com', desc: '代码托管', category: '开发' },
    { id: '2', name: '知乎', url: 'https://zhihu.com', desc: '问答', category: '常用' },
    { id: '3', name: 'MDN', url: 'https://developer.mozilla.org', desc: '文档', category: '开发' },
  ];
  const { doc } = await loadApp({ sites });

  assert.equal(doc.body.dataset.density, 'compact', '默认应是紧凑密度');
  assert.equal(doc.getElementById('app-view').classList.contains('hidden'), false);

  const sections = doc.getElementById('groups').children;
  assert.equal(sections.length, 2, '应渲染两个分组');

  const cards = queryAll(doc.documentElement, '.card');
  assert.equal(cards.length, 3);
  assert.deepEqual(cards.map((card) => card.dataset.name), ['GitHub', 'MDN', '知乎']);

  const titles = queryAll(doc.documentElement, '.section-title');
  assert.equal(titles.length, 2);
  assert.match(titles[0].textContent, /开发2 个站点/, '开发组有 GitHub 与 MDN 两个站点');
  assert.match(titles[1].textContent, /常用1 个站点/);
});

test('只读模式下隐藏编辑入口', async () => {
  const { doc } = await loadApp({
    config: { readonly: true, publicMode: true },
    sites: [{ id: '1', name: 'GitHub', url: 'https://github.com', category: '开发' }],
  });

  assert.equal(doc.getElementById('edit-btn').classList.contains('hidden'), true);
  assert.equal(doc.getElementById('density-btn').classList.contains('hidden'), false);
  assert.equal(doc.getElementById('data-btn').classList.contains('hidden'), false);
});

test('空站点时显示引导，而不是干巴巴的空提示', async () => {
  const { doc } = await loadApp({ sites: [] });
  const onboarding = doc.getElementById('onboarding');
  assert.equal(onboarding.classList.contains('hidden'), false);
  assert.match(onboarding.textContent, /还没有站点/);
  assert.match(onboarding.textContent, /导入常用站点包/);
});

test('搜索输入会过滤卡片并高亮命中', async () => {
  const sites = [
    { id: '1', name: 'GitHub', url: 'https://github.com', category: '开发' },
    { id: '2', name: '知乎', url: 'https://zhihu.com', category: '常用' },
  ];
  const { doc } = await loadApp({ sites });
  assert.equal(queryAll(doc.documentElement, '.card').length, 2);

  const search = doc.getElementById('search');
  search.value = 'zh';
  search.dispatch('input', { target: search });

  const cards = queryAll(doc.documentElement, '.card');
  assert.equal(cards.length, 1, '别名 zh 应只剩知乎');
  assert.equal(cards[0].dataset.name, '知乎');
  assert.equal(queryAll(doc.documentElement, 'mark').length, 1, '命中的「知」应被高亮');
});

test('搜索无结果时提供搜索引擎出口', async () => {
  const { doc } = await loadApp({
    sites: [{ id: '1', name: 'GitHub', url: 'https://github.com', category: '开发' }],
  });

  const search = doc.getElementById('search');
  search.value = '不存在的站点';
  search.dispatch('input', { target: search });

  // 无匹配的结果块渲染在 #groups 里，引导块只用于「一个站点都没有」的情况
  assert.match(doc.getElementById('groups').textContent, /没有匹配的站点/);
  assert.equal(doc.getElementById('search-hint').classList.contains('hidden'), false);
});

test('斜杠键会聚焦搜索框', async () => {
  const { doc } = await loadApp({ sites: [] });
  const search = doc.getElementById('search');

  doc.dispatch('keydown', { key: '/', target: doc.body });
  assert.ok(doc.activeElement === search, '斜杠键应把焦点移到搜索框');

  doc.dispatch('keydown', { key: '/', target: search });
  assert.equal(doc.activeElement, search, '在输入框里按斜杠不应报错');
});

test('分组标题点击后可以折叠并写入本地存储', async () => {
  const { doc } = await loadApp({
    sites: [{ id: '1', name: 'GitHub', url: 'https://github.com', category: '开发' }],
  });

  const title = queryAll(doc.documentElement, '.section-title')[0];
  title.dispatch('click');

  const section = doc.getElementById('groups').children[0];
  assert.equal(section.classList.contains('is-collapsed'), true);
  assert.match(globalThis.localStorage.getItem('nav-collapsed-groups'), /开发/);
});

test('导入书签 HTML 后会保存合并后的站点', async () => {
  const { app, calls } = await loadApp({
    sites: [{ id: '1', name: '已有站点', url: 'https://existing.com', category: '常用' }],
  });

  await app.importFromText(SAMPLE_HTML, 'bookmarks.html');
  await flush();

  assert.equal(calls.puts.length, 1, '应发起一次保存');
  const saved = calls.puts[0].sites;
  const names = saved.map((site) => site.name);
  assert.ok(names.includes('已有站点'));
  assert.ok(names.includes('GitHub'));
  assert.ok(names.includes('知乎'));
  assert.equal(names.includes('坏链接'), false, 'javascript: 链接不应被导入');

  const github = saved.find((site) => site.name === 'GitHub');
  assert.equal(github.category, '开发');
});

test('导入时按 URL 去重，不重复添加已有站点', async () => {
  const { app, calls } = await loadApp({
    sites: [{ id: '1', name: 'GitHub', url: 'https://github.com', category: '常用' }],
  });

  await app.importFromText(SAMPLE_HTML, 'bookmarks.html');
  await flush();

  const saved = calls.puts[0].sites;
  assert.equal(saved.filter((site) => site.url === 'https://github.com').length, 1);
});

test('导入 JSON 时保留 pinned 与 keywords', async () => {
  const { app, calls } = await loadApp({ sites: [] });
  const json = JSON.stringify({
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: { title: '我的工具箱' },
    sites: [{ name: 'K8s 面板', url: 'https://k8s.example.com', category: '运维', pinned: true, keywords: 'k8s' }],
  });

  await app.importFromText(json, 'nav.json');
  await flush();

  const saved = calls.puts[0].sites;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].pinned, true);
  assert.equal(saved[0].keywords, 'k8s');
  assert.equal(calls.puts[0].settings.title, '我的工具箱');
});

test('切换密度会写入状态并持久化', async () => {
  const { doc, calls } = await loadApp({
    sites: [{ id: '1', name: 'GitHub', url: 'https://github.com', category: '开发' }],
  });

  doc.getElementById('density-btn').dispatch('click');
  await flush();

  assert.equal(doc.body.dataset.density, 'comfortable');
  assert.equal(calls.puts.length, 1);
  assert.equal(calls.puts[0].settings.density, 'comfortable');
});

test('只读模式不会因为切换密度而发起写入', async () => {
  const { doc, calls } = await loadApp({
    config: { readonly: true, publicMode: true },
    sites: [{ id: '1', name: 'GitHub', url: 'https://github.com', category: '开发' }],
  });

  doc.getElementById('density-btn').dispatch('click');
  await flush();

  assert.equal(doc.body.dataset.density, 'comfortable');
  assert.equal(calls.puts.length, 0, '只读模式不应发起 PUT');
});

test('打开编辑器会按分组渲染可拖拽的行', async () => {
  const { doc } = await loadApp({
    sites: [
      { id: '1', name: 'GitHub', url: 'https://github.com', category: '开发' },
      { id: '2', name: '知乎', url: 'https://zhihu.com', category: '常用' },
    ],
  });

  doc.getElementById('edit-btn').dispatch('click');

  assert.equal(doc.getElementById('app-view').classList.contains('hidden'), true);
  assert.equal(doc.getElementById('editor-view').classList.contains('hidden'), false);

  const groups = doc.getElementById('editor-groups').children;
  assert.equal(groups.length, 2);

  const rows = queryAll(doc.documentElement, '.edit-row');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].dataset.index, '0');
  assert.ok(rows[0].querySelector('.drag-handle'), '每行都应有拖拽手柄');
  assert.ok(rows[0].querySelector('input[data-field="keywords"]'), '每行都应有别名字段');

  const groupNames = queryAll(doc.documentElement, '.group-name');
  assert.deepEqual(groupNames.map((input) => input.value), ['开发', '常用']);
});

test('编辑器里保存会带上 settings 与站点', async () => {
  const { doc, calls } = await loadApp({
    sites: [{ id: '1', name: 'GitHub', url: 'https://github.com', category: '开发' }],
    settings: { title: '我的工具箱', subtitle: '常用入口', density: 'compact' },
  });

  doc.getElementById('edit-btn').dispatch('click');
  assert.equal(doc.getElementById('settings-title').value, '我的工具箱');


  // 上一行已经打开编辑器，这里直接保存
  doc.getElementById('save-btn').dispatch('click');
  await flush();

  assert.equal(calls.puts.length, 1);
  assert.equal(calls.puts[0].settings.title, '我的工具箱');
  assert.equal(calls.puts[0].sites.length, 1);
  assert.equal(calls.puts[0].sites[0].url, 'https://github.com');
});

test('导入超过上限时会截断并提示', async () => {
  const rows = Array.from({ length: 520 }, (_, i) => `    <DT><A HREF="https://site-${i}.example.com">站点 ${i}</A>`);
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
    <DT><H3>批量</H3>
    <DL><p>
${rows.join('\n')}
    </DL><p>
</DL><p>`;

  const { app, calls, doc } = await loadApp({ sites: [] });
  await app.importFromText(html, 'big.html');
  await flush();

  assert.equal(calls.puts.length, 1);
  assert.equal(calls.puts[0].sites.length, 500, '应截断到服务端上限 500');
  assert.match(doc.getElementById('toast').textContent, /上限/);
});

test('dropIndexInGroup 按下标移除后再定位，避免向下拖错位一格', () => {
  const rows = [{ index: 0 }, { index: 1 }, { index: 2 }];
  // 把 0 拖到 1 的下半区：应落在移除 0 之后的第 1 位（结果 [1, 0, 2]）
  assert.equal(dropIndexInGroup(rows, 0, 1, true), 1);
  // 拖到 1 的上半区
  assert.equal(dropIndexInGroup(rows, 0, 1, false), 0);
  // 把 2 拖到 0 的上半区
  assert.equal(dropIndexInGroup(rows, 2, 0, false), 0);
  // 目标不在同组（跨组拖）时等价于组内原始下标
  assert.equal(dropIndexInGroup([{ index: 1 }, { index: 2 }], 0, 2, true), 2);
});

test('编辑过程中切换密度不会丢掉未保存的改动', async () => {
  const { doc, calls } = await loadApp({
    sites: [{ id: '1', name: 'GitHub', url: 'https://github.com', category: '开发' }],
  });

  doc.getElementById('edit-btn').dispatch('click');
  const nameInput = queryAll(doc.documentElement, 'input[data-field="name"]')[0];
  nameInput.value = '改过的名字';
  nameInput.dispatch('input', { target: nameInput });

  doc.getElementById('density-btn').dispatch('click');
  await flush();

  assert.equal(doc.body.dataset.density, 'comfortable');
  assert.equal(calls.puts.length, 0, '编辑中切换密度不应写服务器');

  doc.getElementById('save-btn').dispatch('click');
  await flush();

  assert.equal(calls.puts.length, 1);
  assert.equal(calls.puts[0].sites[0].name, '改过的名字', '未保存的改动必须活下来');
});

test('折叠的分组不参与键盘导航', async () => {
  const { doc } = await loadApp({
    sites: [
      { id: '1', name: 'GitHub', url: 'https://github.com', category: '开发' },
      { id: '2', name: '知乎', url: 'https://zhihu.com', category: '常用' },
    ],
  });

  const search = doc.getElementById('search');
  // 折叠第一个分组
  queryAll(doc.documentElement, '.section-title')[0].dispatch('click');

  search.dispatch('keydown', { key: 'ArrowDown', target: search });
  search.dispatch('keydown', { key: 'ArrowDown', target: search });

  const marked = queryAll(doc.documentElement, '.card').filter((item) => item.classList.contains('is-active'));
  assert.equal(marked.length, 1, '一次只应有一张卡处于选中态');
  assert.equal(marked[0].dataset.name, '知乎', '折叠组里的 GitHub 不应被选中');
});

test('导入时超长的 ICON 会被丢弃，短图标保留', async () => {
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
    <DT><H3>常用</H3>
    <DL><p>
        <DT><A HREF="https://a.example.com" ICON="https://a.example.com/favicon.ico">长图标</A>
        <DT><A HREF="https://b.example.com" ICON="📦">短图标</A>
    </DL><p>
</DL><p>`;

  const { app, calls } = await loadApp({ sites: [] });
  await app.importFromText(html, 'x.html');
  await flush();

  const saved = calls.puts[0].sites;
  const longOne = saved.find((site) => site.name === '长图标');
  const shortOne = saved.find((site) => site.name === '短图标');
  assert.equal(longOne.icon, '', 'favicon URL 型 icon 应被丢弃，交给图标代理');
  assert.equal(shortOne.icon, '📦');
});

/* ================= 浏览器 API 链路（导出 / 选文件 / 剪贴板） ================= */

function pickMenuAction(doc, index) {
  doc.getElementById('data-btn').dispatch('click');
  const menu = doc.getElementById('context-menu');
  assert.equal(menu.classList.contains('hidden'), false, '数据菜单应展开');
  menu.children[index].dispatch('click');
}

function lastDownload(doc) {
  return doc.created.filter((el) => el.tagName === 'A' && el.download).pop() || null;
}

test('导出 JSON 会走通 Blob + 下载链路，内容可被解析回导入', async () => {
  const sites = [
    { id: '1', name: 'GitHub', url: 'https://github.com', category: '开发', keywords: 'gh', pinned: true },
  ];
  const { doc, calls } = await loadApp({ sites, settings: { title: '我的工具箱', density: 'compact' } });

  pickMenuAction(doc, 0);
  await flush();

  const anchor = lastDownload(doc);
  assert.ok(anchor, '应该创建一个带 download 属性的 <a>');
  assert.match(anchor.download, /^nav-\d{4}-\d{2}-\d{2}\.json$/, '文件名应带日期');
  assert.match(anchor.href, /^blob:stub-/, '应该用 createObjectURL 生成的地址');
  // 用布尔比较而不是 assert.equal(anchor.parent, null)：
  // 后者一旦失败会去 inspect 整个含循环引用的 DOM 桩，输出会指数膨胀。
  assert.ok(anchor.parent === null, '触发下载后应把临时节点移除');
  assert.match(doc.getElementById('toast').textContent, /已导出 JSON/);

  const blob = calls.blobs.get(anchor.href);
  assert.ok(blob, 'blob 应被 createObjectURL 登记');
  const parsed = JSON.parse(await blob.text());
  assert.equal(parsed.sites.length, 1);
  assert.equal(parsed.sites[0].name, 'GitHub');
  assert.equal(parsed.sites[0].keywords, 'gh');
  assert.equal(parsed.settings.title, '我的工具箱');
});

test('导出书签 HTML 会生成 Netscape 格式文件', async () => {
  const { doc, calls } = await loadApp({
    sites: [{ id: '1', name: 'GitHub', url: 'https://github.com', category: '开发' }],
  });

  pickMenuAction(doc, 1);
  await flush();

  const anchor = lastDownload(doc);
  assert.ok(anchor);
  assert.match(anchor.download, /^nav-bookmarks-\d{4}-\d{2}-\d{2}\.html$/);

  const text = await calls.blobs.get(anchor.href).text();
  assert.match(text, /<!DOCTYPE NETSCAPE-Bookmark-file-1>/);
  assert.match(text, /HREF="https:\/\/github\.com"/);
  assert.match(text, /<H3>开发<\/H3>/);
});

test('通过引导按钮选文件导入书签（覆盖 pickFile + FileReader 链路）', async () => {
  const { doc, calls } = await loadApp({ sites: [] });

  const row = queryAll(doc.documentElement, '.empty-actions')[0];
  assert.ok(row, '空状态应渲染引导按钮');
  const importButton = row.children.find((button) => /浏览器书签/.test(button.textContent));
  assert.ok(importButton, '应该有「导入浏览器书签」按钮');

  importButton.dispatch('click');
  await flush();

  const input = doc.getElementById('file-input');
  assert.equal(input.accept, '.html,.htm,.json', '应限制可选文件类型');

  input.files = [{ name: 'bookmarks.html', _text: SAMPLE_HTML }];
  input.dispatch('change', { target: input });
  await flush();

  assert.equal(calls.puts.length, 1, '应保存一次');
  const names = calls.puts[0].sites.map((site) => site.name);
  assert.ok(names.includes('GitHub'));
  assert.ok(names.includes('知乎'));
  assert.equal(names.includes('坏链接'), false);
});

test('选文件后取消不会导入，也不会导致下一次重复导入', async () => {
  const { doc, calls } = await loadApp({ sites: [] });

  const row = queryAll(doc.documentElement, '.empty-actions')[0];
  const importButton = row.children.find((button) => /浏览器书签/.test(button.textContent));
  const input = doc.getElementById('file-input');

  // 第一次：用户点开选择框后取消
  importButton.dispatch('click');
  await flush();
  input.dispatch('cancel', { target: input });
  await flush();
  assert.equal(calls.puts.length, 0, '取消不应触发导入');

  // 第二次：真正选一个文件，只应导入一次（旧实现会残留监听，导入两遍）
  importButton.dispatch('click');
  await flush();
  input.files = [{ name: 'bookmarks.html', _text: SAMPLE_HTML }];
  input.dispatch('change', { target: input });
  await flush();

  assert.equal(calls.puts.length, 1, '一次选择只应产生一次导入');
});

test('右键卡片可以复制链接', async () => {
  const { doc, calls } = await loadApp({
    sites: [{ id: '1', name: 'GitHub', url: 'https://github.com', category: '开发' }],
  });

  const card = queryAll(doc.documentElement, '.card')[0];
  card.dispatch('contextmenu', { clientX: 10, clientY: 10 });

  const menu = doc.getElementById('context-menu');
  assert.equal(menu.classList.contains('hidden'), false, '右键应弹出菜单');
  const copyItem = menu.children.find((item) => /复制链接/.test(item.textContent));
  assert.ok(copyItem, '菜单里应有「复制链接」');

  copyItem.dispatch('click');
  await flush();

  assert.deepEqual(calls.clipboard, ['https://github.com']);
  assert.match(doc.getElementById('toast').textContent, /已复制链接/);
  assert.equal(menu.classList.contains('hidden'), true, '选中后菜单应关闭');
});

/* ================= 账号自救（UI 链路） ================= */

function openAccountMenu(doc) {
  doc.getElementById('user-name').dispatch('click');
  return doc.getElementById('context-menu');
}

test('点用户名会弹出账号菜单', async () => {
  const { doc } = await loadApp({
    sites: [{ id: '1', name: 'GitHub', url: 'https://github.com', category: '开发' }],
  });

  const menu = openAccountMenu(doc);
  assert.equal(menu.classList.contains('hidden'), false);
  const labels = menu.children.map((item) => item.textContent);
  assert.deepEqual(labels, ['修改密码…', '登出全部设备…']);
});

test('公开模式下不提供账号操作', async () => {
  const { doc } = await loadApp({
    config: { publicMode: true, readonly: true },
    sites: [],
  });

  // 公开模式用户名是隐藏的，即使触发也不应给出账号菜单
  assert.equal(doc.getElementById('user-name').classList.contains('hidden'), true);
  const menu = openAccountMenu(doc);
  assert.equal(menu.classList.contains('hidden'), true, '不应弹出菜单');
});

test('修改密码：两次新密码不一致时拦在本地，不发请求', async () => {
  const { doc, calls } = await loadApp({
    sites: [{ id: '1', name: 'GitHub', url: 'https://github.com', category: '开发' }],
  });

  const menu = openAccountMenu(doc);
  menu.children[0].dispatch('click');
  await flush();

  const modal = doc.body.children.find((el) => el.classList.contains('modal-overlay'));
  assert.ok(modal, '应弹出修改密码弹窗');

  const inputs = queryAll(modal, 'input');
  assert.equal(inputs.length, 3, '当前密码 / 新密码 / 确认新密码');
  assert.equal(queryAll(modal, 'input')[1].type, 'password');
  assert.ok(modal.querySelector('h2').textContent.includes('修改密码'));

  inputs[0].value = 'password123';
  inputs[1].value = 'newpassword456';
  inputs[2].value = 'different-value';

  const submit = queryAll(modal, 'button').find((button) => /修改密码/.test(button.textContent));
  submit.dispatch('click');
  await flush();

  assert.equal(calls.fetch.filter((call) => call.url === '/api/password').length, 0, '不应发请求');
  assert.match(queryAll(modal, '.modal-error')[0].textContent, /不一致/);
  assert.ok(modal.parent, '弹窗应保持打开');
});

test('修改密码成功后发请求、提示并关闭弹窗', async () => {
  const { doc, calls } = await loadApp({
    sites: [{ id: '1', name: 'GitHub', url: 'https://github.com', category: '开发' }],
  });

  const menu = openAccountMenu(doc);
  menu.children[0].dispatch('click');
  await flush();

  const modal = doc.body.children.find((el) => el.classList.contains('modal-overlay'));
  const inputs = queryAll(modal, 'input');
  inputs[0].value = 'password123';
  inputs[1].value = 'newpassword456';
  inputs[2].value = 'newpassword456';

  queryAll(modal, 'button').find((button) => /修改密码/.test(button.textContent)).dispatch('click');
  await flush();

  const call = calls.fetch.find((item) => item.url === '/api/password');
  assert.ok(call, '应调用 /api/password');
  assert.equal(call.init.method, 'POST');
  assert.equal(JSON.parse(call.init.body).currentPassword, 'password123');
  assert.equal(JSON.parse(call.init.body).newPassword, 'newpassword456');

  assert.equal(modal.parent, null, '成功后弹窗应关闭');
  assert.match(doc.getElementById('toast').textContent, /密码已修改/);
});

test('修改密码弹窗可以取消，且不发请求', async () => {
  const { doc, calls } = await loadApp({
    sites: [{ id: '1', name: 'GitHub', url: 'https://github.com', category: '开发' }],
  });

  const menu = openAccountMenu(doc);
  menu.children[0].dispatch('click');
  await flush();

  const modal = doc.body.children.find((el) => el.classList.contains('modal-overlay'));
  queryAll(modal, 'button').find((button) => button.textContent === '取消').dispatch('click');
  await flush();

  assert.equal(modal.parent, null, '取消后弹窗应关闭');
  assert.equal(calls.fetch.some((item) => item.url === '/api/password'), false);
});

test('Escape 也能关闭弹窗', async () => {
  const { doc, calls } = await loadApp({
    sites: [{ id: '1', name: 'GitHub', url: 'https://github.com', category: '开发' }],
  });

  const menu = openAccountMenu(doc);
  menu.children[0].dispatch('click');
  await flush();

  const modal = doc.body.children.find((el) => el.classList.contains('modal-overlay'));
  doc.dispatch('keydown', { key: 'Escape', target: doc.body });
  await flush();

  assert.equal(modal.parent, null, 'Escape 应关闭弹窗');
  assert.equal(calls.fetch.some((item) => item.url === '/api/password'), false);
});

test('登出全部设备：确认后调用接口并回到登录页', async () => {
  const { doc, calls } = await loadApp({
    sites: [{ id: '1', name: 'GitHub', url: 'https://github.com', category: '开发' }],
  });

  const menu = openAccountMenu(doc);
  menu.children[1].dispatch('click');
  await flush();

  const modal = doc.body.children.find((el) => el.classList.contains('modal-overlay'));
  assert.ok(modal, '应弹出确认框');
  assert.equal(queryAll(modal, 'input').length, 0, '这个弹窗不需要输入');

  const danger = queryAll(modal, 'button').find((button) => button.textContent === '全部登出');
  assert.ok(danger.classList.contains('danger-btn'), '危险操作应使用危险按钮样式');

  danger.dispatch('click');
  await flush();

  const call = calls.fetch.find((item) => item.url === '/api/logout-all');
  assert.ok(call, '应调用 /api/logout-all');
  assert.equal(call.init.method, 'POST');
  assert.equal(modal.parent, null);

  // 回到登录页
  assert.equal(doc.getElementById('auth-view').classList.contains('hidden'), false);
  assert.equal(doc.getElementById('app-view').classList.contains('hidden'), true);
});

test('服务端拒绝时错误信息显示在弹窗里，弹窗不关闭', async () => {
  const { doc, calls } = await loadApp({
    sites: [{ id: '1', name: 'GitHub', url: 'https://github.com', category: '开发' }],
    onFetch: (url) => {
      if (url === '/api/password') return { status: 401, body: { error: '当前密码不正确' } };
      return null;
    },
  });

  const menu = openAccountMenu(doc);
  menu.children[0].dispatch('click');
  await flush();

  const modal = doc.body.children.find((el) => el.classList.contains('modal-overlay'));
  const inputs = queryAll(modal, 'input');
  inputs[0].value = 'wrong-current';
  inputs[1].value = 'newpassword456';
  inputs[2].value = 'newpassword456';

  queryAll(modal, 'button').find((button) => /修改密码/.test(button.textContent)).dispatch('click');
  await flush();

  assert.ok(calls.fetch.some((item) => item.url === '/api/password'));
  assert.match(queryAll(modal, '.modal-error')[0].textContent, /当前密码不正确/);
  assert.ok(modal.parent, '失败后弹窗应保持打开');
});

/* ================= 使用记录（最近 / 最常访问） ================= */

test('没有使用记录时不显示自动分组', async () => {
  const { doc } = await loadApp({
    sites: [
      { id: '1', name: 'GitHub', url: 'https://github.com', category: '开发' },
      { id: '2', name: '知乎', url: 'https://zhihu.com', category: '常用' },
    ],
  });

  assert.equal(queryAll(doc.documentElement, '.section-smart').length, 0);
  assert.equal(doc.getElementById('groups').children.length, 2, '只应有两个真实分组');
});

test('有使用记录时插入「最近访问 / 最常访问」，且排在真实分组前面', async () => {
  const sites = [
    { id: '1', name: 'GitHub', url: 'https://github.com', category: '开发' },
    { id: '2', name: '知乎', url: 'https://zhihu.com', category: '常用' },
    { id: '3', name: 'MDN', url: 'https://developer.mozilla.org', category: '开发' },
  ];
  const { doc } = await loadApp({
    sites,
    history: [
      ['https://github.com', 5, 5000],
      ['https://zhihu.com', 1, 9000],
    ],
  });

  const smart = queryAll(doc.documentElement, '.section-smart');
  assert.equal(smart.length, 2, '应有两个自动分组');
  assert.deepEqual(
    smart.map((section) => section.querySelector('h2').textContent),
    ['最近访问', '最常访问']
  );

  // 最近访问按时间倒序：知乎(9000) 在 GitHub(5000) 前
  assert.deepEqual(
    queryAll(smart[0], '.card').map((card) => card.dataset.name),
    ['知乎', 'GitHub']
  );

  // 最常访问按次数排序，只收访问 ≥2 次的（知乎只去过 1 次，不算）
  assert.deepEqual(
    queryAll(smart[1], '.card').map((card) => card.dataset.name),
    ['GitHub']
  );

  // 自动分组排在最前，真实分组紧随其后
  const sections = doc.getElementById('groups').children;
  assert.equal(sections.slice(0, 2).every((section) => section.classList.contains('section-smart')), true);
  assert.equal(sections.slice(2).every((section) => !section.classList.contains('section-smart')), true);
  assert.equal(sections.length, 4, '两个自动分组 + 两个真实分组');
});

test('最近访问与最常访问允许重叠：面向「刚去过」和「去得最多」两个视角', async () => {
  const { doc } = await loadApp({
    sites: [
      { id: '1', name: 'GitHub', url: 'https://github.com', category: '开发' },
      { id: '2', name: '知乎', url: 'https://zhihu.com', category: '常用' },
    ],
    history: [
      ['https://github.com', 9, 9000],
      ['https://zhihu.com', 1, 8000],
    ],
  });

  const smart = queryAll(doc.documentElement, '.section-smart');
  const recent = smart.find((section) => section.querySelector('h2').textContent === '最近访问');
  const frequent = smart.find((section) => section.querySelector('h2').textContent === '最常访问');

  // GitHub 两边都出现：这是有意的（否则站点少时「最常访问」永远是空的）
  assert.equal(queryAll(recent, '.card').some((card) => card.dataset.name === 'GitHub'), true);
  assert.deepEqual(
    queryAll(frequent, '.card').map((card) => card.dataset.name),
    ['GitHub']
  );
});

test('搜索时不出自动分组，避免和结果抢位置', async () => {
  const { doc } = await loadApp({
    sites: [{ id: '1', name: 'GitHub', url: 'https://github.com', category: '开发' }],
    history: [['https://github.com', 3, 5000]],
  });

  assert.equal(queryAll(doc.documentElement, '.section-smart').length, 2, '未搜索时应有两个自动分组');

  const search = doc.getElementById('search');
  search.value = 'git';
  search.dispatch('input', { target: search });

  assert.equal(queryAll(doc.documentElement, '.section-smart').length, 0);
  assert.equal(queryAll(doc.documentElement, '.card').length, 1);
});

test('已删除站点的记录不会出现在自动分组里', async () => {
  const { doc } = await loadApp({
    sites: [{ id: '1', name: 'GitHub', url: 'https://github.com', category: '开发' }],
    history: [
      ['https://github.com', 3, 5000],
      ['https://removed.example.com', 8, 9000],
    ],
  });

  const cards = queryAll(doc.documentElement, '.card').map((card) => card.dataset.name);
  assert.equal(cards.includes('GitHub'), true);
  assert.equal(queryAll(doc.documentElement, '.section-smart').every((s) => queryAll(s, '.card').every((c) => c.dataset.name !== 'removed')), true);
});

test('点击卡片会记录一次访问', async () => {
  const { doc } = await loadApp({
    sites: [{ id: '1', name: 'GitHub', url: 'https://github.com', category: '开发' }],
  });

  const card = queryAll(doc.documentElement, '.card')[0];
  card.dispatch('click', { target: card });
  await flush();

  const history = JSON.parse(globalThis.localStorage.getItem('nav-history'));
  assert.equal(history['github.com'].count, 1);
  assert.equal(history['github.com'].url, 'https://github.com');
});

test('键盘 Enter 打开站点时也会记录并开新页', async () => {
  const { doc, calls } = await loadApp({
    sites: [{ id: '1', name: 'GitHub', url: 'https://github.com', category: '开发' }],
  });

  const search = doc.getElementById('search');
  search.value = 'git';
  search.dispatch('input', { target: search });
  // 只剩一张卡片，Enter 直接打开
  search.dispatch('keydown', { key: 'Enter', target: search });
  await flush();

  assert.ok(calls.fetch.some((call) => call.url === 'open:https://github.com'), '应打开新页');
  const history = JSON.parse(globalThis.localStorage.getItem('nav-history'));
  assert.equal(history['github.com'].count, 1);
});

test('右键菜单的「在新标签页打开」也会记录访问', async () => {
  const { doc, calls } = await loadApp({
    sites: [{ id: '1', name: 'GitHub', url: 'https://github.com', category: '开发' }],
  });

  const card = queryAll(doc.documentElement, '.card')[0];
  card.dispatch('contextmenu', { clientX: 5, clientY: 5 });

  const menu = doc.getElementById('context-menu');
  const openItem = menu.children.find((item) => /在新标签页打开/.test(item.textContent));
  openItem.dispatch('click');
  await flush();

  assert.ok(calls.fetch.some((call) => call.url === 'open:https://github.com'));
  const history = JSON.parse(globalThis.localStorage.getItem('nav-history'));
  assert.equal(history['github.com'].count, 1);
});

test('数据菜单可以清除使用记录，自动分组随之消失', async () => {
  const { doc } = await loadApp({
    sites: [{ id: '1', name: 'GitHub', url: 'https://github.com', category: '开发' }],
    history: [['https://github.com', 3, 5000]],
  });

  assert.equal(queryAll(doc.documentElement, '.section-smart').length, 2, '先确认自动分组已出现');

  doc.getElementById('data-btn').dispatch('click');
  const menu = doc.getElementById('context-menu');
  const clearItem = menu.children.find((item) => /清除使用记录/.test(item.textContent));
  assert.ok(clearItem, '数据菜单里应有「清除使用记录」');

  clearItem.dispatch('click');
  await flush();

  assert.equal(globalThis.localStorage.getItem('nav-history'), null);
  assert.equal(queryAll(doc.documentElement, '.section-smart').length, 0);
  assert.match(doc.getElementById('toast').textContent, /已清除/);
});

/* ================= 标签与备注 ================= */

test('parseTags 解析逗号分隔的标签，去掉空白与空项', () => {
  assert.deepEqual(parseTags('运维, 内网'), ['运维', '内网']);
  assert.deepEqual(parseTags('a,,b ,  ,c'), ['a', 'b', 'c']);
  assert.deepEqual(parseTags(''), []);
  assert.deepEqual(parseTags(null), []);
  assert.deepEqual(parseTags(undefined), []);
});

test('#标签 只按标签精确筛选', () => {
  const tagged = { name: '内网面板', url: 'https://panel.example.com', tags: '运维, 内网' };
  const other = { name: '运维手册', url: 'https://wiki.example.com' };

  assert.equal(matchesSite(tagged, '#运维'), true);
  assert.equal(matchesSite(tagged, '#内网'), true);
  assert.equal(matchesSite(tagged, '#运'), false, '标签是精确匹配，不做前缀');
  assert.equal(matchesSite(tagged, '#不存在'), false);
  assert.equal(matchesSite(other, '#运维'), false, '没打标签的站点不该命中');
  // 不带 # 时仍然走普通模糊匹配
  assert.equal(matchesSite(other, '运维'), true);
});

test('标签与备注都会参与普通关键词搜索', () => {
  const site = { name: '面板', url: 'https://panel.example.com', tags: '内网', note: '需先连 VPN' };
  assert.equal(matchesSite(site, '内网'), true);
  assert.equal(matchesSite(site, 'vpn'), true, '备注内容也应可搜');
  assert.equal(matchesSite(site, '不存在'), false);
});

test('卡片显示标签芯片，超过 3 个时收合成 +n', async () => {
  const { doc } = await loadApp({
    sites: [
      { id: '1', name: '面板', url: 'https://panel.example.com', category: '开发', tags: '运维, 内网' },
      { id: '2', name: '多标签', url: 'https://many.example.com', category: '开发', tags: 'a,b,c,d,e' },
    ],
  });

  const rows = queryAll(doc.documentElement, '.tag-row');
  assert.equal(rows.length, 2, '两个站点都有标签行');

  const chips = queryAll(rows[0], '.tag-chip');
  assert.deepEqual(chips.map((chip) => chip.textContent), ['#运维', '#内网']);

  const manyChips = queryAll(rows[1], '.tag-chip');
  assert.equal(manyChips.length, 3, '最多显示 3 个');
  assert.equal(queryAll(rows[1], '.tag-more')[0].textContent, '+2');
});

test('没有标签的站点不渲染标签行', async () => {
  const { doc } = await loadApp({
    sites: [{ id: '1', name: '无标签', url: 'https://plain.example.com', category: '开发' }],
  });
  assert.equal(queryAll(doc.documentElement, '.tag-row').length, 0);
});

test('点标签芯片会按该标签筛选，再点一次取消', async () => {
  const { doc } = await loadApp({
    sites: [
      { id: '1', name: '面板', url: 'https://panel.example.com', category: '开发', tags: '运维' },
      { id: '2', name: 'GitHub', url: 'https://github.com', category: '开发' },
    ],
  });
  assert.equal(queryAll(doc.documentElement, '.card').length, 2);

  const chip = queryAll(doc.documentElement, '.tag-chip')[0];
  chip.dispatch('click', { target: chip });
  await flush();

  assert.equal(doc.getElementById('search').value, '#运维', '搜索框应填入 #标签');
  assert.deepEqual(
    queryAll(doc.documentElement, '.card').map((card) => card.dataset.name),
    ['面板']
  );

  // 再点一次同一个标签 → 取消筛选
  const chipAgain = queryAll(doc.documentElement, '.tag-chip')[0];
  chipAgain.dispatch('click', { target: chipAgain });
  await flush();

  assert.equal(doc.getElementById('search').value, '');
  assert.equal(queryAll(doc.documentElement, '.card').length, 2);
});

test('点标签不会连带打开站点', async () => {
  const { doc, calls } = await loadApp({
    sites: [{ id: '1', name: '面板', url: 'https://panel.example.com', category: '开发', tags: '运维' }],
  });

  const chip = queryAll(doc.documentElement, '.tag-chip')[0];
  chip.dispatch('click', { target: chip });
  await flush();

  assert.equal(calls.fetch.some((call) => String(call.url).startsWith('open:')), false);
  assert.equal(globalThis.localStorage.getItem('nav-history'), null, '不应记录成一次访问');
});

test('有备注的站点显示 📝 标记，点开可以看内容', async () => {
  const { doc } = await loadApp({
    sites: [
      { id: '1', name: '面板', url: 'https://panel.example.com', category: '开发', note: '账号在 1Password' },
      { id: '2', name: 'GitHub', url: 'https://github.com', category: '开发' },
    ],
  });

  const badges = queryAll(doc.documentElement, '.note-badge');
  assert.equal(badges.length, 1, '只有带备注的站点显示标记');

  badges[0].dispatch('click', { target: badges[0] });
  await flush();

  const modal = doc.body.children.find((el) => el.classList.contains('modal-overlay'));
  assert.ok(modal, '应弹出备注弹窗');
  assert.match(modal.querySelector('h2').textContent, /面板 的备注/);
  assert.match(queryAll(modal, '.modal-desc')[0].textContent, /1Password/);

  // 只读弹窗没有取消按钮，只有关闭
  const buttons = queryAll(modal, 'button');
  assert.deepEqual(buttons.map((button) => button.textContent), ['关闭']);
  buttons[0].dispatch('click');
  await flush();
  assert.equal(modal.parent, null);
});

test('右键菜单提供查看备注，只读模式下也可见', async () => {
  const { doc } = await loadApp({
    config: { publicMode: true, readonly: true },
    sites: [{ id: '1', name: '面板', url: 'https://panel.example.com', category: '开发', note: '只读也能看' }],
  });

  const card = queryAll(doc.documentElement, '.card')[0];
  card.dispatch('contextmenu', { clientX: 5, clientY: 5 });

  const menu = doc.getElementById('context-menu');
  const noteItem = menu.children.find((item) => /查看备注/.test(item.textContent));
  assert.ok(noteItem, '有备注时应出现「查看备注」');
  assert.equal(
    menu.children.some((item) => /编辑站点|置顶/.test(item.textContent)),
    false,
    '只读模式下不应出现编辑类操作'
  );

  noteItem.dispatch('click');
  await flush();
  assert.ok(doc.body.children.some((el) => el.classList.contains('modal-overlay')));
});

test('没有备注的站点右键菜单里没有「查看备注」', async () => {
  const { doc } = await loadApp({
    sites: [{ id: '1', name: 'GitHub', url: 'https://github.com', category: '开发' }],
  });

  const card = queryAll(doc.documentElement, '.card')[0];
  card.dispatch('contextmenu', { clientX: 5, clientY: 5 });
  const menu = doc.getElementById('context-menu');
  assert.equal(menu.children.some((item) => /查看备注/.test(item.textContent)), false);
});

test('编辑器提供标签与备注字段，改动会随保存一起提交', async () => {
  const { doc, calls } = await loadApp({
    sites: [{ id: '1', name: '面板', url: 'https://panel.example.com', category: '开发', tags: '运维', note: '旧备注' }],
  });

  doc.getElementById('edit-btn').dispatch('click');

  const tagsInput = queryAll(doc.documentElement, 'input[data-field="tags"]')[0];
  const noteInput = queryAll(doc.documentElement, 'input[data-field="note"]')[0];
  assert.ok(tagsInput, '应有标签字段');
  assert.ok(noteInput, '应有备注字段');
  assert.equal(tagsInput.value, '运维');
  assert.equal(noteInput.value, '旧备注');
  assert.equal(tagsInput.maxLength, 100);
  assert.equal(noteInput.maxLength, 200);

  tagsInput.value = '运维, 内网';
  tagsInput.dispatch('input', { target: tagsInput });
  noteInput.value = '新备注';
  noteInput.dispatch('input', { target: noteInput });

  doc.getElementById('save-btn').dispatch('click');
  await flush();

  assert.equal(calls.puts.length, 1);
  assert.equal(calls.puts[0].sites[0].tags, '运维, 内网');
  assert.equal(calls.puts[0].sites[0].note, '新备注');
});