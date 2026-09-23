import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi, json } from '../functions/_lib/core.js';
import { onRequest as pagesOnRequest } from '../functions/api/[[path]].js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 生产入口就是 Cloudflare Pages：/api/* 交给 functions/，其余交给平台静态资源。
// 这里用同样的分流方式包一层，用例可以继续按 fetch(request, env) 写。
const worker = {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith('/api/')) return pagesOnRequest({ request, env });
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return json({ error: 'Not found' }, 404);
  },
};

class FakeKV {
  constructor() {
    this.map = new Map();
  }

  async get(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  async put(key, value) {
    this.map.set(key, value);
  }

  async delete(key) {
    this.map.delete(key);
  }
}

function env(kv = new FakeKV(), overrides = {}) {
  return {
    NAV_KV: kv,
    ASSETS: {
      async fetch(request) {
        return new Response(`asset:${new URL(request.url).pathname}`, { status: 200 });
      },
    },
    ...overrides,
  };
}

function request(path, options = {}) {
  return new Request(`https://nav.example.com${path}`, {
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

function setCookie(response) {
  return response.headers.get('Set-Cookie') || '';
}

function sessionCookie(response) {
  const value = setCookie(response);
  const match = value.match(/nav_session=([^;]+)/);
  return match ? match[1] : null;
}

// https 下服务端只接受 __Host- 前缀的会话 Cookie。
function authedHeaders(token) {
  return { Cookie: `__Host-nav_session=${token}` };
}

test('未登录访问需要登录的接口返回 401', async () => {
  const e = env();
  const me = await worker.fetch(request('/api/me'), e);
  assert.equal(me.status, 401);

  const sites = await worker.fetch(request('/api/sites'), e);
  assert.equal(sites.status, 401);
});

test('首个账号可以直接注册，之后注册需要注册码', async () => {
  const e = env();

  const first = await worker.fetch(
    request('/api/register', {
      method: 'POST',
      body: { username: 'alice', password: 'password123' },
    }),
    e
  );
  assert.equal(first.status, 200);
  assert.equal(await first.json().then((data) => data.username), 'alice');
  assert.ok(sessionCookie(first));

  const second = await worker.fetch(
    request('/api/register', {
      method: 'POST',
      body: { username: 'bob', password: 'password123' },
    }),
    e
  );
  assert.equal(second.status, 403);

  const keyed = env(new FakeKV(), { REGISTER_KEY: 'setup-secret' });
  const withoutKey = await worker.fetch(
    request('/api/register', {
      method: 'POST',
      body: { username: 'carol', password: 'password123' },
    }),
    keyed
  );
  assert.equal(withoutKey.status, 403);

  const withKey = await worker.fetch(
    request('/api/register', {
      method: 'POST',
      body: { username: 'carol', password: 'password123', registerKey: 'setup-secret' },
    }),
    keyed
  );
  assert.equal(withKey.status, 200);
});

test('登录、站点读写、登出完整流程', async () => {
  const e = env();

  await worker.fetch(
    request('/api/register', {
      method: 'POST',
      body: { username: 'alice', password: 'password123' },
    }),
    e
  );

  const wrong = await worker.fetch(
    request('/api/login', {
      method: 'POST',
      body: { username: 'alice', password: 'wrong-password' },
    }),
    e
  );
  assert.equal(wrong.status, 401);

  const login = await worker.fetch(
    request('/api/login', {
      method: 'POST',
      body: { username: 'alice', password: 'password123' },
    }),
    e
  );
  assert.equal(login.status, 200);
  const token = sessionCookie(login);
  assert.ok(token);

  const empty = await worker.fetch(request('/api/sites', { headers: authedHeaders(token) }), e);
  assert.equal(empty.status, 200);
  assert.deepEqual((await empty.json()).sites, []);

  const payload = [
    { id: '1', name: '个人博客', url: 'https://blog.example.com', desc: '写作与思考', category: '常用', icon: '✍️' },
    { id: '2', name: '图床', url: 'https://image.example.com', desc: '图片托管', category: '常用', icon: '🖼️' },
  ];
  const save = await worker.fetch(
    request('/api/sites', {
      method: 'PUT',
      body: { sites: payload },
      headers: authedHeaders(token),
    }),
    e
  );
  assert.equal(save.status, 200);
  assert.equal((await save.json()).sites.length, 2);

  const loaded = await worker.fetch(request('/api/sites', { headers: authedHeaders(token) }), e);
  assert.deepEqual((await loaded.json()).sites, payload);

  const logout = await worker.fetch(request('/api/logout', { method: 'POST', headers: authedHeaders(token) }), e);
  assert.equal(logout.status, 200);

  const afterLogout = await worker.fetch(request('/api/sites', { headers: authedHeaders(token) }), e);
  assert.equal(afterLogout.status, 401);
});

test('站点数据校验：缺少名称或链接会被拒绝', async () => {
  const e = env();
  await worker.fetch(
    request('/api/register', {
      method: 'POST',
      body: { username: 'alice', password: 'password123' },
    }),
    e
  );
  const login = await worker.fetch(
    request('/api/login', {
      method: 'POST',
      body: { username: 'alice', password: 'password123' },
    }),
    e
  );
  const token = sessionCookie(login);

  const bad = await worker.fetch(
    request('/api/sites', {
      method: 'PUT',
      body: { sites: [{ id: 'x', name: '', url: 'https://example.com' }] },
      headers: authedHeaders(token),
    }),
    e
  );
  assert.equal(bad.status, 400);
});

test('不同账户的站点数据相互隔离', async () => {
  const e = env(new FakeKV(), { REGISTER_KEY: 'setup-secret' });

  async function registerAndLogin(username) {
    await worker.fetch(
      request('/api/register', {
        method: 'POST',
        body: { username, password: 'password123', registerKey: 'setup-secret' },
      }),
      e
    );
    const login = await worker.fetch(
      request('/api/login', {
        method: 'POST',
        body: { username, password: 'password123' },
      }),
      e
    );
    return sessionCookie(login);
  }

  const aliceToken = await registerAndLogin('alice');
  const bobToken = await registerAndLogin('bob');

  await worker.fetch(
    request('/api/sites', {
      method: 'PUT',
      body: { sites: [{ name: 'Alice Blog', url: 'https://alice.example.com' }] },
      headers: authedHeaders(aliceToken),
    }),
    e
  );
  await worker.fetch(
    request('/api/sites', {
      method: 'PUT',
      body: { sites: [{ name: 'Bob Site', url: 'https://bob.example.com' }] },
      headers: authedHeaders(bobToken),
    }),
    e
  );

  const aliceSites = await worker.fetch(request('/api/sites', { headers: authedHeaders(aliceToken) }), e);
  const bobSites = await worker.fetch(request('/api/sites', { headers: authedHeaders(bobToken) }), e);
  const aliceNames = (await aliceSites.json()).sites.map((site) => site.name);
  const bobNames = (await bobSites.json()).sites.map((site) => site.name);

  assert.deepEqual(aliceNames, ['Alice Blog']);
  assert.deepEqual(bobNames, ['Bob Site']);
});

test('公开模式默认只读，匿名访客无法写入', async () => {
  const e = env(new FakeKV(), { PUBLIC_MODE: 'true' });

  const config = await worker.fetch(request('/api/config'), e);
  assert.deepEqual(await config.json(), { publicMode: true, readonly: true });

  const initial = await worker.fetch(request('/api/sites'), e);
  assert.equal(initial.status, 200);
  assert.deepEqual((await initial.json()).sites, []);

  const blocked = await worker.fetch(
    request('/api/sites', {
      method: 'PUT',
      body: { sites: [{ name: '公开站点', url: 'https://example.com' }] },
    }),
    e
  );
  assert.equal(blocked.status, 403);

  const stillEmpty = await worker.fetch(request('/api/sites'), e);
  assert.deepEqual((await stillEmpty.json()).sites, []);

  const register = await worker.fetch(
    request('/api/register', {
      method: 'POST',
      body: { username: 'nobody', password: 'password123' },
    }),
    e
  );
  assert.equal(register.status, 400);
});

test('公开模式可以显式放开写入，或用写入密钥放行', async () => {
  const open = env(new FakeKV(), { PUBLIC_MODE: 'true', PUBLIC_READONLY: 'false' });
  const openConfig = await worker.fetch(request('/api/config'), open);
  assert.deepEqual(await openConfig.json(), { publicMode: true, readonly: false });

  const saved = await worker.fetch(
    request('/api/sites', {
      method: 'PUT',
      body: { sites: [{ name: '公开站点', url: 'https://example.com' }] },
    }),
    open
  );
  assert.equal(saved.status, 200);

  const loaded = await worker.fetch(request('/api/sites'), open);
  assert.deepEqual(
    (await loaded.json()).sites.map((site) => site.name),
    ['公开站点']
  );

  const keyed = env(new FakeKV(), { PUBLIC_MODE: 'true', PUBLIC_WRITE_KEY: 'write-secret' });
  const withoutKey = await worker.fetch(
    request('/api/sites', {
      method: 'PUT',
      body: { sites: [{ name: '公开站点', url: 'https://example.com' }] },
    }),
    keyed
  );
  assert.equal(withoutKey.status, 403);

  const withKey = await worker.fetch(
    request('/api/sites', {
      method: 'PUT',
      body: { sites: [{ name: '公开站点', url: 'https://example.com' }] },
      headers: { 'x-nav-write-key': 'write-secret' },
    }),
    keyed
  );
  assert.equal(withKey.status, 200);
});

test('导航名称和副标题可以保存并读取', async () => {
  const e = env();
  await worker.fetch(
    request('/api/register', {
      method: 'POST',
      body: { username: 'alice', password: 'password123' },
    }),
    e
  );
  const login = await worker.fetch(
    request('/api/login', {
      method: 'POST',
      body: { username: 'alice', password: 'password123' },
    }),
    e
  );
  const token = sessionCookie(login);

  const save = await worker.fetch(
    request('/api/sites', {
      method: 'PUT',
      body: {
        sites: [],
        settings: { title: '我的工具箱', subtitle: '常用入口' },
      },
      headers: authedHeaders(token),
    }),
    e
  );
  assert.equal(save.status, 200);

  const loaded = await worker.fetch(request('/api/sites', { headers: authedHeaders(token) }), e);
  const data = await loaded.json();
  assert.deepEqual(data.settings, { title: '我的工具箱', subtitle: '常用入口' });
});

test('Pages Functions 适配层可以处理 API 请求', async () => {
  const e = env();
  const response = await pagesOnRequest({ request: request('/api/config'), env: e });
  assert.deepEqual(await response.json(), { publicMode: false, readonly: false });
});

test('静态资源请求交给 ASSETS 处理', async () => {
  const response = await worker.fetch(request('/'), env());
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'asset:/');
});

async function newUserEnv() {
  const e = env();
  const register = await worker.fetch(
    request('/api/register', {
      method: 'POST',
      body: { username: 'alice', password: 'password123' },
    }),
    e
  );
  return { e, token: sessionCookie(register) };
}

test('只更新站点不会清空已有的自定义标题', async () => {
  const { e, token } = await newUserEnv();

  await worker.fetch(
    request('/api/sites', {
      method: 'PUT',
      body: { sites: [], settings: { title: '我的工具箱', subtitle: '常用入口' } },
      headers: authedHeaders(token),
    }),
    e
  );

  // 不带 settings，模拟只改站点列表的客户端
  const save = await worker.fetch(
    request('/api/sites', {
      method: 'PUT',
      body: { sites: [{ name: 'GitHub', url: 'https://github.com' }] },
      headers: authedHeaders(token),
    }),
    e
  );
  assert.equal(save.status, 200);

  const loaded = await worker.fetch(request('/api/sites', { headers: authedHeaders(token) }), e);
  assert.deepEqual((await loaded.json()).settings, { title: '我的工具箱', subtitle: '常用入口' });
});

test('settings 传空字符串可以只清空单个字段', async () => {
  const { e, token } = await newUserEnv();

  await worker.fetch(
    request('/api/sites', {
      method: 'PUT',
      body: { sites: [], settings: { title: '我的工具箱', subtitle: '常用入口' } },
      headers: authedHeaders(token),
    }),
    e
  );

  const save = await worker.fetch(
    request('/api/sites', {
      method: 'PUT',
      body: { sites: [], settings: { title: '' } },
      headers: authedHeaders(token),
    }),
    e
  );
  assert.equal(save.status, 200);

  const loaded = await worker.fetch(request('/api/sites', { headers: authedHeaders(token) }), e);
  assert.deepEqual((await loaded.json()).settings, { subtitle: '常用入口' });
});

test('非 http/https 链接会被拒绝', async () => {
  const { e, token } = await newUserEnv();

  const bad = [
    'javascript:alert(document.cookie)',
    'data:text/html,<script>alert(1)</script>',
    'ftp://example.com/x',
  ];
  for (const url of bad) {
    const save = await worker.fetch(
      request('/api/sites', {
        method: 'PUT',
        body: { sites: [{ name: 'bad', url }] },
        headers: authedHeaders(token),
      }),
      e
    );
    assert.equal(save.status, 400, `${url} 应被拒绝`);
  }

  const loaded = await worker.fetch(request('/api/sites', { headers: authedHeaders(token) }), e);
  assert.deepEqual((await loaded.json()).sites, []);
});

test('登录失败次数过多会被限流，但正确密码不会被别人锁死', async () => {
  const { e } = await newUserEnv();

  for (let i = 0; i < 5; i += 1) {
    const attempt = await worker.fetch(
      request('/api/login', {
        method: 'POST',
        body: { username: 'alice', password: 'wrong-password' },
      }),
      e
    );
    assert.equal(attempt.status, 401);
  }

  const blocked = await worker.fetch(
    request('/api/login', {
      method: 'POST',
      body: { username: 'alice', password: 'wrong-password' },
    }),
    e
  );
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers.get('Retry-After'));

  // 限流只挡失败尝试：密码正确时应当放行并清空计数
  const correct = await worker.fetch(
    request('/api/login', {
      method: 'POST',
      body: { username: 'alice', password: 'password123' },
    }),
    e
  );
  assert.equal(correct.status, 200);
  assert.ok(sessionCookie(correct));

  const afterReset = await worker.fetch(
    request('/api/login', {
      method: 'POST',
      body: { username: 'alice', password: 'wrong-password' },
    }),
    e
  );
  assert.equal(afterReset.status, 401);
});

test('跨站 Origin 的写请求会被拒绝', async () => {
  const { e, token } = await newUserEnv();

  const crossSite = await worker.fetch(
    request('/api/sites', {
      method: 'PUT',
      body: { sites: [] },
      headers: { ...authedHeaders(token), Origin: 'https://evil.example.com' },
    }),
    e
  );
  assert.equal(crossSite.status, 403);

  const sameSite = await worker.fetch(
    request('/api/sites', {
      method: 'PUT',
      body: { sites: [] },
      headers: { ...authedHeaders(token), Origin: 'https://nav.example.com' },
    }),
    e
  );
  assert.equal(sameSite.status, 200);
});

test('https 下会话 Cookie 使用 __Host- 前缀，并会滑动续期', async () => {
  const e = env();
  const register = await worker.fetch(
    request('/api/register', {
      method: 'POST',
      body: { username: 'alice', password: 'password123' },
    }),
    e
  );
  const cookie = setCookie(register);
  assert.match(cookie, /__Host-nav_session=/);
  assert.match(cookie, /Secure/);

  const token = sessionCookie(register);

  // 把会话改成即将过期，下一次请求应触发续期并返回新的 Set-Cookie
  const raw = JSON.parse(await e.NAV_KV.get(`session:${token}`));
  raw.expires = Date.now() + 1000;
  await e.NAV_KV.put(`session:${token}`, JSON.stringify(raw));

  const sites = await worker.fetch(request('/api/sites', { headers: authedHeaders(token) }), e);
  assert.equal(sites.status, 200);
  assert.match(sites.headers.get('Set-Cookie') || '', /__Host-nav_session=/);

  const renewed = JSON.parse(await e.NAV_KV.get(`session:${token}`));
  assert.ok(renewed.expires > raw.expires);
});

test('API 响应带安全头，静态资源交给平台（安全头由 _headers 提供）', async () => {
  // 分工：/api/* 的响应由 functions 统一补头；静态资源的头来自 public/_headers，
  // 那是 Cloudflare Pages 平台读取的，不走我们的代码。
  const config = await worker.fetch(request('/api/config'), env());
  assert.equal(config.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(config.headers.get('Content-Security-Policy') || '', /default-src 'self'/);

  const asset = await worker.fetch(request('/'), env());
  assert.equal(await asset.text(), 'asset:/');
});

test('Pages Functions 适配层同样返回安全响应头', async () => {
  const response = await pagesOnRequest({ request: request('/api/config'), env: env() });
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(response.headers.get('Content-Security-Policy') || '', /default-src 'self'/);
});

test('CSP 不会挡掉导出下载：与 Pages 的 _headers 一致且不含 sandbox', async () => {
  // 导出用的是 Blob + <a download>。如果哪天给 CSP 加上 sandbox（没带 allow-downloads），
  // 下载会被浏览器静默拦掉，所以在这里钉住。
  const workerCsp = (await worker.fetch(request('/api/config'), env())).headers.get(
    'Content-Security-Policy'
  );
  assert.ok(workerCsp);
  assert.equal(/sandbox/i.test(workerCsp), false, 'CSP 不应包含 sandbox，否则会挡掉下载');

  // Pages 部署走的是静态 _headers 文件，两边必须一致。
  const headersFile = fs.readFileSync(path.join(repoRoot, 'public', '_headers'), 'utf8');
  const cspLine = headersFile.split('\n').find((line) => /Content-Security-Policy:/i.test(line));
  assert.ok(cspLine, 'public/_headers 应声明 CSP');
  const fileCsp = cspLine.split('Content-Security-Policy:')[1].trim();

  assert.equal(fileCsp, workerCsp, '_headers 与 Worker 注入的 CSP 应完全一致');
  assert.match(fileCsp, /img-src 'self' data:(;|$)/, 'img-src 应收紧到同源加 data:');
  assert.equal(/https:/.test(fileCsp.split(';').find((part) => /img-src/.test(part)) || ''), false);
  assert.match(fileCsp, /script-src 'self'/);
  assert.match(fileCsp, /frame-ancestors 'none'/);
});

test('https 下不接受普通 nav_session（防会话固定）', async () => {
  const { e, token } = await newUserEnv();

  const withHostPrefix = await worker.fetch(
    request('/api/sites', { headers: { Cookie: `__Host-nav_session=${token}` } }),
    e
  );
  assert.equal(withHostPrefix.status, 200);

  const withPlainName = await worker.fetch(
    request('/api/sites', { headers: { Cookie: `nav_session=${token}` } }),
    e
  );
  assert.equal(withPlainName.status, 401);
});

test('登出会同时清掉两个会话 Cookie', async () => {
  const { e, token } = await newUserEnv();

  const logout = await worker.fetch(
    request('/api/logout', { method: 'POST', headers: authedHeaders(token) }),
    e
  );
  assert.equal(logout.status, 200);

  const cookies = logout.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.ok(cookies.some((c) => c.startsWith('nav_session=') && c.includes('Max-Age=0')));
  assert.ok(
    cookies.some(
      (c) => c.startsWith('__Host-nav_session=') && c.includes('Max-Age=0') && c.includes('Secure')
    )
  );
});

test('重复的站点 id 会被去重', async () => {
  const { e, token } = await newUserEnv();

  const save = await worker.fetch(
    request('/api/sites', {
      method: 'PUT',
      body: {
        sites: [
          { id: 'same', name: 'A', url: 'https://a.example.com' },
          { id: 'same', name: 'B', url: 'https://b.example.com' },
        ],
      },
      headers: authedHeaders(token),
    }),
    e
  );
  assert.equal(save.status, 200);

  const ids = (await save.json()).sites.map((site) => site.id);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2);
});

test('合法的 http/https 链接会被接受并去掉首尾空格', async () => {
  const { e, token } = await newUserEnv();

  const save = await worker.fetch(
    request('/api/sites', {
      method: 'PUT',
      body: {
        sites: [
          { name: 'http', url: 'http://plain.example.com' },
          { name: 'upper', url: 'HTTPS://Upper.example.com/Path' },
          { name: 'spaces', url: '  https://spaced.example.com  ' },
        ],
      },
      headers: authedHeaders(token),
    }),
    e
  );
  assert.equal(save.status, 200);

  const urls = (await save.json()).sites.map((site) => site.url);
  assert.deepEqual(urls, [
    'http://plain.example.com',
    'HTTPS://Upper.example.com/Path',
    'https://spaced.example.com',
  ]);
});

test('settings 传入非字符串会被拒绝，且不清空已有标题', async () => {
  const { e, token } = await newUserEnv();

  await worker.fetch(
    request('/api/sites', {
      method: 'PUT',
      body: { sites: [], settings: { title: '我的工具箱' } },
      headers: authedHeaders(token),
    }),
    e
  );

  const bad = await worker.fetch(
    request('/api/sites', {
      method: 'PUT',
      body: { sites: [], settings: { title: 123 } },
      headers: authedHeaders(token),
    }),
    e
  );
  assert.equal(bad.status, 400);

  const loaded = await worker.fetch(request('/api/sites', { headers: authedHeaders(token) }), e);
  assert.deepEqual((await loaded.json()).settings, { title: '我的工具箱' });
});

test('settings 传 null 会清空自定义标题', async () => {
  const { e, token } = await newUserEnv();

  await worker.fetch(
    request('/api/sites', {
      method: 'PUT',
      body: { sites: [], settings: { title: '我的工具箱', subtitle: '常用入口' } },
      headers: authedHeaders(token),
    }),
    e
  );

  const cleared = await worker.fetch(
    request('/api/sites', {
      method: 'PUT',
      body: { sites: [], settings: null },
      headers: authedHeaders(token),
    }),
    e
  );
  assert.equal(cleared.status, 200);

  const loaded = await worker.fetch(request('/api/sites', { headers: authedHeaders(token) }), e);
  assert.deepEqual((await loaded.json()).settings, {});
});

test('非法链接被拒后不会改动已保存的站点', async () => {
  const { e, token } = await newUserEnv();

  await worker.fetch(
    request('/api/sites', {
      method: 'PUT',
      body: { sites: [{ name: 'GitHub', url: 'https://github.com' }] },
      headers: authedHeaders(token),
    }),
    e
  );

  const bad = await worker.fetch(
    request('/api/sites', {
      method: 'PUT',
      body: { sites: [{ name: 'evil', url: 'javascript:alert(1)' }] },
      headers: authedHeaders(token),
    }),
    e
  );
  assert.equal(bad.status, 400);

  const loaded = await worker.fetch(request('/api/sites', { headers: authedHeaders(token) }), e);
  assert.deepEqual(
    (await loaded.json()).sites.map((site) => site.name),
    ['GitHub']
  );
});

test('公开模式下 /api/me 会返回只读标记', async () => {
  const readonlyEnv = env(new FakeKV(), { PUBLIC_MODE: 'true' });
  const me = await worker.fetch(request('/api/me'), readonlyEnv);
  const data = await me.json();
  assert.equal(data.username, 'public');
  assert.equal(data.readonly, true);

  const writableEnv = env(new FakeKV(), { PUBLIC_MODE: 'true', PUBLIC_READONLY: 'false' });
  const writableMe = await worker.fetch(request('/api/me'), writableEnv);
  assert.equal((await writableMe.json()).readonly, false);
});

test('/api/icon 拒绝缺失或畸形 domain', async () => {
  const e = env();
  const bad = [
    '/api/icon',
    '/api/icon?domain=',
    '/api/icon?domain=javascript:alert(1)',
    '/api/icon?domain=example.com/../x',
    '/api/icon?domain=http://x.com',
    '/api/icon?domain=a b.com',
    '/api/icon?domain=localhost',
  ];

  for (const path of bad) {
    const response = await worker.fetch(request(path), e);
    assert.equal(response.status, 400, `${path} 应被拒绝`);
    assert.equal((await response.json()).error, '域名不合法');
  }
});

test('/api/icon 代理上游图片并写入缓存头', async () => {
  const calls = [];
  const stub = async (url) => {
    calls.push(url);
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
  };
  const e = env(new FakeKV(), { ICON_FETCH: stub });

  const icon = await worker.fetch(request('/api/icon?domain=example.com'), e);
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get('Content-Type'), 'image/png');
  assert.equal(icon.headers.get('Cache-Control'), 'public, max-age=604800, immutable');
  assert.deepEqual(Array.from(new Uint8Array(await icon.arrayBuffer())), [1, 2, 3]);
  assert.deepEqual(calls, ['https://example.com/favicon.ico']);
});

test('/api/icon 第二次请求命中 KV 缓存，不再访问上游', async () => {
  let callCount = 0;
  const stub = async () => {
    callCount += 1;
    return new Response(new Uint8Array([7, 8]), { headers: { 'content-type': 'image/png' } });
  };
  const e = env(new FakeKV(), { ICON_FETCH: stub });

  const first = await worker.fetch(request('/api/icon?domain=cached.example.com'), e);
  assert.equal(first.status, 200);

  const second = await worker.fetch(request('/api/icon?domain=cached.example.com'), e);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('Content-Type'), 'image/png');
  assert.deepEqual(Array.from(new Uint8Array(await second.arrayBuffer())), [7, 8]);
  assert.equal(callCount, 1);
});

