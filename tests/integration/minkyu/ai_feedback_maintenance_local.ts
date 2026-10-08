/** 민규 소유 고정 로컬 API만 사용하는 실제 내부 HTTP 준비 검증. */
import { createRuntimeHandler } from '../../../backend/supabase/functions/service-api/index.ts';
const state = JSON.parse(await Deno.readTextFile('/private/tmp/yumidang-release88-http-isolated/status-private.json'));
if (state.API_URL !== 'http://127.0.0.1:59621') throw new Error('OWNED_LOCAL_API_REQUIRED');
const secret = crypto.randomUUID();
const values: Record<string,string> = {
  SUPABASE_URL: state.API_URL, SUPABASE_ANON_KEY: state.ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: state.SERVICE_ROLE_KEY, INTERNAL_WORKER_SECRET: secret,
  ALLOWED_ORIGINS: '[]', UPSTREAM_TIMEOUT_MS: '15000', MAX_REQUEST_BYTES: '65536',
};
let externalRequests = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== '127.0.0.1') { externalRequests++; throw new Error('EXTERNAL_REQUEST_BLOCKED'); }
  return originalFetch(input, init);
}) as typeof fetch;
const server = Deno.serve({ hostname:'127.0.0.1', port:0, onListen:()=>{} }, createRuntimeHandler(k=>values[k]));
try {
  const url = `http://127.0.0.1:${server.addr.port}/functions/v1/service-api/internal/ai-feedback-maintenance`;
  const send = (token: string) => fetch(url,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({limit:1})});
  const denied = await send('not-the-internal-secret');
  if (denied.status !== 403) throw new Error('INTERNAL_AUTH_BYPASS');
  await denied.arrayBuffer();
  const allowed = await send(secret);
  const body = await allowed.json();
  if (allowed.status !== 200 || !Number.isInteger(body.data.deletedCount) || body.data.deletedCount < 0 || body.data.deletedCount > 1) throw new Error('BOUNDED_MAINTENANCE_FAILED');
  const ready = await fetch(state.API_URL+'/rest/v1/rpc/get_ai_feedback_readiness',{method:'POST',headers:{authorization:`Bearer ${state.SERVICE_ROLE_KEY}`,apikey:state.SERVICE_ROLE_KEY,'content-type':'application/json'},body:'{}'});
  const capability = await ready.json();
  if (ready.status !== 200 || capability.reportReady !== false || externalRequests !== 0) throw new Error('READINESS_MUST_REMAIN_CLOSED');
  const receipt = {internalHttp:'PASS',wrongSecretRejected:true,boundedCleanup:true,reportEnabled:false,externalRequests};
  await Deno.writeTextFile('/private/tmp/yumidang-additional-backend-20261008/internal-maintenance-receipt.json',JSON.stringify(receipt));
  console.log(JSON.stringify(receipt));
} finally { await server.shutdown(); globalThis.fetch = originalFetch; }
