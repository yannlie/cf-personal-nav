// 应用入口：身份、搜索、视图切换、导入导出。
import { api } from './api.js';
import { DEFAULT_SETTINGS, mergeSettings, setSites, state } from './store.js';
import {
  applyDensity,
  byId,
  closeContextMenu,
  downloadText,
  initTheme,
  openContextMenu,
  pickFile,
  readFileText,
  readLocalDensity,
  showToast,
  toggleTheme,
} from './ui.js';
import {
  configureRender,
  getActiveIndex,
  getVisibleCards,
  openCardAt,
  renderAll,
  setActiveIndex,
} from './render.js';
import { addSite, closeEditor, openEditor, renderEditor } from './editor.js';
import { PRESET_SITES } from './presets.js';
import { openLogoutAllDialog, openPasswordDialog } from './account.js';
import { clearHistory, recordVisit } from './history.js';
import { engineUrl, parseQuery } from './search.js';
import { parseBookmarkHtml, parseJson, toJson, toNetscapeHtml } from './bookmarks.js';
import { openInfoDialog } from './modal.js';

// 与后端 sanitizeSites 的上限保持一致。
const MAX_SITES = 500;

let authMode = 'login';

/* ---------- 工具 ---------- */

function setAuthError(message) {
  const el = byId('auth-error');
  if (el) el.textContent = message || '';
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// 打开站点：记录一次访问再开新页（卡片原生点击走 onCardOpen，只记录）。
function openSite(site) {
  if (!site || !site.url) return;
  recordVisit(site.url);
  window.open(site.url, '_blank', 'noopener');
}

// 点卡片上的标签：搜索框填入 #标签 做精确筛选；点同一个标签则取消筛选。
function filterByTag(tag) {
  const wanted = `#${String(tag || '').trim()}`;
  const search = byId('search');
  const next = state.query === wanted ? '' : wanted;

  state.query = next;
  if (search) search.value = next;
  renderAll();
  setActiveIndex(-1);
}

// 只补齐缺少协议的裸域名；其它协议原样交给服务端拒绝，不在这里悄悄改写。
function normalizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
  return `https://${raw}`;
}

// 书签文件里的 ICON 通常是 favicon 地址或 data URI，而 icon 字段只用于短字符覆盖；
// 过长的 icon 会被后端截断成乱码，所以这里直接丢弃，交给 /api/icon 代理取图标。
function normalizeImportedSites(incoming) {
  return incoming.map((site) => {
    const icon = typeof site.icon === 'string' ? site.icon.trim() : '';
    return { ...site, icon: icon && icon.length <= 8 ? icon : '' };
  });
}

