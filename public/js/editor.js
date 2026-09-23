// 编辑器：分组化列表、拖拽排序、分组改名、字段编辑。
import { state } from './store.js';
import { byId, showToast } from './ui.js';

// 预设图标用码点写，避免源码文件编码差异导致表情损坏。
const PRESET_ICONS = [
  '\u{1F310}', // 地球
  '\u270D\uFE0F', // 笔
  '\u{1F4F7}', // 相机
  '\u{1F3A7}', // 耳机
  '\u{1F3AC}', // 影片
  '\u{1F4BB}', // 笔记本
  '\u{1F4E6}', // 包裹
  '\u2699\uFE0F', // 齿轮
  '\u{1F6D2}', // 购物车
  '\u{1F4DA}', // 书
  '\u{1F3A8}', // 调色板
  '\u{1F517}', // 链接
];
const DEFAULT_CATEGORY = '常用';

/* ---------- 可测试的纯函数 ---------- */
// 计算「拖到目标行的前/后」在移除被拖元素之后、组内的插入下标。
// group.rows 是移除之前的下标空间，而 moveSiteIntoGroup 需要移除之后的，两者差 1，
// 必须先把被拖元素从行列表里剔除再数位置。
export function dropIndexInGroup(rows, dragIndex, targetIndex, after) {
  const remaining = (Array.isArray(rows) ? rows : []).filter((row) => row.index !== dragIndex);
  const at = remaining.findIndex((row) => row.index === targetIndex);
  if (at === -1) return remaining.length;
  return at + (after ? 1 : 0);
}


// 把 list 中 from 位置的元素移动到 to 位置。
export function moveItem(list, from, to) {
  const next = Array.isArray(list) ? list.slice() : [];
  if (from < 0 || from >= next.length) return next;
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}

// 把某个站点移动到目标分组的第 targetIndex 个位置，并同步它的 category。
export function moveSiteIntoGroup(sites, fromIndex, targetCategory, targetIndex) {
  const list = Array.isArray(sites) ? sites.slice() : [];
  if (fromIndex < 0 || fromIndex >= list.length) return list;

  // 复制一份再改，避免污染调用方传入的站点对象。
  const [moved] = list.splice(fromIndex, 1);
  const item = { ...moved, category: targetCategory || DEFAULT_CATEGORY };

  const positions = [];
  list.forEach((site, index) => {
    if ((site.category || DEFAULT_CATEGORY) === item.category) positions.push(index);
  });

  let insertAt;
  if (!positions.length) insertAt = list.length;
  else if (targetIndex >= positions.length) insertAt = positions[positions.length - 1] + 1;
  else insertAt = positions[Math.max(0, targetIndex)];

  list.splice(insertAt, 0, item);
  return list;
}

// 把分组名从 from 改成 to，作用于该分组下所有站点。
export function renameGroup(sites, from, to) {
  const target = String(to || '').trim().slice(0, 30) || DEFAULT_CATEGORY;
  return (Array.isArray(sites) ? sites : []).map((site) =>
    (site.category || DEFAULT_CATEGORY) === from ? { ...site, category: target } : site
  );
}

// 解散分组：组内站点归到常用，不删除数据。
export function dissolveGroup(sites, category) {
  return (Array.isArray(sites) ? sites : []).map((site) =>
    (site.category || DEFAULT_CATEGORY) === category ? { ...site, category: DEFAULT_CATEGORY } : site
  );
}

// 按分类切成连续块，供编辑器分组渲染。
export function groupEditableSites(sites) {
  const order = [];
  const map = new Map();
  (Array.isArray(sites) ? sites : []).forEach((site, index) => {
    const category = site.category || DEFAULT_CATEGORY;
    if (!map.has(category)) {
      map.set(category, []);
      order.push(category);
    }
    map.get(category).push({ site, index });
  });
  return order.map((category) => ({ category, rows: map.get(category) }));
}

