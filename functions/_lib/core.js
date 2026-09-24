const TEXT_ENCODER = new TextEncoder();
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
// 导入浏览器书签时很容易超过 200，这里放宽到 500；前端导入时会按同一上限截断并提示。
const MAX_SITES = 500;
const PUBLIC_USER = '__public__';
const SESSION_COOKIE = 'nav_session';
const SECURE_SESSION_COOKIE = '__Host-nav_session';
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
const ICON_CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;
const ICON_TIMEOUT_MS = 5000;
const ICON_MAX_BYTES = 100 * 1024;
const ICON_USER_AGENT = 'cf-personal-nav/1.0 (+favicon-proxy)';
const DENSITY_VALUES = ['compact', 'comfortable'];
// 只允许 host（可含多级域），禁止协议、路径、端口、@ 与空白，防止 SSRF 之外的畸形输入。
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.slice('/api/'.length);

  // 写操作做同源校验，作为 SameSite Cookie 之外的纵深防御。
  if (request.method !== 'GET' && request.method !== 'HEAD' && !isSameOrigin(request)) {
    return json({ error: '跨站请求已被拒绝' }, 403);
  }

  if (request.method === 'GET' && path === 'me') return getMe(request, env);
  if (request.method === 'GET' && path === 'config') return getConfig(env);
  if (request.method === 'GET' && path === 'icon') return getIcon(request, env);
  if (request.method === 'POST' && path === 'register') return register(request, env);
  if (request.method === 'POST' && path === 'login') return login(request, env);
  if (request.method === 'POST' && path === 'logout') return logout(request, env);
  if (request.method === 'POST' && path === 'logout-all') return logoutAll(request, env);
  if (request.method === 'POST' && path === 'password') return changePassword(request, env);
  if (request.method === 'GET' && path === 'sites') return getSites(request, env);
  if (request.method === 'PUT' && path === 'sites') return putSites(request, env);

  return json({ error: 'Not found' }, 404);
}

async function getMe(request, env) {
  if (isPublicMode(env)) {
    return json({ username: 'public', publicMode: true, readonly: isPublicReadonly(env) });
  }
  const session = await loadSession(request, env);
  if (!session) return json({ error: '未登录' }, 401);

  const headers = {};
  if (await touchSession(env, session.token, session.session)) {
    headers['Set-Cookie'] = buildSessionCookie(request, session.token, SESSION_TTL_SECONDS);
  }
  return json({ username: session.session.username }, 200, headers);
}

function getConfig(env) {
  return json({ publicMode: isPublicMode(env), readonly: isPublicReadonly(env) });
}

async function register(request, env) {
  if (isPublicMode(env)) {
    return json({ error: '公开模式无需注册' }, 400);
  }

  const rlKey = `register:${clientIp(request)}`;
  const limited = await hitLimit(env, rlKey);
  if (limited) return tooManyRequests(limited);

  const body = await readJson(request);
  const username = normalizeUsername(body.username);
  const password = body.password;

  if (!username) {
    await recordFailure(env, rlKey);
    return json({ error: '用户名需为 2-32 位字母、数字、下划线或中文' }, 400);
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    await recordFailure(env, rlKey);
    return json({ error: '密码长度需为 8-128 位' }, 400);
  }

  const userKey = `user:${username}`;
  if (await env.NAV_KV.get(userKey)) {
    await recordFailure(env, rlKey);
    return json({ error: '用户名已存在' }, 409);
  }

  if (env.REGISTER_KEY) {
    if (body.registerKey !== env.REGISTER_KEY) {
      await recordFailure(env, rlKey);
      return json({ error: '注册码错误' }, 403);
    }
  } else {
    const users = safeParseArray(await env.NAV_KV.get('meta:users'));
    if (users.length > 0) {
      await recordFailure(env, rlKey);
      return json({ error: '已创建首个账号，请配置 REGISTER_KEY 后再开放注册' }, 403);
    }
  }

  const record = await hashPassword(password, env);
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

  const users = safeParseArray(await env.NAV_KV.get('meta:users'));
  if (!users.includes(username)) {
    users.push(username);
    await env.NAV_KV.put('meta:users', JSON.stringify(users));
  }

  await clearRateLimit(env, rlKey);
  return createSession(request, env, username);
}

