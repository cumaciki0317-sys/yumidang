/** 민규: 신고 삭제 전용 모형. 실제 Storage 예약 trigger·권한·파기·운영 검증은 아니다. */
import {test} from "node:test";
import assert from "node:assert/strict";
import {createReportRetentionStorageAdapter,ReportRetentionStorageUnknown,type ReportRetentionTask,type ReportRetentionDeleteAck,type ReportRetentionStoragePorts} from "../../../backend/supabase/functions/_shared/services/report-retention-storage.ts";
import {loadRuntimeConfig} from "../../../backend/supabase/functions/_shared/config/env.ts";
import {toPublicError} from "../../../backend/supabase/functions/_shared/http/errors.ts";
const uid=(n:number)=>`11111111-1111-4111-8111-${String(n).padStart(12,"0")}`;
const config=loadRuntimeConfig(k=>({SUPABASE_URL:"https://project.example.test",SUPABASE_ANON_KEY:"anon",SUPABASE_SERVICE_ROLE_KEY:"service",INTERNAL_WORKER_SECRET:"worker_secret_longer_than_32_characters",ALLOWED_ORIGINS:"[]",MAX_REQUEST_BYTES:"8192",UPSTREAM_TIMEOUT_MS:"1000"}as Record<string,string>)[k]);
const base:ReportRetentionTask={taskId:uid(1),taskLeaseToken:uid(2),taskExpiresAt:"2099-01-01T00:00:00Z",reportId:uid(3),closureRevision:1,kind:"storage_object",assetId:uid(4),bucketId:"report-evidence",objectName:uid(5)+"/"+uid(4)+".png",objectId:uid(6),retentionDueAt:"2098-01-01T00:00:00Z",closureProofId:uid(7)};
function setup(t:ReportRetentionTask=base){
 const calls:string[]=[],signal=new AbortController();let deleted=false,checks=0,recorded:ReportRetentionDeleteAck|null=null;
 const s={calls,signal,beginCalls:0,metadata:{size:634,mimetype:"image/png"}as Record<string,unknown>,objectId:t.objectId,rows:[{id:t.objectId,name:t.objectName,bucket_id:t.bucketId}]as unknown,absentStatus:404,absentBody:null as unknown,failCheck:0,failAck:false,deleteStatus:200,deleteLost:false,ignoreAbort:false,late:null as null|(()=>void),ports:null as unknown as ReportRetentionStoragePorts,adapter:null as unknown as ReturnType<typeof createReportRetentionStorageAdapter>};
 s.ports={begin:async t=>{s.beginCalls++;return {taskId:t.taskId,dispatchId:uid(10),alreadyApplied:false};},check:async t=>{checks++;if(checks===s.failCheck)throw new Error("DB guard/lease closed");return {...t};},getAck:async()=>recorded,recordAck:async(t,h)=>{if(s.failAck)throw new Error("ACK response lost");recorded={receiptId:uid(8),taskId:t.taskId,assetId:t.assetId!,objectId:t.objectId!,ackSha256:h};return recorded;}};
 s.adapter=createReportRetentionStorageAdapter(config,async(url,init)=>{
  const path=new URL(String(url)).pathname,method=init?.method??"GET";calls.push(method+":"+path);const h=new Headers(init?.headers);assert.equal(h.get("authorization"),"Bearer service");assert.equal(h.get("apikey"),"service");assert.equal(init?.redirect,"error");assert.ok(init?.signal instanceof AbortSignal);
  if(method==="DELETE"){
   assert.equal(path,"/storage/v1/object/report-evidence");assert.deepEqual(JSON.parse(String(init?.body)),{prefixes:[t.objectName]});
   if(s.deleteLost)throw new Error("DELETE response lost");if(s.ignoreAbort){setTimeout(()=>s.signal.abort(),1);return await new Promise<Response>(resolve=>{s.late=()=>resolve(Response.json(s.rows));});}deleted=true;return Response.json(s.rows,{status:s.deleteStatus});
  }
  if(!deleted)return Response.json({id:s.objectId,name:t.objectName,bucket_id:t.bucketId,size:s.metadata.size,content_type:s.metadata.mimetype,metadata:{size:1,mimetype:"image/jpeg"}});
  return s.absentBody===null?new Response(null,{status:s.absentStatus}):Response.json(s.absentBody,{status:s.absentStatus});
 });return s;
}
const deletionCount=(s:ReturnType<typeof setup>)=>s.calls.filter(v=>v.startsWith("DELETE:")).length;
const unavailable=(e:unknown)=>toPublicError(e).error.code==="EXTERNAL_UNAVAILABLE";

