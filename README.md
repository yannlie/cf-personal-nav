# CF 个人导航

一个可部署到 Cloudflare Workers 的个人导航站。每个账户有独立的站点列表，登录后可在页面上直接增删改。

项目仓库：<https://github.com/yannlie/cf-personal-nav>

## 功能

- 用户名密码注册/登录，密码使用 PBKDF2 加盐哈希保存
- HttpOnly 会话 Cookie，有效期 7 天，会话存在 KV 中
- 每个账户独立的站点数据
- 页面内编辑站点：名称、链接、描述、分组、图标
- 搜索过滤、深浅色模式、移动端适配

## 本地开发

```bash
npm install
npm run dev
```

打开 `http://localhost:8787`。本地首次注册不需要注册码，之后的账号注册需要先配置 `REGISTER_KEY`。

如果不想安装依赖，也可以用内置的零依赖开发服务器：

```bash
npm run dev:local
```

打开 `http://localhost:8788`。

## 部署到 Cloudflare

完整步骤见 [DEPLOY.md](DEPLOY.md)，下面是最简流程：

1. 创建 KV 命名空间：

```bash
npx wrangler kv namespace create NAV_KV
```

2. 把输出的 namespace id 填入 `wrangler.toml` 的 `id` 和 `preview_id`。

3. 设置注册码（可选，但公开部署建议设置）：

```bash
npx wrangler secret put REGISTER_KEY
```

4. 部署：

```bash
npm run deploy
```

部署完成后访问输出的 Workers 域名即可。首个账号可直接注册；若配置了 `REGISTER_KEY`，注册时需要填写对应注册码。

## 测试

```bash
npm test
```

## 目录结构

```text
public/         前端静态资源
src/index.js    Worker 入口和 API
test/           Node 自动化测试
wrangler.toml   Cloudflare 配置
```

## API

- `POST /api/register`：`{ username, password, registerKey? }`
- `POST /api/login`：`{ username, password }`
- `POST /api/logout`
- `GET /api/me`
- `GET /api/sites`
- `PUT /api/sites`：`{ sites: [...] }`

KV 键结构：`user:<用户名>`、`session:<token>`、`sites:<用户名>`、`meta:users`。
