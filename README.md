# CF 个人导航

一个可完全托管在 Cloudflare 边缘的个人导航站。支持多账户隔离，也可以切换成不需要登录的公开模式；代码推到 GitHub 后由 Cloudflare Pages 自动部署，本地不用安装任何运行环境。

项目仓库：<https://github.com/yannlie/cf-personal-nav>

## 功能

- 用户名密码注册/登录，密码使用 PBKDF2 加盐哈希保存
- HttpOnly 会话 Cookie，有效期 7 天，会话存在 KV 中
- 每个账户独立的站点列表
- 公开模式：设置 `PUBLIC_MODE=true` 后无需登录，所有人共用一份站点列表
- 页面内编辑站点：名称、链接、描述、分组、图标
- 搜索过滤、深浅色模式、移动端适配

## 部署（推荐，无需本地环境）

在 Cloudflare 网页端连接 GitHub 仓库即可自动部署，详细步骤见 [CLOUDFLARE.md](CLOUDFLARE.md)，部署概览见 [DEPLOY.md](DEPLOY.md)。

## 本地开发（可选）

```bash
npm install
npm run dev
```

不安装依赖时：

```bash
npm run dev:local
```

## 目录结构

```text
public/                    前端静态资源
functions/                 Cloudflare Pages API
  api/[[path]].js          /api/* 的统一入口
  _lib/core.js             登录、注册、会话、站点读写逻辑
src/index.js               可选的 Workers 入口，复用同一套逻辑
test/                      自动化测试
wrangler.toml              可选 Wrangler 配置
```

## API

- `GET /api/config`：返回当前是否公开模式
- `POST /api/register`：`{ username, password, registerKey? }`
- `POST /api/login`：`{ username, password }`
- `POST /api/logout`
- `GET /api/me`
- `GET /api/sites`
- `PUT /api/sites`：`{ sites: [...] }`

KV 键结构：`user:<用户名>`、`session:<token>`、`sites:<用户名>`、`meta:users`。

## 测试

```bash
npm test
```
