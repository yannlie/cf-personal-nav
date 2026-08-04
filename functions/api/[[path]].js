import { handleApi } from '../_lib/core.js';

export async function onRequest(context) {
  return handleApi(context.request, context.env);
}
