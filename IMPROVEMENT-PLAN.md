# cf-personal-nav 改进方案

> 本文件是规划文档，不含代码改动。所有「现状」结论都来自对当前仓库的逐文件阅读，标 ⚠️ 的两条已用脚本实测复现。
> 对标对象：hao123/360 导航、WebStackPage、OneNav、Sun-Panel、Homepage/Dashy/Heimdall、iTab/Infinity 新标签页、LinkStack。

---

## 一、现状盘点

**一句话结论**：现在是一个「做得挺干净」的 WebStack 式卡片导航 + 账号体系，但它目前是**静态页面 + 一份 JSON 全量覆盖写**的形态，缺的是导航站真正的三件套：**信息密度、书签工作流、数据安全层**。

技术事实：

| 层 | 现状 |
| --- | --- |
| 部署 | Cloudflare Pages Functions 与 Workers(assets) **两套入口并存**（`functions/api/[[path]].js` 与 `src/index.js`），逻辑都在 `functions/_lib/core.js`（326 行） |
| 存储 | 单个 KV：`user:` / `session:` / `sites:` / `settings:` / `meta:users`，一条站点列表整体读写 |
| API | 7 个端点；写操作只有一个 `PUT /api/sites`（**全量替换**） |
| 前端 | `public/app.js` 单文件 581 行 + 780 行 CSS，零构建、零依赖 |
| 测试 | `node --test`，9 个用例，**实测全部通过**（含 Pages 适配层用例） |

已经做对的地方（不要推翻）：

- PBKDF2 + 随机盐 + 定长比较，密码处理没偷懒；HttpOnly/SameSite Cookie；会话存 KV 且带 TTL。
- 多账户隔离、公开模式、注册码首账号保护都有测试覆盖。
- 前端 favicon 多源回退（首字母彩色方块）+ 图标加载失败降级，很稳。
- 视觉基调（Apple 风格、深浅色变量化、8px 圆角、`prefers-reduced-motion`）已经成型，**不要重做设计语言，要加密度和布局选项**。

---

## 二、对标：出名的导航站各自在卖什么

| 对标 | 形态 | 它真正的杀招（可抄的部分） |
| --- | --- | --- |
| hao123 / 360 导航 / 2345 | 门户型 | 一屏 100+ 文本链接的**极端密度**；频道/地区切换；热搜榜与天气黄历等工具位。本质是 SEO 流量生意，不适合自建站照抄 |
| **WebStackPage**（及大量 Hexo/Hugo 衍生主题） | 静态模板 | 分类侧栏锚点 + **紧凑小卡片（一屏 40+）**；每个分类一个 emoji/图标；数据是静态 yml/json；卡片可折叠 |
| **OneNav** | 自建书签导航（PHP+SQLite） | 后台管理；**私有/公开链接区分**；图标自动抓取；**浏览器书签 HTML 导入**；点击统计排序；开放 API；多主题 |
| **Sun-Panel** | 自建家庭导航面板（Go+Vue） | **分组 tab + 拖拽排序**；图标库与自定义上传；内网服务与 iframe 小组件；壁纸主题；Docker 一键部署 |
| Homepage / Dashy / Homarr / Heimdall | 自建 dashboard | YAML 配置；**服务健康探活小圆点**；widget（Docker/天气/下载器）；分组 tab |
| **iTab / Infinity / WeTab** | 商业新标签页 | **壁纸（Bing 每日图）**；搜索引擎切换 + 搜索建议 + 关键词触发（`!g`/`!b`）；图标拖拽与文件夹；待办便签天气组件；快捷键；账号云同步 |
| LinkStack / Linktree | 个人链接页 | 单页聚合、多主题、以分享为导向 |

**定位判断**：这个项目现在等于「WebStackPage 的 Cloudflare 实现 + 账号体系」。要往前走，性价比最高的不是加组件，而是补齐 WebStackPage 有而你没有的**密度**、OneNav 有而你没有的**书签工作流**、iTab 有而你没有的**新标签页体验**。

---

## 三、差距诊断（按优先级）

### 3.1 数据层：最该先修的，和 UI 无关