async function login(request, env) {
  if (isPublicMode(env)) {
    return json({ error: '公开模式无需登录' }, 400);
  }
  const body = await readJson(request);
  const username = normalizeUsername(body.username);

  if (!username || typeof body.password !== 'string') {
    return json({ error: '请输入用户名和密码' }, 400);
  }

  const rlKey = `login:${clientIp(request)}:${username}`;

  // 先验证凭据：密码正确永远放行，避免别人用失败尝试把账号锁死。
  const raw = await env.NAV_KV.get(`user:${username}`);
  const ok = raw ? await verifyPassword(body.password, JSON.parse(raw)) : false;

  if (ok) {
    await clearRateLimit(env, rlKey);
    return createSession(request, env, username);
  }

  const limited = await hitLimit(env, rlKey);
  if (limited) return tooManyRequests(limited);

  await recordFailure(env, rlKey);
  return json({ error: '用户名或密码错误' }, 401);
}

async function logout(request, env) {
  const token = readSessionToken(request);
  if (token) {
    await env.NAV_KV.delete(`session:${token}`);
  }

  return json({ ok: true }, 200, { 'Set-Cookie': clearedSessionCookies() });
}

// 两个名字都清，覆盖 http 与 https 下分别写入过的会话 Cookie。
function clearedSessionCookies() {
  const clear = (name, secure) =>
    [`${name}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0', secure ? 'Secure' : '']
      .filter(Boolean)
      .join('; ');
  return [clear(SESSION_COOKIE, false), clear(SECURE_SESSION_COOKIE, true)];
}

// 改密码：验证当前密码 → 写回新哈希 → 让所有旧会话失效 → 给当前设备发新会话。
async function changePassword(request, env) {
  if (isPublicMode(env)) return json({ error: '公开模式没有账号密码' }, 400);

  const session = await loadSession(request, env);
  if (!session) return json({ error: '未登录' }, 401);
  const username = session.session.username;

  const body = await readJson(request);
  const current = body.currentPassword;
  const next = body.newPassword;

  if (typeof current !== 'string' || typeof next !== 'string') {
    return json({ error: '请输入当前密码和新密码' }, 400);
  }
  if (next.length < 8 || next.length > 128) {
    return json({ error: '新密码长度需为 8-128 位' }, 400);
  }

  const rlKey = `password:${clientIp(request)}:${username}`;
  const limited = await hitLimit(env, rlKey);
  if (limited) return tooManyRequests(limited);

  const raw = await env.NAV_KV.get(`user:${username}`);
  if (!raw) return json({ error: '未登录' }, 401);

  const record = JSON.parse(raw);
  const ok = await verifyPassword(current, record);
  if (!ok) {
    await recordFailure(env, rlKey);
    return json({ error: '当前密码不正确' }, 401);
  }

  const fresh = await hashPassword(next, env);
  await env.NAV_KV.put(
    `user:${username}`,
    JSON.stringify({
      ...record,
      salt: fresh.salt,
      hash: fresh.hash,
      iterations: fresh.iterations,
      updatedAt: new Date().toISOString(),
    })
  );

  await clearRateLimit(env, rlKey);
  await env.NAV_KV.delete(`session:${session.token}`);
  await bumpUserVersion(env, username);
  return createSession(request, env, username);
}

// 登出全部设备：把会话版本往后推一位，所有旧会话（含当前设备）立刻失效。
async function logoutAll(request, env) {
  if (isPublicMode(env)) return json({ error: '公开模式没有会话' }, 400);

  const session = await loadSession(request, env);
  if (!session) return json({ error: '未登录' }, 401);

  await env.NAV_KV.delete(`session:${session.token}`);
  await bumpUserVersion(env, session.session.username);

  return json({ ok: true }, 200, { 'Set-Cookie': clearedSessionCookies() });
}

// 会话版本：改密码 / 登出全部设备时换一个新值，旧会话因版本不匹配而失效。
// 用单键换值代替遍历删除会话，KV 上没有 list 也能做到（也避免逐条 delete）。
async function getUserVersion(env, username) {
  const raw = await env.NAV_KV.get(`userver:${username}`);
  return typeof raw === 'string' && raw ? raw : '0';
}

async function bumpUserVersion(env, username) {
  const next = randomBytesHex(8);
  await env.NAV_KV.put(`userver:${username}`, next);
  return next;
}


async function getSites(request, env) {
  const auth = await requireUsername(request, env);
  if (!auth) return json({ error: '未登录' }, 401);

  const sites = safeParseArray(await env.NAV_KV.get(`sites:${auth.username}`));
  const settings = await readSettings(env, auth.username);
  return json({ sites, settings }, 200, auth.headers);
}

async function putSites(request, env) {
  const auth = await requireUsername(request, env);
  if (!auth) return json({ error: '未登录' }, 401);

  if (isPublicReadonly(env) && !hasPublicWriteKey(request, env)) {
    return json({ error: '公开模式已设为只读，禁止匿名编辑' }, 403);
  }

  const body = await readJson(request);
  const sites = sanitizeSites(body.sites);
  if (sites === null) {
    return json({ error: `站点数据格式不正确：名称与链接必填、链接仅支持 http/https，且不能超过 ${MAX_SITES} 个站点` }, 400);
  }

  const parsed = readSettingsPatch(body);
  if (parsed.kind === 'invalid') {
    return json({ error: '标题与副标题必须是字符串或 null，密度只能是 compact 或 comfortable' }, 400);
  }

  let settings = null;
  if (parsed.kind === 'clear') {
    settings = {};
  } else if (parsed.kind === 'patch') {
    settings = applySettingsPatch(await readSettings(env, auth.username), parsed.patch);
  }

  await env.NAV_KV.put(`sites:${auth.username}`, JSON.stringify(sites));
  if (settings) {
    await env.NAV_KV.put(`settings:${auth.username}`, JSON.stringify(settings));
  }

  return json(
    { ok: true, sites, settings: settings || (await readSettings(env, auth.username)) },
    200,
    auth.headers
  );
}

// 读取当前身份：公开模式共用一份数据，账号模式要求有效会话。
async function requireUsername(request, env) {
  if (isPublicMode(env)) {
    return { username: PUBLIC_USER, headers: {} };
  }
  const session = await loadSession(request, env);
  if (!session) return null;

  const headers = {};
  if (await touchSession(env, session.token, session.session)) {
    headers['Set-Cookie'] = buildSessionCookie(request, session.token, SESSION_TTL_SECONDS);
  }
  return { username: session.session.username, headers };
}

async function loadSession(request, env) {
  const token = readSessionToken(request);
  if (!token) return null;

  const raw = await env.NAV_KV.get(`session:${token}`);
  if (!raw) return null;

  let session;
  try {
    session = JSON.parse(raw);
  } catch {
    await env.NAV_KV.delete(`session:${token}`);
    return null;
  }

  if (!session.username || !session.expires || session.expires < Date.now()) {
    await env.NAV_KV.delete(`session:${token}`);
    return null;
  }

  // 会话版本变了说明用户改过密码或登出了全部设备，这个 token 立即作废。
  // （旧数据没有 ver 字段，按 '0' 处理，与未改过密码的用户兼容。）
  const currentVer = await getUserVersion(env, session.username);
  if ((session.ver || '0') !== currentVer) {
    await env.NAV_KV.delete(`session:${token}`);
    return null;
  }

  return { token, session };
}

// 剩余有效期不足一半时才滑动续期，避免每个请求都写 KV。
async function touchSession(env, token, session) {
  const now = Date.now();
  const ttlMs = SESSION_TTL_SECONDS * 1000;
  if (session.expires - now > ttlMs / 2) return false;

  session.expires = now + ttlMs;
  await env.NAV_KV.put(`session:${token}`, JSON.stringify(session), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  return true;
}

async function createSession(request, env, username) {
  const token = randomBytesHex(32);
  const session = {
    username,
    ver: await getUserVersion(env, username),
    expires: Date.now() + SESSION_TTL_SECONDS * 1000,
  };
  await env.NAV_KV.put(`session:${token}`, JSON.stringify(session), {
    expirationTtl: SESSION_TTL_SECONDS,
  });

  return json({ username }, 200, {
    'Set-Cookie': buildSessionCookie(request, token, SESSION_TTL_SECONDS),
  });
}

// https 下用 __Host- 前缀（要求 Secure + Path=/ 且无 Domain），http 本地开发回退普通名。
function buildSessionCookie(request, token, maxAgeSeconds) {
  const secure = isSecureRequest(request);
  const name = secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
  return [
    `${name}=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

function readSessionToken(request) {
  // https 下只认 __Host- 前缀，避免同级子域写入的普通 nav_session 被当成有效会话（会话固定）。
  if (isSecureRequest(request)) return readCookie(request, SECURE_SESSION_COOKIE);
  return readCookie(request, SESSION_COOKIE);
}

function isSecureRequest(request) {
  return request.url.startsWith('https://');
}

function sanitizeSites(input) {
  if (!Array.isArray(input) || input.length > MAX_SITES) return null;

  const output = [];
  const usedIds = new Set();

  for (const item of input) {
    if (!item || typeof item !== 'object') return null;

    const name = cleanString(item.name, 50);
    const url = cleanString(item.url, 500);
    if (!name || !url) return null;
    if (!isHttpUrl(url)) return null;

    let id = cleanString(item.id, 40) || newSiteId();
    if (usedIds.has(id)) id = newSiteId();
    usedIds.add(id);

    // 可选字段只在真正有值时才写入输出，保证旧数据序列化结果不变。
    const site = {
      id,
      name,
      url,
      desc: cleanString(item.desc, 100),
      category: cleanString(item.category, 30) || '常用',
      // 不再用站点名首字兜底：留空表示「交给 /api/icon 抓 favicon」，
      // 否则 icon 永远非空，前端就永远不会去请求图标代理。
      icon: cleanString(item.icon, 8),
    };
    if (item.pinned === true) site.pinned = true;
    const keywords = cleanString(item.keywords, 100);
    if (keywords) site.keywords = keywords;
    // 标签：显示在卡片上、可点开筛选（与「别名」不同，别名只用于搜索、不显示）
    const tags = cleanString(item.tags, 100);
    if (tags) site.tags = tags;
    // 备注：私有文本，可在卡片上查看，会随 JSON 导出一起走
    const note = cleanString(item.note, 200);
    if (note) site.note = note;

    output.push(site);
  }
  return output;
}

// favicon 同源代理：域名严格校验 + KV 长缓存，失败一律 404，绝不把上游错误抛成 500。
async function getIcon(request, env) {
  const domain = new URL(request.url).searchParams.get('domain');
  if (!isValidDomain(domain)) return json({ error: '域名不合法' }, 400);

  const cacheKey = `icon:${domain}`;
  const cached = safeParseObject(await env.NAV_KV.get(cacheKey));
  if (typeof cached.contentType === 'string' && typeof cached.base64 === 'string') {
    return iconResponse(base64ToBytes(cached.base64), cached.contentType);
  }

  const doFetch = env.ICON_FETCH || fetch;
  const controller = new AbortController();
  // 计时器要一直活到读完响应体，否则上游可以回头之后无限慢地吐 body。
  const timer = setTimeout(() => controller.abort(), ICON_TIMEOUT_MS);

  try {
    const upstream = await doFetch(`https://${domain}/favicon.ico`, {
      signal: controller.signal,
      headers: { 'User-Agent': ICON_USER_AGENT },
    });

    if (!upstream || !upstream.ok) return json({ error: '图标不可用' }, 404);

    const contentType = (upstream.headers.get('content-type') || '').split(';')[0].trim();
    if (!contentType.toLowerCase().startsWith('image/')) return json({ error: '图标不可用' }, 404);

    // 先看 content-length，避免把超大响应整块读进内存。
    const declared = Number(upstream.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > ICON_MAX_BYTES) {
      return json({ error: '图标不可用' }, 404);
    }

    const bytes = new Uint8Array(await upstream.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > ICON_MAX_BYTES) {
      return json({ error: '图标不可用' }, 404);
    }

    return await cacheAndReturnIcon(env, cacheKey, bytes, contentType);
  } catch {
    // 网络错误、超时（含读体阶段被 abort）、读体失败都走这里
    return json({ error: '图标不可用' }, 404);
  } finally {
    clearTimeout(timer);
  }
}

async function cacheAndReturnIcon(env, cacheKey, bytes, contentType) {
  try {
    await env.NAV_KV.put(
      cacheKey,
      JSON.stringify({ contentType, base64: bytesToBase64(bytes) }),
      { expirationTtl: ICON_CACHE_TTL_SECONDS }
    );
  } catch {
    // 缓存写失败不影响本次返回
  }
  return iconResponse(bytes, contentType);
}
// 只接受纯 host：长度、必须含点、字符集白名单，杜绝协议/路径/端口/凭据/空白。
function isValidDomain(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) return false;
  if (!value.includes('.')) return false;
  return DOMAIN_PATTERN.test(value);
}

function iconResponse(bytes, contentType) {
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=604800, immutable',
    },
  });
}

