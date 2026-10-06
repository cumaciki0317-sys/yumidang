/** 민규: 배정된 신고와 제출된 캡처만 조회한다. 사용자 JWT 전용이며 직원 권한은 매 RPC에서 DB가 확인한다. */
import type { RuntimeConfig } from "../_shared/config/env.ts";
import type { FetchLike } from "../_shared/db/transport.ts";
import type { JsonValue, RequestContext } from "../_shared/contracts/common.ts";
import { requirePrincipal, getPrincipalToken } from "../_shared/auth/principal.ts";
import { createReportOperatorClient } from "../_shared/db/report-operator-client.ts";
import { readJson, createRequestContext } from "../_shared/http/request.ts";
import { jsonSuccess } from "../_shared/http/response.ts";
import { HttpError } from "../_shared/http/errors.ts";
export const MAX_REPORT_CAPTURE_BYTES = 5242880;
export type ReportOperatorRoute = { kind: "report" | "review-state" | "review-start" | "adjudication-state" | "adjudication"; reportId: string } | { kind: "capture"; reportId: string; assetId: string } | { kind: "cancel-resolution-state" | "cancel-resolution"; reportId: string; appealId: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function reportOperatorRoute(url: URL): ReportOperatorRoute | null {
  const prefix = ["/functions/v1/service-api/operator/reports/", "/service-api/operator/reports/"].find(p => url.pathname.startsWith(p));
  if (!prefix) return null;
  const parts = url.pathname.slice(prefix.length).split("/");
  if (parts.length === 4 && parts[1] === "cancellation-appeals" && ["resolution-state","resolutions"].includes(parts[3])) return {kind:parts[3]==="resolution-state"?"cancel-resolution-state":"cancel-resolution",reportId:parts[0],appealId:parts[2]};
  if (parts.length === 1) return {kind:"report",reportId:parts[0]};
  if (parts.length === 2 && parts[1] === "adjudication-state") return {kind:"adjudication-state",reportId:parts[0]};
  if (parts.length === 2 && parts[1] === "adjudications") return {kind:"adjudication",reportId:parts[0]};
  if (parts.length === 2 && parts[1] === "review-state") return {kind:"review-state",reportId:parts[0]};
  if (parts.length === 3 && parts[1] === "review" && parts[2] === "start") return {kind:"review-start",reportId:parts[0]};
  if (parts.length === 3 && parts[1] === "captures") return {kind:"capture",reportId:parts[0],assetId:parts[2]};
  return null;
}
const adjudicationKeys=["clientRequestId","mode","expectedReportVersion","expectedHoldVersion","expectedIncidentRevision","appointmentOutcome","incidentOutcome","responsibleRole","representativeReasonCode","violationClass","violationType"];
const minorTypes=["spam","rule_violation"];
const majorTypes=["sexual_harassment","threat","violence","stalking","privacy_exposure","sexual_exploitation"];
function boundedVersion(value:JsonValue,min:number,max=Number.MAX_SAFE_INTEGER):value is number {
  return typeof value==="number" && Number.isSafeInteger(value) && value>=min && value<max;
}
function adjudicationArgs(value:JsonValue,reportId:string):Record<string,JsonValue> {
  if(!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).length!==adjudicationKeys.length || adjudicationKeys.some(key=>!Object.hasOwn(value,key)))throw new HttpError("INVALID_REQUEST");
  const v=value;
  if(["mode","appointmentOutcome","incidentOutcome","responsibleRole","representativeReasonCode","violationClass"].some(key=>typeof v[key]!=="string") || typeof v.clientRequestId!=="string" || !uuid.test(v.clientRequestId) || !boundedVersion(v.expectedReportVersion,1) || (v.expectedHoldVersion!==null && !boundedVersion(v.expectedHoldVersion,1)) || !boundedVersion(v.expectedIncidentRevision,0) || !["initial","correction"].includes(String(v.mode)) || !["normal","no_show","unchanged"].includes(String(v.appointmentOutcome)) || !["none","confirmed","invalidated"].includes(String(v.incidentOutcome)) || !["none","author","companion","both","target"].includes(String(v.responsibleRole)) || !["none","minor","major"].includes(String(v.violationClass)))throw new HttpError("INVALID_REQUEST");
  let valid=false;
  if(v.incidentOutcome==="none")valid=v.responsibleRole==="none" && v.violationClass==="none" && v.violationType===null && ((v.representativeReasonCode==="no_action" && ["normal","unchanged"].includes(String(v.appointmentOutcome))) || (v.representativeReasonCode==="no_show" && v.appointmentOutcome==="no_show"));
  if(v.incidentOutcome==="invalidated")valid=v.mode==="correction" && Number(v.expectedIncidentRevision)>0 && v.responsibleRole==="none" && v.violationClass==="none" && v.violationType===null && v.representativeReasonCode==="decision_corrected";
  if(v.incidentOutcome==="confirmed" && v.responsibleRole!=="none")valid=(v.violationClass==="none" && v.violationType===null && v.representativeReasonCode==="no_show" && v.appointmentOutcome==="no_show") || (typeof v.violationType==="string" && v.representativeReasonCode===v.violationType && ((v.violationClass==="minor" && minorTypes.includes(v.violationType)) || (v.violationClass==="major" && majorTypes.includes(v.violationType))));
  if(!valid)throw new HttpError("INVALID_REQUEST");
  // 대상 관계는 RPC가 검증한다. 호출자의 identity를 입력으로 받지 않는다.
  return {p_report_id:reportId,p_client_request_id:v.clientRequestId,p_mode:v.mode,p_expected_report_version:v.expectedReportVersion,p_expected_hold_version:v.expectedHoldVersion,p_expected_incident_revision:v.expectedIncidentRevision,p_appointment_outcome:v.appointmentOutcome,p_incident_outcome:v.incidentOutcome,p_responsible_role:v.responsibleRole,p_representative_reason_code:v.representativeReasonCode,p_violation_class:v.violationClass,p_violation_type:v.violationType};
}
const cancelResolutionKeys=["clientRequestId","mode","expectedReportVersion","expectedResultRevision","expectedIncidentRevision","outcome"];
function cancelResolutionArgs(value:JsonValue,reportId:string,appealId:string):Record<string,JsonValue> {
  if(!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).length!==cancelResolutionKeys.length || cancelResolutionKeys.some(key=>!Object.hasOwn(value,key)))throw new HttpError("INVALID_REQUEST");
  if(typeof value.clientRequestId!=="string" || !uuid.test(value.clientRequestId) || typeof value.mode!=="string" || !["initial","correction"].includes(value.mode) || typeof value.outcome!=="string" || !["accepted","rejected"].includes(value.outcome) || !boundedVersion(value.expectedReportVersion,1) || !boundedVersion(value.expectedResultRevision,1) || !boundedVersion(value.expectedIncidentRevision,0))throw new HttpError("INVALID_REQUEST");
  // 직원·현재 회차·제재 계획은 DB가 도출한다. 멱등 키는 서버 응답 context와 별개다.
  return {p_report_id:reportId,p_appeal_id:appealId,p_client_request_id:value.clientRequestId,p_mode:value.mode,p_expected_report_version:value.expectedReportVersion,p_expected_result_revision:value.expectedResultRevision,p_expected_incident_revision:value.expectedIncidentRevision,p_outcome:value.outcome};
}
const privateHeaders = {"Cache-Control":"private, no-store", "Pragma":"no-cache", "Expires":"0", "Vary":"Authorization, Origin", "X-Content-Type-Options":"nosniff"};
function denied(status: number) { return [400,401,403,404].includes(status); }
function sameCapture(a: Record<string,JsonValue>, b: Record<string,JsonValue>) {
  return ["reportId","assetId","bucket","path","objectId","mimeType","byteSize"].every(key => a[key] === b[key]);
}
function imageMagic(bytes: Uint8Array, mime: string) {
  if (mime === "image/jpeg") return bytes.length >= 4 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255 && bytes.at(-2)===255 && bytes.at(-1)===217;
  if (mime === "image/png") return bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((b,i)=>bytes[i]===b);
  if (mime === "image/webp") return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0,4)) === "RIFF" && String.fromCharCode(...bytes.slice(8,12)) === "WEBP" && new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(4,true) === bytes.length-8;
  return false;
}
async function readCapture(response: Response, metadata: Record<string,JsonValue>, signal: AbortSignal) {
  const mime = String(metadata.mimeType), expected = Number(metadata.byteSize);
  const extension = String(metadata.path).split(".").at(-1);
  if (response.status !== 200 || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== mime || ({"image/jpeg":"jpg","image/png":"png","image/webp":"webp"} as Record<string,string>)[mime] !== extension) throw new HttpError("EXTERNAL_UNAVAILABLE");
  const length=response.headers.get("content-length");
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length)!==expected || Number(length)>MAX_REPORT_CAPTURE_BYTES)) throw new HttpError("EXTERNAL_UNAVAILABLE");
  if (!response.body) throw new HttpError("EXTERNAL_UNAVAILABLE");
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
  try {
    while (true) {
      if(signal.aborted)throw new HttpError("EXTERNAL_UNAVAILABLE");
      const next=await reader.read();if(next.done)break;
      size+=next.value.byteLength;
      if(size>MAX_REPORT_CAPTURE_BYTES || size>expected)throw new HttpError("EXTERNAL_UNAVAILABLE");
      chunks.push(next.value);
    }
    if(size!==expected)throw new HttpError("EXTERNAL_UNAVAILABLE");
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    // MIME 전송 손상 검사다. 사진 전체 디코딩·원본 대화 수집을 수행하지 않는다.
    if(!imageMagic(bytes,mime))throw new HttpError("EXTERNAL_UNAVAILABLE");
    return bytes;
  } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function createReportOperatorExecutor(config: RuntimeConfig, fetchImpl: FetchLike = fetch) {
  return async (request: Request, route: ReportOperatorRoute, context: RequestContext = createRequestContext()): Promise<Response> => {
    const url=new URL(request.url);
    const mutation=route.kind==="review-start" || route.kind==="adjudication" || route.kind==="cancel-resolution";
    if(request.method!==(mutation?"POST":"GET"))throw new HttpError("METHOD_NOT_ALLOWED");
    if(url.search || url.hash || (!mutation && request.body!==null) || request.headers.has("range") || !uuid.test(route.reportId) || !["report","capture","review-state","review-start","adjudication-state","adjudication","cancel-resolution-state","cancel-resolution"].includes(route.kind) || (route.kind==="capture" && !uuid.test(route.assetId)) || ((route.kind==="cancel-resolution-state" || route.kind==="cancel-resolution") && !uuid.test(route.appealId)))throw new HttpError("INVALID_REQUEST");
    let startArgs:Record<string,JsonValue>|null=null;
    if(route.kind==="review-start") {
      const value=await readJson(request,{maxBytes:config.maxRequestBytes});
      if(!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).length!==2 || !Object.hasOwn(value,"clientRequestId") || !Object.hasOwn(value,"expectedVersion") || typeof value.clientRequestId!=="string" || !uuid.test(value.clientRequestId) || typeof value.expectedVersion!=="number" || !Number.isSafeInteger(value.expectedVersion) || value.expectedVersion<1 || value.expectedVersion>=Number.MAX_SAFE_INTEGER)throw new HttpError("INVALID_REQUEST");
      // 클라이언트 멱등 키와 서버 응답 요청 ID는 독립적이다.
      startArgs={p_report_id:route.reportId,p_request_id:value.clientRequestId,p_expected_version:value.expectedVersion};
    }
    if(route.kind==="adjudication")startArgs=adjudicationArgs(await readJson(request,{maxBytes:config.maxRequestBytes}),route.reportId);
    if(route.kind==="cancel-resolution")startArgs=cancelResolutionArgs(await readJson(request,{maxBytes:config.maxRequestBytes}),route.reportId,route.appealId);
    const signal=AbortSignal.any([request.signal,AbortSignal.timeout(config.upstreamTimeoutMs)]);
    const scopedFetch:FetchLike=(input,init)=>fetchImpl(input,{...init,signal:init?.signal?AbortSignal.any([signal,init.signal]):signal});
    let upstream:Response|null=null;
    try {
      if(signal.aborted)throw new HttpError("EXTERNAL_UNAVAILABLE");
      const principal=await requirePrincipal(request,config,scopedFetch);
      const db=createReportOperatorClient(config,principal,scopedFetch);
      if(route.kind==="cancel-resolution-state" || route.kind==="cancel-resolution") {
        const submit=route.kind==="cancel-resolution";
        const result=await db.rpc(submit?"resolve_assigned_appointment_cancel_appeal":"get_assigned_appointment_cancel_appeal_resolution_state",startArgs??{p_report_id:route.reportId,p_appeal_id:route.appealId});
        const keys=submit?["reportId","appealId","decisionId","reportVersion","resultRevision","appealState","alreadyApplied"]:["reportId","appealId","reportVersion","resultRevision","incidentRevision","appealState"];
        if(!result || typeof result!=="object" || Array.isArray(result) || Object.keys(result).length!==keys.length || keys.some(key=>!Object.hasOwn(result,key)) || result.reportId!==route.reportId || result.appealId!==route.appealId || !boundedVersion(result.reportVersion,1,Number.MAX_SAFE_INTEGER+1) || !boundedVersion(result.resultRevision,1,Number.MAX_SAFE_INTEGER+1) || typeof result.appealState!=="string" || !["reviewing","accepted","rejected"].includes(result.appealState))throw new HttpError("EXTERNAL_UNAVAILABLE");
        if(submit) {
          if(result.reportVersion!==Number(startArgs?.p_expected_report_version)+1 || result.resultRevision!==Number(startArgs?.p_expected_result_revision)+1 || result.appealState!==startArgs?.p_outcome || typeof result.decisionId!=="string" || !uuid.test(result.decisionId) || typeof result.alreadyApplied!=="boolean")throw new HttpError("EXTERNAL_UNAVAILABLE");
        } else if(!boundedVersion(result.incidentRevision,0,Number.MAX_SAFE_INTEGER+1))throw new HttpError("EXTERNAL_UNAVAILABLE");
        if(signal.aborted)throw new HttpError("EXTERNAL_UNAVAILABLE");
        const response=jsonSuccess(result,context);
        for(const [name,value] of Object.entries(privateHeaders))response.headers.set(name,value);
        return response;
      }
      if(route.kind!=="capture") {
        const name=route.kind==="report"?"get_assigned_member_report":route.kind==="review-state"?"get_assigned_report_review_state":route.kind==="review-start"?"start_assigned_report_review":route.kind==="adjudication-state"?"get_assigned_report_adjudication_state":"adjudicate_assigned_member_report";
        const result=await db.rpc(name,startArgs??{p_report_id:route.reportId});
        if(route.kind!=="report") {
          const keys=route.kind==="review-state"?["reportId","status","version"]:route.kind==="review-start"?["reportId","status","version","holdId","alreadyApplied"]:route.kind==="adjudication-state"?["reportId","status","version","holdVersion","incidentRevision"]:["reportId","status","version","decisionId","alreadyApplied"];
          if(!result || typeof result!=="object" || Array.isArray(result) || Object.keys(result).length!==keys.length || keys.some(key=>!Object.hasOwn(result,key)) || result.reportId!==route.reportId || typeof result.version!=="number" || !Number.isSafeInteger(result.version) || result.version<1 || typeof result.status!=="string" || !["received","reviewing","more_evidence","resolved"].includes(result.status))throw new HttpError("EXTERNAL_UNAVAILABLE");
          if(route.kind==="review-start" && (result.status!=="reviewing" || result.version!==Number(startArgs?.p_expected_version)+1 || typeof result.alreadyApplied!=="boolean" || (result.holdId!==null && (typeof result.holdId!=="string" || !uuid.test(result.holdId)))))throw new HttpError("EXTERNAL_UNAVAILABLE");
        }
          if(route.kind==="adjudication-state") {
            const v=result as Record<string,JsonValue>;
            if((v.holdVersion!==null && !boundedVersion(v.holdVersion,1,Number.MAX_SAFE_INTEGER+1)) || !boundedVersion(v.incidentRevision,0,Number.MAX_SAFE_INTEGER+1))throw new HttpError("EXTERNAL_UNAVAILABLE");
          }
          if(route.kind==="adjudication") {
            const v=result as Record<string,JsonValue>;
            if(v.status!=="reviewing" || v.version!==Number(startArgs?.p_expected_report_version)+1 || typeof v.decisionId!=="string" || !uuid.test(v.decisionId) || typeof v.alreadyApplied!=="boolean")throw new HttpError("EXTERNAL_UNAVAILABLE");
          }
        if(signal.aborted)throw new HttpError("EXTERNAL_UNAVAILABLE");
        const response=jsonSuccess(result,context);
        for(const [name,value] of Object.entries(privateHeaders))response.headers.set(name,value);
        return response;
      }
      const args={p_report_id:route.reportId,p_asset_id:route.assetId};
      const metadata=await db.rpc("get_assigned_report_capture",args) as Record<string,JsonValue>;
      const target=config.supabaseUrl+"/storage/v1/object/authenticated/report-evidence/"+metadata.path;
      const headers={apikey:config.supabaseAnonKey,Authorization:"Bearer "+getPrincipalToken(principal),Accept:String(metadata.mimeType)};
      upstream=await scopedFetch(target,{method:"GET",headers,redirect:"error",cache:"no-store"});
      if(denied(upstream.status))throw new HttpError("RESOURCE_NOT_FOUND");
      const bytes=await readCapture(upstream,metadata,signal);
      const rechecked=await db.rpc("get_assigned_report_capture",args) as Record<string,JsonValue>;
      if(!sameCapture(metadata,rechecked))throw new HttpError("RESOURCE_NOT_FOUND");
      const head=await scopedFetch(target,{method:"HEAD",headers,redirect:"error",cache:"no-store"});
      await head.body?.cancel();
      if(denied(head.status))throw new HttpError("RESOURCE_NOT_FOUND");
      if(head.status!==200 || signal.aborted)throw new HttpError("EXTERNAL_UNAVAILABLE");
      return new Response(new Uint8Array(bytes).buffer,{status:200,headers:{...privateHeaders,"X-Request-Id":context.requestId,"Content-Type":String(metadata.mimeType),"Content-Length":String(bytes.byteLength)}});
    } catch(error) {
      await upstream?.body?.cancel().catch(()=>{});
      if(error instanceof HttpError)throw error;
      throw new HttpError("EXTERNAL_UNAVAILABLE");
    }
  };
}
