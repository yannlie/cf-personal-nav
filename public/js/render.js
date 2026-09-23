// 主视图渲染：分组、卡片、搜索高亮、右键菜单、引导页。
import { state } from './store.js';
import {
  SEARCH_ENGINES,
  countSites,
  engineUrl,
  groupSites,
  highlight,
  hostOf,
  parseQuery,
  parseTags,
  rankSites,
} from './search.js';
import {
  byId,
  copyText,
  openContextMenu,
  readCollapsedGroups,
  showToast,
  writeCollapsedGroups,
} from './ui.js';
import { frequentUrls, recentUrls, resolveSites as resolveHistorySites } from './history.js';

const ICON_COLORS = ['#0a84ff', '#30b0c7', '#34c759', '#ff9f0a', '#ff375f', '#bf5af2', '#64d2ff', '#ffd60a'];
// 卡片上最多显示几个标签芯片，其余的收合成 +n
const MAX_CARD_TAGS = 3;

// app.js 注入的行为，避免渲染层反向依赖业务模块。
let handlers = {};
export function configureRender(next) {
  handlers = { ...handlers, ...next };
}

let visibleCards = [];
// 与 visibleCards 一一对应：键盘/程序化打开时要用它拿到站点对象（用于记录访问）。
let visibleSites = [];
let activeIndex = -1;

export function getVisibleCards() {
  return visibleCards;
}

export function setActiveIndex(index) {
  activeIndex = index;
  visibleCards.forEach((card, i) => card.classList.toggle('is-active', i === index));
  const target = visibleCards[index];
  if (target && target.scrollIntoView) target.scrollIntoView({ block: 'nearest' });
}

export function getActiveIndex() {
  return activeIndex;
}

export function siteAt(index) {
  return visibleSites[index] || null;
}

// 程序化打开统一走这里：app.js 注入的 onOpenSite 会记录访问再开新页；
// 没有注入时退回直接打开，保证渲染层可独立使用。
export function openCardAt(index) {
  const site = siteAt(index);
  const card = visibleCards[index];
  if (!site && !card) return;

  if (site && handlers.onOpenSite) {
    handlers.onOpenSite(site);
    return;
  }
  if (card && card.href) window.open(card.href, '_blank', 'noopener');
}

/* ---------- 小工具 ---------- */

function appendHighlighted(parent, text, term) {
  for (const part of highlight(text, term)) {
    if (part.hit) {
      const mark = document.createElement('mark');
      mark.textContent = part.text;
      parent.append(mark);
    } else {
      parent.append(document.createTextNode(part.text));
    }
  }
}

function iconColor(name) {
  let hash = 0;
  for (const ch of String(name || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return ICON_COLORS[hash % ICON_COLORS.length];
}

function initialTile(name) {
  const span = document.createElement('span');
  span.className = 'icon icon-fallback';
  span.style.background = iconColor(name);
  span.style.color = '#fff';
  const text = document.createElement('span');
  text.className = 'icon-fallback-text';
  text.textContent = (name || '?').slice(0, 1).toUpperCase();
  span.append(text);
  return span;
}

function textIcon(text) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.textContent = text;
  return span;
}

// 图标优先走同源代理 /api/icon，失败再退回首字母方块（不依赖第三方服务）。
function buildIcon(site) {
  if (site.icon && site.icon.trim()) return textIcon(site.icon);
  const host = hostOf(site.url);
  if (!host) return initialTile(site.name);

  const span = document.createElement('span');
  span.className = 'icon';

  const fallback = initialTile(site.name);
  fallback.classList.add('icon-fallback-layer');

  const img = document.createElement('img');
  img.className = 'icon-img';
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  img.src = `/api/icon?domain=${encodeURIComponent(host)}`;
  img.addEventListener('load', () => span.classList.add('icon-has-image'));
  img.addEventListener('error', () => {
    img.remove();
    span.classList.remove('icon-has-image');
  });

  span.append(fallback, img);
  return span;
}

function arrowSvg() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('arrow');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M5 12h14');
  const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  polyline.setAttribute('points', '12 5 19 12 12 19');
  svg.append(path, polyline);
  return svg;
}

/* ---------- 卡片 ---------- */

