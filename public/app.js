const $ = (selector) => document.querySelector(selector);

const DEFAULT_SETTINGS = { title: '我的导航', subtitle: '自建站点，一处直达' };
const ICON_COLORS = ['#0a84ff', '#30b0c7', '#34c759', '#ff9f0a', '#ff375f', '#bf5af2', '#64d2ff', '#ffd60a'];
const PRESET_ICONS = ['🌐', '✍️', '📷', '🎧', '🎬', '💻', '📦', '⚙️'];

const state = {
  user: null,
  publicMode: false,
  settings: { ...DEFAULT_SETTINGS },
  sites: [],
  editSites: [],
  editing: false,
};

let authMode = 'login';
let toastTimer = null;

async function api(path, options = {}) {
  const init = {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  };
  if (init.body && typeof init.body !== 'string') {
    init.body = JSON.stringify(init.body);
  }

  let response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new Error('无法连接到服务器');
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error((data && data.error) || `请求失败 (${response.status})`);
  }
  return data;
}

function normalizeUrl(value) {
  const url = (value || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) return `https://${url}`;
  return url;
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2400);
}

function setAuthError(message) {
  $('#auth-error').textContent = message || '';
}

function showAuth() {
  state.user = null;
  state.publicMode = false;
  state.settings = { ...DEFAULT_SETTINGS };
  state.sites = [];
  state.editSites = [];
  state.editing = false;
  $('#user-name').textContent = '';
  $('#edit-btn').classList.add('hidden');
  $('#logout-btn').classList.add('hidden');
  $('#app-view').classList.add('hidden');
  $('#editor-view').classList.add('hidden');
  $('#footer').classList.add('hidden');
  $('#auth-view').classList.remove('hidden');
  $('#password').value = '';
  $('#register-key').value = '';
  setAuthError('');
}