test('/api/icon 上游 404 时返回 404', async () => {
  const stub = async () => new Response('not found', { status: 404 });
  const e = env(new FakeKV(), { ICON_FETCH: stub });

  const icon = await worker.fetch(request('/api/icon?domain=missing.example.com'), e);
  assert.equal(icon.status, 404);
  assert.equal((await icon.json()).error, '图标不可用');
});

test('/api/icon 上游返回非图片时返回 404', async () => {
  const stub = async () =>
    new Response('<html></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
  const e = env(new FakeKV(), { ICON_FETCH: stub });

  const icon = await worker.fetch(request('/api/icon?domain=html.example.com'), e);
  assert.equal(icon.status, 404);
  assert.equal((await icon.json()).error, '图标不可用');
});

test('/api/icon 上游抛错时返回 404 而不是 500', async () => {
  const stub = async () => {
    throw new Error('network down');
  };
  const e = env(new FakeKV(), { ICON_FETCH: stub });

  const icon = await worker.fetch(request('/api/icon?domain=broken.example.com'), e);
  assert.equal(icon.status, 404);
  assert.equal((await icon.json()).error, '图标不可用');
});

test('站点可选字段 pinned 与 keywords 只在有值时保留', async () => {
  const { e, token } = await newUserEnv();

  const save = await worker.fetch(
    request('/api/sites', {
      method: 'PUT',
      body: {
        sites: [
          { id: '1', name: 'GitHub', url: 'https://github.com', pinned: true, keywords: '  gh, github  ' },
          { id: '2', name: 'Blog', url: 'https://blog.example.com', pinned: false, keywords: '   ' },
        ],
      },
      headers: authedHeaders(token),
    }),
    e
  );
  assert.equal(save.status, 200);

  const sites = (await save.json()).sites;
  assert.deepEqual(sites[0], {
    id: '1',
    name: 'GitHub',
    url: 'https://github.com',
    desc: '',
    category: '常用',
    // icon 留空表示「交给 /api/icon 抓 favicon」；不要再用名称首字兜底，
    // 否则 icon 永远非空，前端的图标代理分支就永远走不到。
    icon: '',
    pinned: true,
    keywords: 'gh, github',
  });
  assert.equal('pinned' in sites[1], false);
  assert.equal('keywords' in sites[1], false);
  assert.equal(sites[1].name, 'Blog');
  assert.equal(sites[1].icon, '', '未提供 icon 时应保持空字符串');
});

test('站点可以保留短图标，超长图标会被截断', async () => {
  const { e, token } = await newUserEnv();

  const save = await worker.fetch(
    request('/api/sites', {
      method: 'PUT',
      body: {
        sites: [
          { id: '1', name: '带图标', url: 'https://a.example.com', icon: '📦' },
          { id: '2', name: '超长图标', url: 'https://b.example.com', icon: 'https://x.com/favicon.ico' },
        ],
      },
      headers: authedHeaders(token),
    }),
    e
  );
  assert.equal(save.status, 200);

  const sites = (await save.json()).sites;
  assert.equal(sites[0].icon, '📦');
  assert.equal([...sites[1].icon].length <= 8, true, '超长图标应被截到 8 个字符以内');
});

test('settings 支持 density：合法值保存，非法值拒绝，null 清空', async () => {
  const { e, token } = await newUserEnv();

  const saved = await worker.fetch(
    request('/api/sites', {
      method: 'PUT',
      body: { sites: [], settings: { title: '我的工具箱', density: 'compact' } },
      headers: authedHeaders(token),
    }),
    e
  );
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).settings, { title: '我的工具箱', density: 'compact' });

  for (const density of ['cozy', '', 123, true]) {
    const bad = await worker.fetch(
      request('/api/sites', {
        method: 'PUT',
        body: { sites: [], settings: { density } },
        headers: authedHeaders(token),
      }),
      e
    );
    assert.equal(bad.status, 400, `density=${String(density)} 应被拒绝`);
    assert.match((await bad.json()).error, /density|密度/, '错误信息应说明是密度不合法');
  }

  const loaded = await worker.fetch(request('/api/sites', { headers: authedHeaders(token) }), e);
  assert.deepEqual((await loaded.json()).settings, { title: '我的工具箱', density: 'compact' });

  const cleared = await worker.fetch(
    request('/api/sites', {
      method: 'PUT',
      body: { sites: [], settings: { density: null } },
      headers: authedHeaders(token),
    }),
    e
  );
  assert.equal(cleared.status, 200);
  assert.deepEqual((await cleared.json()).settings, { title: '我的工具箱' });
});

