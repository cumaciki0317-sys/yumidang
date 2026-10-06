/** 민규: HTTP 모형 회귀다. 실제 직원 승인·배정·Storage 검증과 구분한다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createReportOperatorExecutor, reportOperatorRoute, MAX_REPORT_CAPTURE_BYTES, type ReportOperatorRoute } from "../../../backend/supabase/functions/service-api/report-operator-http.ts";
import { createServiceApi } from "../../../backend/supabase/functions/service-api/handler.ts";
import { toPublicError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
import type { RuntimeConfig } from "../../../backend/supabase/functions/_shared/config/env.ts";
import type { FetchLike } from "../../../backend/supabase/functions/_shared/db/transport.ts";
const uid="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",reportId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",assetId="cccccccc-cccc-4ccc-8ccc-cccccccccccc",objectId="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const api="https://project.example.test",token="header.staff_verified.signature";
const config={supabaseUrl:api,supabaseAnonKey:"public-anon",supabaseServiceRoleKey:"private-service",internalWorkerSecret:"private-internal",maxRequestBytes:8192,upstreamTimeoutMs:1000} as RuntimeConfig;
const jpeg=new Uint8Array([255,216,255,224,0,255,217]);
const png=new Uint8Array([137,80,78,71,13,10,26,10,1]);
const webp=new Uint8Array([82,73,70,70,5,0,0,0,87,69,66,80,1]);
const route:ReportOperatorRoute={kind:"capture",reportId,assetId};
const metadata=(type="image/jpeg",size=jpeg.length)=>({reportId,assetId,bucket:"report-evidence",path:uid+"/"+assetId+({"image/jpeg":".jpg","image/png":".png","image/webp":".webp"} as Record<string,string>)[type],objectId,mimeType:type,byteSize:size});
const request=(suffix="",init:RequestInit={})=>new Request("https://api.example.test/service-api/operator/reports/"+reportId+"/captures/"+assetId+suffix,{headers:{authorization:"Bearer "+token},...init});
type Options={authStatus?:number;firstStatus?:number;secondStatus?:number;getStatus?:number;headStatus?:number;body?:Uint8Array;mime?:string;declared?:string;meta?:Record<string,unknown>;changed?:Record<string,unknown>;report?:unknown;review?:unknown;reviewStatus?:number;reviewCode?:string;adjudication?:unknown;adjudicationStatus?:number;adjudicationCode?:string;resolution?:unknown;resolutionStatus?:number;resolutionCode?:string};
function scenario(o:Options={}) {
 const calls:Array<{url:string;method:string;headers:Headers;body?:string}>=[];let refs=0;
 const meta={...metadata(o.mime??"image/jpeg",o.body?.length??jpeg.length),...o.meta};
 const fetcher:FetchLike=async(input,init={})=>{
  const url=String(input),headers=new Headers(init.headers);calls.push({url,method:init.method??"GET",headers,body:typeof init.body==="string"?init.body:undefined});
  assert.equal(headers.get("authorization"),"Bearer "+token);assert.equal(headers.get("apikey"),"public-anon");
  if(url===api+"/auth/v1/user")return new Response(JSON.stringify({id:uid,role:"authenticated",is_anonymous:false}),{status:o.authStatus??200});
  if(url===api+"/rest/v1/rpc/get_assigned_member_report") {
   assert.deepEqual(JSON.parse(String(init.body)),{p_report_id:reportId});
   return new Response(JSON.stringify(o.report??{reportId,targetType:"chat",context:"online",reasonCodes:["threat"],description:"직접 제출한 신고 내용",assets:[meta]}),{status:o.firstStatus??200});
  }
  if(url===api+"/rest/v1/rpc/get_assigned_appointment_cancel_appeal_resolution_state" || url===api+"/rest/v1/rpc/resolve_assigned_appointment_cancel_appeal") {
   const start=url.endsWith("/resolve_assigned_appointment_cancel_appeal"),args=JSON.parse(String(init.body));
   assert.equal(args.p_report_id,reportId);assert.equal(args.p_appeal_id,assetId);
   if(start){assert.deepEqual(Object.keys(args).sort(),["p_report_id","p_appeal_id","p_client_request_id","p_mode","p_expected_report_version","p_expected_result_revision","p_expected_incident_revision","p_outcome"].sort());assert.equal(args.p_client_request_id,uid);}else assert.deepEqual(args,{p_report_id:reportId,p_appeal_id:assetId});
   return new Response(JSON.stringify(o.resolutionStatus&&o.resolutionStatus!==200?{code:o.resolutionCode??"42501",message:"private rejection"}:o.resolution??(start?{reportId,appealId:assetId,decisionId:objectId,reportVersion:Number(args.p_expected_report_version)+1,resultRevision:Number(args.p_expected_result_revision)+1,appealState:args.p_outcome,alreadyApplied:false}:{reportId,appealId:assetId,reportVersion:2,resultRevision:3,incidentRevision:0,appealState:"reviewing"})),{status:o.resolutionStatus??200});
  }
  if(url===api+"/rest/v1/rpc/get_assigned_report_adjudication_state" || url===api+"/rest/v1/rpc/adjudicate_assigned_member_report") {
   const start=url.endsWith("adjudicate_assigned_member_report");
   const args=JSON.parse(String(init.body));
   assert.equal(args.p_report_id,reportId);
   if(start){assert.deepEqual(Object.keys(args).sort(),["p_report_id","p_client_request_id","p_mode","p_expected_report_version","p_expected_hold_version","p_expected_incident_revision","p_appointment_outcome","p_incident_outcome","p_responsible_role","p_representative_reason_code","p_violation_class","p_violation_type"].sort());assert.equal(args.p_client_request_id,assetId);}else assert.deepEqual(args,{p_report_id:reportId});
   return new Response(JSON.stringify(o.adjudicationStatus&&o.adjudicationStatus!==200?{code:o.adjudicationCode??"42501",message:"private rejection"}:o.adjudication??(start?{reportId,status:"reviewing",version:Number(args.p_expected_report_version)+1,decisionId:objectId,alreadyApplied:false}:{reportId,status:"reviewing",version:2,holdVersion:1,incidentRevision:0})),{status:o.adjudicationStatus??200});
  }
  if(url===api+"/rest/v1/rpc/get_assigned_report_review_state" || url===api+"/rest/v1/rpc/start_assigned_report_review") {
   const start=url.endsWith("start_assigned_report_review");
   assert.deepEqual(JSON.parse(String(init.body)),start?{p_report_id:reportId,p_request_id:assetId,p_expected_version:1}:{p_report_id:reportId});
   return new Response(JSON.stringify(o.reviewStatus&&o.reviewStatus!==200?{code:o.reviewCode??"42501",message:"private rejection"}:o.review??(start?{reportId,status:"reviewing",version:2,holdId:null,alreadyApplied:false}:{reportId,status:"received",version:1})),{status:o.reviewStatus??200});
  }
  if(url===api+"/rest/v1/rpc/get_assigned_report_capture") {
   assert.deepEqual(JSON.parse(String(init.body)),{p_report_id:reportId,p_asset_id:assetId});refs++;
   const status=(refs===1?o.firstStatus:o.secondStatus)??200;
   return new Response(JSON.stringify(status===200?(refs===1?meta:{...meta,...o.changed}):{code:"42501",message:"private rejection"}),{status});
  }
  assert.equal(url,api+"/storage/v1/object/authenticated/report-evidence/"+meta.path);
  assert.equal(init.cache,"no-store");assert.equal(init.redirect,"error");
  if(init.method==="HEAD")return new Response(null,{status:o.headStatus??200});
  return new Response(new Uint8Array(o.body??jpeg).buffer,{status:o.getStatus??200,headers:{"content-type":o.mime??"image/jpeg","content-length":o.declared??String((o.body??jpeg).length),"etag":"upstream-secret","set-cookie":"upstream-secret","cache-control":"public,max-age=600","location":"https://forbidden.example/"}});
 };
 return{run:createReportOperatorExecutor(config,fetcher),calls};
}
async function denied(s:ReturnType<typeof scenario>,code:string,req=request(),r:ReportOperatorRoute=route) {
 await assert.rejects(()=>s.run(req,r),e=>toPublicError(e).error.code===code);
}
test("assigned capture authenticates, uses dedicated RPC twice, GET and HEAD with same JWT",async()=>{
 const s=scenario(),r=await s.run(request(),route);assert.equal(r.status,200);assert.deepEqual(new Uint8Array(await r.arrayBuffer()),jpeg);
 assert.deepEqual(s.calls.map(c=>c.method),["GET","POST","GET","POST","HEAD"]);
 assert.equal(r.headers.get("cache-control"),"private, no-store");assert.equal(r.headers.get("vary"),"Authorization, Origin");assert.match(r.headers.get("x-request-id")??"",/^[a-f0-9-]{36}$/);
 for(const key of["etag","set-cookie","location","last-modified"])assert.equal(r.headers.get(key),null);
});
test("report metadata only invokes get_assigned_member_report with dedicated original JWT",async()=>{
 const s=scenario(),requestId="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",r=await s.run(request(),{kind:"report",reportId},{requestId});assert.equal(r.status,200);
 const envelope=await r.json();assert.deepEqual(Object.keys(envelope).sort(),["data","requestId"]);assert.equal(envelope.data.reportId,reportId);assert.equal(envelope.requestId,requestId);assert.equal(r.headers.get("x-request-id"),requestId);
 assert.equal(r.headers.get("cache-control"),"private, no-store");assert.equal(s.calls.length,2);
});
test("assignment revoked after fetched bytes prevents HEAD and response",async()=>{
 const s=scenario({secondStatus:403});await denied(s,"ACCESS_DENIED");assert.equal(s.calls.length,4);
});
test("changed object or metadata after fetched bytes discards bytes",async()=>{
 for(const changed of[{objectId:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"},{byteSize:jpeg.length+1},{path:reportId+"/"+assetId+".jpg"}]) {
  const s=scenario({changed});await denied(s,"RESOURCE_NOT_FOUND");assert.equal(s.calls.length,4);
 }
});
test("HEAD authorization revoked discards bytes after exact metadata recheck",async()=>{
 const s=scenario({headStatus:403});await denied(s,"RESOURCE_NOT_FOUND");assert.equal(s.calls.length,5);
});
test("staff denied first RPC never fetches Storage and never uses member alias",async()=>{
 const s=scenario({firstStatus:403});await denied(s,"ACCESS_DENIED");assert.equal(s.calls.length,2);
 assert.ok(s.calls.every(c=>!c.url.includes("get_my_report")&&!c.url.includes("get_report_capture")));
});
test("Auth refusal and anonymous/internal/service credentials never fall back",async()=>{
 const s=scenario({authStatus:401});await denied(s,"AUTH_REQUIRED");assert.equal(s.calls.length,1);
 for(const secret of["private-service","private-internal","public-anon"]){const x=scenario();await denied(x,"AUTH_REQUIRED",request("",{headers:{authorization:"Bearer "+secret}}));assert.equal(x.calls.length,0);}
});
test("PNG JPEG WebP MIME and magic accepted without decoder or raw chat collection",async()=>{
 for(const [mime,body]of[["image/jpeg",jpeg],["image/png",png],["image/webp",webp]]as const){const s=scenario({mime,body});const r=await s.run(request(),route);assert.deepEqual(new Uint8Array(await r.arrayBuffer()),body);assert.equal(r.headers.get("content-type"),mime);}
});
test("size MIME extension magic declared lengths and unsafe metadata fail closed",async()=>{
 for(const o of[{body:new Uint8Array([1,2,3,4,5])},{declared:"999"},{declared:"invalid"},{body:new Uint8Array(MAX_REPORT_CAPTURE_BYTES+1)},{meta:{path:"../secret"}},{meta:{bucket:"profile-images"}},{meta:{mimeType:"image/png"}},{meta:{byteSize:0}}]) {
  const s=scenario(o);await denied(s,"EXTERNAL_UNAVAILABLE");assert.ok(s.calls.length<=3);
 }
});
test("method query hash range malformed ids and missing auth reject before upstream",async()=>{
 const s=scenario();for(const suffix of["?token=secret","#secret"])await denied(s,"INVALID_REQUEST",request(suffix));
 await denied(s,"METHOD_NOT_ALLOWED",request("",{method:"POST"}));await denied(s,"INVALID_REQUEST",request("",{headers:{authorization:"Bearer "+token,range:"bytes=0-1"}}));
 await denied(s,"INVALID_REQUEST",request(),{kind:"capture",reportId:"../report",assetId});await denied(s,"AUTH_REQUIRED",request("",{headers:{}}));assert.equal(s.calls.length,0);
});
test("Storage denial, provider failure and aborted request cannot publish bytes",async()=>{
 for(const status of[400,401,403,404]){const s=scenario({getStatus:status});await denied(s,"RESOURCE_NOT_FOUND");assert.equal(s.calls.length,3);}
 for(const o of[{getStatus:503},{headStatus:503}])await denied(scenario(o),"EXTERNAL_UNAVAILABLE");
 const controller=new AbortController();controller.abort();const s=scenario();await denied(s,"EXTERNAL_UNAVAILABLE",request("",{signal:controller.signal}));assert.equal(s.calls.length,0);
});
test("client conditional headers never create304 or skip authorization",async()=>{
 const s=scenario();const r=await s.run(request("",{headers:{authorization:"Bearer "+token,"if-none-match":"secret","if-modified-since":"date"}}),route);assert.equal(r.status,200);
 for(const c of s.calls){assert.equal(c.headers.get("if-none-match"),null);assert.equal(c.headers.get("if-modified-since"),null);}
});
test("route matches only fixed service-api report and capture paths",()=>{
 for(const prefix of["/service-api/operator/reports/","/functions/v1/service-api/operator/reports/"]){assert.deepEqual(reportOperatorRoute(new URL("https://x.example"+prefix+reportId)),{kind:"report",reportId});assert.deepEqual(reportOperatorRoute(new URL("https://x.example"+prefix+reportId+"/captures/"+assetId)),route);}
 for(const path of["/operator/reports/"+reportId,"/service-api/operator/reports/"+reportId+"/captures/"+assetId+"/extra"])assert.equal(reportOperatorRoute(new URL("https://x.example"+path)),null);
});

function connected(s:ReturnType<typeof scenario>) {
 return createServiceApi({allowedOrigins:["https://app.example.test"],maxBodyBytes:8192,reportOperator:{execute:s.run},
 authenticateUser:async()=>assert.fail("operator must not use generic member client"),authenticateInternal:async()=>assert.fail("operator must not use internal client")});
}
test("service-api operator metadata retains JSON envelope same server requestId and CORS",async()=>{
 const s=scenario(),run=connected(s),r=await run(new Request("https://api.example.test/functions/v1/service-api/operator/reports/"+reportId,{headers:{authorization:"Bearer "+token,origin:"https://app.example.test"}}));
 assert.equal(r.status,200);const envelope=await r.json();assert.equal(envelope.data.reportId,reportId);assert.equal(envelope.requestId,r.headers.get("x-request-id"));
 assert.equal(r.headers.get("access-control-allow-origin"),"https://app.example.test");assert.equal(r.headers.get("cache-control"),"private, no-store");
 assert.ok(r.headers.get("vary")?.includes("Authorization"));assert.ok(r.headers.get("vary")?.includes("Origin"));assert.equal(s.calls.length,2);
});
test("service-api capture routes return bytes and same server context through dedicated executor",async()=>{
 const s=scenario(),r=await connected(s)(request("",{headers:{authorization:"Bearer "+token,origin:"https://app.example.test"}}));
 assert.equal(r.status,200);assert.deepEqual(new Uint8Array(await r.arrayBuffer()),jpeg);assert.match(r.headers.get("x-request-id")??"",/^[0-9a-f-]{36}$/);
 assert.equal(r.headers.get("access-control-allow-origin"),"https://app.example.test");assert.ok(r.headers.get("vary")?.includes("Authorization"));
});
test("service-api operator revocation error keeps JSON envelope no-store and hides raw provider message",async()=>{
 const s=scenario({secondStatus:403}),r=await connected(s)(request());assert.equal(r.status,403);const envelope=await r.json();
 assert.equal(envelope.error.code,"ACCESS_DENIED");assert.equal(envelope.requestId,r.headers.get("x-request-id"));assert.equal(r.headers.get("cache-control"),"no-store");
 assert.ok(!JSON.stringify(envelope).includes("private rejection"));assert.equal(s.calls.length,4);
});
test("operator CORS rejection and preflight do not authenticate or call RPC",async()=>{
 const s=scenario(),run=connected(s);
 const refused=await run(request("",{headers:{authorization:"Bearer "+token,origin:"https://forbidden.example"}}));assert.equal(refused.status,403);assert.equal(s.calls.length,0);
 const preflight=await run(request("",{method:"OPTIONS",headers:{origin:"https://app.example.test","access-control-request-method":"GET","access-control-request-headers":"authorization"}}));
 assert.equal(preflight.status,204);assert.equal(s.calls.length,0);assert.equal(preflight.headers.get("access-control-allow-origin"),"https://app.example.test");
});

const reviewRequest=(body:unknown={clientRequestId:assetId,expectedVersion:1},init:RequestInit={})=>new Request("https://api.example.test/service-api/operator/reports/"+reportId+"/review/start",{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify(body),...init});
test("review routes use exact paths and independent server request ID",async()=>{
 assert.deepEqual(reportOperatorRoute(new URL("https://x.example/service-api/operator/reports/"+reportId+"/review-state")),{kind:"review-state",reportId});
 assert.deepEqual(reportOperatorRoute(new URL("https://x.example/functions/v1/service-api/operator/reports/"+reportId+"/review/start")),{kind:"review-start",reportId});
 assert.equal(reportOperatorRoute(new URL("https://x.example/service-api/operator/reports/"+reportId+"/review/start/extra")),null);
 const s=scenario(),context={requestId:objectId},r=await s.run(reviewRequest(),{kind:"review-start",reportId},context),envelope=await r.json();
 assert.deepEqual(envelope,{data:{reportId,status:"reviewing",version:2,holdId:null,alreadyApplied:false},requestId:objectId});assert.equal(r.headers.get("x-request-id"),objectId);assert.notEqual(objectId,assetId);assert.equal(s.calls.length,2);
});
test("fresh review state stays separate from unchanged report metadata",async()=>{
 const s=scenario(),r=await s.run(new Request("https://x.example/service-api/operator/reports/"+reportId+"/review-state",{headers:{authorization:"Bearer "+token}}),{kind:"review-state",reportId});
 assert.deepEqual((await r.json()).data,{reportId,status:"received",version:1});assert.equal(s.calls.length,2);
});
test("review start rejects coercions extras unsafe versions and malformed keys before Auth",async()=>{
 for(const body of[null,[],{}, {clientRequestId:assetId,expectedVersion:"1"},{clientRequestId:assetId,expectedVersion:0},{clientRequestId:assetId,expectedVersion:1.5},{clientRequestId:assetId,expectedVersion:Number.MAX_SAFE_INTEGER},{clientRequestId:assetId,expectedVersion:1,actorId:uid},{clientRequestId:"invalid",expectedVersion:1}]) {
  const s=scenario();await denied(s,"INVALID_REQUEST",reviewRequest(body),{kind:"review-start",reportId});assert.equal(s.calls.length,0);
 }
 const s=scenario();await denied(s,"UNSUPPORTED_MEDIA_TYPE",reviewRequest(undefined,{headers:{authorization:"Bearer "+token,"content-type":"text/plain"}}),{kind:"review-start",reportId});assert.equal(s.calls.length,0);
 await denied(s,"PAYLOAD_TOO_LARGE",reviewRequest({clientRequestId:assetId,expectedVersion:1,padding:"x".repeat(8192)}),{kind:"review-start",reportId});
});
test("review result rejects extra identity fields unsafe versions and mismatched reports",async()=>{
 for(const review of[{reportId,status:"reviewing",version:2,holdId:null,alreadyApplied:false,actorId:uid},{reportId,status:"reviewing",version:Number.MAX_SAFE_INTEGER+1,holdId:null,alreadyApplied:false},{reportId:uid,status:"reviewing",version:2,holdId:null,alreadyApplied:false},{reportId,status:"received",version:2,holdId:null,alreadyApplied:false}])await denied(scenario({review}),"EXTERNAL_UNAVAILABLE",reviewRequest(),{kind:"review-start",reportId});
});
test("review replay preserves original result and conflict denies without fallback",async()=>{
 const s=scenario({review:{reportId,status:"reviewing",version:2,holdId:objectId,alreadyApplied:true}}),r=await s.run(reviewRequest(),{kind:"review-start",reportId});assert.equal((await r.json()).data.alreadyApplied,true);
 await denied(scenario({reviewStatus:409,reviewCode:"40001"}),"STATE_CONFLICT",reviewRequest(),{kind:"review-start",reportId});
});

const adjudicationBody={clientRequestId:assetId,mode:"initial",expectedReportVersion:2,expectedHoldVersion:1,expectedIncidentRevision:0,appointmentOutcome:"normal",incidentOutcome:"none",responsibleRole:"none",representativeReasonCode:"no_action",violationClass:"none",violationType:null};
const adjudicationRequest=(body:unknown=adjudicationBody,init:RequestInit={})=>new Request("https://api.example.test/service-api/operator/reports/"+reportId+"/adjudications",{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify(body),...init});
const adjudicationRoute:ReportOperatorRoute={kind:"adjudication",reportId};
test("adjudication routes and exact twelve RPC args retain independent response context",async()=>{
 for(const prefix of["/service-api/operator/reports/","/functions/v1/service-api/operator/reports/"]){assert.deepEqual(reportOperatorRoute(new URL("https://x.example"+prefix+reportId+"/adjudications")),adjudicationRoute);assert.deepEqual(reportOperatorRoute(new URL("https://x.example"+prefix+reportId+"/adjudication-state")),{kind:"adjudication-state",reportId});}
 const s=scenario(),r=await s.run(adjudicationRequest(),adjudicationRoute,{requestId:uid});assert.equal(r.status,200);assert.deepEqual(await r.json(),{data:{reportId,status:"reviewing",version:3,decisionId:objectId,alreadyApplied:false},requestId:uid});assert.equal(r.headers.get("x-request-id"),uid);assert.equal(r.headers.get("cache-control"),"private, no-store");assert.equal(s.calls.length,2);
 const args=JSON.parse(s.calls[1].body!);for(const [key,value]of Object.entries(adjudicationBody)){const sqlKey="p_"+key.replace(/[A-Z]/g,c=>"_"+c.toLowerCase());assert.equal(args[sqlKey],value);}
});
test("adjudication state is separate exact five keys and accepts safe final versions",async()=>{
 const s=scenario({adjudication:{reportId,status:"reviewing",version:Number.MAX_SAFE_INTEGER,holdVersion:null,incidentRevision:Number.MAX_SAFE_INTEGER}}),r=await s.run(new Request("https://x.example/service-api/operator/reports/"+reportId+"/adjudication-state",{headers:{authorization:"Bearer "+token}}),{kind:"adjudication-state",reportId});assert.deepEqual(Object.keys((await r.json()).data).sort(),["reportId","status","version","holdVersion","incidentRevision"].sort());
});
test("mock supported decision and correction combinations pass exact decoder",async()=>{
 const bodies:Array<Record<string,unknown>>=[adjudicationBody,{...adjudicationBody,appointmentOutcome:"no_show",representativeReasonCode:"no_show"},{...adjudicationBody,appointmentOutcome:"no_show",incidentOutcome:"confirmed",responsibleRole:"both",representativeReasonCode:"no_show"},{...adjudicationBody,mode:"correction",expectedIncidentRevision:1,incidentOutcome:"invalidated",representativeReasonCode:"decision_corrected"}];
 for(const [violationClass,types]of[["minor",["spam","rule_violation"]],["major",["sexual_harassment","threat","violence","stalking","privacy_exposure","sexual_exploitation"]]]as const)for(const violationType of types)bodies.push({...adjudicationBody,appointmentOutcome:"unchanged",expectedHoldVersion:null,incidentOutcome:"confirmed",responsibleRole:"target",violationClass,violationType,representativeReasonCode:violationType});
 for(const body of bodies){const s=scenario();assert.equal((await s.run(adjudicationRequest(body),adjudicationRoute)).status,200);assert.equal(s.calls.length,2);}
});
test("adjudication missing null extras identities enum coercions and invalid matrix deny before Auth",async()=>{
 const missing={...adjudicationBody}as Record<string,unknown>;delete missing.violationType;
 for(const body of[missing,{...adjudicationBody,actorId:uid},{...adjudicationBody,identityId:uid},{...adjudicationBody,subjects:[]},{...adjudicationBody,appealDeadline:"2030-01-01"},{...adjudicationBody,mode:["initial"]},{...adjudicationBody,mode:"unknown"},{...adjudicationBody,expectedReportVersion:"2"},{...adjudicationBody,expectedReportVersion:Number.MAX_SAFE_INTEGER},{...adjudicationBody,expectedHoldVersion:0},{...adjudicationBody,expectedIncidentRevision:-1},{...adjudicationBody,expectedIncidentRevision:Number.MAX_SAFE_INTEGER},{...adjudicationBody,appointmentOutcome:"no_show"},{...adjudicationBody,incidentOutcome:"invalidated",representativeReasonCode:"decision_corrected"},{...adjudicationBody,incidentOutcome:"confirmed",responsibleRole:"none",violationClass:"major",violationType:"threat",representativeReasonCode:"threat"},{...adjudicationBody,incidentOutcome:"confirmed",responsibleRole:"target",violationClass:"minor",violationType:"threat",representativeReasonCode:"threat"},{...adjudicationBody,incidentOutcome:"confirmed",responsibleRole:"target",violationClass:"major",violationType:"threat",representativeReasonCode:"spam"}]){const s=scenario();await denied(s,"INVALID_REQUEST",adjudicationRequest(body),adjudicationRoute);assert.equal(s.calls.length,0);}
});
test("adjudication result excludes extra identities unsafe values and server mismatch",async()=>{
 const valid={reportId,status:"reviewing",version:3,decisionId:objectId,alreadyApplied:false};
 for(const adjudication of[{...valid,actorId:uid},{...valid,version:Number.MAX_SAFE_INTEGER+1},{...valid,version:4},{...valid,reportId:uid},{...valid,status:"resolved"},{...valid,decisionId:"bad"},{...valid,alreadyApplied:"false"}])await denied(scenario({adjudication}),"EXTERNAL_UNAVAILABLE",adjudicationRequest(),adjudicationRoute);
 for(const adjudication of[{reportId,status:"reviewing",version:2,holdVersion:0,incidentRevision:0},{reportId,status:"reviewing",version:2,holdVersion:null,incidentRevision:-1},{reportId,status:"reviewing",version:2,holdVersion:null,incidentRevision:0,identityId:uid}])await denied(scenario({adjudication}),"EXTERNAL_UNAVAILABLE",new Request("https://x.example/service-api/operator/reports/"+reportId+"/adjudication-state",{headers:{authorization:"Bearer "+token}}),{kind:"adjudication-state",reportId});
});
test("adjudication replay and access conflict unresolved errors preserve no fallback",async()=>{
 const s=scenario({adjudication:{reportId,status:"reviewing",version:3,decisionId:objectId,alreadyApplied:true}});assert.equal((await(await s.run(adjudicationRequest(),adjudicationRoute)).json()).data.alreadyApplied,true);
 for(const [adjudicationStatus,adjudicationCode,code]of[[403,"28000","AUTH_REQUIRED"],[403,"42501","ACCESS_DENIED"],[404,"PT404","RESOURCE_NOT_FOUND"],[409,"40001","STATE_CONFLICT"],[500,"55000","EXTERNAL_UNAVAILABLE"]]as const){const x=scenario({adjudicationStatus,adjudicationCode});await denied(x,code,adjudicationRequest(),adjudicationRoute);assert.equal(x.calls.length,2);assert.ok(x.calls.every(c=>!c.url.includes("get_my_report")));}
});

test("adjudication methods query range encoding and size stay bounded before upstream",async()=>{
 const s=scenario();await denied(s,"METHOD_NOT_ALLOWED",new Request("https://x.example/service-api/operator/reports/"+reportId+"/adjudications"),adjudicationRoute);
 for(const suffix of["?actor=secret","#secret"]){const req=adjudicationRequest();await denied(s,"INVALID_REQUEST",new Request(req.url+suffix,req),adjudicationRoute);}
 await denied(s,"INVALID_REQUEST",adjudicationRequest(undefined,{headers:{authorization:"Bearer "+token,"content-type":"application/json",range:"bytes=0-1"}}),adjudicationRoute);
 await denied(s,"UNSUPPORTED_MEDIA_TYPE",adjudicationRequest(undefined,{headers:{authorization:"Bearer "+token,"content-type":"application/json","content-encoding":"gzip"}}),adjudicationRoute);
 await denied(s,"PAYLOAD_TOO_LARGE",adjudicationRequest({...adjudicationBody,padding:"x".repeat(8192)}),adjudicationRoute);assert.equal(s.calls.length,0);
});


const cancelResolutionRoute:ReportOperatorRoute={kind:"cancel-resolution",reportId,appealId:assetId};
const cancelResolutionState:ReportOperatorRoute={kind:"cancel-resolution-state",reportId,appealId:assetId};
const cancelResolutionBody={clientRequestId:uid,mode:"initial",expectedReportVersion:2,expectedResultRevision:3,expectedIncidentRevision:0,outcome:"accepted"};
const cancelResolutionUrl="https://api.example.test/service-api/operator/reports/"+reportId+"/cancellation-appeals/"+assetId;
const cancelResolutionRequest=(body:unknown=cancelResolutionBody,init:RequestInit={})=>new Request(cancelResolutionUrl+"/resolutions",{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify(body),...init});
const cancelStateRequest=()=>new Request(cancelResolutionUrl+"/resolution-state",{headers:{authorization:"Bearer "+token}});
test("cancellation resolution mock uses exact path2 body6 RPC8 and independent server context",async()=>{
 for(const prefix of["/service-api","/functions/v1/service-api"]){const base="https://x.example"+prefix+"/operator/reports/"+reportId+"/cancellation-appeals/"+assetId;assert.deepEqual(reportOperatorRoute(new URL(base+"/resolutions")),cancelResolutionRoute);assert.deepEqual(reportOperatorRoute(new URL(base+"/resolution-state")),cancelResolutionState);assert.equal(reportOperatorRoute(new URL(base+"/resolutions/extra")),null);}
 const s=scenario(),response=await s.run(cancelResolutionRequest(),cancelResolutionRoute,{requestId:objectId}),envelope=await response.json();
 assert.deepEqual(envelope,{requestId:objectId,data:{reportId,appealId:assetId,decisionId:objectId,reportVersion:3,resultRevision:4,appealState:"accepted",alreadyApplied:false}});assert.equal(response.headers.get("x-request-id"),objectId);assert.notEqual(envelope.requestId,uid);assert.equal(response.headers.get("cache-control"),"private, no-store");assert.equal(response.headers.get("vary"),"Authorization, Origin");
 assert.deepEqual(JSON.parse(s.calls[1].body!),{p_report_id:reportId,p_appeal_id:assetId,p_client_request_id:uid,p_mode:"initial",p_expected_report_version:2,p_expected_result_revision:3,p_expected_incident_revision:0,p_outcome:"accepted"});assert.equal(s.calls.length,2);
});
test("cancellation resolution current state exact6 allows final safe versions without changing metadata contracts",async()=>{
 const resolution={reportId,appealId:assetId,reportVersion:Number.MAX_SAFE_INTEGER,resultRevision:Number.MAX_SAFE_INTEGER,incidentRevision:Number.MAX_SAFE_INTEGER,appealState:"rejected"};const s=scenario({resolution});assert.deepEqual((await(await s.run(cancelStateRequest(),cancelResolutionState)).json()).data,resolution);assert.equal(s.calls.length,2);
});
test("cancellation resolution initial correction accepted rejected preserve original replay snapshot",async()=>{
 for(const mode of["initial","correction"])for(const outcome of["accepted","rejected"]){const s=scenario();const r=await s.run(cancelResolutionRequest({...cancelResolutionBody,mode,outcome,expectedIncidentRevision:4}),cancelResolutionRoute);assert.equal((await r.json()).data.appealState,outcome);assert.equal(s.calls.length,2);}
 const resolution={reportId,appealId:assetId,decisionId:objectId,reportVersion:3,resultRevision:4,appealState:"accepted",alreadyApplied:true};const s=scenario({resolution});assert.deepEqual((await(await s.run(cancelResolutionRequest(),cancelResolutionRoute)).json()).data,resolution);
});
test("cancellation resolution body rejects missing null extras identity actor clocks and unsafe versions before Auth",async()=>{
 const bodies:unknown[]=[null,[],"string",{...cancelResolutionBody,mode:["initial"]},{...cancelResolutionBody,mode:"unknown"},{...cancelResolutionBody,outcome:"reviewing"},{...cancelResolutionBody,clientRequestId:"bad"}];
 for(const key of Object.keys(cancelResolutionBody)){const missing={...cancelResolutionBody}as Record<string,unknown>;delete missing[key];bodies.push(missing,{...cancelResolutionBody,[key]:null});}
 for(const key of["actorId","identityId","episodeId","appointmentId","reportId","receivedAt","notifiedAt","penalty","evidence","context"])bodies.push({...cancelResolutionBody,[key]:"forbidden"});
 for(const key of["expectedReportVersion","expectedResultRevision","expectedIncidentRevision"])for(const n of["1",1.5,-1,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER+1])bodies.push({...cancelResolutionBody,[key]:n});
 bodies.push({...cancelResolutionBody,expectedReportVersion:0},{...cancelResolutionBody,expectedResultRevision:0});
 for(const body of bodies){const s=scenario();await denied(s,"INVALID_REQUEST",cancelResolutionRequest(body),cancelResolutionRoute);assert.equal(s.calls.length,0);}
});
test("cancellation resolution DTO rejects extra facts path mismatch wrong outcome revision and nonboolean replay",async()=>{
 const valid={reportId,appealId:assetId,decisionId:objectId,reportVersion:3,resultRevision:4,appealState:"accepted",alreadyApplied:false};
 for(const resolution of[{...valid,actorId:uid},{...valid,incidentId:uid},{...valid,notifiedAt:"2030"},{...valid,reportId:uid},{...valid,appealId:uid},{...valid,decisionId:"bad"},{...valid,reportVersion:4},{...valid,resultRevision:5},{...valid,resultRevision:"4"},{...valid,appealState:"rejected"},{...valid,alreadyApplied:"false"}])await denied(scenario({resolution}),"EXTERNAL_UNAVAILABLE",cancelResolutionRequest(),cancelResolutionRoute);
 const state={reportId,appealId:assetId,reportVersion:2,resultRevision:3,incidentRevision:0,appealState:"reviewing"};
 for(const resolution of[{...state,identityId:uid},{...state,reportId:uid},{...state,appealId:uid},{...state,reportVersion:0},{...state,resultRevision:Number.MAX_SAFE_INTEGER+1},{...state,incidentRevision:-1},{...state,incidentRevision:"0"},{...state,appealState:"unknown"}])await denied(scenario({resolution}),"EXTERNAL_UNAVAILABLE",cancelStateRequest(),cancelResolutionState);
});
test("cancellation resolution rights session CAS TTL and known55000 transport fail without generic or worker fallback",async()=>{
 for(const [resolutionStatus,resolutionCode,code]of[[403,"28000","AUTH_REQUIRED"],[403,"42501","ACCESS_DENIED"],[404,"PT404","RESOURCE_NOT_FOUND"],[409,"40001","STATE_CONFLICT"],[400,"22023","INVALID_REQUEST"],[500,"55000","EXTERNAL_UNAVAILABLE"],[400,"55000","INTERNAL_ERROR"]]as const){const s=scenario({resolutionStatus,resolutionCode});await denied(s,code,cancelResolutionRequest(),cancelResolutionRoute);assert.equal(s.calls.length,2);assert.ok(s.calls.every(c=>c.url===api+"/auth/v1/user"||c.url===api+"/rest/v1/rpc/resolve_assigned_appointment_cancel_appeal"));}
});
test("cancellation resolution methods path query range encoding and bounded body deny before upstream",async()=>{
 const s=scenario();await denied(s,"METHOD_NOT_ALLOWED",new Request(cancelResolutionUrl+"/resolutions"),cancelResolutionRoute);
 for(const suffix of["?actor=x","#x"]){const req=cancelResolutionRequest();await denied(s,"INVALID_REQUEST",new Request(req.url+suffix,req),cancelResolutionRoute);}
 await denied(s,"INVALID_REQUEST",cancelResolutionRequest(),{...cancelResolutionRoute,appealId:"bad"});await denied(s,"INVALID_REQUEST",cancelResolutionRequest(),{...cancelResolutionRoute,reportId:"bad"});
 await denied(s,"INVALID_REQUEST",cancelResolutionRequest(undefined,{headers:{authorization:"Bearer "+token,"content-type":"application/json",range:"bytes=0-1"}}),cancelResolutionRoute);
 await denied(s,"UNSUPPORTED_MEDIA_TYPE",cancelResolutionRequest(undefined,{headers:{authorization:"Bearer "+token,"content-type":"application/json","content-encoding":"gzip"}}),cancelResolutionRoute);
 await denied(s,"PAYLOAD_TOO_LARGE",cancelResolutionRequest({...cancelResolutionBody,padding:"x".repeat(8192)}),cancelResolutionRoute);assert.equal(s.calls.length,0);
});
test("service API cancellation resolution delegates bare Auth staff only and retains CORS request envelope",async()=>{
 const s=scenario(),response=await connected(s)(cancelResolutionRequest(undefined,{headers:{authorization:"Bearer "+token,"content-type":"application/json",origin:"https://app.example.test"}}));const envelope=await response.json();assert.equal(response.status,200);assert.equal(envelope.requestId,response.headers.get("x-request-id"));assert.notEqual(envelope.requestId,uid);assert.equal(response.headers.get("access-control-allow-origin"),"https://app.example.test");assert.equal(envelope.data.appealState,"accepted");assert.equal(s.calls.length,2);
 const deniedScenario=scenario({resolutionStatus:403}),refused=await connected(deniedScenario)(cancelResolutionRequest());const error=await refused.json();assert.equal(refused.status,403);assert.equal(error.error.code,"ACCESS_DENIED");assert.ok(!JSON.stringify(error).includes("private rejection"));assert.equal(refused.headers.get("cache-control"),"no-store");
 const pre=scenario();const r=await connected(pre)(new Request(cancelResolutionUrl+"/resolutions",{method:"OPTIONS",headers:{origin:"https://app.example.test","access-control-request-method":"POST","access-control-request-headers":"authorization,content-type"}}));assert.equal(r.status,204);assert.equal(pre.calls.length,0);
});