async function enterApp() {
  $('#user-name').textContent = state.user;
  $('#user-name').classList.toggle('hidden', state.publicMode);
  $('#logout-btn').classList.toggle('hidden', state.publicMode);
  $('#edit-btn').classList.remove('hidden');
  $('#auth-view').classList.add('hidden');
  $('#editor-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  $('#footer').classList.remove('hidden');
  $('#search').value = '';
  await loadSites();
}

async function loadSites() {
  const data = await api('/api/sites');
  state.sites = Array.isArray(data.sites) ? data.sites : [];
  state.editSites = state.sites.map((site) => ({ ...site }));
  state.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  render();
}

function render() {
  const title = state.settings.title || DEFAULT_SETTINGS.title;
  const subtitle = state.settings.subtitle || DEFAULT_SETTINGS.subtitle;
  document.title = title;
  $('#nav-brand-text').textContent = title;
  $('.hero h1').textContent = title;
  $('.hero p').textContent = subtitle;
  $('#footer-text').textContent = `© ${new Date().getFullYear()} ${title}`;

  const keyword = $('#search').value.trim().toLowerCase();
  const groupsEl = $('#groups');
  const emptyEl = $('#empty');
  groupsEl.textContent = '';

  const categories = [];
  for (const site of state.sites) {
    if (!categories.includes(site.category)) categories.push(site.category);
  }

  let total = 0;
  for (const category of categories) {
    const matches = state.sites.filter((site) => {
      if (site.category !== category) return false;
      if (!keyword) return true;
      return [site.name, site.desc, site.url]
        .filter(Boolean)
        .some((text) => text.toLowerCase().includes(keyword));
    });
    if (!matches.length) continue;

    const section = document.createElement('section');
    section.className = 'section';

    const title = document.createElement('div');
    title.className = 'section-title';
    const h2 = document.createElement('h2');
    h2.textContent = category;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = `${matches.length} 个站点`;
    title.append(h2, count);

    const grid = document.createElement('div');
    grid.className = 'grid';
    matches.forEach((site) => grid.append(buildCard(site)));

    section.append(title, grid);
    groupsEl.append(section);
    total += matches.length;
  }

  emptyEl.classList.toggle('hidden', total > 0);
}

function buildCard(site) {
  const link = document.createElement('a');
  link.className = 'card';
  link.href = normalizeUrl(site.url);
  link.target = '_blank';
  link.rel = 'noopener noreferrer';

  const icon = site.icon && site.icon.trim() ? textIcon(site.icon) : faviconTile(site);

  const meta = document.createElement('span');
  meta.className = 'meta';

  const name = document.createElement('h3');
  name.textContent = site.name;

  const desc = document.createElement('p');
  desc.textContent = site.desc || site.url;

  meta.append(name, desc);
  link.append(icon, meta, arrowSvg());
  return link;
}

function textIcon(text) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.textContent = text;
  return span;
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

function iconColor(name) {
  let hash = 0;
  for (const ch of String(name || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return ICON_COLORS[hash % ICON_COLORS.length];
}

function getDomain(value) {
  try {
    return new URL(normalizeUrl(value)).hostname;
  } catch {
    return '';
  }
}

function faviconTile(site) {
  const domain = getDomain(site.url);
  if (!domain) return initialTile(site.name);

  const span = document.createElement('span');
  span.className = 'icon';

  const fallback = initialTile(site.name);
  fallback.classList.add('icon-fallback-layer');

  const img = document.createElement('img');
  img.className = 'icon-img';
  img.alt = '';
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  img.decoding = 'async';
  img.src = `https://icons.duckduckgo.com/ip3/${domain}.ico`;
  img.addEventListener('load', () => {
    span.classList.add('icon-has-image');
  });
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

function openEditor() {
  state.editSites = state.sites.map((site) => ({ ...site }));
  state.editing = true;
  $('#app-view').classList.add('hidden');
  $('#editor-view').classList.remove('hidden');
  renderEditor();
}

function closeEditor() {
  state.editing = false;
  $('#editor-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  render();
}

function renderEditor() {
  const list = $('#editor-list');
  list.textContent = '';
  $('#settings-name').value = state.settings.title || '';
  $('#settings-subtitle').value = state.settings.subtitle || '';
  state.editSites.forEach((site, index) => list.append(editRow(site, index)));
}

function editRow(site, index) {
  const row = document.createElement('div');
  row.className = 'edit-row';
  row.dataset.index = String(index);

  row.append(
    iconField(site),
    field('名称', 'name', site.name),
    urlField(site),
    field('描述', 'desc', site.desc),
    field('分组', 'category', site.category)
  );

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'row-delete';
  del.setAttribute('aria-label', '删除');
  del.title = '删除';
  del.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M10 11v6"></path><path d="M14 11v6"></path></svg>';
  del.addEventListener('click', () => {
    state.editSites.splice(Number(row.dataset.index), 1);
    renderEditor();
  });

  row.append(del);
  return row;
}

function field(labelText, key, value) {
  const wrap = document.createElement('div');
  wrap.className = 'field';

  const label = document.createElement('label');
  label.textContent = labelText;

  const input = document.createElement('input');
  input.value = value || '';
  input.dataset.field = key;
  if (key === 'name') input.maxLength = 50;
  if (key === 'desc') input.maxLength = 100;
  if (key === 'category') input.maxLength = 30;
  if (key === 'icon') input.maxLength = 8;

  input.addEventListener('input', () => {
    const row = input.closest('.edit-row');
    const site = state.editSites[Number(row.dataset.index)];
    if (site) site[key] = input.value;
  });

  wrap.append(label, input);
  return wrap;
}

function iconField(site) {
  const wrap = document.createElement('div');
  wrap.className = 'field';

  const label = document.createElement('label');
  label.textContent = '图标';

  const input = document.createElement('input');
  input.value = site.icon || '';
  input.dataset.field = 'icon';
  input.maxLength = 8;
  input.addEventListener('input', () => {
    const row = input.closest('.edit-row');
    const target = state.editSites[Number(row.dataset.index)];
    if (target) target.icon = input.value;
  });

  const presets = document.createElement('div');
  presets.className = 'icon-presets';
  PRESET_ICONS.forEach((emoji) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-preset';
    button.textContent = emoji;
    button.setAttribute('aria-label', `设置图标 ${emoji}`);
    button.addEventListener('click', () => {
      const row = button.closest('.edit-row');
      const target = state.editSites[Number(row.dataset.index)];
      if (target) target.icon = emoji;
      input.value = emoji;
    });
    presets.append(button);
  });

  wrap.append(label, input, presets);
  return wrap;
}

function urlField(site) {
  const wrap = document.createElement('div');
  wrap.className = 'field';

  const label = document.createElement('label');
  label.textContent = '链接';

  const group = document.createElement('div');
  group.className = 'url-group';

  const select = document.createElement('select');
  select.className = 'url-proto';
  ['https://', 'http://'].forEach((protocol) => {
    const option = document.createElement('option');
    option.value = protocol;
    option.textContent = protocol;
    select.append(option);
  });

  const input = document.createElement('input');
  input.maxLength = 500;

  const parts = splitUrl(site.url);
  select.value = parts.protocol;
  input.value = parts.rest;

  const update = () => {
    const row = wrap.closest('.edit-row');
    const target = state.editSites[Number(row.dataset.index)];
    if (!target) return;
    const protocol = select.value;
    const rest = input.value.trim().replace(/^\/+/, '');
    target.url = rest ? `${protocol}${rest}` : protocol;
  };

  select.addEventListener('change', update);
  input.addEventListener('input', update);

  group.append(select, input);
  wrap.append(label, group);
  return wrap;
}

function splitUrl(value) {
  try {
    const parsed = new URL(normalizeUrl(value));
    const protocol = parsed.protocol === 'http:' ? 'http://' : 'https://';
    const rest = `${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`.replace(/^\/+/, '');
    return { protocol, rest };
  } catch {
    return { protocol: 'https://', rest: String(value || '').replace(/^https?:\/\//i, '') };
  }
}

async function saveSites() {
  const button = $('#save-btn');
  button.disabled = true;
  try {
    const payload = {
      sites: state.editSites.map((site) => ({
        ...site,
        url: normalizeUrl(site.url),
      })),
      settings: { ...state.settings },
    };
    const data = await api('/api/sites', { method: 'PUT', body: payload });
    state.sites = data.sites;
    state.editSites = data.sites.map((site) => ({ ...site }));
    state.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
    showToast('已保存');
    closeEditor();
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

function setupAuth() {
  const tabs = document.querySelectorAll('.segmented button');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      authMode = tab.dataset.tab;
      tabs.forEach((item) => item.classList.toggle('active', item === tab));
      const isRegister = authMode === 'register';
      $('#key-label').classList.toggle('hidden', !isRegister);
      $('#register-key').classList.toggle('hidden', !isRegister);
      $('#auth-submit').textContent = isRegister ? '注册' : '登录';
      setAuthError('');
    });
  });

  $('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = $('#username').value.trim();
    const password = $('#password').value;
    const registerKey = $('#register-key').value.trim();
    const button = $('#auth-submit');

    button.disabled = true;
    setAuthError('');
    try {
      const data =
        authMode === 'login'
          ? await api('/api/login', { method: 'POST', body: { username, password } })
          : await api('/api/register', {
              method: 'POST',
              body: { username, password, registerKey },
            });
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

function setupTheme() {
  const saved = localStorage.getItem('nav-theme');
  if (saved) {
    document.documentElement.dataset.theme = saved;
  } else if (matchMedia('(prefers-color-scheme: dark)').matches) {
    document.documentElement.dataset.theme = 'dark';
  }

  $('#theme-btn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('nav-theme', next);
  });
}

function setupActions() {
  $('#search').addEventListener('input', render);
  $('#edit-btn').addEventListener('click', openEditor);
  $('#settings-name').addEventListener('input', (event) => {
    state.settings.title = event.target.value;
  });
  $('#settings-subtitle').addEventListener('input', (event) => {
    state.settings.subtitle = event.target.value;
  });
  $('#add-btn').addEventListener('click', () => {
    state.editSites.push({
      id: '',
      name: '',
      url: '',
      desc: '',
      category: '常用',
      icon: '',
    });
    renderEditor();
    const rows = document.querySelectorAll('.edit-row');
    const lastRow = rows[rows.length - 1];
    if (lastRow) lastRow.querySelector('input[data-field="name"]').focus();
  });
  $('#cancel-btn').addEventListener('click', closeEditor);
  $('#save-btn').addEventListener('click', saveSites);
  $('#logout-btn').addEventListener('click', async () => {
    try {
      await api('/api/logout', { method: 'POST' });
    } catch {
      // 本地状态仍然清除
    }
    showAuth();
  });
}

async function init() {
  setupTheme();
  setupAuth();
  setupActions();

  try {
    const config = await api('/api/config');
    state.publicMode = Boolean(config.publicMode);
  } catch {
    state.publicMode = false;
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