function mergeSiteLists(existing, incoming) {
  const seen = new Set(existing.map((site) => String(site.url || '').toLowerCase()));
  const merged = existing.slice();
  for (const site of incoming) {
    const key = String(site.url || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(site);
  }
  return merged;
}

/* ---------- 视图切换 ---------- */

function showAuth() {
  state.user = null;
  state.publicMode = false;
  state.settings = { ...DEFAULT_SETTINGS };
  setSites([]);
  state.editing = false;
  byId('user-name').textContent = '';
  byId('edit-btn').classList.add('hidden');
  byId('density-btn').classList.add('hidden');
  byId('data-btn').classList.add('hidden');
  byId('logout-btn').classList.add('hidden');
  byId('app-view').classList.add('hidden');
  byId('editor-view').classList.add('hidden');
  byId('footer').classList.add('hidden');
  byId('auth-view').classList.remove('hidden');
  byId('password').value = '';
  byId('register-key').value = '';
  setAuthError('');
}

async function enterApp() {
  byId('user-name').textContent = state.user;
  byId('user-name').classList.toggle('hidden', state.publicMode);
  byId('logout-btn').classList.toggle('hidden', state.publicMode);
  byId('edit-btn').classList.toggle('hidden', state.readonly);
  byId('density-btn').classList.remove('hidden');
  byId('data-btn').classList.remove('hidden');
  byId('auth-view').classList.add('hidden');
  byId('editor-view').classList.add('hidden');
  byId('app-view').classList.remove('hidden');
  byId('footer').classList.remove('hidden');
  byId('search').value = '';
  state.query = '';
  await loadSites();
}

/* ---------- 数据 ---------- */

async function loadSites() {
  const data = await api('/api/sites');
  setSites(data.sites);
  state.settings = mergeSettings(data.settings);
  applyDensity(state.settings.density);
  renderAll();
}

async function persistSites(sites, settings) {
  const payload = {
    sites: sites.map((site) => ({ ...site, url: normalizeUrl(site.url) })),
    settings: settings || { ...state.settings },
  };
  const data = await api('/api/sites', { method: 'PUT', body: payload });
  setSites(data.sites);
  state.settings = mergeSettings(data.settings);
  applyDensity(state.settings.density);
  return data;
}

async function saveSites() {
  const button = byId('save-btn');
  button.disabled = true;
  try {
    await persistSites(state.editSites);
    renderAll();
    showToast('已保存');
    closeEditor();
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function togglePin(site) {
  if (state.readonly) return;
  const next = state.sites.map((item) =>
    item.id === site.id ? { ...item, pinned: !item.pinned } : item
  );
  try {
    await persistSites(next);
    renderAll();
    showToast(site.pinned ? '已取消置顶' : '已置顶');
  } catch (error) {
    showToast(error.message);
  }
}

async function loadPresets() {
  if (state.readonly) return;
  const before = state.sites.length;
  const merged = mergeSiteLists(
    state.sites,
    PRESET_SITES.map((site) => ({ ...site, id: '' }))
  );
  try {
    await persistSites(merged);
    renderAll();
    showToast(`已导入 ${merged.length - before} 个常用站点`);
  } catch (error) {
    showToast(error.message);
  }
}

/* ---------- 导入导出 ---------- */

function exportJson() {
  downloadText(`nav-${today()}.json`, toJson(state.sites, state.settings), 'application/json');
  showToast('已导出 JSON');
}

function exportHtml() {
  downloadText(`nav-bookmarks-${today()}.html`, toNetscapeHtml(state.sites), 'text/html');
  showToast('已导出书签 HTML');
}

export async function importFromText(text, filename = '') {
  if (state.readonly) {
    showToast('只读模式无法导入');
    return;
  }

  const looksLikeJson = /\.json$/i.test(filename) || text.trim().startsWith('{');
  let incoming = [];
  let skipped = 0;

  if (looksLikeJson) {
    try {
      const parsed = parseJson(text);
      incoming = parsed.sites;
      if (parsed.settings) state.settings = mergeSettings({ ...state.settings, ...parsed.settings });
    } catch (error) {
      showToast(error.message);
      return;
    }
  } else {
    const parsed = parseBookmarkHtml(text);
    incoming = parsed.sites;
    skipped = parsed.skipped;
  }

  if (!incoming.length) {
    showToast('没有解析到可用站点');
    return;
  }

  const before = state.sites.length;
  const mergedAll = mergeSiteLists(state.sites, normalizeImportedSites(incoming));
  // 与服务端 MAX_SITES 保持一致，超出的部分先截断，避免整批 400 让用户一头雾水。
  const merged = mergedAll.slice(0, MAX_SITES);
  const added = merged.length - before;
  const overflow = mergedAll.length - merged.length;

  try {
    await persistSites(merged);
    renderAll();
    const notes = [];
    if (skipped) notes.push(`跳过 ${skipped} 条`);
    if (overflow > 0) notes.push(`超出 ${MAX_SITES} 个上限，${overflow} 条未导入`);
    const extra = notes.length ? `（${notes.join('，')}）` : '';
    showToast(added ? `已导入 ${added} 个站点${extra}` : `没有新站点${extra}`);
  } catch (error) {
    showToast(error.message);
  }
}

async function importFromFile() {
  const file = await pickFile('.html,.htm,.json');
  if (!file) return;
  try {
    await importFromText(await readFileText(file), file.name);
  } catch (error) {
    showToast(error.message);
  }
}

/* ---------- 搜索与键盘 ---------- */

function onSearchInput(event) {
  state.query = event.target.value;
  renderAll();
  setActiveIndex(-1);
}

function onSearchKeydown(event) {
  const cards = getVisibleCards();

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    if (cards.length) setActiveIndex(Math.min(getActiveIndex() + 1, cards.length - 1));
    return;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    if (cards.length) setActiveIndex(Math.max(getActiveIndex() - 1, 0));
    return;
  }
  if (event.key === 'Escape') {
    event.target.value = '';
    state.query = '';
    renderAll();
    event.target.blur();
    return;
  }
  if (event.key === 'Enter') {
    const index = getActiveIndex();
    if (index >= 0) {
      openCardAt(index);
      return;
    }
    if (cards.length === 1) {
      openCardAt(0);
      return;
    }
    const { term, engine } = parseQuery(state.query);
    if (!term) return;
    window.open(engineUrl(engine || 'g', term), '_blank', 'noopener');
  }
}

function isTypingTarget(target) {
  const tag = (target && target.tagName) || '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function onGlobalKeydown(event) {
  const key = String(event.key || '').toLowerCase();
  if ((key === '/' && !isTypingTarget(event.target)) || ((event.metaKey || event.ctrlKey) && key === 'k')) {
    event.preventDefault();
    byId('search').focus();
    return;
  }
  if (event.key === 'Escape') closeContextMenu();
}

/* ---------- 密度与主题 ---------- */

function cycleDensity() {
  const next = state.settings.density === 'compact' ? 'comfortable' : 'compact';
  state.settings = { ...state.settings, density: next };
  applyDensity(next);
  renderAll();
  showToast(next === 'compact' ? '紧凑视图' : '舒适视图');

  // 只读或正在编辑时不写服务器：
  // persistSites 会按服务端返回刷新 state.sites，进而重置 state.editSites，
  // 把编辑器里尚未保存的改动静默丢掉（还会顺手把未保存的标题一起存了）。
  if (state.readonly || state.editing) return;

  persistSites(state.sites, { ...state.settings }).catch((error) => {
    showToast(`设置未同步：${error.message}`);
  });
}

/* ---------- 绑定 ---------- */

function bindRenderHandlers() {
  configureRender({
    onTogglePin: togglePin,
    onEditSite: (site) => {
      openEditor(site.id);
    },
    onOpenEditor: () => openEditor(),
    onImportBookmarks: importFromFile,
    onLoadPresets: loadPresets,
    // 卡片本身是 <a target="_blank">，浏览器负责开新页，这里只记一次访问
    onCardOpen: (site) => recordVisit(site.url),
    // 程序化打开（键盘 Enter、右键菜单）需要我们自己开页并记录
    onOpenSite: openSite,
    // 点标签 → 用 #标签 精确筛选；再点一次同一标签就清空
    onTagClick: filterByTag,
    onViewNote: (site) => {
      openInfoDialog({ title: `${site.name} 的备注`, text: site.note });
    },
  });
}

function setupAuth() {
  const tabs = document.querySelectorAll('.segmented button');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      authMode = tab.dataset.tab;
      tabs.forEach((item) => item.classList.toggle('active', item === tab));
      const isRegister = authMode === 'register';
      byId('key-label').classList.toggle('hidden', !isRegister);
      byId('register-key').classList.toggle('hidden', !isRegister);
      byId('auth-submit').textContent = isRegister ? '注册' : '登录';
      setAuthError('');
    });
  });

  byId('auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = byId('username').value.trim();
    const password = byId('password').value;
    const registerKey = byId('register-key').value.trim();
    const button = byId('auth-submit');

    button.disabled = true;
    setAuthError('');
    try {
      const data =
        authMode === 'login'
          ? await api('/api/login', { method: 'POST', body: { username, password } })
          : await api('/api/register', { method: 'POST', body: { username, password, registerKey } });
      state.user = data.username;
      await enterApp();
    } catch (error) {
      setAuthError(error.message);
    } finally {
      button.disabled = false;
      button.textContent = authMode === 'register' ? '注册' : '登录';
    }
  });
}