test('服务端拒绝超过 500 个站点的批量写入', async () => {
  const { e, token } = await newUserEnv();

  const tooMany = Array.from({ length: 501 }, (_, i) => ({
    name: `站点 ${i}`,
    url: `https://s-${i}.example.com`,
  }));

  const rejected = await worker.fetch(
    request('/api/sites', {
      method: 'PUT',
      body: { sites: tooMany },
      headers: authedHeaders(token),
    }),
    e
  );
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /500/);

  const exactly = await worker.fetch(
    request('/api/sites', {
      method: 'PUT',
      body: { sites: tooMany.slice(0, 500) },
      headers: authedHeaders(token),
    }),
    e
  );
  assert.equal(exactly.status, 200, '正好 500 个应当被接受');
});

/* ================= 账号自救：改密码 / 登出全部设备 ================= */

// 登两个「设备」：返回各自的 Cookie 头
async function twoDevices(e, username = 'alice', password = 'password123') {
  const register = await worker.fetch(
    request('/api/register', { method: 'POST', body: { username, password } }),
    e
  );
  const first = sessionCookie(register);
  const second = sessionCookie(
    await worker.fetch(request('/api/login', { method: 'POST', body: { username, password } }), e)
  );
  return { first, second };
}

test('改密码后旧密码失效、旧会话被踢、当前设备拿到新会话', async () => {
  const e = env();
  const { first, second } = await twoDevices(e);
  assert.ok(first && second);

  const changed = await worker.fetch(
    request('/api/password', {
      method: 'POST',
      body: { currentPassword: 'password123', newPassword: 'newpassword456' },
      headers: authedHeaders(first),
    }),
    e
  );
  assert.equal(changed.status, 200);
  const fresh = sessionCookie(changed);
  assert.ok(fresh, '调用方应立刻拿到新会话');
  assert.notEqual(fresh, first, 'token 应该换掉');

  // 新会话可用
  assert.equal(
    (await worker.fetch(request('/api/sites', { headers: authedHeaders(fresh) }), e)).status,
    200
  );
  // 另一个设备的旧会话被踢
  assert.equal(
    (await worker.fetch(request('/api/sites', { headers: authedHeaders(second) }), e)).status,
    401
  );

  // 旧密码不能登录，新密码可以
  assert.equal(
    (
      await worker.fetch(
        request('/api/login', { method: 'POST', body: { username: 'alice', password: 'password123' } }),
        e
      )
    ).status,
    401
  );
  assert.equal(
    (
      await worker.fetch(
        request('/api/login', {
          method: 'POST',
          body: { username: 'alice', password: 'newpassword456' },
        }),
        e
      )
    ).status,
    200
  );
});

