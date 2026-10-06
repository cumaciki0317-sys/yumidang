/** 민규: 검증 principal·고정 직원 읽기/명시 검토 시작 transport. 실제 배정/세션/Storage 검증과 구분한다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRuntimeConfig } from "../../../backend/supabase/functions/_shared/config/env.ts";
import { requirePrincipal } from "../../../backend/supabase/functions/_shared/auth/principal.ts";
import { createReportOperatorClient } from "../../../backend/supabase/functions/_shared/db/report-operator-client.ts";
import { HttpError, toPublicError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
import type { JsonValue } from "../../../backend/supabase/functions/_shared/contracts/common.ts";
const uid="11111111-1111-4111-8111-111111111111",report="22222222-2222-4222-8222-222222222222",asset="33333333-3333-4333-8333-333333333333",object="44444444-4444-4444-8444-444444444444";
const env:Record<string,string>={SUPABASE_URL:"https://project.example.test",SUPABASE_ANON_KEY:"synthetic-anon",ALLOWED_ORIGINS:"[]",MAX_REQUEST_BYTES:"8192",UPSTREAM_TIMEOUT_MS:"1000"};
const config=loadRuntimeConfig(k=>env[k]),token="header.synthetic.signature";
const capture={reportId:report,assetId:asset,bucket:"report-evidence",path:`${uid}/${asset}.png`,objectId:object,mimeType:"image/png",byteSize:128};
const submission={reportId:report,targetType:"chat",context:"online",reasonCodes:["spam"],description:"회원이 직접 제출한 설명",assets:[capture]};
const principal=()=>requirePrincipal(new Request("https://example.invalid",{headers:{authorization:`Bearer ${token}`}}),config,async()=>new Response(JSON.stringify({id:uid,role:"authenticated",is_anonymous:false})));
test("위조 principal과 내부/판정/임의 RPC 차단",async()=>{
 assert.throws(()=>createReportOperatorClient(config,{userId:uid}),HttpError);
 const db=createReportOperatorClient(config,await principal(),async()=>assert.fail("network prohibited"));
 for(const name of["record_incident_revision","claim_member_cleanup_task","get_my_report","../private"])await assert.rejects(db.rpc(name,{}),HttpError);
});
test("원 JWT+anon key로 정확 배정 읽기 인수만 전송",async()=>{
 let count=0;const db=createReportOperatorClient(config,await principal(),async(url,init)=>{count++;assert.equal(url,"https://project.example.test/rest/v1/rpc/get_assigned_member_report");assert.equal(new Headers(init?.headers).get("authorization"),`Bearer ${token}`);assert.equal(new Headers(init?.headers).get("apikey"),"synthetic-anon");assert.deepEqual(JSON.parse(String(init?.body)),{p_report_id:report});return new Response(JSON.stringify(submission));});
 assert.deepEqual(await db.rpc("get_assigned_member_report",{p_report_id:report}),submission);
 for(const args of[{p_report_id:report,p_actor_id:uid},{p_report_id:"invalid"},{p_report_id:report,p_session_id:object}])await assert.rejects(db.rpc("get_assigned_member_report",args as unknown as Record<string,JsonValue>),HttpError);assert.equal(count,1);
});
test("제출 첨부 metadata만 정확 report/asset/object/bucket 범위로 확인",async()=>{
 const db=createReportOperatorClient(config,await principal(),async()=>new Response(JSON.stringify(capture)));
 assert.deepEqual(await db.rpc("get_assigned_report_capture",{p_report_id:report,p_asset_id:asset}),capture);
 for(const patch of[{reportId:uid},{assetId:uid},{bucket:"profile-images"},{path:`${uid}/other.png`},{mimeType:["image/png"]},{byteSize:5242881},{description:"타인 원문"},{objectId:null}]){
 const bad=createReportOperatorClient(config,await principal(),async()=>new Response(JSON.stringify({...capture,...patch})));await assert.rejects(bad.rpc("get_assigned_report_capture",{p_report_id:report,p_asset_id:asset}),HttpError);}
});
test("변형 보고서·rawchat·타인필드·중복첨부 거절",async()=>{
 for(const patch of[{chatHistory:"원본 대화"},{reporterId:uid},{reasonCodes:["unknown"]},{description:""},{assets:[capture,capture]},{assets:[{...capture,reportId:uid}]}]){const db=createReportOperatorClient(config,await principal(),async()=>new Response(JSON.stringify({...submission,...patch})));await assert.rejects(db.rpc("get_assigned_member_report",{p_report_id:report}),HttpError);}
});
test("DB 승인/배정/세션 거절은 원문 없는 실패이며 성공으로 변환하지 않는다",async()=>{
 for(const code of["42501","28000","PT404"]){const db=createReportOperatorClient(config,await principal(),async()=>new Response(JSON.stringify({code,message:"SELECT private.report_capture_assets",details:token}),{status:403}));
 await assert.rejects(db.rpc("get_assigned_member_report",{p_report_id:report}),(error:unknown)=>{const text=JSON.stringify(toPublicError(error));assert.equal(text.includes("SELECT"),false);assert.equal(text.includes(token),false);return true;});}
});

test("현재 검토 state3과 start5만 원 JWT+anon key로 정확한 인수 전송",async()=>{
 const p=await principal();let calls=0;
 const args={p_report_id:report,p_request_id:asset,p_expected_version:1};
 const state={reportId:report,status:"received",version:1};
 const started={reportId:report,status:"reviewing",version:2,holdId:object,alreadyApplied:false};
 const db=createReportOperatorClient(config,p,async(url,init)=>{
  calls++;assert.equal(new Headers(init?.headers).get("authorization"),`Bearer ${token}`);assert.equal(new Headers(init?.headers).get("apikey"),"synthetic-anon");
  if(calls===1){assert.equal(url,"https://project.example.test/rest/v1/rpc/get_assigned_report_review_state");assert.deepEqual(JSON.parse(String(init?.body)),{p_report_id:report});return new Response(JSON.stringify(state));}
  assert.equal(url,"https://project.example.test/rest/v1/rpc/start_assigned_report_review");assert.deepEqual(JSON.parse(String(init?.body)),args);return new Response(JSON.stringify(started));
 });
 assert.deepEqual(await db.rpc("get_assigned_report_review_state",{p_report_id:report}),state);
 assert.deepEqual(await db.rpc("start_assigned_report_review",args),started);assert.equal(calls,2);
});
test("현재 상태4종/MAX와 start 마지막 안전버전·NULL hold·멱등 receipt 허용",async()=>{
 for(const status of["received","reviewing","more_evidence","resolved"]){const value={reportId:report,status,version:Number.MAX_SAFE_INTEGER};const db=createReportOperatorClient(config,await principal(),async()=>new Response(JSON.stringify(value)));assert.deepEqual(await db.rpc("get_assigned_report_review_state",{p_report_id:report}),value);}
 for(const alreadyApplied of[false,true]){const value={reportId:report,status:"reviewing",version:Number.MAX_SAFE_INTEGER,holdId:null,alreadyApplied};const db=createReportOperatorClient(config,await principal(),async()=>new Response(JSON.stringify(value)));assert.deepEqual(await db.rpc("start_assigned_report_review",{p_report_id:report,p_request_id:asset,p_expected_version:Number.MAX_SAFE_INTEGER-1}),value);}
});
test("actor/identity/raw extras와 부정확한 version 입력은 transport 호출 전에 거절",async()=>{
 const db=createReportOperatorClient(config,await principal(),async()=>assert.fail("invalid input must not fetch"));
 for(const value of[0,-1,1.5,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER+1,NaN,Infinity,"1",null])await assert.rejects(db.rpc("start_assigned_report_review",{p_report_id:report,p_request_id:asset,p_expected_version:value} as Record<string,JsonValue>),(error:unknown)=>error instanceof HttpError&&toPublicError(error).error.code==="INVALID_REQUEST");
 for(const patch of[{p_actor_id:uid},{p_identity_id:uid},{p_message:"raw"},{p_request_id:"invalid"},{p_report_id:uid,p_target_id:report}] as Record<string,JsonValue>[])await assert.rejects(db.rpc("start_assigned_report_review",{p_report_id:report,p_request_id:asset,p_expected_version:1,...patch}),(error:unknown)=>error instanceof HttpError&&toPublicError(error).error.code==="INVALID_REQUEST");
 for(const patch of[{p_actor_id:uid},{p_expected_version:1},{p_session_id:object},{p_report_id:"invalid"}] as Record<string,JsonValue>[])await assert.rejects(db.rpc("get_assigned_report_review_state",{p_report_id:report,...patch}),(error:unknown)=>error instanceof HttpError&&toPublicError(error).error.code==="INVALID_REQUEST");
});
test("변형 state3/unsafe version/타인자료와 잘못된 start5는 성공으로 변환하지 않음",async()=>{
 const state={reportId:report,status:"reviewing",version:2};
 for(const patch of[{reportId:uid},{status:"complete"},{status:["reviewing"]},{version:0},{version:1.1},{version:Number.MAX_SAFE_INTEGER+1},{version:"2"},{actorId:uid},{rawReason:"raw"}]){const db=createReportOperatorClient(config,await principal(),async()=>new Response(JSON.stringify({...state,...patch})));await assert.rejects(db.rpc("get_assigned_report_review_state",{p_report_id:report}),(error:unknown)=>error instanceof HttpError&&toPublicError(error).error.code==="EXTERNAL_UNAVAILABLE");}
 const started={reportId:report,status:"reviewing",version:2,holdId:null,alreadyApplied:false};
 for(const patch of[{reportId:uid},{status:"resolved"},{version:1},{version:3},{version:Number.MAX_SAFE_INTEGER+1},{holdId:"bad"},{holdId:[]},{alreadyApplied:"false"},{actorId:uid}]){const db=createReportOperatorClient(config,await principal(),async()=>new Response(JSON.stringify({...started,...patch})));await assert.rejects(db.rpc("start_assigned_report_review",{p_report_id:report,p_request_id:asset,p_expected_version:1}),(error:unknown)=>error instanceof HttpError&&toPublicError(error).error.code==="EXTERNAL_UNAVAILABLE");}
});
test("새 read/start의 DB 권한·세션·충돌·만료 실패 원문은 노출하지 않음",async()=>{
 for(const name of["get_assigned_report_review_state","start_assigned_report_review"])for(const code of["42501","28000","PT404","40001","55000"]){const db=createReportOperatorClient(config,await principal(),async()=>new Response(JSON.stringify({code,message:"SELECT private.report_review_start_receipts",details:token}),{status:403}));const args:Record<string,JsonValue>=name==="start_assigned_report_review"?{p_report_id:report,p_request_id:asset,p_expected_version:1}:{p_report_id:report};await assert.rejects(db.rpc(name,args),(error:unknown)=>{const message=JSON.stringify(toPublicError(error));assert.equal(message.includes("SELECT"),false);assert.equal(message.includes(token),false);return true;});}
});

const decisionArgs:Record<string,JsonValue>={p_report_id:report,p_client_request_id:asset,p_mode:"initial",p_expected_report_version:2,p_expected_hold_version:1,p_expected_incident_revision:0,p_appointment_outcome:"no_show",p_incident_outcome:"confirmed",p_responsible_role:"companion",p_representative_reason_code:"no_show",p_violation_class:"none",p_violation_type:null};
const decision={reportId:report,status:"reviewing",version:3,decisionId:object,alreadyApplied:false};
test("현재 판정 state5·판정 typed12는 원 JWT와 정확 인수만 전송",async()=>{
 let calls=0;const state={reportId:report,status:"reviewing",version:2,holdVersion:1,incidentRevision:0};
 const db=createReportOperatorClient(config,await principal(),async(url,init)=>{
  calls++;assert.equal(new Headers(init?.headers).get("authorization"),`Bearer ${token}`);assert.equal(new Headers(init?.headers).get("apikey"),"synthetic-anon");
  if(calls===1){assert.equal(url,"https://project.example.test/rest/v1/rpc/get_assigned_report_adjudication_state");assert.deepEqual(JSON.parse(String(init?.body)),{p_report_id:report});return new Response(JSON.stringify(state));}
  assert.equal(url,"https://project.example.test/rest/v1/rpc/adjudicate_assigned_member_report");assert.deepEqual(JSON.parse(String(init?.body)),decisionArgs);return new Response(JSON.stringify(decision));
 });
 assert.deepEqual(await db.rpc("get_assigned_report_adjudication_state",{p_report_id:report}),state);
 assert.deepEqual(await db.rpc("adjudicate_assigned_member_report",decisionArgs),decision);assert.equal(calls,2);
});
test("유한 판정·정정 조합과 MAX 마지막 입력을 허용하며 피해자·감점 인수를 만들지 않음",async()=>{
 const choices:Record<string,JsonValue>[]=[
  {p_incident_outcome:"none",p_responsible_role:"none"},
  {p_appointment_outcome:"normal",p_incident_outcome:"none",p_responsible_role:"none",p_representative_reason_code:"no_action"},
  {p_appointment_outcome:"unchanged",p_expected_hold_version:null,p_incident_outcome:"none",p_responsible_role:"none",p_representative_reason_code:"no_action"},
  {p_mode:"correction",p_expected_incident_revision:1,p_incident_outcome:"invalidated",p_responsible_role:"none",p_representative_reason_code:"decision_corrected"},
 ];
 for(const type of["spam","rule_violation","sexual_harassment","threat","violence","stalking","privacy_exposure","sexual_exploitation"])choices.push({p_appointment_outcome:"normal",p_representative_reason_code:type,p_violation_class:["spam","rule_violation"].includes(type)?"minor":"major",p_violation_type:type});
 for(const patch of choices){const args={...decisionArgs,...patch};const db=createReportOperatorClient(config,await principal(),async()=>new Response(JSON.stringify(decision)));assert.deepEqual(await db.rpc("adjudicate_assigned_member_report",args),decision);}
 const args={...decisionArgs,p_expected_report_version:Number.MAX_SAFE_INTEGER-1};const result={...decision,version:Number.MAX_SAFE_INTEGER,alreadyApplied:true};const db=createReportOperatorClient(config,await principal(),async()=>new Response(JSON.stringify(result)));assert.deepEqual(await db.rpc("adjudicate_assigned_member_report",args),result);
});
test("판정 임의 actor/원장·불완전/null/문자열 coercion·상충 책임 조합을 fetch 전 차단",async()=>{
 const db=createReportOperatorClient(config,await principal(),async()=>assert.fail("invalid adjudication must not fetch"));
 const patches:Record<string,JsonValue>[]=[{p_actor_id:uid},{p_identity_id:uid},{p_source_episode_id:uid},{p_victim_id:uid},{p_penalty:10},{p_deadline:"tomorrow"},{p_mode:"unknown"},{p_mode:["initial"]},{p_expected_report_version:"2"},{p_expected_report_version:Number.MAX_SAFE_INTEGER},{p_expected_hold_version:0},{p_expected_incident_revision:-1},{p_expected_incident_revision:Number.MAX_SAFE_INTEGER},{p_appointment_outcome:null},{p_incident_outcome:"other"},{p_responsible_role:"target"},{p_responsible_role:"none"},{p_expected_hold_version:null},{p_representative_reason_code:"no_action"},{p_violation_class:"minor",p_violation_type:"threat",p_representative_reason_code:"threat"},{p_violation_class:"major",p_violation_type:"spam",p_representative_reason_code:"spam"},{p_violation_type:[]},{p_incident_outcome:"invalidated"},{p_mode:"initial",p_expected_incident_revision:1}];
 for(const patch of patches)await assert.rejects(db.rpc("adjudicate_assigned_member_report",{...decisionArgs,...patch}),(e:unknown)=>e instanceof HttpError&&toPublicError(e).error.code==="INVALID_REQUEST");
 for(const key of Object.keys(decisionArgs)){const args={...decisionArgs};delete args[key];await assert.rejects(db.rpc("adjudicate_assigned_member_report",args),HttpError);}
});
test("판정 state5와 receipt5는 원문/타인/unsafe 버전/틀린 결정 반환을 거절",async()=>{
 const state={reportId:report,status:"reviewing",version:2,holdVersion:1,incidentRevision:0};
 for(const patch of[{reportId:uid},{status:["reviewing"]},{version:0},{version:Number.MAX_SAFE_INTEGER+1},{holdVersion:0},{holdVersion:"1"},{incidentRevision:-1},{incidentRevision:"0"},{incidentRevision:Number.MAX_SAFE_INTEGER+1},{incidentId:uid},{rawReason:"raw"}]){const db=createReportOperatorClient(config,await principal(),async()=>new Response(JSON.stringify({...state,...patch})));await assert.rejects(db.rpc("get_assigned_report_adjudication_state",{p_report_id:report}),HttpError);}
 for(const patch of[{reportId:uid},{status:"resolved"},{version:2},{version:4},{decisionId:"invalid"},{alreadyApplied:"false"},{sourceEpisodeId:uid}]){const db=createReportOperatorClient(config,await principal(),async()=>new Response(JSON.stringify({...decision,...patch})));await assert.rejects(db.rpc("adjudicate_assigned_member_report",decisionArgs),HttpError);}
 for(const status of["received","reviewing","more_evidence","resolved"]){const value={...state,status,version:Number.MAX_SAFE_INTEGER,holdVersion:null,incidentRevision:Number.MAX_SAFE_INTEGER};const db=createReportOperatorClient(config,await principal(),async()=>new Response(JSON.stringify(value)));assert.deepEqual(await db.rpc("get_assigned_report_adjudication_state",{p_report_id:report}),value);}
});
test("판정 DB 충돌·통지근거미정·권한실패는 성공이나 private 원문으로 변환하지 않음",async()=>{
 for(const code of["42501","28000","PT404","40001","55000"]){const db=createReportOperatorClient(config,await principal(),async()=>new Response(JSON.stringify({code,message:"SELECT private.safety_incidents",details:token}),{status:403}));await assert.rejects(db.rpc("adjudicate_assigned_member_report",decisionArgs),(e:unknown)=>{const text=JSON.stringify(toPublicError(e));assert.equal(text.includes("SELECT"),false);assert.equal(text.includes(token),false);return true;});}
});

const resolutionArgs={p_report_id:report,p_appeal_id:asset,p_client_request_id:object,p_mode:"initial",p_expected_report_version:1,p_expected_result_revision:3,p_expected_incident_revision:0,p_outcome:"accepted"};
const resolutionValue={reportId:report,appealId:asset,decisionId:object,reportVersion:2,resultRevision:4,appealState:"accepted",alreadyApplied:false};
test("취소 이의 직원 state6/resolve8 원 JWT·exact7과 원 receipt 재생",async()=>{
 const state={reportId:report,appealId:asset,reportVersion:1,resultRevision:3,incidentRevision:0,appealState:"reviewing"};let n=0;
 const db=createReportOperatorClient(config,await principal(),async(url,init)=>{n++;assert.equal(new Headers(init?.headers).get("authorization"),`Bearer ${token}`);assert.equal(new Headers(init?.headers).get("apikey"),"synthetic-anon");
  if(n===1){assert.ok(String(url).endsWith("/get_assigned_appointment_cancel_appeal_resolution_state"));assert.deepEqual(JSON.parse(String(init?.body)),{p_report_id:report,p_appeal_id:asset});return new Response(JSON.stringify(state));}
  assert.ok(String(url).endsWith("/resolve_assigned_appointment_cancel_appeal"));assert.deepEqual(JSON.parse(String(init?.body)),resolutionArgs);return new Response(JSON.stringify({...resolutionValue,alreadyApplied:n===3}));});
 assert.deepEqual(await db.rpc("get_assigned_appointment_cancel_appeal_resolution_state",{p_report_id:report,p_appeal_id:asset}),state);
 assert.deepEqual(await db.rpc("resolve_assigned_appointment_cancel_appeal",resolutionArgs),resolutionValue);assert.deepEqual(await db.rpc("resolve_assigned_appointment_cancel_appeal",resolutionArgs),{...resolutionValue,alreadyApplied:true});assert.equal(n,3);
});
test("취소 해소 correction/기존 incident/MAX 경계와 현재 accepted/rejected 상태",async()=>{
 for(const state of["reviewing","accepted","rejected"]){const v={reportId:report,appealId:asset,reportVersion:Number.MAX_SAFE_INTEGER,resultRevision:Number.MAX_SAFE_INTEGER,incidentRevision:Number.MAX_SAFE_INTEGER,appealState:state};const db=createReportOperatorClient(config,await principal(),async()=>new Response(JSON.stringify(v)));assert.deepEqual(await db.rpc("get_assigned_appointment_cancel_appeal_resolution_state",{p_report_id:report,p_appeal_id:asset}),v);}
 const args={...resolutionArgs,p_mode:"correction",p_outcome:"rejected",p_expected_report_version:Number.MAX_SAFE_INTEGER-1,p_expected_result_revision:Number.MAX_SAFE_INTEGER-1,p_expected_incident_revision:1};
 const v={...resolutionValue,reportVersion:Number.MAX_SAFE_INTEGER,resultRevision:Number.MAX_SAFE_INTEGER,appealState:"rejected"};const db=createReportOperatorClient(config,await principal(),async()=>new Response(JSON.stringify(v)));assert.deepEqual(await db.rpc("resolve_assigned_appointment_cancel_appeal",args),v);
});
test("취소 해소 입력 actor/time/identity/raw 및 부정확한 CAS는 fetch 전 거절",async()=>{
 const db=createReportOperatorClient(config,await principal(),async()=>assert.fail("invalid input fetch"));
 for(const patch of[{p_actor_id:uid},{p_identity_id:uid},{p_penalty:2},{p_received_at:"now"},{p_outcome:["accepted"]},{p_mode:"auto"},{p_appeal_id:"bad"},{p_expected_result_revision:Number.MAX_SAFE_INTEGER},{p_expected_report_version:"1"},{p_expected_incident_revision:-1},{p_expected_incident_revision:Number.MAX_SAFE_INTEGER}])await assert.rejects(db.rpc("resolve_assigned_appointment_cancel_appeal",{...resolutionArgs,...patch} as unknown as Record<string,JsonValue>),HttpError);
 await assert.rejects(db.rpc("get_assigned_appointment_cancel_appeal_resolution_state",{p_report_id:report,p_appeal_id:asset,p_actor_id:uid}),HttpError);
});
test("취소 해소 malformed upstream·타인자료·wrongoutcome/version 실패 및 DB 오류 원문 비공개",async()=>{
 for(const patch of[{reportId:uid},{appealId:uid},{decisionId:null},{reportVersion:3},{resultRevision:3},{appealState:"rejected"},{alreadyApplied:"true"},{rawEvidence:"raw"}]){const db=createReportOperatorClient(config,await principal(),async()=>new Response(JSON.stringify({...resolutionValue,...patch})));await assert.rejects(db.rpc("resolve_assigned_appointment_cancel_appeal",resolutionArgs),HttpError);}
 for(const code of["40001","PT404","42501","28000","55000"]){const db=createReportOperatorClient(config,await principal(),async()=>new Response(JSON.stringify({code,message:"private raw evidence",details:token}),{status:400}));await assert.rejects(db.rpc("resolve_assigned_appointment_cancel_appeal",resolutionArgs),(e:unknown)=>{assert.ok(!JSON.stringify(toPublicError(e)).includes(token));assert.ok(!JSON.stringify(toPublicError(e)).includes("raw evidence"));return e instanceof HttpError;});}
});
