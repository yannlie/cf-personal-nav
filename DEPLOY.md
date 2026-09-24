# 部署到 Cloudflare（Pages）

这个项目只有一条部署路径：**Cloudflare Pages**。仓库里没有需要构建的东西，
把 GitHub 仓库连上 Pages 就行，本地不用装 Node、不用跑命令。

先说清楚各部分的作用：

| 位置 | 作用 |
| --- | --- |
| `functions/api/[[path]].js` | 所有 `/api/*` 请求的入口（共享逻辑在 `functions/_lib/core.js`） |
| `functions/_lib/` | 以 `_` 开头，Pages 不会把它当公开路由暴露 |
| `public/` | 静态资源，也是 Pages 的「输出目录」 |
| `public/_headers` | 静态资源的安全响应头（CSP 等），由平台读取 |
| `wrangler.toml` | **仓库里刻意不放**：它一旦存在就会接管 Pages 的绑定与环境变量配置。命令行部署时自建一份，见文末 |

> 项目**没有** Workers 入口。以前有的 `src/index.js` 已移除，避免两套入口改一处忘一处。

**部署一共 5 步，只需做一次。** 之后每次 push 到 `main` 都会自动重新部署，数据不会丢
（数据存在 KV 里，不在代码里）。

---

## 步骤 0：确认代码已在 GitHub

`https://github.com/yannlie/cf-personal-nav`，`main` 分支上应该能看到
`public/js/`、`functions/`、`public/_headers` 这些文件。

---

## 步骤 1：建一个 KV 命名空间

KV 是存放账号和站点数据的地方。

1. 打开 <https://dash.cloudflare.com>，登录
2. 左侧选 `Workers & Pages`（新版界面里可能叫 `Compute (Workers)`）
3. 进 `KV` → `Create a namespace` / `Create instance`
4. 名称填 **`NAV_KV`**（名字随意，但下面绑定时的变量名必须是 `NAV_KV`）
5. 创建

预期结果：列表里出现一个 `NAV_KV`。创建后页面会显示 namespace id ——
**只有走命令行部署才需要它**，走网页端不用记。

---

## 步骤 2：建 Pages 项目并连上仓库

1. `Workers & Pages` → `Create`
2. 选 **`Pages`** 标签页 → `Connect to Git`
   （新界面里可能显示为 `Import an existing Git repository`，或页面底部的
   `Looking to deploy a Pages project?` 链接。关键是选 **Pages**，不是 Workers）
3. 授权 GitHub 并选择仓库 `yannlie/cf-personal-nav`
4. 选择 `main` 分支
5. 构建配置：

   | 项 | 填什么 |
   | --- | --- |
   | Framework preset | `None` |
   | Build command | **留空**（本项目不需要构建） |
   | Build output directory | **`public`**（不要写 `/public`，也不要留空） |

6. 点 `Save and Deploy`

预期结果：第一次构建会跑几十秒，然后给你一个 `https://<项目名>.pages.dev`。
**这时页面能打开，但还不能登录**——因为 KV 还没绑定（下一步）。

> 如果界面只让你建 Workers（找不到 Pages）：直接改用命令行路径（见文末「命令行部署」），
> 或者在 `Workers & Pages` → `Create` 页面往下翻找 Pages 入口。项目结构是按 Pages 组织的。

---

## 步骤 3：绑定 KV（这一步不做就没法登录/存数据）

1. 进入刚创建的 Pages 项目
2. `Settings` → `Functions` → `KV namespace bindings` → `Add binding`
3. 填：

   | 项 | 填什么 |
   | --- | --- |
   | Variable name | **`NAV_KV`**（必须完全一致） |
   | KV namespace | 选步骤 1 建的 `NAV_KV` |

4. 保存
5. 左边 `Deployments` → 找到最新那条 → `Retry deployment`（让新绑定生效）

预期结果：重新部署完成后，访问 `https://<你的域名>/api/config`，
应返回 `{"publicMode":false,"readonly":false}`。
若返回 500 且提示「缺少 KV 绑定」，说明绑定没生效。

### ⚠️ 如果控制台里「Add binding」按钮不可用、不让改