test('改密码的输入校验：当前密码错误、新密码太短、字段缺失', async () => {
  const e = env();
  const { first } = await twoDevices(e);

  const wrong = await worker.fetch(
    request('/api/password', {
      method: 'POST',
      body: { currentPassword: 'not-my-password', newPassword: 'newpassword456' },
      headers: authedHeaders(first),
    }),
    e
  );
  assert.equal(wrong.status, 401);

  const tooShort = await worker.fetch(
    request('/api/password', {
      method: 'POST',
      body: { currentPassword: 'password123', newPassword: 'short' },
      headers: authedHeaders(first),
    }),
    e
  );
  assert.equal(tooShort.status, 400);

  const missing = await worker.fetch(
    request('/api/password', { method: 'POST', body: {}, headers: authedHeaders(first) }),
    e
  );
  assert.equal(missing.status, 400);

  // 失败不应改动密码：原密码仍可登录
  assert.equal(
    (await worker.fetch(request('/api/sites', { headers: authedHeaders(first) }), e)).status,
    200
  );
});

test('改密码需要登录，公开模式不支持', async () => {
  const anonymous = await worker.fetch(
    request('/api/password', {
      method: 'POST',
      body: { currentPassword: 'a'.repeat(8), newPassword: 'b'.repeat(8) },
    }),
    env()
  );
  assert.equal(anonymous.status, 401);

  const pub = env(new FakeKV(), { PUBLIC_MODE: 'true' });
  const inPublic = await worker.fetch(
    request('/api/password', {
      method: 'POST',
      body: { currentPassword: 'a'.repeat(8), newPassword: 'b'.repeat(8) },
    }),
    pub
  );
  assert.equal(inPublic.status, 400);
});