| 编号 | 问题 | 证据 | 后果 |
| --- | --- | --- | --- |
| ⚠️ A1 | **只更新站点会把自定义标题/副标题清空** | `core.js:138` 无条件 `sanitizeSettings(body.settings)`，`core.js:211-217` 对缺省输入返回默认值，`core.js:140-141` 随即写回。实测：先存 `{title:"我的工具箱"}`，再 `PUT {sites:[...]}` 不带 settings → 读回 `{}`，前端回落成「我的导航」 | README 把 `settings` 标成可选，实际会**静默丢配置**。前端 `saveSites()` 恰好总会带上 settings，所以只在直接调 API/多客户端时踩雷 |
| A2 | 全量替换 + 无并发控制 | `core.js:131-143` 整个列表覆盖写，没有版本号/ETag/`updatedAt` | 手机和电脑同时编辑 → 后保存的**整份覆盖**前者，无提示 |
| A3 | KV 不适合当站点库 | 列表、分类、排序、统计全塞在一个 value 里 | 无法分页、无法按条件查询、无法做点击统计，列表一长就只能整体读写 |
| A4 | 没有备份与版本 | KV 只有 `sites:<user>` 一份 | 误删/误存即永久丢失，OneNav/Sun-Panel 都有导出与备份 |
| A5 | 没有导入导出 | 前端只有手工增删 | **从浏览器书签迁移是导航站的刚需入口**，没有它等于把用户挡在门外 |
| A6 | 首次登录是空页面 | `core.js:124-125` 新用户 `sites` 为空；`index.html:88` 直接显示「没有找到匹配的站点」 | 新用户第一眼是空的，没有引导、没有预置站点 |

### 3.2 安全与账号

| 编号 | 问题 | 证据 |
| --- | --- | --- |
| B1 | **公开模式下任何匿名访客都能清空全站数据** | `core.js:121`/`core.js:132`：`PUBLIC_MODE` 下 `username = PUBLIC_USER`，读写都不校验身份，`test/worker.test.mjs:249` 还把这个行为固化成了测试 |
| ⚠️ B2 | **后端不过滤 URL 协议** | `core.js:196` 只做 `cleanString(item.url, 500)`。实测 `javascript:alert(document.cookie)` 被 200 接受并原样存回。当前前端 `normalizeUrl`（`app.js:51-56`）会给非 http(s) 补 `https://` 前缀所以暂时打不出去，但**任何直接渲染 API 数据的客户端或未来的 SSR 页面都是 XSS 洞** |
| B3 | 登录/注册无限流 | `handleApi`（`core.js:7-20`）全程无计数，密码可暴力破解，注册可洪水式写 KV 烧配额 |
| B4 | 无 CSRF token / 无 Origin 校验 | `app.js:19-49` 无 token；后端不校验 `Origin`/`Referer`。`SameSite=Lax` 挡住大部分跨站 POST，但没有纵深防御 |
| B5 | 缺少安全响应头 | 无 `_headers` 文件：无 CSP、无 `X-Content-Type-Options`、无 `Referrer-Policy` |
| B6 | 会话 7 天不滑动续期 | `core.js:166-186` 只在登录时写 TTL，活跃用户第 7 天会被突然登出；Cookie 也没有 `__Host-` 前缀 |
| B7 | 账号自救能力为零 | 没有改密码、登出全部设备；`DEPLOY.md:52` 的官方答案是「删 KV 里的 `user:<用户名>`」 |
| B8 | `meta:users` 读改写非原子 | `core.js:60-64` 与 `core.js:79-84` 两次读同一键再写，两个并发注册可能都通过首个账号校验 |

### 3.3 交互与视觉