export function allCategories(sites) {
  return groupEditableSites(sites).map((group) => group.category);
}

/* ---------- 拖拽辅助 ---------- */

let dragIndex = -1;
let dragCategory = null;

function clearDragState() {
  dragIndex = -1;
  dragCategory = null;
  document.querySelectorAll('.is-dragging, .drop-before, .drop-after').forEach((el) => {
    el.classList.remove('is-dragging', 'drop-before', 'drop-after');
  });
}

function bindRowDrag(row, index) {
  const handle = row.querySelector('.drag-handle');
  if (!handle) return;

  handle.addEventListener('dragstart', (event) => {
    dragIndex = index;
    dragCategory = null;
    row.classList.add('is-dragging');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(index));
    }
  });

  row.addEventListener('dragover', (event) => {
    if (dragIndex === -1) return;
    event.preventDefault();
    row.classList.remove('drop-before', 'drop-after');
    const rect = row.getBoundingClientRect ? row.getBoundingClientRect() : null;
    const after = rect ? event.clientY > rect.top + rect.height / 2 : true;
    row.classList.add(after ? 'drop-after' : 'drop-before');
  });

  row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));

  row.addEventListener('drop', (event) => {
    if (dragIndex === -1) return;
    event.preventDefault();
    const group = groupEditableSites(state.editSites).find((item) =>
      item.rows.some((entry) => entry.index === index)
    );
    if (!group) {
      clearDragState();
      return;
    }

    const rect = row.getBoundingClientRect ? row.getBoundingClientRect() : null;
    const after = rect ? event.clientY > rect.top + rect.height / 2 : true;
    if (dragIndex === index) {
      clearDragState();
      return;
    }
    const positionInGroup = dropIndexInGroup(group.rows, dragIndex, index, after);

    state.editSites = moveSiteIntoGroup(state.editSites, dragIndex, group.category, positionInGroup);
    clearDragState();
    renderEditor();
  });

  handle.addEventListener('dragend', clearDragState);
}

function bindGroupDrag(head, category) {
  const handle = head.querySelector('.drag-handle');
  if (!handle) return;

  handle.addEventListener('dragstart', (event) => {
    dragCategory = category;
    dragIndex = -1;
    head.classList.add('is-dragging');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', category);
    }
  });

  head.addEventListener('dragover', (event) => {
    if (!dragCategory) return;
    event.preventDefault();
  });

  head.addEventListener('drop', (event) => {
    if (!dragCategory || dragCategory === category) {
      clearDragState();
      return;
    }
    event.preventDefault();

    // 整组一起移动：把它在扁平数组里的所有元素搬到目标分组前面。
    const list = state.editSites.slice();
    const moving = list.filter((site) => (site.category || DEFAULT_CATEGORY) === dragCategory);
    const rest = list.filter((site) => (site.category || DEFAULT_CATEGORY) !== dragCategory);
    const targetAt = rest.findIndex((site) => (site.category || DEFAULT_CATEGORY) === category);
    const insertAt = targetAt === -1 ? rest.length : targetAt;

    state.editSites = [...rest.slice(0, insertAt), ...moving, ...rest.slice(insertAt)];
    clearDragState();
    renderEditor();
  });

  handle.addEventListener('dragend', clearDragState);
}

/* ---------- 渲染 ---------- */

function makeField(labelText, key, value, options = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  if (options.wide) wrap.classList.add('field-wide');

  const label = document.createElement('label');
  label.textContent = labelText;

  const input = document.createElement('input');
  input.value = value == null ? '' : String(value);
  input.dataset.field = key;
  if (options.maxLength) input.maxLength = options.maxLength;
  if (options.placeholder) input.placeholder = options.placeholder;
  if (options.listId) input.setAttribute('list', options.listId);

  input.addEventListener('input', () => {
    const site = currentSite(input);
    if (site) site[key] = input.value;
  });

  wrap.append(label, input);
  if (options.sublabel) {
    const hint = document.createElement('span');
    hint.className = 'field-hint';
    hint.textContent = options.sublabel;
    wrap.append(hint);
  }
  return wrap;
}

