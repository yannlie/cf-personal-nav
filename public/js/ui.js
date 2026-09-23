// 界面工具：主题、密度、吐司提示、右键菜单、文件读写。
export const THEME_KEY = 'nav-theme';
export const DENSITY_KEY = 'nav-density';
export const COLLAPSE_KEY = 'nav-collapsed-groups';

function root() {
  return document.documentElement;
}

export function byId(id) {
  return document.getElementById(id);
}

/* ---------- 主题 ---------- */

export function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved) {
    root().dataset.theme = saved;
  } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    root().dataset.theme = 'dark';
  }
}

export function toggleTheme() {
  const next = root().dataset.theme === 'dark' ? 'light' : 'dark';
  root().dataset.theme = next;
  localStorage.setItem(THEME_KEY, next);
  return next;
}

/* ---------- 密度 ---------- */

export function applyDensity(density) {
  document.body.dataset.density = density;
  localStorage.setItem(DENSITY_KEY, density);
}

export function readLocalDensity() {
  return localStorage.getItem(DENSITY_KEY);
}

/* ---------- 分组折叠状态 ---------- */

export function readCollapsedGroups() {
  try {
    const parsed = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function writeCollapsedGroups(categories) {
  localStorage.setItem(COLLAPSE_KEY, JSON.stringify(Array.from(new Set(categories))));
}

/* ---------- 吐司 ---------- */

let toastTimer = null;

export function showToast(message) {
  const toast = byId('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2400);
}

/* ---------- 右键菜单 ---------- */

// 每次按需查找，不在模块里缓存 DOM 节点（缓存会让换页面/热重载后指向旧元素）。
function getContextMenu() {
  return byId('context-menu');
}

export function closeContextMenu() {
  const menu = getContextMenu();
  if (menu) {
    menu.classList.add('hidden');
    menu.textContent = '';
  }
}

// items: [{ label, onSelect, danger? }]
export function openContextMenu(items, x, y) {
  const menu = getContextMenu();
  if (!menu) return;

  menu.textContent = '';
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'context-item';
    if (item.danger) button.classList.add('is-danger');
    button.textContent = item.label;
    button.addEventListener('click', () => {
      closeContextMenu();
      item.onSelect();
    });
    menu.append(button);
  }

  menu.classList.remove('hidden');
  // 先显示才能量到尺寸，再做贴边修正。
  const rect = menu.getBoundingClientRect ? menu.getBoundingClientRect() : { width: 0, height: 0 };
  const maxX = Math.max(8, window.innerWidth - rect.width - 8);
  const maxY = Math.max(8, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.min(x, maxX)}px`;
  menu.style.top = `${Math.min(y, maxY)}px`;
}

export async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 落到下面的兜底
  }
  return false;
}

/* ---------- 文件读写 ---------- */

export function downloadText(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = byId('file-input');
    if (!input) {
      resolve(null);
      return;
    }
    input.accept = accept;
    input.value = '';

    // 必须成对移除：这个 input 是常驻元素，残留的监听会让下一次选文件时
    // 两个待决 promise 同时恢复，导入被执行两遍。
    const cleanup = () => {
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
    };
    const finish = (file) => {
      cleanup();
      resolve(file);
    };

    function onChange() {
      finish(input.files && input.files[0] ? input.files[0] : null);
    }
    function onCancel() {
      finish(null);
    }

    input.addEventListener('change', onChange);
    input.addEventListener('cancel', onCancel);
    input.click();
  });
}

export function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsText(file);
  });
}
