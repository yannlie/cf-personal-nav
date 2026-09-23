// 统一的 API 封装：JSON 出入、错误信息提取。
export async function api(path, options = {}) {
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
