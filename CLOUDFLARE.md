# Cloudflare Pages 零本地部署

本项目已经按 Cloudflare Pages 结构组织：

- `public/`：前端静态文件
- `functions/`：API 函数（登录、注册、会话、站点读写）
- 推送到 GitHub 后，在 Cloudflare 连接仓库即可自动部署，本地不需要安装 Node 或 Wrangler

## 1. 确认代码在 GitHub

仓库地址：<https://github.com/yannlie/cf-personal-nav>

## 2. 创建 KV 命名空间

1. 打开 <https://dash.cloudflare.com> 并登录
2. 左侧 `Workers & Pages` -> `KV` -> `Create a namespace`
3. 名称填 `NAV_KV`，创建后复制 namespace id

## 3. 创建 Pages 项目并连接 GitHub

1. `Workers & Pages` -> `Create` -> `Pages` -> `Connect to Git`
2. 选择 `yannlie/cf-personal-nav`
3. 构建配置：
   - Framework preset: `None`
   - Build command: 留空
   - Build output directory: `/public`
4. 点击 `Save and Deploy`

## 4. 绑定 KV

1. 进入刚创建的 Pages 项目
2. `Settings` -> `Functions` -> `KV namespace bindings`
3. `Add binding`：
   - Variable name: `NAV_KV`
   - KV namespace: 选择 `NAV_KV`
4. 保存后重新部署一次（`Deployments` -> `Retry deployment`）

## 5. 配置模式

1. `Settings` -> `Environment variables`
2. 账号模式（默认）：新增 `REGISTER_KEY`，类型选 `Secret`，值填你的注册码
3. 公开模式（可选）：新增 `PUBLIC_MODE`，值填 `true`
4. 保存后重新部署一次

## 6. 部署完成

Cloudflare 会提供 `https://<项目名>.pages.dev` 地址。

之后每次 push 到 GitHub 的 `main` 分支，Cloudflare 会自动重新部署。

## 7. 自定义域名（可选）

Pages 项目 -> `Custom domains` -> `Set up a custom domain`，输入你的域名。

## 两种模式

- 账号模式：注册需要 `REGISTER_KEY`，每个账号有独立的站点列表
- 公开模式：`PUBLIC_MODE=true`，无需登录，所有人共用一份站点列表
