/** 민규: 실제 삭제가 아닌 탈퇴 요청/응답 어댑터 경계 검증. HTTP 공개 연결은 실제 cleanup 검증 뒤다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRetirementRequest, retireMyAccount } from "../../../backend/supabase/functions/_shared/services/member-lifecycle-service.ts";
import type { JsonValue } from "../../../backend/supabase/functions/_shared/contracts/common.ts";
import { HttpError, toPublicError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
const id = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const normalized = id.toLowerCase();
const valid = { withdrawalId: normalized, status: "processing", memberAccessRevoked: true };

test("탈퇴 입력에는 요청 ID만 허용하고 타인·외부 삭제 정보를 받지 않는다", () => {
  assert.equal(parseRetirementRequest({ withdrawalId: id }), normalized);
  for (const body of [null, [], {}, { withdrawalId: 1 }, { withdrawalId: "invalid" },
    { withdrawalId: id, userId: normalized }, { withdrawalId: id, storagePath: "other/file.jpg" },
    { withdrawalId: id, completed: true }, { withdrawalId: id, serviceRoleKey: "untrusted" }]) {
    assert.throws(() => parseRetirementRequest(body as JsonValue), (error: unknown) => error instanceof HttpError && toPublicError(error).error.code === "INVALID_REQUEST");
  }
});
test("탈퇴는 원래 회원 RPC와 정규화한 ID만 사용하며 processing을 completed로 바꾸지 않는다", async () => {
  const calls: unknown[] = [];
  const result = await retireMyAccount({ rpc: async (name, args) => { calls.push({ name, args });return valid; } }, id);
  assert.deepEqual(calls, [{ name: "retire_my_account", args: { p_withdrawal_id: normalized } }]);
  assert.deepEqual(result, valid);
});
test("동일 요청의 실제 완료 응답만 completed로 반환한다", async () => {
  assert.deepEqual(await retireMyAccount({ rpc: async () => ({ ...valid, status: "completed" }) }, id), { ...valid, status: "completed" });
});
test("변형·다른 요청·접근 미회수 응답은 성공으로 표시하지 않는다", async () => {
  for (const value of [null, [], {}, { ...valid, status: ["completed"] }, { ...valid, status: "pending" },
    { ...valid, memberAccessRevoked: false }, { ...valid, memberAccessRevoked: "true" },
    { ...valid, withdrawalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, { ...valid, filesDeleted: true }]) {
    await assert.rejects(() => retireMyAccount({ rpc: async () => value as JsonValue }, id),
      (error: unknown) => error instanceof HttpError && toPublicError(error).error.code === "EXTERNAL_UNAVAILABLE");
  }
});
test("진행 중 약속의 충돌은 탈퇴 성공으로 대체하지 않는다", async () => {
  const conflict = new HttpError("STATE_CONFLICT");
  await assert.rejects(() => retireMyAccount({ rpc: async () => { throw conflict; } }, id), (error: unknown) => error === conflict);
});
test("잘못된 ID는 DB 호출 전에 거절한다", async () => {
  let called = false;
  await assert.rejects(() => retireMyAccount({ rpc: async () => { called = true;return valid; } }, "invalid"), HttpError);
  assert.equal(called, false);
});

import { createServiceApi } from "../../../backend/supabase/functions/service-api/handler.ts";
import { createRuntimeHandler } from "../../../backend/supabase/functions/service-api/index.ts";
import { loadRuntimeConfig } from "../../../backend/supabase/functions/_shared/config/env.ts";
import { requirePrincipal } from "../../../backend/supabase/functions/_shared/auth/principal.ts";
import { createUserClient } from "../../../backend/supabase/functions/_shared/db/user-client.ts";

function retirementRequest(body: unknown = { withdrawalId: id }, suffix = "", method = "POST") {
  return new Request("https://api.test/service-api/me/retirement" + suffix, { method,
    headers: { "content-type": "application/json", authorization: "Bearer header.valid.signature" },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
}
function retirementHttp(enabled = false, rpc = async (_name: string, _args: unknown): Promise<JsonValue> => valid) {
  const counts = { auth: 0, internal: 0, rpc: 0 };
  const handler = createServiceApi({ allowedOrigins: [], maxBodyBytes: 65536,
    ...(enabled ? { memberRetirement: true as const } : {}),
    authenticateUser: async () => { counts.auth++; return { rpc: async (name, args) => { counts.rpc++;return rpc(name,args); } }; },
    authenticateInternal: async () => { counts.internal++; throw new Error("internal auth must not run"); },
  });
  return { handler, counts };
}

test("탈퇴 HTTP는 기본 닫힘이며 본문과 헤더로 활성화할 수 없다", async () => {
  const { handler, counts } = retirementHttp();
  const response = await handler(retirementRequest({ withdrawalId: id, memberRetirement: true }));
  assert.equal(response.status, 404);
  assert.deepEqual(counts, { auth: 0, internal: 0, rpc: 0 });
});
test("준비된 탈퇴 HTTP는 회원 인증과 원래 RPC를 쓰고 processing을 그대로 반환한다", async () => {
  const { handler, counts } = retirementHttp(true, async (name, args) => {
    assert.equal(name, "retire_my_account");assert.deepEqual(args,{p_withdrawal_id:normalized});return valid;
  });
  const response = await handler(retirementRequest());
  assert.equal(response.status,200);assert.deepEqual((await response.json()).data,valid);
  assert.deepEqual(counts,{auth:1,internal:0,rpc:1});
});
test("탈퇴 HTTP의 주입 필드·query·잘못된 ID·메서드는 저장 전에 거절한다", async () => {
  const { handler, counts }=retirementHttp(true);
  for(const body of [{withdrawalId:id,userId:normalized},{withdrawalId:id,storagePath:"other/file"},
    {withdrawalId:id,completed:true},{withdrawalId:"bad"},{}]) {
    assert.equal((await handler(retirementRequest(body))).status,400);
  }
  assert.equal((await handler(retirementRequest(undefined,"?actor=other"))).status,400);
  assert.equal((await handler(retirementRequest(undefined,"","GET"))).status,405);
  assert.equal(counts.rpc,0);assert.equal(counts.internal,0);
});
test("탈퇴 HTTP는 접근 미회수·다른 요청 결과·DB 충돌을 성공으로 바꾸지 않는다",async()=>{
  for(const result of [{...valid,memberAccessRevoked:false},{...valid,withdrawalId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}]){
    const {handler}=retirementHttp(true,async()=>result);assert.equal((await handler(retirementRequest())).status,503);
  }
  const {handler}=retirementHttp(true,async()=>{throw new HttpError("STATE_CONFLICT");});
  assert.equal((await handler(retirementRequest())).status,409);
});
test("준비된 탈퇴 HTTP라도 회원 인증 거절을 내부 인증으로 대체하지 않는다",async()=>{
  let rpc=0,internal=0;
  const handler=createServiceApi({allowedOrigins:[],maxBodyBytes:65536,memberRetirement:true,
    authenticateUser:async()=>{throw new HttpError("AUTH_REQUIRED");},
    authenticateInternal:async()=>{internal++;return{rpc:async()=>{rpc++;return valid;}};}});
  assert.equal((await handler(retirementRequest())).status,401);assert.equal(rpc,0);assert.equal(internal,0);
});
test("runtime 탈퇴 옵션은 cleanup 없이 켜지지 않으며 기본 진입점은 닫혀 있다",async()=>{
  const values:Record<string,string>={SUPABASE_URL:"https://project.test",SUPABASE_ANON_KEY:"anon",
    ALLOWED_ORIGINS:"[]",MAX_REQUEST_BYTES:"65536",UPSTREAM_TIMEOUT_MS:"1000"};
  const read=(key:string)=>values[key];
  assert.throws(()=>createRuntimeHandler(read,{memberRetirement:true}),HttpError);
  assert.equal((await createRuntimeHandler(read)(retirementRequest())).status,404);
});
test("탈퇴 RPC 허용목록은 회원 원 JWT와 anon key를 유지하고 service key를 쓰지 않는다",async()=>{
  const c=loadRuntimeConfig(key=>({SUPABASE_URL:"https://project.test",SUPABASE_ANON_KEY:"anon",
    SUPABASE_SERVICE_ROLE_KEY:"private-service",ALLOWED_ORIGINS:"[]",MAX_REQUEST_BYTES:"65536",UPSTREAM_TIMEOUT_MS:"1000"})[key]);
  const token="header.valid.signature";
  const principal=await requirePrincipal(new Request("https://api.test",{headers:{authorization:"Bearer "+token}}),c,
    async()=>new Response(JSON.stringify({id:normalized,role:"authenticated",is_anonymous:false}),{status:200}));
  const client=createUserClient(c,principal,async(url,init)=>{
    assert.equal(url,"https://project.test/rest/v1/rpc/retire_my_account");
    const headers=new Headers(init?.headers);assert.equal(headers.get("authorization"),"Bearer "+token);
    assert.equal(headers.get("apikey"),"anon");return new Response(JSON.stringify(valid),{status:200});
  });
  assert.deepEqual(await retireMyAccount(client,id),valid);
});
