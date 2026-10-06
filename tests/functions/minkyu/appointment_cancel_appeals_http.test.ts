/** 민규 C: 취소 이의 본인 관리 HTTP 모형. 실제 접수·시계·회차·DB/Provider 증거와 구분한다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServiceApi } from "../../../backend/supabase/functions/service-api/handler.ts";
import { HttpError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
import { loadRuntimeConfig } from "../../../backend/supabase/functions/_shared/config/env.ts";
import { requirePrincipal } from "../../../backend/supabase/functions/_shared/auth/principal.ts";
import { createUserClient } from "../../../backend/supabase/functions/_shared/db/user-client.ts";
import type { JsonValue } from "../../../backend/supabase/functions/_shared/contracts/common.ts";
const ap="11111111-1111-4111-8111-111111111111",requestId="22222222-2222-4222-8222-222222222222",report="33333333-3333-4333-8333-333333333333",appeal="44444444-4444-4444-8444-444444444444";
const path=`/appointments/${ap}/cancellation-appeals`,input={clientRequestId:requestId,expectedResultRevision:1,reportId:report};
const absent={appealId:null,appointmentId:ap,resultRevision:1,state:null,cancelledAt:"2026-10-05T12:00:00.123456+00:00",deadlineAt:"2026-10-06T12:00:00.123456+00:00",receivedAt:null,resolvedAt:null};
const current={...absent,appealId:appeal,resultRevision:2,state:"reviewing",receivedAt:"2026-10-06T11:59:59.999999Z"};
const submitted={...current,alreadyApplied:false};
function setup(value:JsonValue=absent,error?:HttpError){
 const calls:Array<{name:string;args:Record<string,JsonValue>}>=[];
 const handler=createServiceApi({allowedOrigins:[],maxBodyBytes:8192,authenticateUser:async request=>{
  if(request.headers.get("authorization")!=="Bearer synthetic-member")throw new HttpError("AUTH_REQUIRED");
  return{rpc:async(name,args)=>{calls.push({name,args});if(error)throw error;return value;}};
 },authenticateInternal:async()=>assert.fail("본인 이의는 내부/직원 권한으로 대체하지 않는다")});
 return{calls,send:(method="GET",body:JsonValue=input,suffix="",authorized=true)=>handler(new Request(`https://example.invalid/functions/v1/service-api${path}${suffix}`,{method,headers:{authorization:authorized?"Bearer synthetic-member":"Bearer invalid","content-type":"application/json"},...(method==="POST"?{body:JSON.stringify(body)}:{})}))};
}
test("본인 GET exact8·신청 없음 null4·원RPC AP만 전달",async()=>{
 const{calls,send}=setup();const r=await send();assert.equal(r.status,200);assert.deepEqual((await r.json()).data,absent);assert.equal(r.headers.get("cache-control"),"no-store");assert.deepEqual(calls,[{name:"get_my_appointment_cancel_appeal",args:{p_appointment_id:ap}}]);
});
test("POST strict3→typed4와 exact9 최초접수·원스냅샷 replay",async()=>{
 for(const alreadyApplied of[false,true]){const result={...submitted,alreadyApplied};const{calls,send}=setup(result);const r=await send("POST");assert.equal(r.status,200);assert.deepEqual((await r.json()).data,result);assert.equal(r.headers.get("cache-control"),"no-store");assert.deepEqual(calls,[{name:"submit_appointment_cancel_appeal",args:{p_appointment_id:ap,p_client_request_id:requestId,p_expected_result_revision:1,p_report_id:report}}]);}
});
test("GET 현재 accepted/rejected·마감 경과 facts와 safe revision 유지",async()=>{
 for(const state of["reviewing","accepted","rejected"]){const result={...current,resultRevision:9007199254740991,state,resolvedAt:state==="reviewing"?null:"2026-10-08T12:00:00Z"};assert.equal((await setup(result).send()).status,200);}
 assert.equal((await setup({...submitted,resultRevision:9007199254740991}).send("POST",{...input,expectedResultRevision:9007199254740990})).status,200);
});
test("마감 1microsecond 이전은 보존하고 동일/이후 upstream접수는503",async()=>{
 assert.equal((await setup({...submitted,receivedAt:"2026-10-06T12:00:00.123455Z"}).send("POST")).status,200);
 for(const receivedAt of["2026-10-06T12:00:00.123456Z","2026-10-06T12:00:00.123457Z","2026-10-05T12:00:00.123455Z"]){assert.equal((await setup({...submitted,receivedAt}).send("POST")).status,503);}
});
test("회원 본인 관리를 위해 자격·제재·유료활동 gate를 추가 호출하지 않음",async()=>{
 for(const label of["restricted","qualification-incomplete"]){const{calls,send}=setup(submitted);assert.equal((await send("POST")).status,200,label);assert.equal(calls.length,1);assert.equal(calls[0].name,"submit_appointment_cancel_appeal");}
});
test("미인증·지원하지 않는 method·잘못된 경로ID는 RPC 전 차단",async()=>{
 const{calls,send}=setup();assert.equal((await send("GET",input,"",false)).status,401);assert.equal((await send("PUT")).status,405);assert.equal((await send("GET",input,"/extra")).status,404);assert.equal(calls.length,0);
});
test("접수 시각·회차·actor·원문·AP주입 및 정수 coercion 거부",async()=>{
 const{calls,send}=setup(submitted);
 for(const body of[{},null,[],{...input,receivedAt:"2026-10-06T12:00:00Z"},{...input,deadlineAt:"now"},{...input,identityId:appeal},{...input,actorId:appeal},{...input,episodeId:appeal},{...input,appointmentId:ap},{...input,description:"원문"},{...input,expectedResultRevision:"1"},{...input,expectedResultRevision:0},{...input,expectedResultRevision:1.5},{...input,expectedResultRevision:9007199254740991},{...input,reportId:null},{...input,clientRequestId:[]}])assert.equal((await send("POST",body as unknown as JsonValue)).status,400);
 assert.equal((await send("GET",input,"?userId="+appeal)).status,400);assert.equal((await send("POST",input,"?receivedAt=now")).status,400);assert.equal(calls.length,0);
});
test("원문/다른 사건·상충 null/state/잘못된 시각 및revision upstream은503",async()=>{
 const patches=[{description:"민감 원문"},{actorId:report},{identityId:report},{reportId:report},{sanctionId:report},{penalty:7},{alreadyApplied:true},{appointmentId:report},{appealId:[]},{appealId:null,state:"reviewing"},{state:null},{state:"unknown"},{state:"accepted",resolvedAt:null},{state:"reviewing",resolvedAt:"2026-10-08T00:00:00Z"},{state:"rejected",resolvedAt:"2026-10-05T00:00:00Z"},{resultRevision:"2"},{resultRevision:9007199254740992},{resultRevision:0},{deadlineAt:"2026-10-06T12:00:00.123455Z"},{cancelledAt:"2026-02-30T12:00:00Z"},{receivedAt:"2026-10-06T24:00:00Z"}];
 for(const patch of patches){const r=await setup({...current,...patch} as unknown as JsonValue).send();assert.equal(r.status,503);const data=JSON.stringify(await r.json());assert.equal(data.includes("민감 원문"),false);assert.equal(data.includes(report),false);}
 for(const patch of[{alreadyApplied:1},{state:"accepted",resolvedAt:"2026-10-08T00:00:00Z"},{resultRevision:3},{appealId:null,state:null,receivedAt:null}])assert.equal((await setup({...submitted,...patch} as unknown as JsonValue).send("POST")).status,503);
});
test("GET current state와 POST replay 스냅샷을 섞지 않고 null4 상충 거부",async()=>{
 const result={...current,state:"accepted",resolvedAt:"2026-10-08T00:00:00Z",resultRevision:3};assert.equal((await setup(result).send()).status,200);assert.equal((await setup({...submitted,alreadyApplied:true}).send("POST")).status,200);
 for(const patch of[{receivedAt:"2026-10-06T11:00:00Z"},{resolvedAt:"2026-10-08T00:00:00Z"},{state:"accepted"}])assert.equal((await setup({...absent,...patch} as unknown as JsonValue).send()).status,503);
});
test("원 JWT/anon 전용 정확RPC와 SQL오류를 공개코드로만 투영",async()=>{
 const env:Record<string,string>={SUPABASE_URL:"https://project.example.test",SUPABASE_ANON_KEY:"synthetic-anon",ALLOWED_ORIGINS:"[]",MAX_REQUEST_BYTES:"8192",UPSTREAM_TIMEOUT_MS:"1000"},config=loadRuntimeConfig(k=>env[k]),token="header.synthetic.signature";
 const principal=await requirePrincipal(new Request("https://example.invalid",{headers:{authorization:`Bearer ${token}`}}),config,async()=>new Response(JSON.stringify({id:ap,role:"authenticated",is_anonymous:false})));
 const calls:Array<{url:string;body:unknown}>=[];const db=createUserClient(config,principal,async(url,init)=>{assert.equal(new Headers(init?.headers).get("authorization"),`Bearer ${token}`);assert.equal(new Headers(init?.headers).get("apikey"),"synthetic-anon");calls.push({url:String(url),body:JSON.parse(String(init?.body))});return new Response("{}");});
 await db.rpc("get_my_appointment_cancel_appeal",{p_appointment_id:ap});await db.rpc("submit_appointment_cancel_appeal",{p_appointment_id:ap,p_client_request_id:requestId,p_expected_result_revision:1,p_report_id:report});assert.equal(calls.length,2);assert.deepEqual(calls[1],{url:"https://project.example.test/rest/v1/rpc/submit_appointment_cancel_appeal",body:{p_appointment_id:ap,p_client_request_id:requestId,p_expected_result_revision:1,p_report_id:report}});
 for(const name of["record_incident_revision","cancellation_sanction_plan","set_report_operator_assignment"])await assert.rejects(db.rpc(name,{}),HttpError);assert.equal(calls.length,2);
 for(const[code,httpStatus,expected]of[["PT404",400,404],["40001",400,409],["22023",400,400],["28000",403,401],["42501",403,403],["55000",500,503]]as const){const failing=createUserClient(config,principal,async()=>new Response(JSON.stringify({code,message:"민감 오류 원문",details:report}),{status:httpStatus}));const h=createServiceApi({allowedOrigins:[],maxBodyBytes:8192,authenticateUser:async()=>failing,authenticateInternal:async()=>assert.fail()});const r=await h(new Request(`https://example.invalid/service-api${path}`));assert.equal(r.status,expected);const value=JSON.stringify(await r.json());assert.equal(value.includes(report),false);assert.equal(value.includes("민감 오류 원문"),false);}
});

const atomicInput={clientRequestId:requestId,expectedResultRevision:1,reasonCodes:["other"],description:"합성 취소 이의 사유",assetIds:[],hideTarget:false};
const atomicResult={...submitted,reportId:report};
test("S21 단일 제출 exact6→typed7 한 RPC·server reportId exact10·동일 replay",async()=>{
 for(const alreadyApplied of[false,true]){
  const result={...atomicResult,alreadyApplied},fixture=setup(result);
  const r=await fixture.send("POST",atomicInput,"/submit");assert.equal(r.status,200);assert.equal(r.headers.get("cache-control"),"no-store");assert.deepEqual((await r.json()).data,result);
  assert.deepEqual(fixture.calls,[{name:"submit_appointment_cancel_appeal_with_report",args:{p_appointment_id:ap,p_client_request_id:requestId,p_expected_result_revision:1,p_reason_codes:["other"],p_description:atomicInput.description,p_asset_ids:[],p_hide_target:false}}]);
 }
});
test("S21 기존 신고 parser 재사용·오프라인 증거0/5·유한 신고사유·원문 상한",async()=>{
 for(const body of[{...atomicInput,reasonCodes:["no_show","other"]},{...atomicInput,assetIds:[ap,requestId,report,appeal,"55555555-5555-4555-8555-555555555555"]},{...atomicInput,description:"a".repeat(4000),hideTarget:true}])assert.equal((await setup(atomicResult).send("POST",body,"/submit")).status,200);
 const fixture=setup(atomicResult);
 for(const body of[{...atomicInput,reasonCodes:[]},{...atomicInput,reasonCodes:["other","other"]},{...atomicInput,reasonCodes:["confirmed_major"]},{...atomicInput,description:" "},{...atomicInput,description:" 앞공백"},{...atomicInput,description:"a".repeat(4001)},{...atomicInput,description:"사유\u0000"},{...atomicInput,assetIds:[ap,ap]},{...atomicInput,assetIds:[null]},{...atomicInput,assetIds:[ap,requestId,report,appeal,ap,report]},{...atomicInput,hideTarget:"false"}])assert.equal((await fixture.send("POST",body as JsonValue,"/submit")).status,400);
 assert.equal((await fixture.send("POST",{...atomicInput,description:"한".repeat(4000)},"/submit")).status,413);
 assert.equal(fixture.calls.length,0);
});
test("S21 actor·시각·reportId·AP·target/context 주입과 숫자 coercion RPC 전 거부",async()=>{
 const fixture=setup(atomicResult);
 for(const body of[{},null,[],...Object.entries({actorId:ap,identityId:ap,episodeId:ap,receivedAt:"now",deadlineAt:"now",reportId:report,appointmentId:ap,targetType:"member",targetId:report,context:"online"}).map(([key,value])=>({...atomicInput,[key]:value})),{...atomicInput,expectedResultRevision:"1"},{...atomicInput,expectedResultRevision:0},{...atomicInput,expectedResultRevision:1.2},{...atomicInput,expectedResultRevision:Number.MAX_SAFE_INTEGER},{...atomicInput,clientRequestId:null}])assert.equal((await fixture.send("POST",body as JsonValue,"/submit")).status,400);
 assert.equal((await fixture.send("POST",atomicInput,"/submit?receivedAt=now")).status,400);assert.equal(fixture.calls.length,0);
});
test("S21 단일 제출 미인증/method/query 거절·본인 관리 gate 및 fallback 없음",async()=>{
 const fixture=setup(atomicResult);assert.equal((await fixture.send("POST",atomicInput,"/submit",false)).status,401);assert.equal((await fixture.send("GET",atomicInput,"/submit")).status,405);assert.equal((await fixture.send("PUT",atomicInput,"/submit")).status,405);assert.equal(fixture.calls.length,0);
 const failed=setup(atomicResult,new HttpError("STATE_CONFLICT"));assert.equal((await failed.send("POST",atomicInput,"/submit")).status,409);assert.equal(failed.calls.length,1);assert.equal(failed.calls[0].name,"submit_appointment_cancel_appeal_with_report");
});
test("S21 exact10 upstream privacy·잘못된 serverID/state/revision/null·마감은 안전실패",async()=>{
 for(const patch of[{reportId:null},{reportId:[]},{reportId:"not-a-uuid"},{description:"민감 원문"},{actorId:ap},{identityId:ap},{sanctionId:ap},{resultRevision:3},{resultRevision:"2"},{state:"accepted",resolvedAt:"2026-10-08T00:00:00Z"},{appealId:null,state:null,receivedAt:null},{alreadyApplied:1},{receivedAt:absent.deadlineAt}]){
  const fixture=setup({...atomicResult,...patch} as unknown as JsonValue),r=await fixture.send("POST",atomicInput,"/submit");assert.equal(r.status,503);assert.equal(fixture.calls.length,1);assert.equal(JSON.stringify(await r.json()).includes("민감 원문"),false);
 }
 assert.equal((await setup(submitted).send("POST",atomicInput,"/submit")).status,503);
 assert.equal((await setup({...atomicResult,resultRevision:Number.MAX_SAFE_INTEGER}).send("POST",{...atomicInput,expectedResultRevision:Number.MAX_SAFE_INTEGER-1},"/submit")).status,200);
});
test("S21 original JWT/anon 단일 transport·SQLSTATE와 upstreamHTTP별 안전오류",async()=>{
 const env:Record<string,string>={SUPABASE_URL:"https://project.example.test",SUPABASE_ANON_KEY:"synthetic-anon",ALLOWED_ORIGINS:"[]",MAX_REQUEST_BYTES:"8192",UPSTREAM_TIMEOUT_MS:"1000"},config=loadRuntimeConfig(k=>env[k]),token="header.synthetic.signature";
 const principal=await requirePrincipal(new Request("https://example.invalid",{headers:{authorization:`Bearer ${token}`}}),config,async()=>new Response(JSON.stringify({id:ap,role:"authenticated",is_anonymous:false})));
 const args={p_appointment_id:ap,p_client_request_id:requestId,p_expected_result_revision:1,p_reason_codes:["other"],p_description:atomicInput.description,p_asset_ids:[],p_hide_target:false};let calls=0;
 const db=createUserClient(config,principal,async(url,init)=>{calls++;assert.equal(String(url),"https://project.example.test/rest/v1/rpc/submit_appointment_cancel_appeal_with_report");assert.equal(new Headers(init?.headers).get("authorization"),`Bearer ${token}`);assert.equal(new Headers(init?.headers).get("apikey"),"synthetic-anon");assert.deepEqual(JSON.parse(String(init?.body)),args);return new Response(JSON.stringify(atomicResult));});
 const h=createServiceApi({allowedOrigins:[],maxBodyBytes:8192,authenticateUser:async()=>db,authenticateInternal:async()=>assert.fail()});
 const request=()=>new Request(`https://example.invalid/service-api${path}/submit`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(atomicInput)});
 assert.equal((await h(request())).status,200);assert.equal(calls,1);
 for(const[code,upstream,expected]of[["40001",400,409],["PT404",400,404],["22023",400,400],["42501",403,403],["28000",403,401],["55000",400,500],["55000",500,503]]as const){
  let attempts=0;const failing=createUserClient(config,principal,async()=>{attempts++;return new Response(JSON.stringify({code,message:"비공개 원문",details:report}),{status:upstream});});
  const handler=createServiceApi({allowedOrigins:[],maxBodyBytes:8192,authenticateUser:async()=>failing,authenticateInternal:async()=>assert.fail()});const response=await handler(request());assert.equal(response.status,expected);assert.equal(attempts,1);const body=JSON.stringify(await response.json());assert.equal(body.includes("비공개 원문"),false);assert.equal(body.includes(report),false);
 }
});
