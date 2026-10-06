/** 민규: 취소 due RPC 전송 경계의 모형 검증. DB 권한·guard·작업 배포 준비를 선언하지 않는다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRuntimeConfig } from "../../../backend/supabase/functions/_shared/config/env.ts";
import { createInternalClient } from "../../../backend/supabase/functions/_shared/db/internal-client.ts";
import { createPublicClient } from "../../../backend/supabase/functions/_shared/db/public-client.ts";
import { createUserClient } from "../../../backend/supabase/functions/_shared/db/user-client.ts";
import { requirePrincipal } from "../../../backend/supabase/functions/_shared/auth/principal.ts";
import { toPublicError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
const values: Record<string,string> = { SUPABASE_URL:"https://project.example.test",SUPABASE_ANON_KEY:"fixture-anon",
 SUPABASE_SERVICE_ROLE_KEY:"fixture-service",INTERNAL_WORKER_SECRET:"fixture_internal_secret_longer_than_32_characters",
 ALLOWED_ORIGINS:"[]",MAX_REQUEST_BYTES:"8192",UPSTREAM_TIMEOUT_MS:"1000" };
const config=loadRuntimeConfig(key=>values[key]);
const names=["enqueue_cancellation_safety_due","process_cancellation_safety_due"] as const;
const id="11111111-1111-4111-8111-111111111111",job="22222222-2222-4222-8222-222222222222",lease="33333333-3333-4333-8333-333333333333",run="44444444-4444-4444-8444-444444444444";

test("due 내부 자격 누락은 클라이언트 생성과 네트워크 전에 차단한다",()=>{
 let calls=0;
 for(const missing of ["SUPABASE_SERVICE_ROLE_KEY","INTERNAL_WORKER_SECRET"]){
  const c=loadRuntimeConfig(key=>key===missing?undefined:values[key]);
  assert.throws(()=>createInternalClient(c,async()=>{calls++;assert.fail("내부 자격 없이 전송하지 않는다");}),error=>{
   const safe=toPublicError(error);assert.equal(safe.status,503);assert.equal(safe.error.code,"EXTERNAL_UNAVAILABLE");return true;
  });
 }
 assert.equal(calls,0);
});

test("due 두 RPC만 서비스 JWT·apikey로 원래 2개/5개 인자와 AbortSignal을 전달한다",async()=>{
 const calls:Array<{name:string;args:unknown}>=[];
 const db=createInternalClient(config,async(url,init)=>{
  assert.equal(init?.method,"POST");assert.equal(init?.redirect,"error");assert.ok(init?.signal instanceof AbortSignal);assert.equal(init.signal.aborted,false);
  const headers=new Headers(init.headers);assert.equal(headers.get("apikey"),values.SUPABASE_SERVICE_ROLE_KEY);assert.equal(headers.get("authorization"),"Bearer "+values.SUPABASE_SERVICE_ROLE_KEY);
  const name=String(url).split("/").at(-1)!;assert.ok(names.includes(name as typeof names[number]));calls.push({name,args:JSON.parse(String(init.body))});
  return Response.json(name===names[0]?{enqueued:1}:{status:"held",generation:7,changed:true});
 });
 const enqueue={p_limit:10,p_worker_run_token:run},process={p_identity_id:id,p_expected_generation:7,p_job_id:job,p_job_lease_token:lease,p_worker_run_token:run};
 assert.equal(db.supportsRpc!(names[0]),true);assert.equal(db.supportsRpc!(names[1]),true);assert.equal(calls.length,0);
 assert.deepEqual(await db.rpc(names[0],enqueue),{enqueued:1});assert.deepEqual(await db.rpc(names[1],process),{status:"held",generation:7,changed:true});
 assert.deepEqual(calls,[{name:names[0],args:enqueue},{name:names[1],args:process}]);
});

test("공개·원사용자 JWT client는 due를 지원하지 않으며 임의 이름은 무전송 거절한다",async()=>{
 let transfers=0;const fake=async()=>{transfers++;return Response.json(null);};
 const token="header.synthetic.signature";
 const principal=await requirePrincipal(new Request("https://local.example",{headers:{authorization:"Bearer "+token}}),config,async(_url,init)=>{
  assert.equal(new Headers(init?.headers).get("authorization"),"Bearer "+token);return Response.json({id,role:"authenticated",is_anonymous:false});
 });
 const publicDb=createPublicClient(config,fake),userDb=createUserClient(config,principal,fake),internalDb=createInternalClient(config,fake);
 for(const db of [publicDb,userDb])for(const name of names){assert.equal(db.supportsRpc!(name),false);await assert.rejects(db.rpc(name,{}),error=>toPublicError(error).error.code==="ACCESS_DENIED");}
 for(const name of ["process_cancellation_safety_due_extra","../process_cancellation_safety_due","process_cancellation_safety_due\n","PROCESS_CANCELLATION_SAFETY_DUE","create_service_post"]){assert.equal(internalDb.supportsRpc!(name),false);await assert.rejects(internalDb.rpc(name,{}),error=>toPublicError(error).error.code==="ACCESS_DENIED");}
 assert.equal(transfers,0);
});

test("DB execute·due guard가 닫힌 오류는 전송 지원과 별개이며 원문을 공개하지 않는다",async()=>{
 for(const [status,code,expectedStatus,expectedCode]of [[403,"42501",403,"ACCESS_DENIED"],[500,"55000",503,"EXTERNAL_UNAVAILABLE"]]as const){
  let calls=0;const db=createInternalClient(config,async()=>{calls++;return Response.json({code,message:"민감한 DB 원문",details:id,hint:values.SUPABASE_SERVICE_ROLE_KEY},{status});});
  assert.equal(db.supportsRpc!(names[0]),true);
  await assert.rejects(db.rpc(names[0],{p_limit:10,p_worker_run_token:run}),error=>{
   const safe=toPublicError(error);assert.equal(safe.status,expectedStatus);assert.equal(safe.error.code,expectedCode);
   const json=JSON.stringify(safe);for(const secret of ["민감한 DB 원문",id,values.SUPABASE_SERVICE_ROLE_KEY,"55000","42501"])assert.equal(json.includes(secret),false);return true;
  });assert.equal(calls,1);
 }
});

test("due 전송 제한시간은 fetch의 AbortSignal을 중단하고 원문 없는503으로 끝난다",async()=>{
 const short=loadRuntimeConfig(key=>key==="UPSTREAM_TIMEOUT_MS"?"1":values[key]);let calls=0,aborted=false;
 const db=createInternalClient(short,async(_url,init)=>{calls++;const signal=init?.signal;assert.ok(signal instanceof AbortSignal);return await new Promise<Response>((_resolve,reject)=>{signal.addEventListener("abort",()=>{aborted=true;reject(new Error("민감한 제한시간 원문"));},{once:true});});});
 await assert.rejects(db.rpc(names[1],{p_identity_id:id,p_expected_generation:7,p_job_id:job,p_job_lease_token:lease,p_worker_run_token:run}),error=>{const safe=toPublicError(error);assert.equal(safe.status,503);assert.equal(JSON.stringify(safe).includes("민감한 제한시간 원문"),false);return true;});
 assert.equal(calls,1);assert.equal(aborted,true);
});

test("워커 budget은 기존 내부 transport에서만 서비스 JWT와 원래 토큰1개를 전달한다",async()=>{
 let transfers=0;
 const db=createInternalClient(config,async(url,init)=>{
  transfers++;assert.equal(String(url),values.SUPABASE_URL+"/rest/v1/rpc/read_worker_run_budget");
  const headers=new Headers(init?.headers);assert.equal(headers.get("apikey"),values.SUPABASE_SERVICE_ROLE_KEY);assert.equal(headers.get("authorization"),"Bearer "+values.SUPABASE_SERVICE_ROLE_KEY);
  assert.equal(init?.method,"POST");assert.ok(init?.signal instanceof AbortSignal);assert.deepEqual(JSON.parse(String(init.body)),{p_worker_run_token:run});return Response.json({remainingMs:170000});
 });
 assert.equal(db.supportsRpc!("read_worker_run_budget"),true);assert.equal(transfers,0);
 assert.deepEqual(await db.rpc("read_worker_run_budget",{p_worker_run_token:run}),{remainingMs:170000});assert.equal(transfers,1);
 // 기존 typed budget reader의 DB clock/수신시간 검증을 중복 구현하지 않는다.
});

test("워커 budget은 자격 누락·공개·일반 사용자 및 유사 RPC 이름을 무전송 차단한다",async()=>{
 let transfers=0;const fake=async()=>{transfers++;return Response.json({remainingMs:170000});};
 for(const missing of["SUPABASE_SERVICE_ROLE_KEY","INTERNAL_WORKER_SECRET"]){const c=loadRuntimeConfig(key=>key===missing?undefined:values[key]);assert.throws(()=>createInternalClient(c,fake));}
 const token="header.synthetic.signature";
 const principal=await requirePrincipal(new Request("https://local.example",{headers:{authorization:"Bearer "+token}}),config,async()=>Response.json({id,role:"authenticated",is_anonymous:false}));
 for(const db of[createPublicClient(config,fake),createUserClient(config,principal,fake)]){assert.equal(db.supportsRpc!("read_worker_run_budget"),false);await assert.rejects(db.rpc("read_worker_run_budget",{p_worker_run_token:run}),error=>toPublicError(error).error.code==="ACCESS_DENIED");}
 const db=createInternalClient(config,fake);for(const name of["read_worker_run_budget_extra","../read_worker_run_budget","READ_WORKER_RUN_BUDGET"]){assert.equal(db.supportsRpc!(name),false);await assert.rejects(db.rpc(name,{p_worker_run_token:run}),error=>toPublicError(error).error.code==="ACCESS_DENIED");}assert.equal(transfers,0);
});
