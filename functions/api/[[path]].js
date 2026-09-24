import { handleApi, json, withSecurityHeaders } from '../_lib/core.js';

// Pages 上部署时最容易漏的一步就是绑 KV。缺了就给出能照着做的提示，
// 而不是一个光秃秃的 500 —— 前端会把这句 error 直接显示在界面上。
function missingKvResponse() {
  return json(
    {
      error:
        '服务器缺少 KV 绑定：请在 Cloudflare Pages 项目 → Settings → Functions → KV namespace bindings 里把变量名设为 NAV_KV（大小写一致），保存后到 Deployments 重新部署一次',
    },
    500
  );
}

export async function onRequest(context) {
  const { request, env } = context;

  if (!env || !env.NAV_KV) {
    // Pages Functions 不走 Workers 入口，安全头必须在这里补
    return withSecurityHeaders(missingKvResponse());
  }

  try {
    return withSecurityHeaders(await handleApi(request, env));
  } catch (error) {
    // 默认不回显内部错误细节，避免把 KV 报错、堆栈之类泄漏给客户端。
    // 排查阶段可以临时把环境变量 DEBUG_ERRORS 设为 true，让真实报错显示在界面上，
    // 查完记得删掉这个变量。
    const detail =
      env.DEBUG_ERRORS === 'true' && error instanceof Error && error.message
        ? `：${error.message}`
        : '';

    return withSecurityHeaders(
      json({ error: `服务器内部错误${detail}` }, 500)
    );
  }
}
