/** 실제 민규 내부 HTTP handler의 TLS·권한 검증. mutation RPC는 호출하지 않는다. */
import { createRuntimeHandler } from '../../../backend/supabase/functions/service-api/index.ts';
import { createReviewSummaryWorkerRuntime } from '../../../backend/supabase/functions/review-summary-worker/index.ts';
const root='/private/tmp/yumidang-queue-tls99/';
const state=JSON.parse(await Deno.readTextFile('/private/tmp/yumidang-release88-http-isolated/status-private.json'));
if(state.API_URL!=='http://127.0.0.1:59621')throw new Error('OWNED_LOCAL_REQUIRED');
const secret=crypto.randomUUID();
const config:Record<string,string>={SUPABASE_URL:state.API_URL,SUPABASE_ANON_KEY:state.ANON_KEY,SUPABASE_SERVICE_ROLE_KEY:state.SERVICE_ROLE_KEY,INTERNAL_WORKER_SECRET:secret,ALLOWED_ORIGINS:'[]',UPSTREAM_TIMEOUT_MS:'15000',MAX_REQUEST_BYTES:'65536'};
let upstream=0;
const fetchOriginal=globalThis.fetch;
globalThis.fetch=(()=>{upstream++;throw new Error('NO_UPSTREAM_EXPECTED');})as typeof fetch;
const server=Deno.serve({hostname:'127.0.0.1',port:0,key:await Deno.readTextFile(root+'server.key'),cert:await Deno.readTextFile(root+'server.crt'),onListen:()=>{}},createRuntimeHandler(k=>config[k]));
const good=Deno.createHttpClient({caCerts:[await Deno.readTextFile(root+'ca.crt')]});
const bad=Deno.createHttpClient({caCerts:[await Deno.readTextFile(root+'wrong-ca.crt')]});
const worker=Deno.serve({hostname:'127.0.0.1',port:0,key:await Deno.readTextFile(root+'server.key'),cert:await Deno.readTextFile(root+'server.crt'),onListen:()=>{}},createReviewSummaryWorkerRuntime(k=>config[k]));
try{
 const url=`https://127.0.0.1:${server.addr.port}/functions/v1/service-api/internal/ai-feedback-maintenance`;
 const send=(token:string,client:Deno.HttpClient)=>fetchOriginal(url,{client,method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:'{"limit":0}'});
 const rejected=await send('wrong-secret',good);if(rejected.status!==403)throw new Error('AUTH_BYPASS');await rejected.arrayBuffer();
 const valid=await send(secret,good);if(valid.status!==400)throw new Error('VALIDATION_REQUIRED');await valid.arrayBuffer();
 let blocked=false;try{await send(secret,bad);}catch{blocked=true;}if(!blocked||upstream!==0)throw new Error('TLS_OR_MUTATION_BYPASS');
 const workerUrl=`https://127.0.0.1:${worker.addr.port}/functions/v1/review-summary-worker`;
 const workerSend=(token:string)=>fetchOriginal(workerUrl,{client:good,method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:'{}'});
 const unauthorized=await workerSend('wrong-secret');if(unauthorized.status!==403)throw new Error('WORKER_AUTH_BYPASS');await unauthorized.arrayBuffer();
 const disabled=await workerSend(secret);const body=await disabled.json();if(disabled.status!==200||body.data?.status!=='not_enabled'||upstream!==0)throw new Error('WORKER_NOT_FAIL_CLOSED');
 const receipt={httpsInternalHandler:'PASS',actualSummaryWorkerFailClosed:true,wrongSecretRejected:true,trustedCaAccepted:true,wrongCaRejected:true,upstreamRequests:upstream,mutationRequests:0};
 await Deno.writeTextFile(root+'https-receipt.json',JSON.stringify(receipt));console.log(JSON.stringify(receipt));
}finally{good.close();bad.close();await server.shutdown();await worker.shutdown();globalThis.fetch=fetchOriginal;}