原因：**仓库里只要存在 `wrangler.toml`，Cloudflare 就把它当作 Pages 配置的唯一真源**
（[官方说明](https://developers.cloudflare.com/pages/functions/wrangler-configuration/)：
“you must treat your file as the source of truth”），此时控制台的绑定界面不再生效。

两种修法，选一种：

| 修法 | 怎么做 | 适合谁 |
| --- | --- | --- |
| **删掉 `wrangler.toml`**（推荐） | 在 GitHub 网页打开该文件 → 右上角垃圾桶图标 → `Commit changes`。Cloudflare 会自动重新部署，之后控制台就能正常加绑定 | 用网页端连 GitHub 的（本仓库默认形态） |
| **把绑定写进文件** | 在 `wrangler.toml` 里加上 `[[kv_namespaces]]` / `binding = "NAV_KV"` / `id = "<你的 id>"`，提交后自动生效 | 想用命令行、或想让配置进版本库 |

走第二种的话，环境变量（`REGISTER_KEY` 等）建议一并在文件里用 `[vars]` 声明，
避免「一部分在文件、一部分在控制台」的混淆。

---

## 步骤 4：配环境变量

`Settings` → `Environment variables`（新版界面里叫 `Variables and Secrets`）。

先只配一个就能用：

| 变量 | 类型 | 值 | 说明 |
| --- | --- | --- | --- |
| `REGISTER_KEY` | **Secret** | 你自己定一串 | 注册码。**配上之后每次注册都要填它（包括第一个账号）**；不配的话只有第一个账号能注册 |

想免登录共用一份列表，再加：

| 变量 | 类型 | 值 | 说明 |
| --- | --- | --- | --- |
| `PUBLIC_MODE` | 明文 | `true` | 开启公开模式 |
| `PUBLIC_READONLY` | 明文 | `false` | ⚠️ 公开模式**默认只读**，填 `false` 才允许匿名访客编辑 |
| `PUBLIC_WRITE_KEY` | **Secret** | 你自己定一串 | 公开模式只读时，带 `x-nav-write-key` 请求头才能写 |

**注意 Production 与 Preview 是分开的。** Cloudflare 默认把变量加到 Production；
Preview（非 main 分支的预览部署）需要单独加一遍，否则预览环境里功能会缺一半。

保存后同样 `Deployments` → `Retry deployment` 一次。

---

## 步骤 5：打开站点，注册第一个账号

访问 `https://<项目名>.pages.dev`：

1. 点「注册」，填用户名和密码（密码 8 位以上）
2. 关于注册码，真实行为是这样的：
   - **配了 `REGISTER_KEY`**：注册时**必须**在「注册码」输入框填它，**第一个账号也一样**
   - **没配 `REGISTER_KEY`**：只有这第一个账号能注册成功，之后所有人注册都会被拒（提示「已创建首个账号，请配置 REGISTER_KEY 后再开放注册」）
3. 进去后可以点右上角 `导入常用站点包`，或自己加站点

---

## 部署后自检（建议逐条过一遍）

| 检查 | 期望结果 | 不符合说明什么 |
| --- | --- | --- |
| `https://<域名>/api/config` | `{"publicMode":false,"readonly":false}` | 返回 500 且提示「缺少 KV 绑定」→ KV 没绑或变量名不对 |
| 首页能打开且样式正常 | 卡片式界面，不是纯文字 | 构建输出目录填错了 |
| 能注册并登录 | 进入站点列表 | KV 读写有问题 |
| 加一个站点 → **刷新页面** | 站点还在 | KV 没写进去 |
| 站点图标 | 真图标或首字母彩色方块 | 目标站没有 favicon，会回退，正常 |
| 页面源码里有 `Content-Security-Policy` 响应头 | 有 | `public/_headers` 没被识别（确认输出目录是 `public`） |

> 我可以帮你跑这些检查：把部署后的域名（`xxx.pages.dev` 或你自己的域名）发我，
> 我会在线核对 `/api/config` 的返回值、安全响应头、以及静态资源的 MIME 类型。

---

## 自定义域名（可选）

Pages 项目 → `Custom domains` → `Set up a custom domain` → 输入你的域名 → 按提示加 DNS 记录。

**建议用 HTTPS 的自定义域名**：会话 Cookie 只在 https 下启用 `__Host-` 前缀
（更安全，能防子域篡改）。`*.pages.dev` 本身也是 https，所以默认就已经是安全状态。

---

## 数据在哪里，怎么备份

- 全部数据在 **KV** 里：`user:<用户名>`、`sites:<用户名>`、`settings:<用户名>` 等。
  重新部署代码不会影响它们。
- 页面内可自助导出：右上角第二个图标（数据菜单）→ `导出 JSON（可再导入）` 或 `导出书签 HTML`。
  建议定期导一份留底。
- 改密码 / 登出全部设备：点右上角用户名 → 对应菜单项。

---

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 接口全部 500 / 502，且提示「缺少 KV 绑定」 | KV 没绑，或绑定变量名不是 `NAV_KV`。绑好后 `Deployments` → `Retry deployment` |
| 接口 500 但没有「缺少 KV 绑定」字样 | KV 没问题，是代码抛了别的异常。把域名发我，或去 Pages 项目看 Functions 日志 |
| 页面样式/脚本没生效 | `Build output directory` 不是 `public`（写成了 `/public`、仓库根目录，或留空） |
| 注册提示「注册码错误」 | 你配了 `REGISTER_KEY`，但注册时没填或填错了。第一个账号同样要填 |
| 注册提示「已创建首个账号」 | 没配 `REGISTER_KEY`，而 KV 里已经有账号了。想再开放注册就配上 `REGISTER_KEY` |
| 公开模式下改不了东西 | 这是默认行为（公开模式默认只读）。设 `PUBLIC_READONLY=false`，或配 `PUBLIC_WRITE_KEY` |
| 忘记密码 | 界面里可自助改密码（右上角用户名 → 修改密码）。完全进不去就删 KV 里的 `user:<用户名>` 重新注册 |
| **刚保存完刷新看到旧数据** | KV 是最终一致的（边缘缓存，通常秒级）。等几秒再刷新即可，不是 bug |
| 改了代码但线上没变 | 确认 push 到了 `main`，并在 `Deployments` 里看最新一条是否构建成功 |
| 图标一直是首字母方块 | 目标站点没有 `/favicon.ico` 或抓不到，会正常回退。想强制重抓：编辑该站点、清空「图标」字段后保存 |
| 预览部署里功能缺失 | 环境变量/绑定只加到了 Production，Preview 需要单独加 |

---

> 只用浏览器就能分诊：打开 `https://<域名>/api/icon?domain=example.com`
> —— 返回 404 或一张图 = **KV 正常**；返回 500 = **KV 没绑好**。
> （这个端点一定会读 KV；而 `/api/config`、`/api/me` 在未登录时不读 KV，所以它们不能用来判断。）

---

## 命令行部署（可选）

网页端连 GitHub 的好处是「push 即部署」，不需要这条。命令行部署时**要自己建一份
`wrangler.toml`**（仓库里刻意不放它，原因见步骤 3 的「控制台绑不了 KV」），至少包含：

```toml
name = "cf-personal-nav"
pages_build_output_dir = "public"
compatibility_date = "2025-01-01"

[[kv_namespaces]]
binding = "NAV_KV"
id = "你的 KV namespace id"
```

```bash
# 首次：建 KV（用 npx wrangler kv namespace list 可以查 id）
npx wrangler kv namespace create NAV_KV

# 部署
npx wrangler pages deploy public --project-name cf-personal-nav
```

---

## 本地开发

不装任何依赖就能跑（零依赖开发服务器，直接复用 Pages 的 API 入口）：

```bash
node scripts/dev-server.mjs
# 或
npm run dev
```

打开 <http://127.0.0.1:8788>。数据存在内存里，重启即清空。

想看公开模式：`PUBLIC_MODE=true node scripts/dev-server.mjs`。

跑测试：`node --test test/worker.test.mjs test/bookmarks.test.mjs test/history.test.mjs test/frontend.test.mjs`