test("exact object DELETE200→durable ACK→info/GET404 then priorACK retry has no DELETE",async()=>{
 const s=setup(),r=await s.adapter.deleteExact(base,s.ports,s.signal.signal);assert.equal(r.status,"verified");assert.match(r.ack.ackSha256,/^[a-f0-9]{64}$/);assert.equal(deletionCount(s),1);
 assert.equal(s.calls.filter(v=>v.startsWith("GET:")).length,3);
 const replay=await s.adapter.deleteExact(base,s.ports,s.signal.signal);assert.deepEqual(replay,r);assert.equal(deletionCount(s),1);
 const absent=await s.adapter.verifyAbsent(base,s.ports,s.signal.signal);assert.deepEqual(absent,r);assert.equal(deletionCount(s),1);
});
test("meaning404 only NoSuchKey400 is accepted with durable ACK; permission/other errors are not absent",async()=>{
 const s=setup();await s.adapter.deleteExact(base,s.ports,s.signal.signal);s.absentStatus=400;s.absentBody={code:"NoSuchKey",statusCode:"404"};await s.adapter.verifyAbsent(base,s.ports,s.signal.signal);
 for(const [status,body]of [[401,null],[403,null],[500,null],[400,{code:"NoSuchBucket",statusCode:"404"}],[400,{code:"AccessDenied",statusCode:"404"}]]as const){s.absentStatus=status;s.absentBody=body;await assert.rejects(s.adapter.verifyAbsent(base,s.ports,s.signal.signal),unavailable);}
 assert.equal(deletionCount(s),1);
});
test("ACK 없는 부재와 metadata-only task는 삭제 완료로 추정하지 않는다",async()=>{
 const s=setup();await assert.rejects(s.adapter.verifyAbsent(base,s.ports,s.signal.signal));assert.equal(s.calls.length,0);
 const absent=setup();absent.adapter=createReportRetentionStorageAdapter(config,async()=>new Response(null,{status:404}));await assert.rejects(absent.adapter.deleteExact(base,absent.ports,absent.signal.signal),unavailable);
 const metadata={...base,kind:"report_metadata",assetId:null,bucketId:null,objectName:null,objectId:null};await assert.rejects(s.adapter.deleteExact(metadata as ReportRetentionTask,s.ports,s.signal.signal),unavailable);assert.equal(s.calls.length,0);
});
test("다른 objectId·MIME·크기 타입/상한·경로는 DELETE 전에 거절한다",async()=>{
 for(const change of [()=>{const s=setup();s.objectId=uid(99);return s;},()=>{const s=setup();s.metadata.mimetype="image/jpeg";return s;},()=>{const s=setup();s.metadata.size="634";return s;},()=>{const s=setup();s.metadata.size=5242881;return s;},()=>{const s=setup();s.metadata.size=0;return s;}]){const s=change();await assert.rejects(s.adapter.deleteExact(base,s.ports,s.signal.signal),unavailable);assert.equal(deletionCount(s),0);}
 for(const objectName of ["../file.png",uid(5)+"/"+uid(9)+".png",uid(5)+"/"+uid(4)+".gif"]){const s=setup();await assert.rejects(s.adapter.deleteExact({...base,objectName},s.ports,s.signal.signal),unavailable);assert.equal(s.calls.length,0);}
});
test("JPEG PNG WebP metadata·확장자와5MiB inclusive bound를 확인한다",async()=>{
 for(const [extension,mime]of [["jpg","image/jpeg"],["png","image/png"],["webp","image/webp"]]as const){const t={...base,objectName:uid(5)+"/"+uid(4)+"."+extension},s=setup(t);s.metadata={size:5242880,mimetype:mime};const result=await s.adapter.deleteExact(t,s.ports,s.signal.signal);assert.equal(result.status,"verified");assert.equal(deletionCount(s),1);}
});
test("DB guard/lease check failure and changed exact12 block DELETE",async()=>{
 for(const n of [1,2]){const s=setup();s.failCheck=n;await assert.rejects(s.adapter.deleteExact(base,s.ports,s.signal.signal));assert.equal(deletionCount(s),0);}
 const s=setup();s.ports.check=async t=>({...t,taskLeaseToken:uid(99)});await assert.rejects(s.adapter.deleteExact(base,s.ports,s.signal.signal));assert.equal(s.calls.length,0);
});
test("multiple/wrong DELETE ACK or lost DELETE response are terminal unknown without ACK write/retry",async()=>{
 for(const kind of ["many","wrong","lost","500"]){const s=setup();if(kind==="many")s.rows=[{id:base.objectId,name:base.objectName},{id:uid(9),name:"other"}];if(kind==="wrong")s.rows=[{id:uid(9),name:base.objectName}];if(kind==="lost")s.deleteLost=true;if(kind==="500")s.deleteStatus=500;
  await assert.rejects(s.adapter.deleteExact(base,s.ports,s.signal.signal),e=>e instanceof ReportRetentionStorageUnknown&&e.phase==="delete"&&e.terminal);assert.equal(deletionCount(s),1);assert.equal(await s.ports.getAck(base,s.signal.signal),null);
 }
});
test("ACK 응답 유실과 DELETE 후 lease expiry는 terminal unknown; 자동 재DELETE/cleanup 없음",async()=>{
 for(const failAck of [true,false]){const s=setup();s.failAck=failAck;if(!failAck)s.failCheck=4;await assert.rejects(s.adapter.deleteExact(base,s.ports,s.signal.signal),e=>e instanceof ReportRetentionStorageUnknown&&e.phase==="ack"&&e.terminal);assert.equal(deletionCount(s),1);assert.equal(s.calls.length,2);}
});
test("abort-before has no transport; provider ignores DELETE abort yet caller stops terminally",async()=>{
 const before=setup();before.signal.abort();await assert.rejects(before.adapter.deleteExact(base,before.ports,before.signal.signal));assert.equal(before.calls.length,0);
 const s=setup();s.ignoreAbort=true;await assert.rejects(s.adapter.deleteExact(base,s.ports,s.signal.signal),e=>e instanceof ReportRetentionStorageUnknown&&e.phase==="delete");assert.equal(deletionCount(s),1);s.late!();await new Promise(resolve=>setTimeout(resolve,1));assert.equal(await s.ports.getAck(base,new AbortController().signal),null);assert.equal(s.calls.length,2);
});
test("foreign durable ACK·잘못된 ACK hash는 객체 부재와 삭제 완료로 수용하지 않는다",async()=>{
 const prior=setup();prior.ports.getAck=async()=>({receiptId:uid(8),taskId:uid(99),assetId:base.assetId,objectId:base.objectId,ackSha256:"a".repeat(64)});await assert.rejects(prior.adapter.deleteExact(base,prior.ports,prior.signal.signal),unavailable);assert.equal(prior.calls.length,0);
 const lost=setup();lost.ports.recordAck=async()=>({receiptId:uid(8),taskId:base.taskId,assetId:base.assetId,objectId:base.objectId,ackSha256:"a".repeat(64)});await assert.rejects(lost.adapter.deleteExact(base,lost.ports,lost.signal.signal),e=>e instanceof ReportRetentionStorageUnknown&&e.phase==="ack");assert.equal(deletionCount(lost),1);assert.equal(lost.calls.length,2);
});
test("서비스 자격 누락과 invalid exact12 입력은 외부전송 없이 거절한다",async()=>{
 let calls=0;assert.throws(()=>createReportRetentionStorageAdapter({...config,supabaseServiceRoleKey:undefined},async()=>{calls++;assert.fail("missing service credential");}));assert.equal(calls,0);
 for(const input of [{...base,extra:true},{...base,closureRevision:0},{...base,taskExpiresAt:"2099-02-30T00:00:00Z"}]){const s=setup();await assert.rejects(s.adapter.deleteExact(input,s.ports,s.signal.signal),unavailable);assert.equal(s.calls.length,0);}
});
test("DB canonical opaque UUID는 v1/v7·그룹값을 보존하고 NIL/invalid는 전송 전 거절한다",async()=>{
 for(const objectId of ["12345678-1234-1234-8123-123456789abc","12345678-1234-7123-9123-123456789abc","12345678-1234-1234-0123-123456789abc"]){const t={...base,objectId},s=setup(t);assert.equal((await s.adapter.deleteExact(t,s.ports,s.signal.signal)).status,"verified");assert.equal(deletionCount(s),1);}
 for(const objectId of ["00000000-0000-0000-0000-000000000000","12345678-1234-7123-9123-123456789ABC","not-a-uuid"]){const s=setup();await assert.rejects(s.adapter.deleteExact({...base,objectId},s.ports,s.signal.signal),unavailable);assert.equal(s.calls.length,0);}
});
test("scheduling 직후 synchronous abort는 다음 microtask port/fetch dispatch를 차단한다",async()=>{
 const s=setup();let checks=0,acks=0;s.ports.check=async t=>{checks++;return t;};s.ports.getAck=async()=>{acks++;return null;};
 const pending=s.adapter.deleteExact(base,s.ports,s.signal.signal);s.signal.abort();await assert.rejects(pending);await Promise.resolve();assert.equal(checks,0);assert.equal(acks,0);assert.equal(s.calls.length,0);
});


