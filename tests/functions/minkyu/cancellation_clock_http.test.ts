/** 민규: 제재 원 시각 연결의 HTTP 계약. 실제 DB 검증과 별도다. */
import {test} from "node:test";
import assert from "node:assert/strict";
import {createReportOperatorExecutor,reportOperatorRoute} from "../../../backend/supabase/functions/service-api/report-operator-http.ts";
import type {RuntimeConfig} from "../../../backend/supabase/functions/_shared/config/env.ts";
import type {JsonValue} from "../../../backend/supabase/functions/_shared/contracts/common.ts";
const uid="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",report="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",anchor="cccccccc-cccc-4ccc-8ccc-cccccccccccc",requestId="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const config={supabaseUrl:"https://example.test",supabaseAnonKey:"anon",maxRequestBytes:8192,upstreamTimeoutMs:1000,allowedOrigins:[]} as RuntimeConfig;
const base={clientRequestId:requestId,expectedReportVersion:3,planFingerprint:"a".repeat(64),mappings:[{anchorAppointmentId:anchor,predecessorApplicationId:null}]};
function setup(kind:"clock-state"|"clock-repair",result:JsonValue){let calls=0;const suffix=kind==="clock-state"?"cancellation-clock-state":"cancellation-clock-repairs";const url=`https://example.test/service-api/operator/reports/${report}/${suffix}`;
 const execute=createReportOperatorExecutor(config,async(input,init)=>{
  assert.equal(new Headers(init?.headers).get("authorization"),"Bearer header.staff.signature");
  if(String(input).endsWith("/auth/v1/user"))return new Response(JSON.stringify({id:uid,role:"authenticated",is_anonymous:false}));
  assert.equal(String(input),config.supabaseUrl+"/rest/v1/rpc/"+(kind==="clock-state"?"get_assigned_cancellation_clock_state":"repair_assigned_cancellation_clocks"));calls++;
  return new Response(JSON.stringify(result));});
 return{count:()=>calls,url,run:(body:JsonValue=base)=>execute(new Request(url,{method:kind==="clock-state"?"GET":"POST",headers:{authorization:"Bearer header.staff.signature","content-type":"application/json"},...(kind==="clock-state"?{}:{body:JSON.stringify(body)})}),{kind,reportId:report})};}
test("시계 상태는 정확한 actions와 fingerprint만 반환",async()=>{const s=setup("clock-state",{reportId:report,reportVersion:3,planFingerprint:base.planFingerprint,actions:[{anchorAppointmentId:anchor,kind:"cancel_warning"}]});assert.deepEqual(reportOperatorRoute(new URL(s.url)),{kind:"clock-state",reportId:report});const response=await s.run();assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"private, no-store");await assert.rejects(setup("clock-state",{reportId:report,reportVersion:3,planFingerprint:base.planFingerprint,actions:[{anchorAppointmentId:anchor,kind:"cancel_warning",rawText:"private"}]}).run());});
test("시계 정정은 서버 시각 입력·중복 mapping·새 필드를 거절",async()=>{const s=setup("clock-repair",{reportId:report,reportVersion:4,repairedCount:1,alreadyApplied:false});assert.equal((await s.run()).status,200);for(const bad of[{...base,appliedAt:"2026-01-01"},{...base,mappings:[...base.mappings,...base.mappings]},{...base,planFingerprint:"wrong"}])await assert.rejects(s.run(bad));assert.equal(s.count(),1);});
test("시계 정정 결과 버전/개수/원문 누출을 거절",async()=>{for(const bad of[{reportId:report,reportVersion:5,repairedCount:1,alreadyApplied:false},{reportId:report,reportVersion:4,repairedCount:2,alreadyApplied:false},{reportId:report,reportVersion:4,repairedCount:1,alreadyApplied:false,raw:"private"}])await assert.rejects(setup("clock-repair",bad).run());});