| 编号 | 问题 | 依据 |
| --- | --- | --- |
| C1 | **信息密度太低** | `styles.css:401` `minmax(300px, 1fr)` + 78px 高卡片 → 1080px 下一屏约 9 个站点。WebStackPage 是同类紧凑卡片 4 列 + 分组折叠，一屏 40+。**这是「像不像导航站」的第一观感** |
| C2 | 搜索太弱 | `app.js:119-137` 只对 `name/desc/url` 做 includes，不匹配分类、无拼音首字母（中文用户习惯敲 `zh` 找知乎）、无高亮、无键盘导航、无搜索引擎直通 |
| C3 | 无拖拽排序、无分组管理 | 分组只是 `category` 字符串（`core.js:204`），列表顺序 = 数组顺序，编辑器（`app.js:292-319`）只能删除重加来「排序」 |
| C4 | 无书签工作流 | 没有导入、导出、右键菜单（复制链接/新窗口打开）、标签、备注、收藏置顶、最近访问、点击统计 |
| C5 | favicon 依赖第三方且无缓存 | `app.js:237` 直连 `icons.duckduckgo.com`，国内网络常不可达 → 图标长期回退成首字母；也没有服务端缓存，每张卡一次外部请求 |
| C6 | 无 PWA / 无新标签页形态 | 无 `manifest`、无 Service Worker；`index.html` 无 favicon/`description`/OG 标签。iTab 那类产品的黏性正来自「当新标签页用」 |
| C7 | 无个性化外观 | 只有深浅色。壁纸、卡片密度、圆角、自定义 logo 都没有 |

### 3.4 工程化

| 编号 | 问题 | 依据 |
| --- | --- | --- |
| D1 | 两套入口 + 文档不一致 | `src/index.js`（Workers）与 `functions/api/[[path]].js`（Pages）并行；`wrangler.toml:7` 用 `not_found_handling = "single-page-application"` 而 `CLOUDFLARE.md` 讲的是 Pages 网页端配置。两条路都留着，改一处忘一处 |
| D2 | 前端单文件 581 行无模块化 | `app.js` 里 state、请求、渲染、编辑器、表单混在一起，加拖拽/多布局前应先拆 |
| D3 | 无 CI、无 lint | 只有 `npm test`，靠人手动跑；本机 PowerShell 策略还会拦掉 `npm.ps1`（需用 `node --test` 直调） |
| D4 | 测试只覆盖后端主路径 | 9 个用例不含 A1（settings 覆盖）、A2（并发）、B2（协议）、B3（限流）、B8（注册竞态） |
| D5 | 无错误可观测 | 前端只 `showToast`，后端只把异常转 500，线上没有日志/错误聚合 |

---

## 四、改进方案（分阶段，可直接排期）

### Phase 0 · 止血：数据不丢、别人改不了（半天到 1 天）

1. **settings 半量更新**：区分「字段缺省 = 不动」与「显式空值 = 清空」，或拆出 `PATCH /api/settings`。补测试用例。
2. **URL 协议白名单**：`sanitizeSites` 只接受 `http:`/`https:`，其余直接 400，前端同步提示。
3. **公开模式写保护**：新增 `PUBLIC_READONLY=true`（默认开）或「访客写需管理口令」，至少要能一键切成只读展示。
4. **限流**：登录/注册按 `IP + 用户名` 计数（KV 短 TTL 计数键，或直接上 Cloudflare Rate Limiting 规则），失败 5 次锁 15 分钟。
5. **Origin 校验 + `_headers`**：校验 `Origin`/`Referer` 同源；新增 `public/_headers` 加 CSP、`X-Content-Type-Options: nosniff`、`Referrer-Policy`、`Permissions-Policy`。
6. **会话滑动续期 + `__Host-nav_session` 前缀**。
7. **CI**：GitHub Actions 跑 `node --test` + ESLint/Prettier。
8. **定入口**：在 Pages Functions 与 Workers(assets) 之间二选一。建议 **Workers + Static Assets**，因为后面要用的 Cron（备份）、D1、Rate Limiting 都在这条路上；删掉另一套适配层与对应文档，消除不一致。

**状态：全部完成（未提交）。**

第 8 项最终选了 **Cloudflare Pages**（不是当初建议的 Workers）：你的目标是「挂一个导航到 CF 上」，Pages 连 GitHub 就能跑、不需要本地工具链，代价最小。

