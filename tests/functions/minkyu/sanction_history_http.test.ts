/** 민규: HTTP 고정 회원 RPC 경계. 실제 DB 신원 필터·통지 성공과 구분한다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServiceApi } from "../../../backend/supabase/functions/service-api/handler.ts";
import { HttpError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
import type { JsonValue } from "../../../backend/supabase/functions/_shared/contracts/common.ts";
const id="11111111-1111-4111-8111-111111111111",other="22222222-2222-4222-8222-222222222222";
const item={sanctionId:id,kind:"general_7d",status:"active",reasonCode:"spam",correctionReasonCode:null,appliedAt:"2026-10-01T12:00:00+00:00",expiresAt:"2026-10-08T12:00:00+00:00",notifiedAt:null,revokedAt:null,appealPolicy:"general_7d",appealDeadlineAt:null,appealState:null};
function setup(value:JsonValue={items:[item],nextCursor:null}) {
 const calls:Array<{name:string;args:Record<string,JsonValue>}>=[];
 const handler=createServiceApi({allowedOrigins:[],maxBodyBytes:20000,authenticateUser:async request=>{
 if(request.headers.get("authorization")!=="Bearer synthetic-member")throw new HttpError("AUTH_REQUIRED");
 return{rpc:async(name,args)=>{calls.push({name,args});return value;}};},authenticateInternal:async()=>{throw new Error("본인 읽기에 내부 권한 불가");}});
 return{calls,send:(query="",method="GET",member=true)=>handler(new Request(`https://example.invalid/functions/v1/service-api/me/sanctions${query}`,{method,headers:{authorization:member?"Bearer synthetic-member":"Bearer invalid"},...(method==="POST"?{body:"{}"}:{})}))};
}
test("본인 제재 이력 고정 RPC와 무통지 NULL 마감",async()=>{const{send,calls}=setup();const r=await send();assert.equal(r.status,200);assert.deepEqual((await r.json()).data,{items:[item],nextCursor:null});assert.deepEqual(calls,[{name:"list_my_sanctions",args:{p_limit:20,p_before:null}}]);});
test("검증한 페이지만 전달하며 회원·통지·마감 선택 차단",async()=>{const{send,calls}=setup({items:[],nextCursor:null});assert.equal((await send(`?limit=1&before=${id}`)).status,200);assert.deepEqual(calls[0],{name:"list_my_sanctions",args:{p_limit:1,p_before:id}});for(const q of [`?userId=${other}`,`?identityId=${other}`,"?deadline=now","?limit=101","?limit=01","?limit=1&limit=2","?before=bad"])assert.equal((await send(q)).status,400);assert.equal(calls.length,1);});
test("미인증·변경 method는 RPC 이전 차단",async()=>{const{send,calls}=setup();assert.equal((await send("","GET",false)).status,401);assert.equal((await send("","POST")).status,405);assert.equal(calls.length,0);});
test("기간종료·정정·other 대표사유를 좁은 DTO로 표시",async()=>{for(const value of [item,{...item,status:"ended"},{...item,status:"corrected",revokedAt:"2026-10-03T12:00:00Z",correctionReasonCode:"other",appealState:"accepted"},{...item,kind:"cancel_warning",expiresAt:null,reasonCode:"other",appealPolicy:"cancellation_24h"}])assert.equal((await setup({items:[value],nextCursor:null}).send()).status,200);});
test("원문·타인 사건·추정 마감·변형 DTO는 503이며 재노출 없음",async()=>{for(const patch of [{description:"비공개 원문"},{reporterId:other},{incidentId:other},{actorReference:other},{reasonCode:"synthetic_private_reason"},{appealDeadlineAt:"2026-10-09T12:00:00Z"},{status:["active"]},{appliedAt:"2026-02-30T12:00:00Z"},{notifiedAt:"2026-10-05T24:00:00Z"},{status:"corrected"},{correctionReasonCode:"other"},{kind:"unknown"},{appealState:"sent"},{expiresAt:null},{sanctionId:id.split("-")}]){const r=await setup({items:[{...item,...patch}],nextCursor:null} as unknown as JsonValue).send();assert.equal(r.status,503);const text=JSON.stringify(await r.json());assert.equal(text.includes("비공개 원문"),false);assert.equal(text.includes(other),false);}});
test("초과·중복·역순·잘못된 커서·취소의 임의 이의 연결 거절",async()=>{for(const value of [{items:[item,item],nextCursor:null},{items:[{...item,sanctionId:other},item],nextCursor:null},{items:[item],nextCursor:other},{items:[],nextCursor:id},{items:[{...item,kind:"cancel_restriction",appealPolicy:"cancellation_24h",appealState:"reviewing"}],nextCursor:null},{items:[item],nextCursor:null,rawReason:"secret"}])assert.equal((await setup(value as JsonValue).send("?limit=1")).status,503);assert.equal((await setup({items:[item],nextCursor:id}).send("?limit=1")).status,200);});
test("사용자 transport는 검증 JWT·anon key로 정확 RPC만 전송한다",async()=>{
 const{loadRuntimeConfig}=await import("../../../backend/supabase/functions/_shared/config/env.ts");
 const{requirePrincipal}=await import("../../../backend/supabase/functions/_shared/auth/principal.ts");
 const{createUserClient}=await import("../../../backend/supabase/functions/_shared/db/user-client.ts");
 const env:Record<string,string>={SUPABASE_URL:"https://project.example.test",SUPABASE_ANON_KEY:"synthetic-anon",ALLOWED_ORIGINS:"[]",MAX_REQUEST_BYTES:"8192",UPSTREAM_TIMEOUT_MS:"1000"};
 const config=loadRuntimeConfig(k=>env[k]),token="header.synthetic.signature";
 const principal=await requirePrincipal(new Request("https://example.invalid",{headers:{authorization:`Bearer ${token}`}}),config,async()=>new Response(JSON.stringify({id,role:"authenticated",is_anonymous:false})));
 let calls=0;const db=createUserClient(config,principal,async(url,init)=>{calls++;assert.equal(url,"https://project.example.test/rest/v1/rpc/list_my_sanctions");assert.equal(new Headers(init?.headers).get("authorization"),`Bearer ${token}`);assert.equal(new Headers(init?.headers).get("apikey"),"synthetic-anon");assert.deepEqual(JSON.parse(String(init?.body)),{p_limit:20,p_before:null});return new Response(JSON.stringify({items:[],nextCursor:null}));});
 await db.rpc("list_my_sanctions",{p_limit:20,p_before:null});assert.equal(calls,1);
 await assert.rejects(db.rpc("record_incident_revision",{}),HttpError);assert.equal(calls,1);
});