function openDataMenu(anchor) {
  const rect = anchor.getBoundingClientRect();
  const items = [
    { label: '导出 JSON（可再导入）', onSelect: exportJson },
    { label: '导出书签 HTML', onSelect: exportHtml },
  ];
  if (!state.readonly) {
    items.push({ label: '导入浏览器书签…', onSelect: importFromFile });
    items.push({
      label: '导入 JSON…',
      onSelect: () => {
        importFromFile();
      },
    });
    items.push({ label: '导入常用站点包', onSelect: loadPresets });
  }
  items.push({
    label: '清除使用记录',
    onSelect: () => {
      clearHistory();
      renderAll();
      showToast('已清除最近/最常访问记录');
    },
  });
  openContextMenu(items, rect.left, rect.bottom + 6);
}

// 点用户名：账号级操作（改密码、登出全部设备）。公开模式没有账号，直接不响应。
function openAccountMenu(anchor) {
  if (state.publicMode) return;

  const rect = anchor.getBoundingClientRect();
  openContextMenu(
    [
      {
        label: '修改密码…',
        onSelect: () => openPasswordDialog(),
      },
      {
        label: '登出全部设备…',
        onSelect: () => openLogoutAllDialog(showAuth),
      },
    ],
    rect.left,
    rect.bottom + 6
  );
}