function currentSite(element) {
  const row = element.closest ? element.closest('.edit-row') : null;
  if (!row) return null;
  return state.editSites[Number(row.dataset.index)] || null;
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
  input.placeholder = '表情或字符';
  input.addEventListener('input', () => {
    const target = currentSite(input);
    if (target) target.icon = input.value;
  });

  const presets = document.createElement('div');
  presets.className = 'icon-presets';
  for (const emoji of PRESET_ICONS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-preset';
    button.textContent = emoji;
    button.setAttribute('aria-label', `设置图标 ${emoji}`);
    button.addEventListener('click', () => {
      const target = currentSite(button);
      if (target) target.icon = emoji;
      input.value = emoji;
    });
    presets.append(button);
  }

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
  for (const protocol of ['https://', 'http://']) {
    const option = document.createElement('option');
    option.value = protocol;
    option.textContent = protocol;
    select.append(option);
  }

  const input = document.createElement('input');
  input.maxLength = 500;
  input.placeholder = 'example.com';

  const parts = splitUrl(site.url);
  select.value = parts.protocol;
  input.value = parts.rest;

  const update = () => {
    const target = currentSite(wrap);
    if (!target) return;
    const rest = input.value.trim().replace(/^\/+/, '');
    target.url = rest ? `${select.value}${rest}` : '';
  };
  select.addEventListener('change', update);
  input.addEventListener('input', update);

  group.append(select, input);
  wrap.append(label, group);
  return wrap;
}

