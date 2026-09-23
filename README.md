# CF 个人导航

一个可完全托管在 Cloudflare 边缘的个人导航站。支持多账户隔离，也可以切换成不需要登录的公开模式；代码推到 GitHub 后由 Cloudflare Pages 自动部署，本地不用安装任何运行环境。

项目仓库：<https://github.com/yannlie/cf-personal-nav>

## 功能

**账号与安全**

- 用户名密码注册/登录，密码使用 PBKDF2 加盐哈希保存
- HttpOnly 会话 Cookie，有效期 7 天；剩余不足一半时自动续期，https 下使用 `__Host-` 前缀
- 登录/注册失败次数限流（5 次 / 15 分钟），且正确密码不会被别人的失败尝试锁死
- 写操作校验同源 `Origin`；站点链接仅接受 `http:` / `https:`
- 账号自救：可自助**修改密码**（其他设备立即失效）与**登出全部设备**，不必再删 KV 记录
- 统一的安全响应头（CSP、nosniff、Referrer-Policy 等）
- 公开模式：`PUBLIC_MODE=true` 共用一份数据，默认**只读**，可用 `PUBLIC_READONLY=false` 放开

**导航体验**

- 分组卡片 + **紧凑 / 舒适两种密度**一键切换（默认紧凑，一屏可容纳数十个站点）
- 分组可折叠、可改名、可解散；**拖拽调整站点顺序，拖到别的分组即改分组**
- 搜索支持名称/描述/分类/别名，内置常用站点简称（`zh`、`gh`、`bili`…），命中高亮
- `/` 或 `⌘/Ctrl+K` 聚焦搜索，`↑↓` 选择、`Enter` 打开；`!g`/`!b`/`!d` 直通搜索引擎
- 卡片右键菜单：新标签页打开、复制链接、置顶、编辑
- 图标走同源 `/api/icon` 代理（服务端抓取 + KV 缓存 30 天），失败回退首字母彩色方块，不依赖第三方图标服务
- **导入浏览器书签**（Netscape HTML）与 JSON；导出 JSON / 书签 HTML
- **标签与备注**：给站点打标签（显示成芯片，点一下只看该标签的站点，也支持搜索框输入 `#标签` 精确筛选）；备注是私有文本，卡片上点 📝 查看，会随 JSON 导出一起走
- **最近访问 / 最常访问**：自动在你点过的站点里挑出「刚去过」和「去得最多」两组置顶显示；记录只存在本机浏览器（不上传服务器），可在数据菜单里一键清除
- 新账号空状态提供「导入常用站点包」引导，不必从零开始

## 部署到 Cloudflare

只有一条路径：**Cloudflare Pages**，连上 GitHub 仓库就能跑，不需要本地构建。
完整步骤（含 KV 绑定、环境变量、自检清单、常见问题）见 [DEPLOY.md](DEPLOY.md)。

最短流程：建 KV 命名空间 `NAV_KV` → 建 Pages 项目（输出目录填 `public`）→ 把 KV 绑定为 `NAV_KV` → 配 `REGISTER_KEY`。

## 本地开发

零依赖，不需要 `npm install`：

```bash
node scripts/dev-server.mjs
# 或
npm run dev
```

打开 <http://127.0.0.1:8788>。开发服务器直接复用 Pages 的 API 入口（`functions/`），
静态资源从 `public/` 读取，数据存在内存里、重启清空。

想看公开模式：`PUBLIC_MODE=true node scripts/dev-server.mjs`。

## 目录结构

