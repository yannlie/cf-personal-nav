# 部署到 Cloudflare（Pages）

项目只有一条部署路径：**Cloudflare Pages**。仓库里没有需要本地构建的东西，
把 GitHub 仓库连上 Pages 就能跑。

- `functions/api/[[path]].js` → 所有 `/api/*` 请求（共享逻辑在 `functions/_lib/core.js`，`_` 开头不会被当成路由暴露）
- `public/` → 静态资源，Pages 的输出目录
- `public/_headers` → 静态资源的安全响应头（CSP 等），由平台读取

> 项目**没有** Workers 入口。以前有的 `src/index.js` 已移除，避免两套入口改一处忘一处。

---

## 一、零本地环境：网页端连 GitHub（推荐）

### 1. 代码在 GitHub

`https://github.com/yannlie/cf-personal-nav`，推到 `main` 分支即可。

### 2. 建 KV 命名空间

1. <https://dash.cloudflare.com> → `Workers & Pages` → `KV` → `Create a namespace`
2. 名称填 `NAV_KV`，创建后**复制 namespace id**（后面不用它，绑定时选名字即可）

### 3. 建 Pages 项目

`Workers & Pages` → `Create` → `Pages` → `Connect to Git` → 选 `yannlie/cf-personal-nav`

构建配置：

| 项 | 值 |
| --- | --- |
| Framework preset | `None` |
| Build command | 留空 |
| Build output directory | `public` |

点 `Save and Deploy`。

### 4. 绑 KV（关键，不绑就没法登录/存数据）

项目 → `Settings` → `Functions` → `KV namespace bindings` → `Add binding`：

| 项 | 值 |
| --- | --- |
| Variable name | `NAV_KV`（必须叫这个名字） |
| KV namespace | 选第 2 步建的 `NAV_KV` |

保存后到 `Deployments` → `Retry deployment` 重新部署一次。

### 5. 配环境变量

`Settings` → `Environment variables`：

| 变量 | 类型 | 说明 |
| --- | --- | --- |
| `REGISTER_KEY` | Secret | 账号模式的注册码。**首个账号不需要它**，之后注册都要 |
| `PUBLIC_MODE` | 明文 | 想免登录共用一份列表就填 `true` |
| `PUBLIC_READONLY` | 明文 | 公开模式默认只读；填 `false` 才允许匿名写入 |
| `PUBLIC_WRITE_KEY` | Secret | 公开模式只读时，带 `x-nav-write-key` 请求头才能写 |

保存后同样重新部署一次。

### 6. 访问

Cloudflare 会给 `https://<项目名>.pages.dev`。之后每次 push 到 `main` 自动重新部署。

想用自己的域名：项目 → `Custom domains` → `Set up a custom domain`。

---

## 二、可选：命令行部署

装好 Node 后：

```bash
npx wrangler pages deploy public --project-name cf-personal-nav
```

本地带 KV 跑一遍（需要 `wrangler.toml` 里的 KV id 换成你自己的）：

```bash
npx wrangler kv namespace create NAV_KV   # 把输出的 id 填进 wrangler.toml
npx wrangler pages dev public
```

---

## 三、本地开发

不装任何依赖就能跑（零依赖开发服务器，直接复用 Pages 的 API 入口）：

```bash
node scripts/dev-server.mjs
# 或
npm run dev
```

打开 <http://127.0.0.1:8788>。数据存在内存里，重启即清空。

想看公开模式：`PUBLIC_MODE=true node scripts/dev-server.mjs`。

---

## 四、自检清单

部署完按这几条确认：

1. `https://<域名>/api/config` 返回 `{"publicMode":false,"readonly":false}` —— 返回 500/502 说明 KV 没绑好
2. 打开首页能注册（首个账号不需要注册码）
3. 随便加一个站点、刷新页面后还在 —— 说明 KV 读写在正常工作
4. 站点图标能显示（走 `/api/icon` 同源代理，抓不到就回退首字母方块）

## 五、常见问题

- **接口全部 500**：KV 绑定名不是 `NAV_KV`，或绑完后没重新部署。
- **注册提示「已创建首个账号」**：说明 KV 里已经有账号了；要么用注册码，要么清掉 KV。
- **公开模式下改不了东西**：这是默认行为（默认只读）。设 `PUBLIC_READONLY=false`，或配 `PUBLIC_WRITE_KEY`。
- **忘记密码**：现在可以在界面里自助改密码（右上角用户名 → 修改密码）；完全进不去就删 KV 里的 `user:<用户名>` 重新注册。
- **图标一直是首字母方块**：目标站点没有 `/favicon.ico`，或网络抓不到；这是正常的回退行为。
- **页面样式/脚本没生效**：确认 Pages 的 Build output directory 填的是 `public`（不是 `/public` 之外的东西，也不是仓库根目录）。
