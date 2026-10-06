/** 민규: 신고 파기 RPC와 Storage 체인의 모형 검증. 실제 DB 예약/guard/Provider 준비를 주장하지 않는다. */
import {test}from"node:test";
import assert from"node:assert/strict";
import {loadRuntimeConfig}from"../../../backend/supabase/functions/_shared/config/env.ts";
import {createReportRetentionStoragePorts}from"../../../backend/supabase/functions/_shared/db/report-retention-client.ts";
import {createInternalClient}from"../../../backend/supabase/functions/_shared/db/internal-client.ts";
import {createPublicClient}from"../../../backend/supabase/functions/_shared/db/public-client.ts";
import {createUserClient}from"../../../backend/supabase/functions/_shared/db/user-client.ts";
import {requirePrincipal}from"../../../backend/supabase/functions/_shared/auth/principal.ts";
import {toPublicError}from"../../../backend/supabase/functions/_shared/http/errors.ts";
import {createReportRetentionStorageAdapter,ReportRetentionStorageUnknown,type ReportRetentionTask}from"../../../backend/supabase/functions/_shared/services/report-retention-storage.ts";
const vals:Record<string,string>={SUPABASE_URL:"https://project.example.test",SUPABASE_ANON_KEY:"anon-fixture",SUPABASE_SERVICE_ROLE_KEY:"service-fixture",INTERNAL_WORKER_SECRET:"internal_fixture_secret_more_than_32_chars",ALLOWED_ORIGINS:"[]",MAX_REQUEST_BYTES:"8192",UPSTREAM_TIMEOUT_MS:"1000"};
const config=loadRuntimeConfig(k=>vals[k]),id=(n:number)=>String(n).padStart(8,"0")+"-1234-7234-8234-123456789abc";
const context={jobId:id(1),jobLeaseToken:id(2),globalToken:id(3)};
const task:ReportRetentionTask={taskId:id(4),taskLeaseToken:id(5),taskExpiresAt:"2030-01-01T00:00:00.123456Z",reportId:id(6),closureRevision:7,kind:"storage_object",assetId:id(8),bucketId:"report-evidence",objectName:id(9)+"/"+id(8)+".png",objectId:id(10),retentionDueAt:"2020-01-01T00:00:00Z",closureProofId:id(11)};
const hash="a".repeat(64),ack={receiptId:id(12),taskId:task.taskId,assetId:task.assetId,objectId:task.objectId,ackSha256:hash};
const signal=()=>new AbortController().signal;
const names=["enqueue_report_retention_purges","claim_report_retention_task","check_report_retention_task","get_report_retention_delete_ack","record_report_retention_delete_ack","complete_report_retention_task","purge_report_retention_terminal_receipts","claim_supported_job","begin_report_retention_delete"];
const expected={p_task_id:task.taskId,p_task_lease_token:task.taskLeaseToken,p_job_id:context.jobId,p_job_lease_token:context.jobLeaseToken,p_global_token:context.globalToken,p_object_id:task.objectId};

test("내부 설정과 exact3 context·exact12 task·hash·이미 중단된 signal은 전송 전에 거절한다",async()=>{
 let calls=0;const fake:typeof fetch=async()=>{calls++;return Response.json(null);};
 for(const missing of["SUPABASE_SERVICE_ROLE_KEY","INTERNAL_WORKER_SECRET"])assert.throws(()=>createReportRetentionStoragePorts(loadRuntimeConfig(k=>k===missing?undefined:vals[k]),context,fake));
 for(const c of[{...context,jobId:"00000000-0000-0000-0000-000000000000"},{...context,extra:true},{jobId:context.jobId,jobLeaseToken:context.jobLeaseToken}])assert.throws(()=>createReportRetentionStoragePorts(config,c as typeof context,fake));
 const ports=createReportRetentionStoragePorts(config,context,fake);
 for(const t of[{...task,extra:true},{...task,objectId:null},{...task,kind:"report_metadata",assetId:null,objectId:null,bucketId:null,objectName:null},{...task,objectName:"../"+task.assetId+".png"},{...task,taskExpiresAt:"2030-02-30T00:00:00Z"}])await assert.rejects(ports.check(t as ReportRetentionTask,signal()));
 await assert.rejects(ports.recordAck(task,"BAD",signal()));await assert.rejects(ports.recordAck(task,undefined as unknown as string,signal()));
 const c=new AbortController();c.abort();await assert.rejects(ports.check(task,c.signal));assert.equal(calls,0);
});