test('改密码失败次数过多会被限流', async () => {
  const e = env();
  const { first } = await twoDevices(e);

  for (let i = 0; i < 5; i += 1) {
    const attempt = await worker.fetch(
      request('/api/password', {
        method: 'POST',
        body: { currentPassword: 'wrong-one', newPassword: 'newpassword456' },
        headers: authedHeaders(first),
      }),
      e
    );
    assert.equal(attempt.status, 401);
  }

  const blocked = await worker.fetch(
    request('/api/password', {
      method: 'POST',
      body: { currentPassword: 'wrong-one', newPassword: 'newpassword456' },
      headers: authedHeaders(first),
    }),
    e
  );
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers.get('Retry-After'));
});

test('登出全部设备会让所有会话失效并清 Cookie', async () => {
  const e = env();
  const { first, second } = await twoDevices(e);

  const result = await worker.fetch(
    request('/api/logout-all', { method: 'POST', headers: authedHeaders(first) }),
    e
  );
  assert.equal(result.status, 200);

  const cookies = result.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.ok(cookies.every((cookie) => cookie.includes('Max-Age=0')));

  // 两台设备的会话都应失效
  assert.equal(
    (await worker.fetch(request('/api/sites', { headers: authedHeaders(first) }), e)).status,
    401
  );
  assert.equal(
    (await worker.fetch(request('/api/sites', { headers: authedHeaders(second) }), e)).status,
    401
  );

  // 密码没变，仍然可以重新登录
  assert.equal(
    (
      await worker.fetch(
        request('/api/login', { method: 'POST', body: { username: 'alice', password: 'password123' } }),
        e
      )
    ).status,
    200
  );
});

