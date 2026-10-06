/** 민규: 배정 심사 HTTP 모형. 실제 DB 심사 검증과 구분한다. */
import {test} from "node:test";
import assert from "node:assert/strict";
import {createReportOperatorExecutor,reportOperatorRoute} from "../../../backend/supabase/functions/service-api/report-operator-http.ts";
import type {RuntimeConfig} from "../../../backend/supabase/functions/_shared/config/env.ts";
import type {JsonValue} from "../../../backend/supabase/functions/_shared/contracts/common.ts";
const uid="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",report="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",appeal="cccccccc-cccc-4ccc-8ccc-cccccccccccc",requestId="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const config={supabaseUrl:"https://example.test",supabaseAnonKey:"anon",maxRequestBytes:8192,upstreamTimeoutMs:1000,allowedOrigins:[]} as RuntimeConfig;
const url=`https://example.test/service-api/operator/reports/${report}/final-closures`;
const base={clientRequestId:requestId,expectedReportVersion:4,expectedIncidentRevision:2,resolutionSummary:"검토 종결"};
const value={reportId:report,status:"resolved",version:5,finalClosedAt:"2026-10-06T00:00:00Z",retentionDueAt:"2027-01-04T00:00:00Z",alreadyApplied:false};
function setup(result:JsonValue=value){let calls=0;const execute=createReportOperatorExecutor(config,async(input,init)=>{
 assert.equal(new Headers(init?.headers).get("authorization"),"Bearer header.staff.signature");
 if(String(input).endsWith("/auth/v1/user"))return new Response(JSON.stringify({id:uid,role:"authenticated",is_anonymous:false}));
 assert.equal(String(input),config.supabaseUrl+"/rest/v1/rpc/final_close_assigned_member_report");calls++;
 return new Response(JSON.stringify(result));});return{count:()=>calls,run:(body:JsonValue)=>execute(new Request(url,{method:"POST",headers:{authorization:"Bearer header.staff.signature","content-type":"application/json"},body:JSON.stringify(body)}),{kind:"final-closure",reportId:report})};}
test("종결 전용 JWT와 exact 입력 및 private 응답",async()=>{const s=setup();const response=await s.run(base);assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"private, no-store");assert.deepEqual(reportOperatorRoute(new URL(url)),{kind:"final-closure",reportId:report});await assert.rejects(s.run({...base,actorId:uid}));await assert.rejects(s.run({...base,resolutionSummary:" "+base.resolutionSummary}));assert.equal(s.count(),1);});
test("종결 보관 90일/버전/원문 누출 응답 거절",async()=>{for(const bad of[{...value,version:6},{...value,retentionDueAt:"2027-01-05T00:00:00Z"},{...value,raw:"secret"}])await assert.rejects(setup(bad).run(base));});
