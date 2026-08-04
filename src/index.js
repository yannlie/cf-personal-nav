import { handleApi, json } from '../functions/_lib/core.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) {
        return await handleApi(request, env);
      }
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : '服务器错误' }, 500);
    }
  },
};