test('未登录时登出全部设备返回 401', async () => {
  const response = await worker.fetch(request('/api/logout-all', { method: 'POST' }), env());
  assert.equal(response.status, 401);
});

test('一个账号改密码不会影响另一个账号的会话', async () => {
  const e = env(new FakeKV(), { REGISTER_KEY: 'setup-secret' });

  async function loginAs(username) {
    const login = await worker.fetch(
      request('/api/login', { method: 'POST', body: { username, password: 'password123' } }),
      e
    );
    return sessionCookie(login);
  }

  for (const username of ['alice', 'bob']) {
    await worker.fetch(
      request('/api/register', {
        method: 'POST',
        body: { username, password: 'password123', registerKey: 'setup-secret' },
      }),
      e
    );
  }

  const aliceToken = await loginAs('alice');
  const bobToken = await loginAs('bob');

  await worker.fetch(
    request('/api/password', {
      method: 'POST',
      body: { currentPassword: 'password123', newPassword: 'alice-new-pass' },
      headers: authedHeaders(aliceToken),
    }),
    e
  );

  assert.equal(
    (await worker.fetch(request('/api/sites', { headers: authedHeaders(bobToken) }), e)).status,
    200,
    'bob 的会话不应受影响'
  );
});

test('站点可选字段 tags 与 note 只在有值时保留', async () => {
  const { e, token } = await newUserEnv();

  const save = await worker.fetch(
    request('/api/sites', {
      method: 'PUT',
      body: {
        sites: [
          { id: '1', name: '内网面板', url: 'https://panel.example.com', tags: '  运维, 内网  ', note: '账号在 1Password / 需先连 VPN' },
          { id: '2', name: 'GitHub', url: 'https://github.com', tags: '   ', note: '' },
        ],
      },
      headers: authedHeaders(token),
    }),
    e
  );
  assert.equal(save.status, 200);

  const sites = (await save.json()).sites;
  assert.equal(sites[0].tags, '运维, 内网');
  assert.equal(sites[0].note, '账号在 1Password / 需先连 VPN');
  assert.equal('tags' in sites[1], false, '空白 tags 不应写入');
  assert.equal('note' in sites[1], false, '空 note 不应写入');
});

