import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/index.js';

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

const env = {
  NAV_KV: new FakeKV(),
  ASSETS: {
    async fetch(request) {
      const url = new URL(request.url);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === '/') pathname = '/index.html';

      const filePath = path.normalize(path.join(publicDir, pathname));
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
        const fallback = await fs.promises.readFile(path.join(publicDir, 'index.html'));
        return new Response(fallback, {
          headers: { 'Content-Type': MIME['.html'] },
        });
      }
    },
  },
};

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = `http://${req.headers.host || 'localhost'}${req.url}`;
    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: body.length ? body : undefined,
    });

    const response = await worker.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
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
