import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

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

function authedHeaders(token) {
  return { Cookie: `nav_session=${token}` };
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

test('静态资源请求交给 ASSETS 处理', async () => {
  const response = await worker.fetch(request('/'), env());
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'asset:/');
});