test("원 task와 불변 job context를 exact6/7 wire로 서비스 JWT·apikey와 결합 signal에 전달한다",async()=>{
 const seen:unknown[]=[];const mutable={...context};const ports=createReportRetentionStoragePorts(config,mutable,async(url,init)=>{
  const name=String(url).split("/").at(-1);seen.push({name,args:JSON.parse(String(init?.body))});const h=new Headers(init?.headers);assert.equal(h.get("apikey"),vals.SUPABASE_SERVICE_ROLE_KEY);assert.equal(h.get("authorization"),"Bearer "+vals.SUPABASE_SERVICE_ROLE_KEY);assert.equal(init?.redirect,"error");assert.ok(init?.signal instanceof AbortSignal);assert.equal(init.signal.aborted,false);
  return Response.json(name==="check_report_retention_task"?task:name==="get_report_retention_delete_ack"?null:ack);
 });mutable.jobId=id(99);
 assert.deepEqual(await ports.check(task,signal()),task);assert.equal(await ports.getAck(task,signal()),null);assert.deepEqual(await ports.recordAck(task,hash,signal()),ack);
 assert.deepEqual(seen,[{name:"check_report_retention_task",args:expected},{name:"get_report_retention_delete_ack",args:expected},{name:"record_report_retention_delete_ack",args:{...expected,p_ack_sha256:hash}}]);
});

test("동기 abort가 dispatch microtask보다 먼저면 전송0, 진행 중 fetch 무시에도 abort가 종료하고 늦은 결과를 버린다",async()=>{
 let calls=0;const c=new AbortController();const p=createReportRetentionStoragePorts(config,context,async()=>{calls++;return Response.json(task);}).check(task,c.signal);c.abort();await assert.rejects(p);assert.equal(calls,0);
 let late!:(r:Response)=>void;let dispatched! :()=>void;const ready=new Promise<void>(r=>dispatched=r),d=new AbortController();let upstream:AbortSignal|null=null;
 const pending=createReportRetentionStoragePorts(config,context,async(_u,i)=>{calls++;upstream=i!.signal as AbortSignal;dispatched();return new Promise<Response>(r=>late=r);}).check(task,d.signal);await ready;d.abort();await assert.rejects(pending);assert.equal(upstream!.aborted,true);late(Response.json(task));await new Promise(r=>setTimeout(r,0));assert.equal(calls,1);
});

test("fetch가 timeout을 무시해도 bounded RPC가503으로 끝나며 원문은 노출하지 않는다",async()=>{
 const short=loadRuntimeConfig(k=>k==="UPSTREAM_TIMEOUT_MS"?"5":vals[k]);let calls=0;let late!:(r:Response)=>void;let upstream:AbortSignal|null=null;
 const ports=createReportRetentionStoragePorts(short,context,async(_u,i)=>{calls++;upstream=i!.signal as AbortSignal;return new Promise<Response>(r=>late=r);});await assert.rejects(ports.check(task,signal()),e=>toPublicError(e).status===503);assert.equal(upstream!.aborted,true);assert.equal(calls,1);late(Response.json(task));
});

test("check 및 ACK strict decoder는 교체객체·추가필드·다른hash를 거절한다",async()=>{
 for(const value of[{...task,objectId:id(90)},{...task,extra:true},{...task,closureRevision:8}]){const p=createReportRetentionStoragePorts(config,context,async()=>Response.json(value));await assert.rejects(p.check(task,signal()));}
 for(const value of[{...ack,objectId:id(90)},{...ack,extra:true},{...ack,ackSha256:"BAD"}]){const p=createReportRetentionStoragePorts(config,context,async()=>Response.json(value));await assert.rejects(p.getAck(task,signal()));}
 const p=createReportRetentionStoragePorts(config,context,async()=>Response.json({...ack,ackSha256:"b".repeat(64)}));await assert.rejects(p.recordAck(task,hash,signal()),e=>e instanceof ReportRetentionStorageUnknown&&e.phase==="ack");
});