test("최초 begin=false 뒤만 DELETE하고 durableACK 재조회는 begin/DELETE를 추가하지 않는다",async()=>{
 const s=setup();await s.adapter.deleteExact(base,s.ports,s.signal.signal);assert.equal(s.beginCalls,1);assert.equal(deletionCount(s),1);await s.adapter.deleteExact(base,s.ports,s.signal.signal);await s.adapter.verifyAbsent(base,s.ports,s.signal.signal);assert.equal(s.beginCalls,1);assert.equal(deletionCount(s),1);
});
test("begin 중복true·유실·변조·중단은 dispatch unknown이며 DELETE/ACK/cleanup0이다",async()=>{
 for(const mode of["duplicate","lost","foreign","extra","nil","abort","lease_after_begin"]){const s=setup();let records=0;s.ports.recordAck=async()=>{records++;throw new Error("호출하면 안 됨");};s.ports.begin=async t=>{s.beginCalls++;if(mode==="lost")throw new Error("begin response lost");if(mode==="abort")s.signal.abort();return {taskId:mode==="foreign"?uid(99):t.taskId,dispatchId:mode==="nil"?"00000000-0000-0000-0000-000000000000":uid(10),alreadyApplied:mode==="duplicate",...(mode==="extra"?{extra:true}:{})};};if(mode==="lease_after_begin")s.failCheck=3;
 await assert.rejects(s.adapter.deleteExact(base,s.ports,s.signal.signal),e=>e instanceof ReportRetentionStorageUnknown&&e.phase==="dispatch"&&e.terminal);assert.equal(s.beginCalls,1);assert.equal(deletionCount(s),0);assert.equal(records,0);assert.equal(s.calls.length,1);
 }
});

 test("Storage user metadata는 실제 MIME·크기 검증을 대체할 수 없다",async()=>{const s=setup();s.adapter=createReportRetentionStorageAdapter(config,async()=>Response.json({id:base.objectId,name:base.objectName,bucket_id:base.bucketId,metadata:{size:634,mimetype:"image/png"}}));await assert.rejects(s.adapter.deleteExact(base,s.ports,s.signal.signal),unavailable);assert.equal(s.beginCalls,0);});
