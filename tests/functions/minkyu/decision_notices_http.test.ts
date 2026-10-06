/** 민규 C: 본인 통지 HTTP 모형. 실제 DB 신원·통지 배송·화면 읽기 증거와 구분한다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServiceApi } from "../../../backend/supabase/functions/service-api/handler.ts";
import { HttpError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
import { loadRuntimeConfig } from "../../../backend/supabase/functions/_shared/config/env.ts";
import { requirePrincipal } from "../../../backend/supabase/functions/_shared/auth/principal.ts";
import { createUserClient } from "../../../backend/supabase/functions/_shared/db/user-client.ts";
import type { JsonValue } from "../../../backend/supabase/functions/_shared/contracts/common.ts";
const id="11111111-1111-4111-8111-111111111111",other="22222222-2222-4222-8222-222222222222",ap="33333333-3333-4333-8333-333333333333";
const notice={noticeId:id,appointmentId:ap,appointmentOutcome:"no_show",violationOutcome:null,reasonCode:"no_show",violationClass:null,violationType:null,availableAt:"2026-10-06T12:00:00.123456+00:00",firstReadAt:null};
function setup(value:JsonValue={items:[notice],nextCursor:null},error?:HttpError){
 const calls:Array<{name:string;args:Record<string,JsonValue>}>=[];
 const handler=createServiceApi({allowedOrigins:[],maxBodyBytes:8192,authenticateUser:async request=>{
  if(request.headers.get("authorization")!=="Bearer synthetic-member")throw new HttpError("AUTH_REQUIRED");
  return{rpc:async(name,args)=>{calls.push({name,args});if(error)throw error;return value;}};
 },authenticateInternal:async()=>assert.fail("통지 조회는 내부/직원 권한으로 fallback하지 않는다")});
 return{calls,send:(path="/decision-notices",method="GET",body:JsonValue={},member=true)=>handler(new Request(`https://example.invalid/functions/v1/service-api${path}`,{method,headers:{authorization:member?"Bearer synthetic-member":"Bearer invalid","content-type":"application/json"},...(method==="POST"?{body:JSON.stringify(body)}:{})}))};
}
test("본인 통지 GET 고정 RPC·default page·no-store",async()=>{
 const{calls,send}=setup();const r=await send();assert.equal(r.status,200);assert.deepEqual((await r.json()).data,{items:[notice],nextCursor:null});assert.deepEqual(calls,[{name:"list_my_decision_notices",args:{p_limit:20,p_before:null}}]);assert.equal(r.headers.get("cache-control"),"no-store");
});
test("명시 empty ACK만 서버 최초읽기를 받고 반복 동일 시각을 보존",async()=>{
 const result={...notice,firstReadAt:"2026-10-06T12:05:00Z"};const{calls,send}=setup(result);
 for(let i=0;i<2;i++){const r=await send(`/decision-notices/${id}/read`,"POST");assert.equal(r.status,200);assert.deepEqual((await r.json()).data,result);assert.equal(r.headers.get("cache-control"),"no-store");}
 assert.deepEqual(calls,Array.from({length:2},()=>({name:"read_my_decision_notice",args:{p_notice_id:id}})));
});
test("현재 회원 관리 권한만 사용하고 자격·제재·일괄알림을 추가 호출하지 않음",async()=>{
 for(const state of["restricted-member","qualification-incomplete"]){const{calls,send}=setup();assert.equal((await send()).status,200,state);assert.equal(calls.length,1);assert.equal(calls[0].name,"list_my_decision_notices");assert.ok(!calls.some(c=>c.name==="get_my_safety_state"||c.name==="mark_all_my_notifications_read"));}
});
test("유한 본인 책임확정·해제와 AP 결과만 exact9로 허용",async()=>{
 const forms=[notice,{...notice,appointmentOutcome:"normal",reasonCode:"normal"},{...notice,violationOutcome:"confirmed",violationClass:"none"},{...notice,appointmentId:null,appointmentOutcome:null,violationOutcome:"confirmed",reasonCode:"spam",violationClass:"minor",violationType:"spam"},{...notice,appointmentOutcome:null,violationOutcome:"confirmed",reasonCode:"threat",violationClass:"major",violationType:"threat"},{...notice,violationOutcome:"invalidated",reasonCode:"decision_corrected"}];
 for(const item of forms){const r=await setup({items:[item],nextCursor:null} as JsonValue).send();assert.equal(r.status,200);}
});
test("검증 page만 전달·회원/actor/기간/ACK 시각 입력 불허",async()=>{
 const{calls,send}=setup({items:[],nextCursor:null});assert.equal((await send(`/decision-notices?limit=1&before=${id}`)).status,200);assert.deepEqual(calls[0],{name:"list_my_decision_notices",args:{p_limit:1,p_before:id}});
 for(const q of["?limit=0","?limit=101","?limit=01","?limit=1&limit=2","?before=bad",`?userId=${other}`,`?identityId=${other}`,"?firstReadAt=now","?deadline=now"])assert.equal((await send("/decision-notices"+q)).status,400);
 for(const body of[{firstReadAt:"2026-10-06T12:05:00Z"},{recipientId:other},null,[],{alreadyRead:true}])assert.equal((await send(`/decision-notices/${id}/read`,"POST",body as JsonValue)).status,400);
 assert.equal((await send(`/decision-notices/${id}/read?actorId=${other}`,"POST")).status,400);assert.equal(calls.length,1);
});
test("미인증·틀린 메서드·잘못된 ID는 RPC 이전 차단",async()=>{
 const{calls,send}=setup();assert.equal((await send("/decision-notices","GET",{},false)).status,401);assert.equal((await send("/decision-notices","POST")).status,405);assert.equal((await send(`/decision-notices/${id}/read`)).status,405);assert.equal((await send("/decision-notices/bad/read","POST")).status,400);assert.equal(calls.length,0);
});
test("foreign/expired PT404는 같은404로 실패하고 성공 또는 원문으로 바꾸지 않음",async()=>{
 for(const target of["foreign","expired"]){const{send}=setup(null,new HttpError("RESOURCE_NOT_FOUND"));for(const path of[`/decision-notices/${id}/read`,`/decision-notices?before=${id}`]){const r=await send(path,path.endsWith("read")?"POST":"GET");assert.equal(r.status,404,target);assert.equal(JSON.stringify(await r.json()).includes(target),false);}}
});
test("원문·타인/actor/감점/기한·상충 조합·잘못된 시간은503이며 재노출 없음",async()=>{
 for(const patch of[{description:"비공개 원문"},{otherViolation:"threat"},{reporterId:other},{actorId:other},{identityId:other},{penalty:10},{appealDeadlineAt:"2026-10-07T12:00:00Z"},{reasonCode:"no_action"},{reasonCode:"spam"},{violationClass:"none"},{appointmentId:null},{appointmentOutcome:["no_show"]},{violationOutcome:"confirmed",violationClass:"minor",violationType:"threat",reasonCode:"threat"},{violationOutcome:"invalidated",reasonCode:"no_show"},{availableAt:"2026-02-30T12:00:00Z"},{availableAt:"2026-10-06T24:00:00Z"},{firstReadAt:"2026-10-06T11:00:00Z"},{firstReadAt:[]},{noticeId:[id]}]){
  const r=await setup({items:[{...notice,...patch}],nextCursor:null} as unknown as JsonValue).send();assert.equal(r.status,503);const text=JSON.stringify(await r.json());assert.equal(text.includes("비공개 원문"),false);assert.equal(text.includes(other),false);
 }
 for(const result of[{...notice,firstReadAt:null},{...notice,noticeId:other,firstReadAt:"2026-10-06T12:05:00Z"}])assert.equal((await setup(result as JsonValue).send(`/decision-notices/${id}/read`,"POST")).status,503);
});
test("초과·중복·역순·틀린cursor·exact2 변형을 failclosed",async()=>{
 for(const page of[{items:[notice,notice],nextCursor:null},{items:[{...notice,noticeId:other},notice],nextCursor:null},{items:[notice],nextCursor:other},{items:[],nextCursor:id},{items:[notice],nextCursor:null,raw:"secret"}])assert.equal((await setup(page as JsonValue).send("/decision-notices?limit=1")).status,503);
 assert.equal((await setup({items:[notice],nextCursor:id}).send("/decision-notices?limit=1")).status,200);
 assert.equal((await setup({items:[notice],nextCursor:null}).send(`/decision-notices?before=${id}`)).status,503);
});
test("user client 원 JWT·anon key·정확 RPC 인수 유지 및 임의직원 RPC 차단",async()=>{
 const env:Record<string,string>={SUPABASE_URL:"https://project.example.test",SUPABASE_ANON_KEY:"synthetic-anon",ALLOWED_ORIGINS:"[]",MAX_REQUEST_BYTES:"8192",UPSTREAM_TIMEOUT_MS:"1000"};const config=loadRuntimeConfig(k=>env[k]),token="header.synthetic.signature";
 const principal=await requirePrincipal(new Request("https://example.invalid",{headers:{authorization:`Bearer ${token}`}}),config,async()=>new Response(JSON.stringify({id,role:"authenticated",is_anonymous:false})));
 const calls:Array<{url:string;body:unknown}>=[];const db=createUserClient(config,principal,async(url,init)=>{assert.equal(new Headers(init?.headers).get("authorization"),`Bearer ${token}`);assert.equal(new Headers(init?.headers).get("apikey"),"synthetic-anon");calls.push({url:String(url),body:JSON.parse(String(init?.body))});return new Response("{}");});
 await db.rpc("list_my_decision_notices",{p_limit:20,p_before:null});await db.rpc("read_my_decision_notice",{p_notice_id:id});assert.deepEqual(calls,[{url:"https://project.example.test/rest/v1/rpc/list_my_decision_notices",body:{p_limit:20,p_before:null}},{url:"https://project.example.test/rest/v1/rpc/read_my_decision_notice",body:{p_notice_id:id}}]);
 for(const name of["record_assigned_report_decision_notice","adjudicate_assigned_member_report","private.member_decision_notices"])await assert.rejects(db.rpc(name,{}),HttpError);assert.equal(calls.length,2);
});

const cancelNotice={noticeId:id,appointmentId:ap,appealState:"accepted",planState:"corrected",eligibleCount:0,provisionalCount:0,hasCancellationWarning:false,restrictedUntil:null,availableAt:"2026-10-06T12:00:00.123456+00:00",firstReadAt:null};
test("취소 본인 list2/notice10·고정 RPC/no-store·관리권한·empty ACK 최초값 안정",async()=>{
 const {calls,send}=setup({items:[cancelNotice],nextCursor:null});const r=await send("/cancellation-notices");assert.equal(r.status,200);assert.deepEqual((await r.json()).data,{items:[cancelNotice],nextCursor:null});assert.equal(r.headers.get("cache-control"),"no-store");assert.deepEqual(calls,[{name:"list_my_cancellation_notices",args:{p_limit:20,p_before:null}}]);
 const ack={...cancelNotice,firstReadAt:"2026-10-06T12:00:00.123457Z"};const s=setup(ack);for(let i=0;i<2;i++){const a=await s.send(`/cancellation-notices/${id}/read`,"POST");assert.equal(a.status,200);assert.deepEqual((await a.json()).data,ack);assert.equal(a.headers.get("cache-control"),"no-store");}assert.equal(s.calls.length,2);assert.equal(s.calls[0].name,"read_my_cancellation_notice");
});
test("취소 통지 finite 상태·미정 NULL counts·현재 제한 facts 허용",async()=>{
 for(const form of[{...cancelNotice,planState:"held",appealState:"reviewing"},{...cancelNotice,planState:"applied",appealState:"rejected",eligibleCount:1,provisionalCount:2,hasCancellationWarning:true,restrictedUntil:"2026-10-13T12:00:00Z"},{...cancelNotice,planState:"policy_pending",eligibleCount:null,provisionalCount:null},{...cancelNotice,planState:"policy_pending",eligibleCount:0,provisionalCount:0}])assert.equal((await setup({items:[form],nextCursor:null}).send("/cancellation-notices")).status,200);
});
test("취소 통지 DESC 정렬·마이크로초·cursor·duplicate 검증",async()=>{
 const older={...cancelNotice,noticeId:other,availableAt:"2026-10-06T12:00:00.123455Z"};assert.equal((await setup({items:[cancelNotice,older],nextCursor:other}).send("/cancellation-notices?limit=2")).status,200);
 for(const items of[[older,cancelNotice],[cancelNotice,cancelNotice],[cancelNotice,{...older,availableAt:cancelNotice.availableAt}]])assert.equal((await setup({items,nextCursor:null}).send("/cancellation-notices")).status,503);
 assert.equal((await setup({items:[cancelNotice],nextCursor:other}).send("/cancellation-notices?limit=1")).status,503);
 const {calls,send}=setup({items:[],nextCursor:null});assert.equal((await send(`/cancellation-notices?limit=100&before=${id}`)).status,200);assert.deepEqual(calls[0],{name:"list_my_cancellation_notices",args:{p_limit:100,p_before:id}});
});
test("취소 통지 원문/actor/추정기한·형변환·NULL조합·날짜/ACK 역전 거절",async()=>{
 for(const patch of[{reportId:other},{rawReason:"raw"},{deadlineAt:"2026-10-13T00:00:00Z"},{eligibleCount:-1},{eligibleCount:"0"},{eligibleCount:null},{eligibleCount:null,provisionalCount:null},{planState:"pending"},{hasCancellationWarning:"false"},{restrictedUntil:"bad"},{appointmentId:null},{availableAt:"2026-02-30T00:00:00Z"},{firstReadAt:"2026-10-06T12:00:00.123455Z"}])assert.equal((await setup({items:[{...cancelNotice,...patch}],nextCursor:null} as unknown as JsonValue).send("/cancellation-notices")).status,503);
 assert.equal((await setup(cancelNotice).send(`/cancellation-notices/${id}/read`,"POST")).status,503);
});
test("취소 통지 인증/body/query/method·foreign TTL 안전오류",async()=>{
 const s=setup();assert.equal((await s.send("/cancellation-notices","GET",{},false)).status,401);
 for(const q of["?limit=101","?limit=0","?userId=x","?firstReadAt=now"])assert.equal((await s.send("/cancellation-notices"+q)).status,400);
 for(const body of[{actorId:id},{readAt:"now"},null])assert.equal((await s.send(`/cancellation-notices/${id}/read`,"POST",body as JsonValue)).status,400);
 assert.equal((await s.send(`/cancellation-notices/${id}/read?actorId=x`,"POST")).status,400);assert.equal((await s.send("/cancellation-notices","POST")).status,405);assert.equal(s.calls.length,0);
 assert.equal((await setup({},new HttpError("RESOURCE_NOT_FOUND")).send(`/cancellation-notices/${id}/read`,"POST")).status,404);
});
test("취소 본인 transport 원 JWT/anon과 직원/due/raw RPC 폐쇄",async()=>{
 const config=loadRuntimeConfig(k=>({SUPABASE_URL:"https://project.example.test",SUPABASE_ANON_KEY:"synthetic-anon",ALLOWED_ORIGINS:"[]",UPSTREAM_TIMEOUT_MS:"1000",MAX_REQUEST_BYTES:"65536"}as Record<string,string>)[k]);const token="header.synthetic.signature";
 const principal=await requirePrincipal(new Request("https://example.invalid",{headers:{authorization:`Bearer ${token}`}}),config,async()=>new Response(JSON.stringify({id,role:"authenticated",is_anonymous:false})));let count=0;
 const db=createUserClient(config,principal,async(url,init)=>{count++;assert.equal(new Headers(init?.headers).get("authorization"),`Bearer ${token}`);assert.equal(new Headers(init?.headers).get("apikey"),"synthetic-anon");assert.ok(String(url).endsWith(count===1?"/list_my_cancellation_notices":"/read_my_cancellation_notice"));return new Response("{}");});await db.rpc("list_my_cancellation_notices",{p_limit:20,p_before:null});await db.rpc("read_my_cancellation_notice",{p_notice_id:id});
 for(const name of["resolve_assigned_appointment_cancel_appeal","process_cancellation_safety_due","private.member_cancellation_notices"])await assert.rejects(db.rpc(name,{}),HttpError);assert.equal(count,2);
});