test("권한·닫힌 guard·hash충돌 오류는 공개 변환에서 원문과 credential을 숨긴다",async()=>{
 for(const [status,code,publicStatus]of[[403,"42501",403],[500,"55000",503],[409,"40001",409]]as const){const ports=createReportRetentionStoragePorts(config,context,async()=>Response.json({code,message:"비밀 원문 "+vals.SUPABASE_SERVICE_ROLE_KEY},{status}));await assert.rejects(ports.check(task,signal()),e=>{const safe=toPublicError(e);assert.equal(safe.status,publicStatus);assert.equal(JSON.stringify(safe).includes("비밀"),false);assert.equal(JSON.stringify(safe).includes(vals.SUPABASE_SERVICE_ROLE_KEY),false);return true;});}
 const denied=createReportRetentionStoragePorts(config,context,async()=>Response.json({code:"42501"},{status:403}));await assert.rejects(denied.recordAck(task,hash,signal()),e=>!(e instanceof ReportRetentionStorageUnknown)&&toPublicError(e).status===403);
});

test("ACK dispatch 후 응답 유실·중단은 terminal unknown이며 자동 재전송하지 않는다",async()=>{
 let calls=0;const c=new AbortController();let ready! :()=>void;const started=new Promise<void>(r=>ready=r);const ports=createReportRetentionStoragePorts(config,context,async()=>{calls++;ready();return new Promise<Response>(()=>{});});const pending=ports.recordAck(task,hash,c.signal);await started;c.abort();await assert.rejects(pending,e=>e instanceof ReportRetentionStorageUnknown&&e.phase==="ack"&&e.terminal);assert.equal(calls,1);
});

test("exact9 전송 목록은 공개·사용자 목록과 독립이고 임의RPC를 허용하지 않는다",async()=>{
 let calls=0;const fake:typeof fetch=async()=>{calls++;return Response.json(null);};const token="synthetic.original.jwt";const principal=await requirePrincipal(new Request("https://local.test",{headers:{authorization:"Bearer "+token}}),config,async()=>Response.json({id:id(55),role:"authenticated",is_anonymous:false}));const internal=createInternalClient(config,fake);
 for(const name of names){assert.equal(internal.supportsRpc!(name),true);for(const db of[createPublicClient(config,fake),createUserClient(config,principal,fake)]){assert.equal(db.supportsRpc!(name),false);await assert.rejects(db.rpc(name,{}));}}
 await assert.rejects(internal.rpc("delete_storage_object_any",{}));assert.equal(calls,0);
});

test("실제 호출 없는 전체 adapter+RPC 모형 체인은 check→begin→DELETE→durableACK→absence만 처리한다",async()=>{
 const seen:string[]=[];let saved:unknown=null;let deleted=false;const fake:typeof fetch=async(url,init)=>{const u=String(url),rpc=u.split("/").at(-1)!;const h=new Headers(init?.headers);assert.equal(h.get("authorization"),"Bearer "+vals.SUPABASE_SERVICE_ROLE_KEY);
  if(u.includes("/rest/v1/rpc/")){seen.push(rpc);if(rpc==="begin_report_retention_delete")return Response.json({taskId:task.taskId,dispatchId:id(13),alreadyApplied:false});if(rpc==="check_report_retention_task")return Response.json(task);if(rpc==="get_report_retention_delete_ack")return Response.json(saved);if(rpc==="record_report_retention_delete_ack"){const args=JSON.parse(String(init?.body));saved={...ack,ackSha256:args.p_ack_sha256};return Response.json(saved);}assert.fail("다른RPC 전송0");}
  if(init?.method==="DELETE"){seen.push("DELETE");assert.deepEqual(JSON.parse(String(init.body)),{prefixes:[task.objectName]});deleted=true;return Response.json([{id:task.objectId,name:task.objectName}]);}
  seen.push("StorageGET");if(deleted)return Response.json({code:"NoSuchKey",statusCode:"404"},{status:400});return Response.json({id:task.objectId,name:task.objectName,bucket_id:task.bucketId,content_type:"image/png",size:5242880,metadata:{}});
 };const ports=createReportRetentionStoragePorts(config,context,fake),adapter=createReportRetentionStorageAdapter(config,fake);assert.equal((await adapter.deleteExact(task,ports,signal())).status,"verified");assert.equal(seen.filter(n=>n==="DELETE").length,1);assert.equal(seen.filter(n=>n==="begin_report_retention_delete").length,1);assert.ok(seen.indexOf("begin_report_retention_delete")<seen.indexOf("DELETE"));assert.equal(seen.filter(n=>n==="record_report_retention_delete_ack").length,1);assert.equal((await adapter.deleteExact(task,ports,signal())).status,"verified");assert.equal(seen.filter(n=>n==="DELETE").length,1);assert.equal(seen.some(n=>n.includes("complete")||n.includes("enqueue")||n.includes("claim")),false);
});