- 删掉 `src/index.js` 与空掉的 `src/`，生产入口只剩 `functions/api/[[path]].js`；测试改为直接打这个入口（`test/worker.test.mjs` 顶部用一个 12 行的分流骨架镜像 Pages 的行为：`/api/*` 交给 Functions，其余交给平台静态资源）。
- `scripts/dev-server.mjs` 也从 Workers 入口切到同一个 Pages 入口，并补上行为对齐：不发布 `_headers`/`_redirects`、未知路径回落首页、静态与 API 都带安全头。
- `wrangler.toml` 改成 Pages 配置；**KV 绑定默认注释掉**——Git 连接的 Pages 构建会读取本文件，留一个无效的 KV id 会直接让构建失败。
- 部署文档合并：`CLOUDFLARE.md` 与 `DEPLOY.md` 内容重复（之前的不一致就是从这里来的），现在只留 `DEPLOY.md` 一份，含 KV 绑定、环境变量表、**部署后自检清单**和常见问题；`CLOUDFLARE.md` 已删除（`git checkout CLOUDFLARE.md` 可恢复）。
- 新增 4 条「部署结构守护」测试：入口唯一（没有 `src/`、`wrangler.toml` 里没有 Workers 的 `main`/`assets`）、`functions/` 下只有 `api/[[path]].js` 是公开路由（共享代码必须在 `_` 开头的目录里，否则会变成公开端点）、`public/` 里不含开发文件、API 与 `_headers` 提供同一套安全头。

已完成内容：

- `functions/_lib/core.js`：settings 改为半量更新（省略 = 不动，空字符串 = 清空）；`sanitizeSites` 增加 http/https 白名单与重复 id 去重；公开模式默认只读（`PUBLIC_READONLY`，默认 `true`，`false` 才放开；或用 `PUBLIC_WRITE_KEY` + `x-nav-write-key` 头写入）；登录/注册失败限流 5 次/15 分钟，超限返回 429 + `Retry-After`；写操作校验同源 `Origin`；会话剩余不足一半时滑动续期，https 下用 `__Host-nav_session`；`json()` 支持多条 `Set-Cookie`。
- `src/index.js` + `public/_headers`：统一注入 CSP、`X-Content-Type-Options`、`Referrer-Policy`、`X-Frame-Options`、`Permissions-Policy`。
- `public/app.js`：识别 `readonly`，只读时隐藏并拦截编辑入口。
- `.github/workflows/ci.yml`：push/PR 自动跑 `node --test`。
- `test/worker.test.mjs`：从 9 个用例扩到 17 个，新增覆盖 A1（settings 覆盖）、B1（公开只读）、B2（协议白名单）、B3（限流）、Origin 校验、`__Host-` 前缀与滑动续期、安全响应头。
- README / CLOUDFLARE.md / DEPLOY.md 同步了新环境变量与行为。
- 一轮独立代码复核后追加修复：https 下不再回退接受普通 `nav_session`（防同级子域写入导致的会话固定）；登录改为「先验证凭据、只对失败尝试限流」，正确密码不会被他人锁死；`settings` 传非字符串改成明确 400，不再静默清空标题；`isPublicReadonly` 同时接受 `'false'` 与 TOML 布尔 `false`；限流只信任 `CF-Connecting-IP` 并关闭 KV 读缓存；logout 的双 `Set-Cookie` 在本地 dev-server 也能正确下发；安全头抽到 `core.js` 的 `withSecurityHeaders`，Pages Functions 适配层与 Workers 入口共用，500 不再回显内部错误。
- 测试从 17 个用例扩到 26 个（新增：`__Host-` 前缀防固定、登出双 Cookie、重复 id 去重、合法 http/https 正例、settings 非字符串与 null、非法链接不改动既有数据、公开模式 `/api/me` 只读标记、Pages 适配层与静态资源安全头）。CI 增加 5 个文件的 `node --check` 语法检查。

> 这一阶段完成前不要动 UI：否则数据层会继续丢配置。

### Phase 1 · 体验对齐：让它「像一个导航站」（2–4 天）

