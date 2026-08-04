# 部署步骤

## 1. 上传到 GitHub

1. 打开 <https://github.com/new>，新建一个仓库：
   - 仓库名建议使用 `cf-personal-nav`
   - 可见性按你的需要选择 Public 或 Private
   - 不要勾选 “Add a README file”，避免和本地文件冲突
2. 在项目目录执行以下命令：

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<你的用户名>/cf-personal-nav.git
git push -u origin main
```

3. 如果 Git 弹出登录窗口，用 GitHub 账号登录即可。也可以先安装并登录 GitHub CLI：

```bash
gh auth login
```

## 2. 创建 Cloudflare KV 命名空间

在项目目录执行：

```bash
npm install
npx wrangler kv namespace create NAV_KV
```

把输出中的 namespace id 填入 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "NAV_KV"
id = "刚创建的 namespace id"
preview_id = "刚创建的 namespace id"
```

## 3. 本地验证

```bash
npm run dev
```

打开 `http://localhost:8787`。首次注册不需要注册码，之后的账号需要 `REGISTER_KEY`。

如果不想安装依赖，也可以运行：

```bash
npm run dev:local
```

然后打开 `http://localhost:8788`。

## 4. 设置注册码

建议部署前设置，防止任何人注册：

```bash
npx wrangler secret put REGISTER_KEY
```

输入一个只有你知道的注册码。之后注册新账号时需要填写这个注册码。

## 5. 部署到 Cloudflare

```bash
npm run deploy
```

部署完成后，Cloudflare 会输出一个 `*.workers.dev` 域名，用浏览器打开即可使用。

## 6. 绑定自定义域名（可选）

1. 打开 Cloudflare Dashboard，进入 `Workers & Pages`
2. 选择这个项目，进入 `Settings` -> `Domains & Routes`
3. 点击 `Add Custom Domain`，输入你的域名并确认 DNS 解析

## 7. 常见问题

- 注册码丢了：重新执行 `npx wrangler secret put REGISTER_KEY`，然后再次 `npm run deploy`。
- 站点数据消失：确认 `wrangler.toml` 中的 KV namespace id 已替换，并已重新部署。
- 忘记账号密码：目前没有找回功能，可以删除 KV 中的 `user:<用户名>` 后重新注册。