test('超长 tags / note 会被截断到上限', async () => {
  const { e, token } = await newUserEnv();

  const save = await worker.fetch(
    request('/api/sites', {
      method: 'PUT',
      body: {
        sites: [
          { id: '1', name: '长标签', url: 'https://a.example.com', tags: 'x'.repeat(150), note: 'y'.repeat(400) },
        ],
      },
      headers: authedHeaders(token),
    }),
    e
  );
  assert.equal(save.status, 200);

  const site = (await save.json()).sites[0];
  assert.equal(site.tags.length, 100);
  assert.equal(site.note.length, 200);
});

/* ================= 部署结构守护（Cloudflare Pages） ================= */

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

test('只有一套部署入口：Pages Functions，没有遗留的 Workers 入口', () => {
  // 曾经同时存在 functions/api/[[path]].js 与 src/index.js，两套逻辑容易改一处忘一处。
  assert.equal(fs.existsSync(path.join(repoRoot, 'src')), false, 'src/ 应已移除');

  const wrangler = fs.readFileSync(path.join(repoRoot, 'wrangler.toml'), 'utf8');
  assert.equal(/^\s*main\s*=/m.test(wrangler), false, 'wrangler.toml 不应再有 Workers 的 main');
  assert.equal(/^\s*assets\s*=/m.test(wrangler), false, 'asssets 配置属于 Workers，Pages 用 pages_build_output_dir');
  assert.match(wrangler, /^\s*pages_build_output_dir\s*=\s*"public"/m, '应声明 Pages 的输出目录');
  assert.match(wrangler, /binding\s*=\s*"NAV_KV"/, 'KV 绑定名必须是 NAV_KV');
});