9. **默认密度改造**：主视图改成紧凑卡片（图标 + 单行名称，每行 5–6 个），并加「紧凑/舒适」切换（存 localStorage + 用户设置）。保留 hover 抬升与箭头。
10. **分组能力**：分组增删改名、**拖拽排序（分组之间 + 分组内部）**、分组折叠、置顶/常用区、分组图标。用原生 HTML5 拖拽即可，无需依赖。
11. **搜索升级**：`/` 或 `⌘/Ctrl+K` 聚焦；拼音首字母匹配（内置常用站点拼音表或用轻量 pinyin 库）；结果高亮 + `↑↓` 选择 + `Enter` 打开；`!g`/`!b`/`!d` 直通搜索引擎；无匹配时给「用 Google 搜索…」兜底。
12. **站点增强**：右键菜单（编辑/复制链接/新窗口打开/删除）、收藏置顶、标签、备注、最近访问（本地记录即可）。
13. **导入导出**：Netscape 书签 HTML 导入（浏览器导出的文件直接吃）+ JSON 导入导出。**这是拉新最有效的一步**。
14. **首次体验**：新账号预置一组默认站点（常用/开发/设计/AI/影音）+「一键导入常用站点包」，消灭空白首页。
15. **favicon 服务端代理**：新增 `/api/icon?domain=`，服务端抓 `https://<域名>/favicon.ico` 并用 KV 缓存（带长 `Cache-Control`），失败再回退第三方或首字母。国内可达性与隐私都更好。
16. **移动端**：卡片两列、底部操作条、编辑器字段全宽（在现有 `styles.css:695-771` 媒体查询上收紧）。

**状态：9–15 已完成（未提交），16 做了部分（移动端编辑器改成两列/单列 + 紧凑网格收窄到 150px，底部操作条未做）。**

已完成内容：

