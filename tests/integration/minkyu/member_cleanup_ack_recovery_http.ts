/** SQL108 common product processor→HTTPS→real PostgREST/TLS DB and Storage. Full queue CLI excluded. */
import assert from 'node:assert/strict';
import {loadRuntimeConfig}from'../../../backend/supabase/functions/_shared/config/env.ts';
import {createMemberCleanupAckRecoveryPorts}from'../../../backend/supabase/functions/_shared/db/repositories/member-cleanup.ts';
import {createMemberCleanupAdapter,processMemberCleanupTask}from'../../../backend/supabase/functions/_shared/auth/member-cleanup.ts';
const root='/private/tmp/yumidang-queue-tls99';const f=JSON.parse(await Deno.readTextFile(root+'/member-ack-recovery-private.json'));
assert.equal(f.phase,'ack_prepared');
let deletes=0,storageGets=0,external=0,beginDeletes=0,ackWrites=0;
const server=Deno.serve({hostname:'127.0.0.1',port:0,cert:await Deno.readTextFile(root+'/server.crt'),key:await Deno.readTextFile(root+'/server.key'),onListen(){}},async request=>{
 const url=new URL(request.url);let destination;
 if(url.pathname.startsWith('/rest/v1/')){
  if(url.pathname.endsWith('/begin_member_cleanup_delete')){beginDeletes++;return new Response('DISPATCH_DISABLED',{status:500});}
  if(url.pathname.endsWith('/record_member_cleanup_delete_ack')){ackWrites++;return new Response('ACK_WRITE_DISABLED',{status:500});}
  destination='http://127.0.0.1:61621'+url.pathname.slice('/rest/v1'.length)+url.search;
 }
 else if(url.pathname.startsWith('/storage/v1/')){
  if(request.method==='DELETE'){deletes++;return new Response('DELETE_DISABLED',{status:500});}
  assert.equal(request.method,'GET');storageGets++;destination='http://127.0.0.1:61623'+url.pathname.slice('/storage/v1'.length)+url.search;
 }else return new Response('NOT_FOUND',{status:404});
 return await fetch(destination,{method:request.method,headers:request.headers,body:['GET','HEAD'].includes(request.method)?undefined:await request.arrayBuffer(),redirect:'error'});
});
const client=Deno.createHttpClient({caCerts:[await Deno.readTextFile(root+'/ca.crt')]});const origin='https://127.0.0.1:'+server.addr.port;
const localFetch:typeof fetch=(input,init)=>{const url=new URL(input instanceof Request?input.url:String(input));if(url.origin!==origin){external++;throw Error('EXTERNAL_DISABLED');}return fetch(input,{...init,client}as unknown as RequestInit);};
const values:Record<string,string>={SUPABASE_URL:origin,SUPABASE_ANON_KEY:f.anonKey,SUPABASE_SERVICE_ROLE_KEY:f.serviceKey,INTERNAL_WORKER_SECRET:f.internalSecret,ALLOWED_ORIGINS:'[]',MAX_REQUEST_BYTES:'65536',UPSTREAM_TIMEOUT_MS:'10000'};
try{
 const config=loadRuntimeConfig(k=>values[k]);const ports=createMemberCleanupAckRecoveryPorts(config,f.taskId,localFetch);
 await assert.rejects(ports.beginDelete!({taskId:f.taskId,leaseToken:f.originalLease,workerRunToken:f.globalToken,objectId:f.objectId}));
 await assert.rejects(ports.recordDeleteAck!({taskId:f.taskId,leaseToken:f.originalLease,workerRunToken:f.globalToken,objectId:f.objectId,ackSha256:'a'.repeat(64)}));
 await assert.rejects(ports.claim(crypto.randomUUID()));
 const result=await processMemberCleanupTask(f.globalToken,ports,createMemberCleanupAdapter(config,localFetch));assert.deepEqual(result,{status:'applied'});
 assert.deepEqual(await processMemberCleanupTask(f.globalToken,ports,createMemberCleanupAdapter(config,localFetch)),{status:'idle'});
 assert.equal(storageGets,2);assert.equal(deletes,0);assert.equal(external,0);
 assert.equal(beginDeletes,0);assert.equal(ackWrites,0);
 const denied=await localFetch(origin+'/rest/v1/rpc/claim_member_cleanup_ack_recovery',{method:'POST',headers:{authorization:'Bearer '+f.anonKey,apikey:f.anonKey,'content-type':'application/json'},body:JSON.stringify({p_task_id:f.taskId,p_worker_run_token:f.globalToken})});assert.equal(denied.status,401);
 const receipt={sql108CommonMemberProcessorHttps:'PASS',realStorageGetCount:storageGets,additionalDeleteCount:deletes,additionalDispatchCount:beginDeletes,additionalAckWriteCount:ackWrites,completedThenIdle:true,wrongTokenDenied:true,anonDenied:true,externalRequests:external,fullQueueCli:'NOT_RUN',operatingChanged:false};
 await Deno.writeTextFile(root+'/member-ack-recovery-http-receipt.json',JSON.stringify(receipt),{mode:0o600});console.log(JSON.stringify(receipt));
}finally{client.close();await server.shutdown();}