test("ACK 500·503 및 잘못된 응답은 terminal unknown이며 503 후 자동 재전송0이다",async()=>{
 for(const status of[500,503,200]){let calls=0;const ports=createReportRetentionStoragePorts(config,context,async()=>{calls++;return Response.json(status===200?{unexpected:true}:{code:"55000",message:"비밀 원문"},{status});});
  await assert.rejects(ports.recordAck(task,hash,signal()),e=>{assert.ok(e instanceof ReportRetentionStorageUnknown);assert.equal(e.phase,"ack");assert.equal(e.terminal,true);assert.equal(String(e).includes("비밀"),false);return true;});
  await new Promise(r=>setTimeout(r,0));assert.equal(calls,1);
 }
 for(const status of[401,403]){let calls=0;const ports=createReportRetentionStoragePorts(config,context,async()=>{calls++;return Response.json({code:status===401?"28000":"42501"},{status});});await assert.rejects(ports.recordAck(task,hash,signal()),e=>!(e instanceof ReportRetentionStorageUnknown)&&toPublicError(e).status===status);assert.equal(calls,1);}
});


test("begin exact6 wire와 exact3 decoder는 최초·중복을 보존하며 응답유실5xx는 unknown이다",async()=>{
 for(const alreadyApplied of[false,true]){let calls=0;const p=createReportRetentionStoragePorts(config,context,async(url,init)=>{calls++;assert.equal(String(url).split("/").at(-1),"begin_report_retention_delete");assert.deepEqual(JSON.parse(String(init?.body)),expected);return Response.json({taskId:task.taskId,dispatchId:id(13),alreadyApplied});});assert.deepEqual(await p.begin(task,signal()),{taskId:task.taskId,dispatchId:id(13),alreadyApplied});assert.equal(calls,1);}
 for(const [status,value]of[[503,{code:"55000"}],[200,{taskId:task.taskId,dispatchId:id(13),alreadyApplied:false,extra:true}],[200,{taskId:id(99),dispatchId:id(13),alreadyApplied:false}]]as const){let calls=0;const p=createReportRetentionStoragePorts(config,context,async()=>{calls++;return Response.json(value,{status});});await assert.rejects(p.begin(task,signal()),e=>e instanceof ReportRetentionStorageUnknown&&e.phase==="dispatch");assert.equal(calls,1);}
 let ready! :()=>void;const started=new Promise<void>(r=>ready=r);const c=new AbortController();let calls=0;const p=createReportRetentionStoragePorts(config,context,async()=>{calls++;ready();return new Promise<Response>(()=>{});});const pending=p.begin(task,c.signal);await started;c.abort();await assert.rejects(pending,e=>e instanceof ReportRetentionStorageUnknown&&e.phase==="dispatch");assert.equal(calls,1);
});


test("전체 RPC+Storage 체인에서 중복 begin과503 응답은 실제 모형 DELETE0·ACK0로 종료한다",async()=>{
 for(const status of[200,503]){let begins=0,deletes=0,acks=0;const fake:typeof fetch=async(url,init)=>{const u=String(url),name=u.split("/").at(-1);if(u.includes("/rest/v1/rpc/")){if(name==="check_report_retention_task")return Response.json(task);if(name==="get_report_retention_delete_ack")return Response.json(null);if(name==="begin_report_retention_delete"){begins++;return Response.json(status===200?{taskId:task.taskId,dispatchId:id(13),alreadyApplied:true}:{code:"55000"},{status});}if(name==="record_report_retention_delete_ack")acks++;assert.fail("추가RPC 금지");}if(init?.method==="DELETE"){deletes++;assert.fail("새DELETE 금지");}return Response.json({id:task.objectId,name:task.objectName,bucket_id:task.bucketId,content_type:"image/png",size:100,metadata:{}});};const adapter=createReportRetentionStorageAdapter(config,fake),ports=createReportRetentionStoragePorts(config,context,fake);await assert.rejects(adapter.deleteExact(task,ports,signal()),e=>e instanceof ReportRetentionStorageUnknown&&e.phase==="dispatch");assert.equal(begins,1);assert.equal(deletes,0);assert.equal(acks,0);}
});