function buildCard(site, term) {
  const link = document.createElement('a');
  link.className = 'card';
  link.href = site.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.dataset.name = site.name;

  const meta = document.createElement('span');
  meta.className = 'meta';

  const name = document.createElement('h3');
  appendHighlighted(name, site.name, term);

  const desc = document.createElement('p');
  appendHighlighted(desc, site.desc || site.url, term);

  meta.append(name, desc);

  // 标签芯片：点一下按该标签筛选（搜索框会变成 #标签）
  const tags = parseTags(site.tags);
  if (tags.length) {
    const row = document.createElement('span');
    row.className = 'tag-row';
    for (const tag of tags.slice(0, MAX_CARD_TAGS)) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tag-chip';
      chip.textContent = `#${tag}`;
      chip.title = `只看「${tag}」`;
      chip.addEventListener('click', (event) => {
        // 阻止冒泡，否则会连带触发卡片的打开行为
        event.preventDefault();
        event.stopPropagation();
        if (handlers.onTagClick) handlers.onTagClick(tag);
      });
      row.append(chip);
    }
    if (tags.length > MAX_CARD_TAGS) {
      const more = document.createElement('span');
      more.className = 'tag-more';
      more.textContent = `+${tags.length - MAX_CARD_TAGS}`;
      row.append(more);
    }
    meta.append(row);
  }

  link.append(buildIcon(site), meta, arrowSvg());

  // 有备注就挂一个小标记，点它看内容
  if (site.note) {
    const noteBadge = document.createElement('button');
    noteBadge.type = 'button';
    noteBadge.className = 'note-badge';
    noteBadge.textContent = '📝';
    noteBadge.title = '查看备注';
    noteBadge.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (handlers.onViewNote) handlers.onViewNote(site);
    });
    link.append(noteBadge);
  }
  if (site.pinned) {
    const badge = document.createElement('span');
    badge.className = 'pin-badge';
    badge.title = '已置顶';
    badge.textContent = '★';
    link.append(badge);
  }

  link.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openContextMenu(buildCardMenu(site), event.clientX, event.clientY);
  });

  link.addEventListener('click', () => {
    if (handlers.onCardOpen) handlers.onCardOpen(site);
  });

  return link;
}

function buildCardMenu(site) {
  const items = [
    {
      label: '在新标签页打开',
      onSelect: () => {
        if (handlers.onOpenSite) handlers.onOpenSite(site);
        else window.open(site.url, '_blank', 'noopener');
      },
    },
    {
      label: '复制链接',
      onSelect: async () => {
        const ok = await copyText(site.url);
        showToast(ok ? '已复制链接' : '复制失败，请手动复制');
      },
    },
  ];

  // 有备注时提供查看入口（只读，不要求编辑权限）
  if (site.note) {
    items.push({
      label: '查看备注',
      onSelect: () => {
        if (handlers.onViewNote) handlers.onViewNote(site);
      },
    });
  }

  if (!state.readonly) {
    items.push({
      label: site.pinned ? '取消置顶' : '置顶到分组前面',
      onSelect: () => {
        if (handlers.onTogglePin) handlers.onTogglePin(site);
      },
    });
    items.push({
      label: '编辑站点',
      onSelect: () => {
        if (handlers.onEditSite) handlers.onEditSite(site);
      },
    });
  }

  return items;
}

/* ---------- 分组 ---------- */

function buildSection(group, term, collapsedSet) {
  const section = document.createElement('section');
  section.className = 'section';
  const collapsed = collapsedSet.has(group.category);
  if (collapsed) section.classList.add('is-collapsed');

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'section-title';
  head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');

  const h2 = document.createElement('h2');
  h2.textContent = group.category;

  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = `${group.sites.length} 个站点`;

  const chevron = document.createElement('span');
  chevron.className = 'chevron';
  chevron.textContent = '▾';
  chevron.setAttribute('aria-hidden', 'true');

  head.append(chevron, h2, count);
  head.addEventListener('click', () => {
    const next = new Set(readCollapsedGroups());
    if (next.has(group.category)) next.delete(group.category);
    else next.add(group.category);
    writeCollapsedGroups(next);
    renderAll();
  });

  const grid = document.createElement('div');
  grid.className = 'grid';
  // 折叠分组里的卡片不参与键盘导航，否则 ↑↓/Enter 会落到看不见的站点上。
  for (const site of group.sites) {
    const card = buildCard(site, term);
    grid.append(card);
    if (!collapsed) {
      visibleCards.push(card);
      visibleSites.push(site);
    }
  }

  section.append(head, grid);
  return section;
}

// 「最近访问 / 最常访问」这类自动分组：标题不可折叠，卡片同样参与键盘导航。
function buildSmartSection(label, sites, term, hint) {
  const section = document.createElement('section');
  section.className = 'section section-smart';

  const head = document.createElement('div');
  head.className = 'section-title';

  const h2 = document.createElement('h2');
  h2.textContent = label;

  const hintEl = document.createElement('span');
  hintEl.className = 'count';
  hintEl.textContent = hint;

  head.append(h2, hintEl);

  const grid = document.createElement('div');
  grid.className = 'grid';
  for (const site of sites) {
    const card = buildCard(site, term);
    grid.append(card);
    visibleCards.push(card);
    visibleSites.push(site);
  }

  section.append(head, grid);
  return section;
}

