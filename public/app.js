const $ = (selector) => document.querySelector(selector);

const state = {
  user: null,
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
  $('#edit-btn').classList.remove('hidden');
  $('#logout-btn').classList.remove('hidden');
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
  render();
}

function render() {
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

  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.textContent = site.icon || site.name.slice(0, 1);

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
  state.editSites.forEach((site, index) => list.append(editRow(site, index)));
}

function editRow(site, index) {
  const row = document.createElement('div');
  row.className = 'edit-row';
  row.dataset.index = String(index);

  row.append(
    field('图标', 'icon', site.icon),
    field('名称', 'name', site.name),
    field('链接', 'url', site.url),
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
  if (key === 'url') input.type = 'url';
  if (key === 'name') input.maxLength = 50;
  if (key === 'url') input.maxLength = 500;
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

async function saveSites() {
  const button = $('#save-btn');
  button.disabled = true;
  try {
    const payload = state.editSites.map((site) => ({
      ...site,
      url: normalizeUrl(site.url),
    }));
    const data = await api('/api/sites', { method: 'PUT', body: { sites: payload } });
    state.sites = data.sites;
    state.editSites = data.sites.map((site) => ({ ...site }));
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
    const me = await api('/api/me');
    state.user = me.username;
    await enterApp();
  } catch {
    showAuth();
  }
}

init();
