import { handleApi, withSecurityHeaders } from '../_lib/core.js';

export async function onRequest(context) {
  // Pages Functions 不会经过 src/index.js，安全头必须在这里也补一次。
  return withSecurityHeaders(await handleApi(context.request, context.env));
}
