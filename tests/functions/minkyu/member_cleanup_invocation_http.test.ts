/** 민규: 합성 RPC/HTTP만 사용한다. 실제 삭제·운영 활성화 검증이 아니다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServiceApi, type MemberCleanupInvocationAllocation } from "../../../backend/supabase/functions/service-api/handler.ts";
import { createRuntimeHandler } from "../../../backend/supabase/functions/service-api/index.ts";
import { HttpError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
import type { JsonValue } from "../../../backend/supabase/functions/_shared/contracts/common.ts";
const token = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const shared = { "x-worker-run-token": token, "x-worker-request-id": id, "x-worker-max-jobs": "2", "x-worker-time-budget-ms": "180000" };
const prepared = () => ({ requestId: id, globalToken: token, kind: "member_cleanup", limit: 2, remainingMs: 180000,
  state: "prepared", closedAt: null, result: null });
function request(headers: Record<string,string> = shared, body: unknown = {}, signal?: AbortSignal, path = "/service-api/internal/member-cleanup") {
  return new Request("https://cleanup.example.invalid" + path, { method: "POST", signal,
    headers: { authorization: "Bearer synthetic-worker", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
function fixture(options: { state?: unknown; claimed?: JsonValue; hook?: (name:string)=>void; result?: unknown; enabled?: boolean; authError?: boolean } = {}) {
  const calls: string[] = [], executions: Array<{ allocation?: MemberCleanupInvocationAllocation; signal: AbortSignal }> = [];
  let users = 0;
  const db = { async rpc(name: string, args: Record<string,JsonValue>): Promise<JsonValue> {
    calls.push(name); options.hook?.(name);
    if (name === "get_queue_invocation") { assert.deepEqual(args,{p_request_id:id}); return (options.state ?? prepared()) as JsonValue; }
    if (name === "claim_queue_invocation_dispatch") {
      assert.deepEqual(args,{p_request_id:id,p_global_token:token,p_kind:"member_cleanup",p_limit:2,p_remaining_ms:180000});
      return { claimed: options.claimed ?? true } as JsonValue;
    }
    assert.fail("예상하지 않은 RPC");
  } };
  const handler = createServiceApi({ allowedOrigins: [], maxBodyBytes: 1024,
    authenticateUser: async () => { users++; throw new HttpError("AUTH_REQUIRED"); },
    authenticateInternal: async () => { calls.push("authenticate"); if (options.authError) throw new HttpError("ACCESS_DENIED"); return db; },
    ...(options.enabled === false ? {} : { memberCleanup: { execute: async (received, receivedToken, signal, allocation) => {
      assert.equal(received,db); assert.equal(receivedToken,token); calls.push("execute"); executions.push({ allocation,signal });
      options.hook?.("execute");
      return (options.result ?? {status:"ran",claimed:1,succeeded:1}) as {status:"ran";claimed:number;succeeded:number};
    } } }),
  });
  return { handler, calls, executions, users:()=>users };
}
test("내부 인증과 정확한 prepared 배정 조회 후 CAS 한 번만 실행하고 배정을 전달한다", async () => {
  const x=fixture(); const r=await x.handler(request()); assert.equal(r.status,200);
  assert.deepEqual(x.calls,["authenticate","get_queue_invocation","claim_queue_invocation_dispatch","execute"]);
  const allocation=x.executions[0].allocation!;
  assert.equal(allocation.requestId,id); assert.equal(allocation.limit,2);
  assert.ok(allocation.remainingMs>0 && allocation.remainingMs<=180000); assert.ok(Object.isFrozen(allocation));
  assert.ok(x.executions[0].signal instanceof AbortSignal); assert.equal(x.users(),0);
  assert.deepEqual((await r.json()).data,{status:"ran",claimed:1,succeeded:1});
});
test("내부 인증 실패는 malformed 입력보다 먼저 거절하고 사용자 인증으로 fallback하지 않는다", async () => {
  const x=fixture({authError:true}); const r=await x.handler(request({"x-worker-request-id":"bad"},{target:"private"}));
  assert.equal(r.status,403); assert.deepEqual(x.calls,["authenticate"]); assert.equal(x.users(),0);
});
test("공유 네 헤더 일부 누락과 범위·형식 오류는 조회와 삭제 전에 거절한다", async () => {
  for(const key of Object.keys(shared)) {
    const headers={...shared}; delete headers[key as keyof typeof headers];
    const x=fixture(); assert.equal((await x.handler(request(headers))).status,400); assert.deepEqual(x.calls,["authenticate"]);
  }
  for(const [key,value] of [["x-worker-max-jobs","11"],["x-worker-max-jobs","0"],["x-worker-max-jobs","01"],
    ["x-worker-max-jobs","2,2"],["x-worker-time-budget-ms","180001"],["x-worker-time-budget-ms","0"],
    ["x-worker-request-id",id+","+id],["x-worker-run-token","bad"]]) {
    const x=fixture(); assert.equal((await x.handler(request({...shared,[key]:value}))).status,400); assert.deepEqual(x.calls,["authenticate"]);
  }
});
test("공유 요청 body는 빈 객체이며 query나 대상·한도 주입은 허용하지 않는다", async () => {
  for(const body of [null,[],{limit:2},{requestId:id},{target:token}]) {
    const x=fixture(); assert.equal((await x.handler(request(shared,body))).status,400); assert.deepEqual(x.calls,["authenticate"]);
  }
  const x=fixture(); assert.equal((await x.handler(request(shared,{},undefined,"/service-api/internal/member-cleanup?limit=2"))).status,400);
  assert.deepEqual(x.calls,["authenticate"]);
});
test("UNKNOWN·완료·다른 kind/token/allocation은 CAS나 실행을 허용하지 않는다", async () => {
  for(const patch of [{state:"unknown"},{state:"completed"},{kind:"review_summary"},{globalToken:id},{limit:1},{remainingMs:179999}]) {
    const x=fixture({state:{...prepared(),...patch}}); assert.notEqual((await x.handler(request())).status,200);
    assert.deepEqual(x.calls,["authenticate","get_queue_invocation"]); assert.equal(x.executions.length,0);
  }
});
test("CAS false·깨진 응답은 재호출이나 삭제 실행으로 복구하지 않는다", async () => {
  for(const claimed of [false,"true"]) {
    const x=fixture({claimed}); assert.notEqual((await x.handler(request())).status,200);
    assert.deepEqual(x.calls,["authenticate","get_queue_invocation","claim_queue_invocation_dispatch"]); assert.equal(x.executions.length,0);
  }
});
test("CAS 응답 유실은 원문 노출·자동 재호출·legacy 실행으로 바꾸지 않는다", async () => {
  const x=fixture({hook:name=>{if(name==="claim_queue_invocation_dispatch")throw new Error("fixture-secret raw response");}});
  const r=await x.handler(request()); assert.equal(r.status,500); assert.doesNotMatch(await r.text(),/fixture-secret|raw response/);
  assert.deepEqual(x.calls,["authenticate","get_queue_invocation","claim_queue_invocation_dispatch"]); assert.equal(x.executions.length,0);
});
test("조회 및 CAS 중 취소되면 삭제 실행하지 않는다", async () => {
  for(const when of ["get_queue_invocation","claim_queue_invocation_dispatch"]) {
    const abort=new AbortController(); const x=fixture({hook:name=>{if(name===when)abort.abort();}});
    assert.equal((await x.handler(request(shared,{},abort.signal))).status,409); assert.equal(x.executions.length,0);
    assert.equal(x.calls.filter(n=>n==="claim_queue_invocation_dispatch").length,when==="get_queue_invocation"?0:1);
  }
});
test("조회·CAS의 monotonic 경과 시간을 배정에서 차감하고 지연 만료면 실행하지 않는다", async () => {
  const descriptor=Object.getOwnPropertyDescriptor(performance,"now"); let now=100;
  Object.defineProperty(performance,"now",{configurable:true,value:()=>now});
  try {
    const x=fixture({hook:name=>{now+=name==="get_queue_invocation"?2500:700;}});
    assert.equal((await x.handler(request())).status,200); assert.equal(x.executions[0].allocation!.remainingMs,176800);
    const expired=fixture({hook:name=>{if(name==="get_queue_invocation")now+=180000;}});
    assert.equal((await expired.handler(request())).status,409); assert.deepEqual(expired.calls,["authenticate","get_queue_invocation"]);
    const lateResult=fixture({hook:name=>{if(name==="execute")now+=180000;}});
    assert.equal((await lateResult.handler(request())).status,409); assert.equal(lateResult.executions.length,1);
  } finally { if(descriptor)Object.defineProperty(performance,"now",descriptor); else Reflect.deleteProperty(performance,"now"); }
});
test("공유 집계는 DB 배정 한도보다 큰 값을 성공으로 반환하지 않는다", async () => {
  const x=fixture({result:{status:"ran",claimed:3,succeeded:3}}); assert.equal((await x.handler(request())).status,503);
});
test("원래 token-only 요청과 기본 비활성 동작을 보존한다", async () => {
  const x=fixture(); assert.equal((await x.handler(request({"x-worker-run-token":token}))).status,200);
  assert.deepEqual(x.calls,["authenticate","execute"]); assert.equal(x.executions[0].allocation,undefined);
  const closed=fixture({enabled:false}); assert.equal((await closed.handler(request())).status,404); assert.deepEqual(closed.calls,[]);
});

const values: Record<string,string>={ SUPABASE_URL:"https://cleanup.example.invalid",SUPABASE_ANON_KEY:"fixture-anon",
  SUPABASE_SERVICE_ROLE_KEY:"fixture-service",INTERNAL_WORKER_SECRET:"fixture_worker_secret_longer_than_32_characters",
  ALLOWED_ORIGINS:"[]",MAX_REQUEST_BYTES:"65536",UPSTREAM_TIMEOUT_MS:"1000" };
function runtimeRequest(limit:number,time:number) {
  const r=request({...shared,"x-worker-max-jobs":String(limit),"x-worker-time-budget-ms":String(time)});
  r.headers.set("authorization",`Bearer ${values.INTERNAL_WORKER_SECRET}`); return r;
}
test("실제 factory는 공유 시간 상한을 drain에 전달해60초 미만이면 claim하지 않는다", async () => {
  const original=globalThis.fetch,calls:string[]=[];
  globalThis.fetch=async(url)=>{
    const name=String(url).split("/").at(-1)!; calls.push(name);
    if(name==="get_queue_invocation")return Response.json({...prepared(),limit:1,remainingMs:59000});
    if(name==="claim_queue_invocation_dispatch")return Response.json({claimed:true});
    if(name==="read_worker_run_budget")return Response.json({remainingMs:180000});
    assert.fail("60초 미만 배정은 task claim이나 외부 삭제를 하지 않아야 한다");
  };
  try {
    const r=await createRuntimeHandler(k=>values[k],{memberCleanup:true})(runtimeRequest(1,59000));
    assert.equal(r.status,200); assert.deepEqual((await r.json()).data,{status:"ran",claimed:0,succeeded:0});
    assert.deepEqual(calls,["get_queue_invocation","claim_queue_invocation_dispatch","read_worker_run_budget"]);
  } finally { globalThis.fetch=original; }
});
test("실제 factory의 배정 limit1은 한 합성 Auth task 완료 후 추가 claim을 막는다", async () => {
  const original=globalThis.fetch,calls:string[]=[]; let deleted=false;
  const task={taskId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",leaseToken:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    expiresAt:new Date(Date.now()+120000).toISOString(),kind:"auth_user",profileId:token,bucketId:null,objectName:null,objectId:null};
  globalThis.fetch=async(url,init)=>{
    const name=String(url).split("/").at(-1)!; calls.push(name); assert.ok(init?.signal instanceof AbortSignal);
    if(String(url).includes("/auth/v1/admin/users/")) {
      if(init?.method==="DELETE"){deleted=true;return Response.json({});}
      return Response.json(deleted?{}:{id:token},{status:deleted?404:200});
    }
    const input=JSON.parse(String(init?.body));
    if(name==="get_queue_invocation")return Response.json({...prepared(),limit:1});
    if(name==="claim_queue_invocation_dispatch")return Response.json({claimed:true});
    if(name==="read_worker_run_budget")return Response.json({remainingMs:180000});
    if(name==="claim_member_cleanup_task"||name==="check_member_cleanup_task")return Response.json(task);
    if(name==="get_member_cleanup_delete_ack")return Response.json(null);
    if(name==="begin_member_cleanup_delete")return Response.json({dispatchId:id,alreadyDispatched:false});
    if(name==="record_member_cleanup_delete_ack")return Response.json({receiptId:id,taskId:task.taskId,kind:task.kind,objectId:null,evidenceSha256:input.p_ack_sha256});
    if(name==="complete_member_cleanup_task")return Response.json({status:"applied"});
    assert.fail("예상하지 않은 실제 조립 호출");
  };
  try {
    const r=await createRuntimeHandler(k=>values[k],{memberCleanup:true})(runtimeRequest(1,180000));
    assert.equal(r.status,200); assert.deepEqual((await r.json()).data,{status:"ran",claimed:1,succeeded:1});
    assert.equal(calls.filter(n=>n==="claim_member_cleanup_task").length,1); assert.equal(deleted,true);
    assert.equal(calls.includes("complete_queue_invocation"),false);
  } finally { globalThis.fetch=original; }
});