function newSiteId() {
  return `${Date.now()}-${randomBytesHex(4)}`;
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// 返回 { kind }：none = 未提供（保持现状）、clear = 清空自定义、patch = 合并字段、invalid = 类型不合法
function readSettingsPatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { kind: 'none' };
  if (!('settings' in input) || input.settings === undefined) return { kind: 'none' };

  const raw = input.settings;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'clear' };

  const limits = { title: 50, subtitle: 100 };
  const patch = {};
  for (const key of Object.keys(limits)) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (value === null) {
      patch[key] = null;
      continue;
    }
    // 传了非字符串就明确报错，而不是静默把用户的标题删掉。
    if (typeof value !== 'string') return { kind: 'invalid' };
    patch[key] = cleanString(value, limits[key]) || null;
  }

  // density 只有紧凑/舒适两种值，缺省不动、null 清空、其它一律 invalid。
  if ('density' in raw) {
    const density = raw.density;
    if (density === null) patch.density = null;
    else if (typeof density !== 'string' || !DENSITY_VALUES.includes(density)) return { kind: 'invalid' };
    else patch.density = density;
  }
  return { kind: 'patch', patch };
}

function applySettingsPatch(current, patch) {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    // 显式空值 = 清空该字段，前端会回退到默认文案。
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

async function readSettings(env, username) {
  const parsed = safeParseObject(await env.NAV_KV.get(`settings:${username}`));
  const settings = {};
  if (typeof parsed.title === 'string' && parsed.title) settings.title = parsed.title;
  if (typeof parsed.subtitle === 'string' && parsed.subtitle) settings.subtitle = parsed.subtitle;
  if (DENSITY_VALUES.includes(parsed.density)) settings.density = parsed.density;
  return settings;
}

function cleanString(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function safeParseArray(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeParseObject(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeUsername(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().toLowerCase();
  if (!/^[\p{L}\p{N}_]{2,32}$/u.test(name)) return null;
  return name;
}

function isPublicMode(env) {
  const value = env.PUBLIC_MODE;
  return value === 'true' || value === '1';
}

// 公开模式默认只读：只有显式把 PUBLIC_READONLY 设为 false 才允许匿名写入。
function isPublicReadonly(env) {
  // 同时接受字符串 'false' 与 TOML 布尔 false，避免配置写了却毫无提示地仍只读
  return isPublicMode(env) && env.PUBLIC_READONLY !== 'false' && env.PUBLIC_READONLY !== false;
}

function hasPublicWriteKey(request, env) {
  return Boolean(env.PUBLIC_WRITE_KEY) && request.headers.get('x-nav-write-key') === env.PUBLIC_WRITE_KEY;
}

function isSameOrigin(request) {
  const origin = request.headers.get('Origin');
  // 无 Origin 的非浏览器请求（脚本、测试）交给 SameSite Cookie 兜底。
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

function clientIp(request) {
  // 只信任 Cloudflare 注入的头；不接受 X-Forwarded-For，避免伪造头绕过限流。
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

async function hitLimit(env, key) {
  const state = await readRateState(env, key);
  if (!state || state.count < RATE_LIMIT_MAX_ATTEMPTS) return null;
  return Math.ceil((state.resetAt - Date.now()) / 1000);
}

async function readRateState(env, key) {
  // KV 读默认带边缘缓存，显式关闭以减少并发下计数滞后的影响。
  const raw = await env.NAV_KV.get(`rl:${key}`, { cacheTtl: 0 });
  if (!raw) return null;

  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!state || typeof state.count !== 'number' || typeof state.resetAt !== 'number') return null;
  if (Date.now() >= state.resetAt) return null;
  return state;
}

async function recordFailure(env, key) {
  const state = (await readRateState(env, key)) || {
    count: 0,
    resetAt: Date.now() + RATE_LIMIT_WINDOW_SECONDS * 1000,
  };
  state.count += 1;
  await env.NAV_KV.put(`rl:${key}`, JSON.stringify(state), {
    expirationTtl: RATE_LIMIT_WINDOW_SECONDS,
  });
}

async function clearRateLimit(env, key) {
  await env.NAV_KV.delete(`rl:${key}`);
}

function tooManyRequests(retryAfterSeconds) {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return json({ error: `尝试次数过多，请在 ${minutes} 分钟后重试` }, 429, {
    'Retry-After': String(retryAfterSeconds),
  });
}

// 免费版 Workers/Pages 每次请求只有 10ms CPU（付费 5 分钟），而 PBKDF2 的 CPU 开销
// 基本由迭代次数决定：10 万次在原生实现下约 20ms，会直接触发 CPU 超限（表现为 500）。
// 所以默认取 2.5 万次（约 3-5ms），并留一个环境变量方便按计划调整。
const DEFAULT_PBKDF2_ITERATIONS = 25000;
const MIN_PBKDF2_ITERATIONS = 1000;
const MAX_PBKDF2_ITERATIONS = 200000;

function pbkdf2Iterations(env) {
  const raw = Number(env && env.PBKDF2_ITERATIONS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PBKDF2_ITERATIONS;
  return Math.min(MAX_PBKDF2_ITERATIONS, Math.max(MIN_PBKDF2_ITERATIONS, Math.floor(raw)));
}

async function hashPassword(password, env) {
  const salt = randomBytes(16);
  // 迭代次数写进用户记录：以后改默认值不会让已有账号登不进来
  const iterations = pbkdf2Iterations(env);
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
  const headers = new Headers(JSON_HEADERS);
  for (const [key, value] of Object.entries(extraHeaders)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  return new Response(JSON.stringify(data), { status, headers });
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "style-src 'self'",
    "script-src 'self'",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; '),
};

// 统一给任意响应补上安全头，Pages Functions 与 Workers 两个入口共用。
function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export { handleApi, json, withSecurityHeaders };
