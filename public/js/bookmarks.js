// 书签数据的纯函数模块：解析 / 导出 Netscape 书签 HTML 与本站 JSON。
// 零依赖、无 DOM 访问、无网络请求，浏览器 <script type="module"> 与 Node 都能直接 import。

const DEFAULT_CATEGORY = '未分组';
const MAX_SITES = 1000;
const MAX_NAME = 50;
const MAX_DESC = 100;
const MAX_CATEGORY = 30;
const MAX_ICON = 8;
const MAX_KEYWORDS = 100;
const MAX_TAGS = 100;
const MAX_NOTE = 200;
const MAX_TITLE = 50;
const MAX_SUBTITLE = 100;
const DENSITIES = new Set(['compact', 'comfortable']);
const BAD_FILE_MESSAGE = '文件格式不正确，需要本站在「导出」里生成的 JSON';

// 命名实体只覆盖浏览器导出文件里常见的几个，其余保持原样。
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

// 解析 HTML 实体：命名实体、十进制 &#123;、十六进制 &#x1F600;。
export function decodeEntities(value) {
  if (typeof value !== 'string' || value.indexOf('&') === -1) return typeof value === 'string' ? value : '';
  return value.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (raw, body) => {
    if (body.charAt(0) === '#') {
      const isHex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
      const code = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return raw;
      try {
        return String.fromCodePoint(code);
      } catch {
        return raw;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? raw : named;
  });
}

// 按码点截断，避免把 emoji 之类的代理对切一半。
function truncate(value, max) {
  const chars = Array.from(value);
  return chars.length > max ? chars.slice(0, max).join('') : value;
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

// 读取标签属性，支持双引号 / 单引号 / 无引号三种写法。
function readAttr(attrs, name) {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const matched = pattern.exec(attrs);
  if (!matched) return '';
  return matched[1] ?? matched[2] ?? matched[3] ?? '';
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// 只在内存字符串上做转义，不触碰 DOM。
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// <H3> 文本 | <A 属性>文本</A> | <DL...> | </DL>，其他标签（DT/p/BODY 等）直接跳过。
const TOKEN_PATTERN = /<h3\b([^>]*)>([\s\S]*?)<\/h3>|<a\b([^>]*)>([\s\S]*?)<\/a>|<dl\b[^>]*>|<\/dl>/gi;

function currentFolder(folderStack) {
  for (let i = folderStack.length - 1; i >= 0; i -= 1) {
    if (folderStack[i]) return folderStack[i];
  }
  return '';
}

function resolveCategory(raw) {
  const value = asString(raw).trim();
  return value ? truncate(value, MAX_CATEGORY) : DEFAULT_CATEGORY;
}

function resolveName(rawName, url) {
  const name = rawName.trim();
  if (name) return truncate(name, MAX_NAME);
  // 名称为空时用域名兜底，域名也取不到就退回 url。
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    host = '';
  }
  return truncate(host || url, MAX_NAME);
}

// 解析浏览器导出的 Netscape 书签格式，返回 { sites, skipped }。
// 不生成 id（由服务端负责）；keywords 不来自书签文件。
export function parseBookmarkHtml(html) {
  if (typeof html !== 'string') return { sites: [], skipped: 0 };

  const source = html.replace(/<!--[\s\S]*?-->/g, '');
  const sites = [];
  const seen = new Set();
  const folderStack = [];
  let pendingFolder = null;
  let skipped = 0;

  TOKEN_PATTERN.lastIndex = 0;
  let match = TOKEN_PATTERN.exec(source);
  while (match !== null) {
    if (match[2] !== undefined) {
      // <H3>：记下文件名，等它后面的 <DL> 打开时入栈。
      pendingFolder = decodeEntities(match[2]).trim();
    } else if (match[4] !== undefined) {
      const attrs = match[3];
      const url = decodeEntities(readAttr(attrs, 'HREF')).trim();
      if (!isHttpUrl(url)) {
        skipped += 1;
      } else if (seen.has(url)) {
        skipped += 1;
      } else {
        seen.add(url);
        if (sites.length < MAX_SITES) {
          sites.push({
            name: resolveName(decodeEntities(match[4]), url),
            url,
            desc: truncate(decodeEntities(readAttr(attrs, 'DESCRIPTION')).trim(), MAX_DESC),
            category: resolveCategory(currentFolder(folderStack)),
            // 浏览器常在 ICON 里写完整的 favicon URL，所以这里不按 icon 长度上限裁剪（该上限只用于 parseJson）。
            icon: decodeEntities(readAttr(attrs, 'ICON')).trim(),
          });
        }
      }
    } else if (match[0].charAt(1) === '/') {
      // </DL>：离开当前文件夹。
      if (folderStack.length) folderStack.pop();
    } else {
      // <DL>：进入待定文件夹；根 <DL> 没有前置 <H3>，压入 null。
      folderStack.push(pendingFolder);
      pendingFolder = null;
    }
    match = TOKEN_PATTERN.exec(source);
  }

  return { sites, skipped };
}

// 按分类分组，保持分类首次出现的顺序；空分类归入「未分组」。
function groupByCategory(sites) {
  const groups = new Map();
  const list = Array.isArray(sites) ? sites : [];
  for (const site of list) {
    if (!site || typeof site !== 'object') continue;
    const url = asString(site.url).trim();
    if (!url) continue;
    const category = asString(site.category).trim() || DEFAULT_CATEGORY;
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push({
      name: asString(site.name),
      url,
      desc: asString(site.desc),
      icon: asString(site.icon),
    });
  }
  return groups;
}

// 导出为可被浏览器导入的 Netscape 书签 HTML。
export function toNetscapeHtml(sites) {
  const groups = groupByCategory(sites);
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file.',
    '     It will be read and overwritten.',
    '     DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ];

  for (const [category, items] of groups) {
    lines.push(`  <DT><H3>${escapeHtml(category)}</H3>`);
    lines.push('  <DL><p>');
    for (const site of items) {
      // 有描述时额外写 DESCRIPTION，这样导出的文件能被解析回等价的站点集合。
      const descAttr = site.desc ? ` DESCRIPTION="${escapeHtml(site.desc)}"` : '';
      lines.push(
        `    <DT><A HREF="${escapeHtml(site.url)}"${descAttr} ICON="${escapeHtml(site.icon)}">${escapeHtml(site.name)}</A>`,
      );
    }
    lines.push('  </DL><p>');
  }

  lines.push('</DL><p>');
  return lines.join('\n');
}

function toPlainSite(site) {
  const plain = {
    name: asString(site.name),
    url: asString(site.url),
    desc: asString(site.desc),
    category: asString(site.category),
    icon: asString(site.icon),
  };
  // pinned / keywords / tags / note 只在有值时输出，避免导出文件被空字段撑大。
  if (site.pinned) plain.pinned = true;
  const keywords = asString(site.keywords).trim();
  if (keywords) plain.keywords = keywords;
  const tags = asString(site.tags).trim();
  if (tags) plain.tags = tags;
  const note = asString(site.note).trim();
  if (note) plain.note = note;
  return plain;
}

// 导出为本站 JSON 文本（2 空格缩进）。
export function toJson(sites, settings) {
  const list = Array.isArray(sites) ? sites : [];
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {},
    sites: list.filter((site) => site && typeof site === 'object').map(toPlainSite),
  };
  return JSON.stringify(payload, null, 2);
}

function cleanSettings(raw) {
  const settings = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return settings;
  if (typeof raw.title === 'string' && raw.title.trim()) {
    settings.title = truncate(raw.title.trim(), MAX_TITLE);
  }
  if (typeof raw.subtitle === 'string' && raw.subtitle.trim()) {
    settings.subtitle = truncate(raw.subtitle.trim(), MAX_SUBTITLE);
  }
  if (DENSITIES.has(raw.density)) settings.density = raw.density;
  return settings;
}

// 解析本站导出的 JSON，返回 { sites, settings }。
export function parseJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(BAD_FILE_MESSAGE);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(BAD_FILE_MESSAGE);
  if (!Array.isArray(data.sites)) throw new Error(BAD_FILE_MESSAGE);

  const sites = [];
  const seen = new Set();
  for (const item of data.sites) {
    // 单条不合法只跳过，不让整个文件失败。
    if (!item || typeof item !== 'object') continue;
    const name = asString(item.name).trim();
    const url = asString(item.url).trim();
    if (!name || !url || !isHttpUrl(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    const site = {
      name: truncate(name, MAX_NAME),
      url,
      desc: truncate(asString(item.desc).trim(), MAX_DESC),
      category: truncate(asString(item.category).trim(), MAX_CATEGORY) || DEFAULT_CATEGORY,
      icon: truncate(asString(item.icon).trim(), MAX_ICON),
    };
    if (item.pinned === true) site.pinned = true;
    const keywords = asString(item.keywords).trim();
    if (keywords) site.keywords = truncate(keywords, MAX_KEYWORDS);
    const tags = asString(item.tags).trim();
    if (tags) site.tags = truncate(tags, MAX_TAGS);
    const note = asString(item.note).trim();
    if (note) site.note = truncate(note, MAX_NOTE);
    sites.push(site);
  }

  return { sites, settings: cleanSettings(data.settings) };
}
