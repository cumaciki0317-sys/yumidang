/** 민규: 실제 Auth 거절 뒤 원 JWT+anon 단일 GET만 사용한다. JWT 실제 검증은 격리 통합 검사다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRuntimeHandler } from "../../../backend/supabase/functions/service-api/index.ts";
const id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",withdrawal="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const token="header.payload.signature";
const values:Record<string,string>={SUPABASE_URL:"https://retirement.example.invalid",SUPABASE_ANON_KEY:"fixture-anon",
 SUPABASE_SERVICE_ROLE_KEY:"fixture-service",INTERNAL_WORKER_SECRET:"retirement_fixture_internal_secret_longer_than32",
 MAX_REQUEST_BYTES:"65536",UPSTREAM_TIMEOUT_MS:"1000",ALLOWED_ORIGINS:"[]"};
const result={withdrawalId:withdrawal,status:"processing",memberAccessRevoked:true};
const request=(bearer:string|null=token,body:unknown={withdrawalId:withdrawal})=>new Request(values.SUPABASE_URL+"/service-api/me/retirement",{
 method:"POST",headers:{...(bearer===null?{}:{authorization:"Bearer "+bearer}),"content-type":"application/json"},body:JSON.stringify(body)});
const handler=()=>createRuntimeHandler(k=>values[k],{memberCleanup:true,memberRetirement:true});
function assertReceipt(url:string,init:RequestInit){
 const u=new URL(url);assert.equal(u.pathname,"/rest/v1/rpc/get_my_retirement_receipt");assert.equal(init.method,"GET");assert.equal(init.body,undefined);
 assert.deepEqual([...u.searchParams.keys()].sort(),["p_request_fingerprint","p_withdrawal_id"]);
 assert.equal(u.searchParams.get("p_withdrawal_id"),withdrawal);
 assert.equal(u.searchParams.get("p_request_fingerprint"),createHash("sha256").update("retirement:v1:"+withdrawal).digest("hex"));
 const h=new Headers(init.headers);assert.equal(h.get("authorization"),"Bearer "+token);assert.equal(h.get("apikey"),values.SUPABASE_ANON_KEY);
}
test("최초 탈퇴 응답 유실 뒤 실제 Auth 거절은 정확한 영수증 GET으로만 복구한다",async()=>{
 const original=globalThis.fetch;let auth=0,retire=0,receipt=0;
 globalThis.fetch=async(url,init={})=>{
  if(String(url).endsWith("/auth/v1/user"))return ++auth===1?Response.json({id,role:"authenticated",is_anonymous:false}):Response.json({message:"private auth error"},{status:403});
  if(init.method==="POST"){assert.ok(String(url).endsWith("/rest/v1/rpc/retire_my_account"));retire++;return Response.json(result);}
  assertReceipt(String(url),init);receipt++;return Response.json(result);
 };
 try{const h=handler();assert.equal((await h(request())).status,200);const retry=await h(request());assert.equal(retry.status,200);
  assert.deepEqual((await retry.json()).data,result);assert.equal(auth,2);assert.equal(retire,1);assert.equal(receipt,1);
 }finally{globalThis.fetch=original;}
});
test("Auth401·403과 종료된 영수증은 원 bearer GET 결과만 반환한다",async()=>{
 const original=globalThis.fetch;
 try{for(const status of [401,403]){let calls=0;globalThis.fetch=async(url,init={})=>{
  calls++;if(String(url).endsWith("/auth/v1/user"))return Response.json({},{status});assertReceipt(String(url),init);return Response.json({...result,status:"completed"});};
  const response=await handler()(request());assert.equal(response.status,200);assert.equal((await response.json()).data.status,"completed");assert.equal(calls,2);
 }}finally{globalThis.fetch=original;}
});
test("Auth500·503·timeout은 영수증 GET이나 새 탈퇴로 fallback하지 않는다",async()=>{
 const original=globalThis.fetch;
 try{for(const status of [500,503,0]){let calls=0;globalThis.fetch=async url=>{calls++;assert.ok(String(url).endsWith("/auth/v1/user"));if(!status)throw new TypeError("private failure");return Response.json({message:"private failure"},{status});};
  const response=await handler()(request());assert.equal(response.status,503);assert.equal(calls,1);assert.doesNotMatch(await response.text(),/private failure/);
 }}finally{globalThis.fetch=original;}
});
test("missing·malformed·내부 bearer는 Auth나 receipt 전에 닫힌다",async()=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;assert.fail("인증 전 네트워크 금지");};
 try{for(const bearer of [null,"unsigned",values.SUPABASE_ANON_KEY,values.SUPABASE_SERVICE_ROLE_KEY,values.INTERNAL_WORKER_SECRET])assert.equal((await handler()(request(bearer))).status,401);assert.equal(calls,0);}
 finally{globalThis.fetch=original;}
});
test("Auth200의 부적합 사용자 body는 AUTH_REQUIRED라도 receipt를 호출하지 않는다",async()=>{
 const original=globalThis.fetch;
 try{for(const body of [null,{id,role:"anon"},{id,role:"authenticated",is_anonymous:true},{id:"bad",role:"authenticated"}]){
  let calls=0;globalThis.fetch=async()=>{calls++;return Response.json(body);};assert.equal((await handler()(request())).status,401);assert.equal(calls,1);
 }}finally{globalThis.fetch=original;}
});
test("JWT·대상·fingerprint·상태 거절과 missing RPC는 성공·새쓰기로 대체하지 않는다",async()=>{
 const original=globalThis.fetch;
 try{for(const status of [401,403,404]){let calls=0;globalThis.fetch=async(url,init={})=>{calls++;if(String(url).endsWith("/auth/v1/user"))return Response.json({},{status:401});assertReceipt(String(url),init);return Response.json({message:"private SQL detail",code:"28000"},{status});};
  const response=await handler()(request());assert.equal(response.status,401);assert.equal(calls,2);assert.doesNotMatch(await response.text(),/private SQL|28000/);
 }}finally{globalThis.fetch=original;}
});
test("영수증 비정상 반환은 최소 응답 검증에서 닫힌다",async()=>{
 const original=globalThis.fetch;
 try{for(const body of [null,{...result,profileId:id},{...result,withdrawalId:id},{...result,memberAccessRevoked:false},{...result,status:"accepted"}]){
  globalThis.fetch=async(url,init={})=>{if(String(url).endsWith("/auth/v1/user"))return Response.json({},{status:403});assertReceipt(String(url),init);return Response.json(body);};
  assert.equal((await handler()(request())).status,503);
 }}finally{globalThis.fetch=original;}
});
test("Auth 거절 뒤 잘못된 본문은 조회·새 탈퇴를 실행하지 않는다",async()=>{
 const original=globalThis.fetch;
 try{for(const body of [{withdrawalId:"bad"},{withdrawalId:withdrawal,userId:id}]){let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({},{status:403});};
  assert.equal((await handler()(request(token,body))).status,400);assert.equal(calls,1);
 }}finally{globalThis.fetch=original;}
});
test("기본 비활성 retirement는 Auth와 receipt 전에 닫힌다",async()=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;assert.fail("기본 활성화 금지");};
 try{assert.equal((await createRuntimeHandler(k=>values[k])(request())).status,404);assert.equal(calls,0);}finally{globalThis.fetch=original;}
});