```text
public/                    前端静态资源（含 _headers）
  index.html
  styles.css
  js/
    app.js                 入口：身份、搜索、视图切换、导入导出
    api.js                 fetch 封装
    store.js               状态与设置默认值
    search.js              查询解析、别名匹配、排序、高亮、分组（纯函数）
    render.js              主视图渲染
    editor.js              编辑器（分组化列表、拖拽排序）
    bookmarks.js           书签 HTML / JSON 解析与导出（纯函数，零依赖）
    ui.js                  主题、密度、吐司、右键菜单、文件读写
    account.js             账号自救：修改密码 / 登出全部设备
    modal.js               通用模态框原语（账号弹窗、查看备注共用）
    history.js             使用记录（最近 / 最常访问），纯本地存储
    aliases.js             常用站点简称别名表
    presets.js             常用站点包
functions/                 Cloudflare Pages API
  api/[[path]].js          /api/* 的统一入口
  _lib/core.js             登录、注册、会话、限流、站点读写、图标代理
scripts/dev-server.mjs     零依赖本地开发服务器（复用同一个 API 入口）
test/                      自动化测试（后端 / 书签 / 使用记录 / 前端）
.github/workflows/ci.yml   CI：语法检查 + 全部测试
wrangler.toml              Cloudflare Pages 配置，仅在用命令行部署时才需要
```

生产入口只有一个：`functions/api/[[path]].js`（共享逻辑在 `functions/_lib/core.js`，
`_` 开头不会被 Pages 当成公开路由）。

前端是零依赖的原生 ESM，没有构建步骤；`public/js/` 下的模块可以直接在浏览器里调试。

## API

- `GET /api/config`：返回 `{ publicMode, readonly }`
- `GET /api/icon?domain=<host>`：同源图标代理，命中 KV 缓存直接返回，否则抓取 `https://<host>/favicon.ico`（5 秒超时、仅接受 `image/*`、上限 100KB）
- `POST /api/register`：`{ username, password, registerKey? }`
- `POST /api/login`：`{ username, password }`
- `POST /api/logout`
- `POST /api/logout-all`：登出全部设备（所有会话立即失效，密码不变）
- `POST /api/password`：`{ currentPassword, newPassword }`，成功后其他设备失效、当前设备拿到新会话
- `GET /api/me`
- `GET /api/sites`：返回 `{ sites, settings }`
- `PUT /api/sites`：`{ sites: [...], settings?: { title?, subtitle?, density? } }`
  - `settings` 整体省略 = 保持现有设置不变；传某字段 = 覆盖该字段；传空字符串/`null` = 清空该字段
  - `density` 仅接受 `compact` / `comfortable`
  - 站点字段：`id`、`name`、`url`、`desc`、`category`，可选 `icon`（短字符/表情，≤8 字符；留空则前端走 `/api/icon` 抓 favicon）、`pinned`（布尔）、`keywords`（搜索别名，≤100 字符，不显示）、`tags`（可见标签，≤100 字符）、`note`（私有备注，≤200 字符）
  - 站点 `url` 仅接受 `http:` / `https:`，出现其他协议时整批拒绝（400）
  - 公开模式且只读时，匿名写入返回 403
  - 站点总数上限 500（前端导入时会按同一上限截断并提示）

认证类失败累计过多会返回 429 并带 `Retry-After`；写操作会校验同源 `Origin`。
KV 键结构：`user:<用户名>`、`session:<token>`、`userver:<用户名>`（会话版本，改密码或登出全部设备时换值使旧会话失效）、`sites:<用户名>`、`settings:<用户名>`、`meta:users`、`rl:<限流键>`、`icon:<域名>`。

## 测试

```bash
node --test test/worker.test.mjs test/bookmarks.test.mjs test/frontend.test.mjs
```

`npm test` 等价，但部分 Windows PowerShell 环境会拦截 `npm.ps1`，直接用上面的命令更稳。

当前共 149 个用例：`worker.test.mjs` 46、`bookmarks.test.mjs` 20、`history.test.mjs` 13、`frontend.test.mjs` 70。

`test/frontend.test.mjs` 用一个最小 DOM 桩真实执行 `public/js/` 下的模块，并解析真实的 `index.html`，因此：

- index.html 与 JS 之间的 id / class 写错、文件被意外污染都会失败；
- 导出链路（`Blob` + `URL.createObjectURL` + `<a download>`）、选文件导入（`input.click` + `FileReader`）、右键复制链接（`navigator.clipboard`）都在桩里跑通，导出的内容会被读回来解析校验；
- `public/_headers` 与 Worker 注入的 CSP 必须完全一致，且不允许出现 `sandbox`（否则浏览器会静默拦掉导出下载）。