function setupActions() {
  byId('search').addEventListener('input', onSearchInput);
  byId('search').addEventListener('keydown', onSearchKeydown);
  document.addEventListener('keydown', onGlobalKeydown);
  document.addEventListener('click', (event) => {
    if (!event.target.closest || !event.target.closest('#context-menu')) closeContextMenu();
  });
  window.addEventListener('scroll', closeContextMenu, true);

  byId('theme-btn').addEventListener('click', () => toggleTheme());
  byId('density-btn').addEventListener('click', cycleDensity);
  byId('user-name').addEventListener('click', (event) => {
    event.stopPropagation();
    openAccountMenu(event.currentTarget);
  });
  byId('data-btn').addEventListener('click', (event) => {
    event.stopPropagation();
    openDataMenu(event.currentTarget);
  });

  byId('edit-btn').addEventListener('click', () => openEditor());
  byId('add-btn').addEventListener('click', addSite);
  byId('cancel-btn').addEventListener('click', () => {
    closeEditor();
    renderAll();
  });
  byId('save-btn').addEventListener('click', saveSites);

  byId('settings-title').addEventListener('input', (event) => {
    state.settings.title = event.target.value;
  });
  byId('settings-subtitle').addEventListener('input', (event) => {
    state.settings.subtitle = event.target.value;
  });

  byId('logout-btn').addEventListener('click', async () => {
    try {
      await api('/api/logout', { method: 'POST' });
    } catch {
      // 本地状态仍然清除
    }
    showAuth();
  });
}

/* ---------- 启动 ---------- */

async function init() {
  initTheme();
  applyDensity(readLocalDensity() || DEFAULT_SETTINGS.density);
  setupAuth();
  setupActions();
  bindRenderHandlers();

  try {
    const config = await api('/api/config');
    state.publicMode = Boolean(config.publicMode);
    state.readonly = Boolean(config.readonly);
  } catch {
    state.publicMode = false;
    state.readonly = false;
  }

  if (state.publicMode) {
    state.user = 'public';
    await enterApp();
    return;
  }

  try {
    const me = await api('/api/me');
    state.user = me.username;
    await enterApp();
  } catch {
    showAuth();
  }
}

init();