function splitUrl(value) {
  try {
    const parsed = new URL(String(value));
    return {
      protocol: parsed.protocol === 'http:' ? 'http://' : 'https://',
      rest: `${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`.replace(/^\/+/, ''),
    };
  } catch {
    return { protocol: 'https://', rest: String(value || '').replace(/^https?:\/\//i, '') };
  }
}

function pinnedField(site) {
  const wrap = document.createElement('div');
  wrap.className = 'field field-check';

  const label = document.createElement('label');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = Boolean(site.pinned);
  input.addEventListener('change', () => {
    const target = currentSite(input);
    if (target) target.pinned = input.checked;
  });

  const text = document.createTextNode('置顶');
  label.append(input, text);
  wrap.append(label);
  return wrap;
}

function editRow(site, index, listId) {
  const row = document.createElement('div');
  row.className = 'edit-row';
  row.dataset.index = String(index);

  const handle = document.createElement('span');
  handle.className = 'drag-handle';
  handle.draggable = true;
  handle.title = '拖拽调整顺序或移动到其它分组';
  handle.setAttribute('aria-label', '拖拽调整顺序');
  handle.textContent = '⠿';

  row.append(
    handle,
    iconField(site),
    makeField('名称', 'name', site.name, { maxLength: 50 }),
    urlField(site),
    makeField('描述', 'desc', site.desc, { maxLength: 100 }),
    makeField('分组', 'category', site.category, {
      maxLength: 30,
      listId,
      sublabel: '输入新名称即可新建分组',
    }),
    makeField('别名', 'keywords', site.keywords, {
      maxLength: 100,
      sublabel: '逗号分隔，便于搜索',
    }),
    pinnedField(site)
  );

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'row-delete';
  del.setAttribute('aria-label', '删除');
  del.title = '删除';
  del.textContent = '✕';
  del.addEventListener('click', () => {
    state.editSites.splice(index, 1);
    renderEditor();
  });

  row.append(del);

  // 标签与备注铺满整行（放在最后，靠 grid-column: 1/-1 单独占一行）
  const wideFields = document.createElement('div');
  wideFields.className = 'field-wide';
  wideFields.append(
    makeField('标签', 'tags', site.tags, {
      maxLength: 100,
      sublabel: '逗号分隔；会显示在卡片上，点标签即可筛选用它',
    }),
    makeField('备注', 'note', site.note, {
      maxLength: 200,
      sublabel: '私有备注，只在卡片上点 📝 查看',
    })
  );
  row.append(wideFields);

  bindRowDrag(row, index);
  return row;
}

function buildGroupBlock(group, listId) {
  const block = document.createElement('div');
  block.className = 'edit-group';

  const head = document.createElement('div');
  head.className = 'edit-group-head';

  const handle = document.createElement('span');
  handle.className = 'drag-handle';
  handle.draggable = true;
  handle.title = '拖拽调整分组顺序';
  handle.textContent = '⠿';

  const nameInput = document.createElement('input');
  nameInput.className = 'group-name';
  nameInput.value = group.category;
  nameInput.maxLength = 30;
  nameInput.setAttribute('aria-label', '分组名称');
  nameInput.addEventListener('change', () => {
    const next = nameInput.value.trim();
    if (!next || next === group.category) {
      nameInput.value = group.category;
      return;
    }
    state.editSites = renameGroup(state.editSites, group.category, next);
    showToast(`分组已改名为「${next}」`);
    renderEditor();
  });

  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = `${group.rows.length} 个站点`;

  const dissolve = document.createElement('button');
  dissolve.type = 'button';
  dissolve.className = 'ghost-btn';
  dissolve.textContent = '解散分组';
  dissolve.addEventListener('click', () => {
    state.editSites = dissolveGroup(state.editSites, group.category);
    showToast('分组已解散，站点移入常用');
    renderEditor();
  });

  head.append(handle, nameInput, count, dissolve);

  const list = document.createElement('div');
  list.className = 'editor-list';
  for (const entry of group.rows) {
    list.append(editRow(entry.site, entry.index, listId));
  }

  block.append(head, list);
  bindGroupDrag(head, group.category);
  return block;
}

export function renderEditor() {
  const groupsEl = byId('editor-groups');
  if (!groupsEl) return;

  const titleInput = byId('settings-title');
  if (titleInput) titleInput.value = state.settings.title || '';
  const subtitleInput = byId('settings-subtitle');
  if (subtitleInput) subtitleInput.value = state.settings.subtitle || '';

  const categories = allCategories(state.editSites);

  const listId = 'category-options';
  let datalist = byId(listId);
  if (!datalist) {
    datalist = document.createElement('datalist');
    datalist.id = listId;
    document.body.append(datalist);
  }
  datalist.textContent = '';
  for (const category of categories) {
    const option = document.createElement('option');
    option.value = category;
    datalist.append(option);
  }

  groupsEl.textContent = '';
  for (const group of groupEditableSites(state.editSites)) {
    groupsEl.append(buildGroupBlock(group, listId));
  }

  const empty = byId('editor-empty');
  if (empty) empty.classList.toggle('hidden', state.editSites.length > 0);
}

export function openEditor() {
  state.editSites = state.sites.map((site) => ({ ...site }));
  state.editing = true;
  byId('app-view').classList.add('hidden');
  byId('editor-view').classList.remove('hidden');
  renderEditor();
}

export function closeEditor() {
  state.editing = false;
  byId('editor-view').classList.add('hidden');
  byId('app-view').classList.remove('hidden');
}

export function addSite() {
  state.editSites.push({
    id: '',
    name: '',
    url: '',
    desc: '',
    category: DEFAULT_CATEGORY,
    icon: '',
  });
  renderEditor();

  const rows = document.querySelectorAll('.edit-row');
  const last = rows[rows.length - 1];
  if (last) {
    const nameInput = last.querySelector('input[data-field="name"]');
    if (nameInput) nameInput.focus();
  }
}

export { DEFAULT_CATEGORY, PRESET_ICONS };