- 前端从单文件 `public/app.js` 拆成 `public/js/` 下的原生 ESM 模块（`app/api/store/search/render/editor/bookmarks/ui/aliases/presets`），零依赖、无构建；入口改为 `<script type="module" src="/js/app.js">`。
- **密度**：主视图默认紧凑（`minmax(190px, 1fr)`，一屏约 30–40 个站点），可在紧凑/舒适间切换，密度存进 `settings.density` 跟随账号同步，同时写 localStorage 以便首屏不闪。
- **分组**：可折叠（状态存 localStorage）、可在编辑器里直接改名（作用于整组）、可解散（站点移入常用，不删数据）；分组顺序靠拖拽整组移动。
- **拖拽排序**：编辑器里每行与每个分组头都有手柄，拖动站点到别的分组会自动改 `category`；纯函数 `moveItem` / `moveSiteIntoGroup` / `renameGroup` / `dissolveGroup` 都有测试。
- **搜索**：`parseQuery` 支持 `!g`/`!b`/`!d` 直通搜索引擎；匹配覆盖面扩到名称/描述/分类/URL/`keywords` 以及内置简称别名表（`aliases.js`，`zh`→知乎、`gh`→GitHub…）；结果按相关度排序、命中处用 `<mark>` 高亮；`/` 或 `⌘/Ctrl+K` 聚焦、`↑↓` 选择、`Enter` 打开，无本地匹配时提示可直接上网搜。
- **站点增强**：卡片右键菜单（新标签页打开/复制链接/置顶/编辑），`pinned` 字段让置顶站点排在同组前面，`keywords` 字段做个性化别名。
- **导入导出**：`bookmarks.js` 纯函数模块支持 Netscape 书签 HTML 解析（文件夹→分组、实体解码、协议过滤、按 URL 去重）与导出，以及 JSON 往返（保留 `pinned`/`keywords`）；导入按 URL 与现有数据合并，书签里的 favicon URL 型 `ICON` 会被丢弃（交给图标代理）。
- **首次体验**：新账号空页面给三张卡（导入常用站点包 30+ 个站点 / 导入浏览器书签 / 手动添加），不再是干巴巴的「没有找到匹配的站点」。
- **图标代理**：新增 `GET /api/icon?domain=`，服务端抓 `https://<域名>/favicon.ico`，5 秒超时、只接受 `image/*`、上限 100KB，KV 缓存 30 天并带长 `Cache-Control`；域名白名单校验防 SSRF；CSP 的 `img-src` 因此收紧为 `'self' data:`（不再依赖第三方图标服务）。
- 测试从 26 个扩到 **97** 个：`test/worker.test.mjs` 37、`test/bookmarks.test.mjs` 18、`test/frontend.test.mjs` 42。前端测试用最小 DOM 桩真实执行 `public/js/` 的模块并解析真实 `index.html`（id/class 写错、文件被污染都会失败）。
- 一轮独立代码复核后又修掉 8 个真实缺陷：`index.html` 写入事故（每行行首多一个 `+`，会让 DOCTYPE 失效、模块脚本变成文本、整站打不开）；`sanitizeSites` 用站点名首字兜底 icon，导致 `/api/icon` 代理永远不可达（已改为留空即走代理，并补了断言）；编辑器**同组内向下拖拽错位一格**（抽成纯函数 `dropIndexInGroup` 并测试）；编辑过程中切换密度会用 `state.sites` 覆盖未保存的改动（改为编辑中只本地生效）；键盘导航会走到折叠分组里看不见的卡片（折叠组不再进入导航队列）；`pickFile` 取消后 promise 悬空且遗留监听导致导入执行两次（改为成对移除监听）；`/api/icon` 的 5 秒超时只覆盖响应头阶段、体积上限在整块读入后才判（改为超时覆盖读体 + 先看 `content-length`）；`ui.js` 在模块级缓存右键菜单 DOM 节点（指向旧文档的隐患，改为按需查找）。另外把 `MAX_SITES` 从 200 放宽到 500，并在前端导入时按同一上限截断并提示，避免导入几百条书签时被整批 400 拒掉。
- **顺手消掉一个此前只能靠人眼看的不确定性**：DOM 桩补上 `Blob` / `URL.createObjectURL` / `FileReader` / `navigator.clipboard` / `doc.created`，现在导出 JSON 与书签 HTML、通过文件选择导入、取消选择不重复导入、右键复制链接都有自动化用例（导出的内容会被读回来解析校验）。另加一条守护：`public/_headers` 与 Worker 注入的 CSP 必须一致且不得出现 `sandbox`（否则浏览器会静默拦掉导出下载）。调试过程中还发现 DOM 桩的 `remove()` 没把 `parent` 置空，会让断言失败时 Node 去 inspect 含循环引用的大对象图，表现为 36 秒后抛 `Array buffer allocation failed` —— 已修桩，并把相关断言改成布尔比较以免以后又被这个坑咬到。
- **账号自救（本轮新增）**：`POST /api/password` 与 `POST /api/logout-all`。会话带版本号（`userver:<用户名>`），改密码或登出全部设备时换一个新版本值，所有旧会话立即失效——用单键换值代替遍历删除会话，KV 上没有 list 也能做到。改密码成功后给当前设备发新会话（其他设备被踢），并对失败尝试限流。UI 为点用户名弹出的账号菜单 + 自建模态框（修改密码 / 登出全部设备，危险操作走红色按钮）。
- 测试从 26 个扩到 **112** 个：`test/worker.test.mjs` 44、`test/bookmarks.test.mjs` 18、`test/frontend.test.mjs` 50。除上一条所述内容外，本轮新增覆盖：改密码后旧密码失效 / 旧会话被踢 / 当前设备拿到新会话、失败不改动密码、限流、按账号隔离、登出全部设备清两台设备的会话；前端的账号菜单、弹窗校验（两次密码不一致拦在本地）、取消与 Escape 关闭、危险按钮样式、服务端报错时弹窗保持打开。
- 前端测试又抓到 2 个真实缺陷并已修：`ui.js` 在模块级缓存右键菜单节点（改为按需查找）；模态框的 `setError` 只设文案不移交控制权，导致**校验失败时弹窗照样关闭**（改为标记 invalid 后不关闭）。
- 唯一还需要真机确认的只剩**视觉布局**（`.edit-row` 的 9 列网格在 1100px / 700px 断点下的表现，以及新增模态框的观感）。
- **本轮新增：最近访问 / 最常访问**。`public/js/history.js` 用本机 localStorage 记录「访问次数 + 最后访问时间」，键取规范化 URL（忽略大小写与末尾斜杠，站点 id 会因为导入导出而变，URL 才稳定）。主视图在真实分组前插入两组自动分组：最近访问按时间倒序、最常访问按次数（≥2 次）排序。**两者允许重叠**——最初我让「最常访问」排除已出现在「最近访问」里的站点，测试立刻暴露这个设计缺陷：条目少时近期去过的必然也是最常去的，那一组几乎永远是空的，等于白做。搜索时不显示自动分组（避免和结果抢位置），已删除的站点会自动从记录里过滤掉，记录总量上限 300 条，localStorage 写满时静默降级不影响使用。数据菜单里可一键清除。
- **标签与备注**。站点新增两个可选字段：`tags`（可见标签，逗号分隔，≤100 字符）与 `note`（私有备注，≤200 字符）。标签在卡片上显示成芯片（最多 3 个，多的收合成 `+n`），点一下把搜索框填成 `#标签` 做**精确筛选**（再点一次取消）；搜索框直接输入 `#标签` 也走同一条路径。备注在卡片右下角挂一个 📝 标记，点开是只读弹窗（复用了抽出来的 `modal.js` 原语）。标签与备注都会参与普通关键词搜索（`注意：别名 keywords 只用于搜索、不显示；标签 tags 显示且可筛选，两者用途不同`）。`#标签` 是精确匹配，所以搜索 `#运维` 不会命中一个叫「运维手册」的站点。两个字段都随 JSON 导出往返（`bookmarks.js` 同步支持，超长会被截断到同一上限）。
- 仍未做（留给 Phase 2/3）：服务端点击统计（需要 D1）、服务探活、自定义壁纸、PWA、SSR/分享链接、i18n，以及 **D1 迁移**（需要你先定「两套入口二选一」并新建 D1 实例）。

