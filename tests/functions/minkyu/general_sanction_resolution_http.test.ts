/** 민규: 배정 심사 HTTP 모형. 실제 DB 심사 검증과 구분한다. */
import {test} from "node:test";
import assert from "node:assert/strict";
import {createReportOperatorExecutor,reportOperatorRoute} from "../../../backend/supabase/functions/service-api/report-operator-http.ts";
import type {RuntimeConfig} from "../../../backend/supabase/functions/_shared/config/env.ts";
import type {JsonValue} from "../../../backend/supabase/functions/_shared/contracts/common.ts";
const uid="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",report="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",appeal="cccccccc-cccc-4ccc-8ccc-cccccccccccc",requestId="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const config={supabaseUrl:"https://example.test",supabaseAnonKey:"anon",maxRequestBytes:8192,upstreamTimeoutMs:1000,allowedOrigins:[]} as RuntimeConfig;
const base={clientRequestId:requestId,expectedReportVersion:3,expectedHoldVersion:2,expectedIncidentRevision:1,outcome:"rejected",appointmentOutcome:null,incidentOutcome:null,responsibleRole:null,representativeReasonCode:null,violationClass:null,violationType:null};
const url=`https://example.test/service-api/operator/reports/${report}/general-sanction-appeals/${appeal}/resolutions`;
function setup(value?:JsonValue){const calls:Array<Record<string,JsonValue>>=[];
 const execute=createReportOperatorExecutor(config,async(input,init)=>{
  assert.equal(new Headers(init?.headers).get("authorization"),"Bearer header.staff.signature");
  if(String(input).endsWith("/auth/v1/user"))return new Response(JSON.stringify({id:uid,role:"authenticated",is_anonymous:false}));
  assert.equal(String(input),config.supabaseUrl+"/rest/v1/rpc/resolve_assigned_general_sanction_appeal");
  const args=JSON.parse(String(init?.body));calls.push(args);
  return new Response(JSON.stringify(value??{reportId:report,appealId:appeal,appealState:args.p_outcome,reportVersion:4,decisionId:args.p_outcome==="accepted"?requestId:null,alreadyApplied:false}));
 });
 return{calls,run:(body:JsonValue)=>execute(new Request(url,{method:"POST",headers:{authorization:"Bearer header.staff.signature","content-type":"application/json"},body:JSON.stringify(body)}),{kind:"general-resolution",reportId:report,appealId:appeal})};
}
test("일반 이의 기각은 판정 입력 NULL과 전용 JWT RPC",async()=>{
 const {calls,run}=setup();const response=await run(base);assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"private, no-store");assert.equal(calls.length,1);assert.equal(calls[0].p_incident_outcome,null);assert.equal(calls[0].p_appeal_id,appeal);assert.equal(calls[0].p_outcome,"rejected");
 assert.deepEqual(reportOperatorRoute(new URL(url)),{kind:"general-resolution",reportId:report,appealId:appeal});
});
test("인용은 명시 정정만 전달하며 추가 actor/기각 판정 입력 거절",async()=>{
 const {calls,run}=setup();assert.equal((await run({...base,outcome:"accepted",appointmentOutcome:"normal",incidentOutcome:"invalidated",responsibleRole:"none",representativeReasonCode:"decision_corrected",violationClass:"none"})).status,200);
 assert.equal(calls[0].p_incident_outcome,"invalidated");assert.equal(Object.hasOwn(calls[0],"p_mode"),false);
 await assert.rejects(run({...base,actorId:uid}));await assert.rejects(run({...base,incidentOutcome:"invalidated"}));assert.equal(calls.length,1);
});
test("판정 누출/기각의 정정 ID/잘못된 버전 응답 거절",async()=>{
 const v={reportId:report,appealId:appeal,appealState:"rejected",reportVersion:4,decisionId:null,alreadyApplied:false};
 for(const bad of[{...v,raw:"private"},{...v,decisionId:requestId},{...v,reportVersion:5}])await assert.rejects(setup(bad).run(base));
});