test('Pages 的 API 入口存在，且内部文件不会被当成路由暴露', () => {
  const files = walk(path.join(repoRoot, 'functions'));
  assert.ok(files.includes('api/[[path]].js'), '应有 /api/* 的 catch-all 入口');

  // Pages 会把 functions/ 下不以 _ 开头的文件当成路由；
  // 因此共享代码必须放在 _ 开头的目录里，否则会变成公开端点。
  const exposed = files.filter((file) => {
    const segments = file.split('/');
    const name = segments.pop();
    const inPrivateDir = segments.some((part) => part.startsWith('_'));
    return !inPrivateDir && !name.startsWith('_');
  });
  assert.deepEqual(exposed, ['api/[[path]].js'], `functions/ 里不应有其它公开路由：${exposed.join(', ')}`);
});

test('静态资源目录只包含要发布的东西', () => {
  const files = walk(path.join(repoRoot, 'public'));

  assert.ok(files.includes('index.html'), '需要首页');
  assert.ok(files.includes('_headers'), '需要 _headers（Pages 靠它给静态资源加安全头）');
  assert.ok(files.includes('js/app.js'), '入口脚本应在 /js/app.js');
  assert.equal(files.some((file) => file === 'app.js'), false, '旧的单文件 app.js 不应残留');

  // 这些是仓库内的开发/文档文件，绝不能被发布出去
  for (const leaked of ['package.json', 'wrangler.toml', 'test', 'scripts']) {
    assert.equal(files.some((file) => file === leaked || file.startsWith(`${leaked}/`)), false, `public/ 里不应有 ${leaked}`);
  }
});

test('Pages 的 API 响应与 public/_headers 提供同一套安全头', async () => {
  const apiResponse = await pagesOnRequest({ request: request('/api/config'), env: env() });
  const headerFile = fs.readFileSync(path.join(repoRoot, 'public', '_headers'), 'utf8');

  for (const name of [
    'X-Content-Type-Options',
    'Referrer-Policy',
    'X-Frame-Options',
    'Permissions-Policy',
    'Content-Security-Policy',
  ]) {
    assert.ok(apiResponse.headers.get(name), `API 响应缺少 ${name}`);
    assert.match(headerFile, new RegExp(name, 'i'), `public/_headers 缺少 ${name}`);
  }
});