function emptyBlock(title, description, actions) {
  const wrap = document.createElement('div');
  wrap.className = 'empty-block';

  const heading = document.createElement('h3');
  heading.textContent = title;
  const text = document.createElement('p');
  text.textContent = description;

  wrap.append(heading, text);

  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'empty-actions';
    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = action.primary ? 'primary-btn' : 'secondary-btn';
      button.textContent = action.label;
      button.addEventListener('click', action.onSelect);
      row.append(button);
    }
    wrap.append(row);
  }

  return wrap;
}

// 有搜索词但没命中：给一个直通搜索引擎的出口。
function noMatchBlock(term, engine) {
  const actions = [];
  const keys = engine ? [engine] : ['g', 'b', 'd'];
  for (const key of keys) {
    actions.push({
      label: `用 ${SEARCH_ENGINES[key].name} 搜索「${term}」`,
      onSelect: () => window.open(engineUrl(key, term), '_blank', 'noopener'),
      primary: key === 'g',
    });
  }
  return emptyBlock('没有匹配的站点', `试试别名（zh、gh、bili）或 !g 直接搜索。`, actions);
}

function onboardingBlock() {
  const actions = [
    {
      label: '导入常用站点包',
      primary: true,
      onSelect: () => {
        if (handlers.onLoadPresets) handlers.onLoadPresets();
      },
    },
    {
      label: '导入浏览器书签',
      onSelect: () => {
        if (handlers.onImportBookmarks) handlers.onImportBookmarks();
      },
    },
    {
      label: '手动添加',
      onSelect: () => {
        if (handlers.onOpenEditor) handlers.onOpenEditor();
      },
    },
  ];
  return emptyBlock('还没有站点', '可以从常用站点包开始，或直接导入浏览器导出的书签文件。', actions);
}

/* ---------- 主渲染 ---------- */

function updateHero() {
  const title = state.settings.title;
  const subtitle = state.settings.subtitle;
  document.title = title;

  const brand = byId('nav-brand-text');
  if (brand) brand.textContent = title;
  const heroTitle = byId('hero-title');
  if (heroTitle) heroTitle.textContent = title;
  const heroSubtitle = byId('hero-subtitle');
  if (heroSubtitle) heroSubtitle.textContent = subtitle;
  const footerText = byId('footer-text');
  if (footerText) footerText.textContent = `© ${new Date().getFullYear()} ${title}`;
}

function updateSearchHint(term, engine, hitCount) {
  const hint = byId('search-hint');
  if (!hint) return;

  if (!term) {
    hint.classList.add('hidden');
    hint.textContent = '';
    return;
  }
  if (engine) {
    hint.textContent = `按 Enter 用 ${SEARCH_ENGINES[engine].name} 搜索「${term}」`;
    hint.classList.remove('hidden');
    return;
  }
  if (hitCount === 0) {
    hint.textContent = '没有本地匹配，按 Enter 直接上网搜索';
    hint.classList.remove('hidden');
    return;
  }
  hint.classList.add('hidden');
  hint.textContent = '';
}

export function renderAll() {
  updateHero();

  const groupsEl = byId('groups');
  if (!groupsEl) return;

  const { term, engine } = parseQuery(state.query);
  groupsEl.textContent = '';
  visibleCards = [];
  visibleSites = [];
  activeIndex = -1;

  const ranked = rankSites(state.sites, term);
  const groups = groupSites(ranked);
  const collapsedSet = new Set(readCollapsedGroups());
  const onboardingEl = byId('onboarding');

  // 空数据：显示引导，而不是干巴巴一句「没有找到」
  if (!state.sites.length) {
    if (onboardingEl) {
      onboardingEl.textContent = '';
      if (state.readonly) {
        onboardingEl.append(emptyBlock('这里还没有站点', '当前是只读部署，只有站点维护者可以添加内容。', []));
      } else {
        onboardingEl.append(onboardingBlock());
      }
      onboardingEl.classList.remove('hidden');
    }
    updateSearchHint('', null, 0);
    return;
  }

  if (onboardingEl) {
    onboardingEl.classList.add('hidden');
    onboardingEl.textContent = '';
  }

  // 有使用记录时，在真实分组前面插入「最近访问 / 最常访问」。
  // 两者各自独立、允许重叠：一个是「刚去过」，一个是「去得最多」，
  // 如果让后者排除前者，在站点不多时它会永远是空的。
  if (!term) {
    const recent = resolveHistorySites(state.sites, recentUrls());
    const frequent = resolveHistorySites(state.sites, frequentUrls());
    if (recent.length) {
      groupsEl.append(buildSmartSection('最近访问', recent, term, '刚去过'));
    }
    if (frequent.length) {
      groupsEl.append(buildSmartSection('最常访问', frequent, term, '去得最多'));
    }
  }

  for (const group of groups) {
    groupsEl.append(buildSection(group, term, collapsedSet));
  }

  if (countSites(groups) === 0) {
    groupsEl.append(noMatchBlock(term, engine));
  }

  updateSearchHint(term, engine, countSites(groups));
}