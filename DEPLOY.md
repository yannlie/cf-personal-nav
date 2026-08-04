# 部署与发布

## 推荐：Cloudflare Pages（网页端，零本地部署）

详细步骤见 [CLOUDFLARE.md](CLOUDFLARE.md)。核心流程：

1. 代码已推送到 GitHub：<https://github.com/yannlie/cf-personal-nav>
2. 打开 <https://dash.cloudflare.com>，进入 `Workers & Pages`
3. `Create` -> `Pages` -> `Connect to Git`，选择 `yannlie/cf-personal-nav`
4. 构建输出目录填 `/public`
5. 创建 KV 命名空间 `NAV_KV`，并在 Pages 项目里绑定为 `NAV_KV`
6. 配置环境变量：
   - 账号模式（默认）：新增 `REGISTER_KEY`，类型选 Secret
   - 公开模式（可选）：新增 `PUBLIC_MODE`，值填 `true`
7. 保存并重新部署，Cloudflare 会提供 `*.pages.dev` 地址

之后每次 push 到 GitHub 的 `main` 分支，Cloudflare 会自动重新部署。

## 可选：本地 Wrangler 部署

如果更习惯命令行：

```bash
npm install
npx wrangler login
npx wrangler kv namespace create NAV_KV
```

把输出的 namespace id 填入 `wrangler.toml`，然后：

```bash
npx wrangler secret put REGISTER_KEY
npm run deploy
```

## 本地开发（可选）

```bash
npm run dev
```

零依赖开发服务器：

```bash
npm run dev:local
```

## 常见问题

- 注册码丢了：在 Cloudflare 网页端重新设置 `REGISTER_KEY` 环境变量并重新部署。
- 站点数据消失：确认 KV 绑定名是 `NAV_KV`，且指向同一个命名空间。
- 忘记账号密码：删除 KV 中 `user:<用户名>` 后重新注册。
