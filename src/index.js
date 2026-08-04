const TEXT_ENCODER = new TextEncoder();
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const MAX_SITES = 200;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) {
        return await handleApi(request, env);
      }
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : '服务器错误' }, 500);
    }
  },
};

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.slice('/api/'.length);

  if (request.method === 'GET' && path === 'me') return getMe(request, env);
  if (request.method === 'POST' && path === 'register') return register(request, env);
  if (request.method === 'POST' && path === 'login') return login(request, env);
  if (request.method === 'POST' && path === 'logout') return logout(request, env);
  if (request.method === 'GET' && path === 'sites') return getSites(request, env);
  if (request.method === 'PUT' && path === 'sites') return putSites(request, env);

  return json({ error: 'Not found' }, 404);
}

async function getMe(request, env) {
  const username = await currentUser(request, env);
  if (!username) return json({ error: '未登录' }, 401);
  return json({ username });
}

async function register(request, env) {
  const body = await readJson(request);
  const username = normalizeUsername(body.username);
  const password = body.password;

  if (!username) {
    return json({ error: '用户名需为 2-32 位字母、数字、下划线或中文' }, 400);
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    return json({ error: '密码长度需为 8-128 位' }, 400);
  }

  const userKey = `user:${username}`;
  if (await env.NAV_KV.get(userKey)) {
    return json({ error: '用户名已存在' }, 409);
  }

  if (env.REGISTER_KEY) {
    if (body.registerKey !== env.REGISTER_KEY) {
      return json({ error: '注册码错误' }, 403);
    }
  } else {
    const indexRaw = await env.NAV_KV.get('meta:users');
    const users = indexRaw ? JSON.parse(indexRaw) : [];
    if (users.length > 0) {
      return json({ error: '已创建首个账号，请配置 REGISTER_KEY 后再开放注册' }, 403);
    }
  }

  const record = await hashPassword(password);
  await env.NAV_KV.put(
    userKey,
    JSON.stringify({
      username,
      salt: record.salt,
      hash: record.hash,
      iterations: record.iterations,
      createdAt: new Date().toISOString(),
    })
  );

  const indexRaw = await env.NAV_KV.get('meta:users');
  const users = indexRaw ? JSON.parse(indexRaw) : [];
  if (!users.includes(username)) {
    users.push(username);
    await env.NAV_KV.put('meta:users', JSON.stringify(users));
  }

  return createSession(request, env, username);
}

async function login(request, env) {
  const body = await readJson(request);
  const username = normalizeUsername(body.username);

  if (!username || typeof body.password !== 'string') {
    return json({ error: '请输入用户名和密码' }, 400);
  }

  const raw = await env.NAV_KV.get(`user:${username}`);
  if (!raw) return json({ error: '用户名或密码错误' }, 401);

  const record = JSON.parse(raw);
  const ok = await verifyPassword(body.password, record);
  if (!ok) return json({ error: '用户名或密码错误' }, 401);

  return createSession(request, env, username);
}

async function logout(request, env) {
  const token = readCookie(request, 'nav_session');
  if (token) {
    await env.NAV_KV.delete(`session:${token}`);
  }
  return json({ ok: true }, 200, {
    'Set-Cookie': 'nav_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
  });
}

async function getSites(request, env) {
  const username = await currentUser(request, env);
  if (!username) return json({ error: '未登录' }, 401);

  const raw = await env.NAV_KV.get(`sites:${username}`);
  return json({ sites: raw ? JSON.parse(raw) : [] });
}

async function putSites(request, env) {
  const username = await currentUser(request, env);
  if (!username) return json({ error: '未登录' }, 401);

  const body = await readJson(request);
  const sites = sanitizeSites(body.sites);
  if (sites === null) return json({ error: '站点数据格式不正确' }, 400);

  await env.NAV_KV.put(`sites:${username}`, JSON.stringify(sites));
  return json({ ok: true, sites });
}

async function currentUser(request, env) {
  const token = readCookie(request, 'nav_session');
  if (!token) return null;

  const raw = await env.NAV_KV.get(`session:${token}`);
  if (!raw) return null;

  let session;
  try {
    session = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!session.username || !session.expires || session.expires < Date.now()) {
    await env.NAV_KV.delete(`session:${token}`);
    return null;
  }
  return session.username;
}

async function createSession(request, env, username) {
  const token = randomBytesHex(32);
  const session = { username, expires: Date.now() + SESSION_TTL_SECONDS * 1000 };
  await env.NAV_KV.put(`session:${token}`, JSON.stringify(session), {
    expirationTtl: SESSION_TTL_SECONDS,
  });

  const secure = request.url.startsWith('https://');
  const cookie = [
    `nav_session=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${SESSION_TTL_SECONDS}`,
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');

  return json({ username }, 200, { 'Set-Cookie': cookie });
}

function sanitizeSites(input) {
  if (!Array.isArray(input) || input.length > MAX_SITES) return null;

  const output = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') return null;

    const name = cleanString(item.name, 50);
    const url = cleanString(item.url, 500);
    if (!name || !url) return null;

    output.push({
      id: cleanString(item.id, 40) || `${Date.now()}-${randomBytesHex(4)}`,
      name,
      url,
      desc: cleanString(item.desc, 100),
      category: cleanString(item.category, 30) || '常用',
      icon: cleanString(item.icon, 8) || name.slice(0, 1),
    });
  }
  return output;
}

function cleanString(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function normalizeUsername(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().toLowerCase();
  if (!/^[\p{L}\p{N}_]{2,32}$/u.test(name)) return null;
  return name;
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const iterations = 100000;
  const hash = await deriveBits(password, salt, iterations);
  return {
    salt: bytesToBase64(salt),
    iterations,
    hash: bytesToBase64(hash),
  };
}

async function verifyPassword(password, record) {
  const salt = base64ToBytes(record.salt);
  const expected = base64ToBytes(record.hash);
  const actual = await deriveBits(password, salt, record.iterations);
  return timingSafeEqual(actual, expected);
}

async function deriveBits(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    'raw',
    TEXT_ENCODER.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256
  );
  return new Uint8Array(bits);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function randomBytesHex(length) {
  return Array.from(randomBytes(length), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}