### Phase 2 · 架构升级：能撑住增长（3–5 天）

17. **迁移到 D1**：表 `users / sessions / sites / categories / clicks`。分页、排序、统计、条件查询、乐观锁都能自然实现；KV 只留会话与图标缓存。
18. **增量 API + 乐观锁**：`POST/PATCH/DELETE /api/sites/:id` + `If-Match: updatedAt`，冲突返回 409 让前端提示「另一处已修改」。
19. **备份**：Cron Trigger 每日把每账户数据快照到 R2（或 KV `backup:<user>:<date>`），后台支持一键回滚 + 下载。
20. **点击统计**：记录打开次数与最近打开，驱动「最常访问/最近访问」和默认排序；这也是 OneNav 的招牌能力。
21. **服务探活**：定时 HEAD 探测并在卡片上显示可用性小圆点（对标 Homepage/Dashy），内网地址跳过。

### Phase 3 · 差异化（按兴趣选做）

22. **外观个性化**：自定义壁纸（URL / 上传 / Bing 每日一图）、毛玻璃强度、圆角、卡片密度、自定义 Logo 上传。
23. **PWA + 新标签页形态**：`manifest.json` + Service Worker（离线可打开、可加到主屏），把「打开浏览器就先看到它」变成习惯。
24. **SEO 与分享**：首页服务端直出真实 HTML + `description`/OG 图/`sitemap.xml`；再加**只读分享链接**（`/?share=<token>`）——比现在「公开模式导致任何人可写」安全得多。
25. **前端工程化**：先拆成原生 ESM 模块（`api.js` / `store.js` / `render.js` / `editor.js`），再决定要不要上 Vite + TS。保持零依赖也能拆。
26. **i18n + 无障碍**：中/英切换、完整键盘操作与焦点管理、`aria` 补全。

---

## 五、不建议照抄的「出名做法」

- **hao123 式超密文本墙与频道/地区/热搜位**：那是 SEO 与流量变现逻辑，自建站照抄只会变成噪音。
- **Homepage/Dashy 式 widget 全家桶**（Docker、下载器、天气、股票）：维护成本高且需要额外后端；真要做，先只做「服务探活小圆点」这一项性价比最高的。
- **过早引入前端框架**：当前痛点是数据层与交互，不是渲染性能；先拆 ESM 模块、把 Phase 0/1 做完再评估。

---

## 六、建议的下一步（如果只做 4 件事）

1. A1 settings 覆盖 bug（半小时，直接止损）。
2. B2 URL 协议白名单 + B1 公开模式写保护（半小时，堵洞）。
3. C1 信息密度 + C3 拖拽排序与分组管理（1 天，观感与手感立刻不同）。
4. C4 导入导出（1 天，决定这站能不能被别人用起来）。

验收标准：新用户从零到「看到 40+ 站点、拖过顺序、导过书签、换过标题且不丢」全程无错；`node --test` 覆盖 A1/A2/B1/B2/B3；线上有 CI 与安全头。
