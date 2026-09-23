// 前端共享状态与设置默认值。
export const DEFAULT_SETTINGS = {
  title: '我的导航',
  subtitle: '自建站点，一处直达',
  density: 'compact',
};

export const DENSITIES = ['compact', 'comfortable'];

export const state = {
  user: null,
  publicMode: false,
  readonly: false,
  settings: { ...DEFAULT_SETTINGS },
  sites: [],
  editSites: [],
  editing: false,
  query: '',
  activeIndex: -1,
};

// 只接受已知的 density 取值，其余回退默认。
export function mergeSettings(raw) {
  const next = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  if (!DENSITIES.includes(next.density)) next.density = DEFAULT_SETTINGS.density;
  return next;
}

export function setSites(sites) {
  state.sites = Array.isArray(sites) ? sites : [];
  state.editSites = state.sites.map((site) => ({ ...site }));
}
