// 零依赖本地开发服务器：直接复用生产入口（Pages Functions → core.js），
// 静态资源手工从 public/ 读取，行为尽量贴近 Cloudflare Pages。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi, withSecurityHeaders } from '../functions/_lib/core.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const port = Number(process.env.PORT || 8788);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// KV 替身：进程内存，重启即清空。
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

async function serveAsset(request) {
  const url = new URL(request.url);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  // Pages 从不把 _headers / _redirects 当资源发布，本地也保持一致
  if (path.basename(pathname).startsWith('_')) {
    return new Response('Not found', { status: 404 });
  }

  const filePath = path.normalize(path.join(publicDir, pathname));
  // 目录穿越保护
  if (!filePath.startsWith(publicDir)) {
    return new Response('Not found', { status: 404 });
  }

  try {
    const data = await fs.promises.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    return new Response(data, {
      headers: { 'Content-Type': MIME[ext] || 'application/octet-stream' },
    });
  } catch {
    // 单页应用：找不到的路径回落到 index.html
    const fallback = await fs.promises.readFile(path.join(publicDir, 'index.html'));
    return new Response(fallback, { headers: { 'Content-Type': MIME['.html'] } });
  }
}

const env = {
  NAV_KV: new FakeKV(),
  PUBLIC_MODE: process.env.PUBLIC_MODE,
  PUBLIC_READONLY: process.env.PUBLIC_READONLY,
  PUBLIC_WRITE_KEY: process.env.PUBLIC_WRITE_KEY,
  REGISTER_KEY: process.env.REGISTER_KEY,
  // 排查用（与 Pages 环境变量同名，方便本地复现线上问题）
  DEBUG_ERRORS: process.env.DEBUG_ERRORS,
  PBKDF2_ITERATIONS: process.env.PBKDF2_ITERATIONS,
};

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = `http://${req.headers.host || 'localhost'}${req.url}`;
    const request = new Request(url, {
      method: req.method,
      headers: {
        ...req.headers,
        // 本地没有 Cloudflare 边缘，补一个等效的客户端 IP 供限流使用。
        'CF-Connecting-IP': req.socket.remoteAddress || '127.0.0.1',
      },
      body: body.length ? body : undefined,
    });

    // 和 Pages 一样：/api/* 交给 Functions，其余走静态资源。
    // 生产环境的静态安全头来自 public/_headers，这里统一用同一套补上。
    const isApi = new URL(request.url).pathname.startsWith('/api/');
    const response = withSecurityHeaders(isApi ? await handleApi(request, env) : await serveAsset(request));

    const headers = {};
    for (const [key, value] of response.headers.entries()) {
      if (key.toLowerCase() !== 'set-cookie') headers[key] = value;
    }
    // Headers.entries() 会把多条 Set-Cookie 合并成一条，必须单独取。
    const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
    if (cookies.length) headers['Set-Cookie'] = cookies;

    res.writeHead(response.status, headers);
    const payload = await response.arrayBuffer();
    res.end(Buffer.from(payload));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(error instanceof Error ? error.message : '服务器错误');
  }
});

server.listen(port, () => {
  console.log(`Local nav dev server: http://127.0.0.1:${port}`);
});
