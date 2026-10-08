/** 민규: 별도 승인·사건 배정을 DB에서 확인하는 직원 전용 제출 자료·현재 상태 읽기 및 명시 검토 시작·판정·정정 transport. 원 JWT만 쓴다. */
import type { RuntimeConfig } from "../config/env.ts";
import { getPrincipalToken, type Principal } from "../auth/principal.ts";
import { HttpError } from "../http/errors.ts";
import { createRpcTransport, type FetchLike, type RpcClient } from "./transport.ts";
import type { JsonValue } from "../contracts/common.ts";
const names = new Set(["get_assigned_cancellation_clock_state","repair_assigned_cancellation_clocks","final_close_assigned_member_report","resolve_assigned_general_sanction_appeal","get_assigned_member_report", "get_assigned_report_capture", "get_assigned_report_review_state", "start_assigned_report_review", "get_assigned_report_adjudication_state", "adjudicate_assigned_member_report", "get_assigned_appointment_cancel_appeal_resolution_state", "resolve_assigned_appointment_cancel_appeal"]);
const safeVersion = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= Number.MAX_SAFE_INTEGER;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
function exact(value: JsonValue, keys: string[], code: "INVALID_REQUEST" | "EXTERNAL_UNAVAILABLE"): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value,k))) throw new HttpError(code);
  return value;
}
const resolutionKeys = ["p_report_id","p_appeal_id","p_client_request_id","p_mode","p_expected_report_version","p_expected_result_revision","p_expected_incident_revision","p_outcome"];
const generalResolutionKeys = ["p_report_id","p_appeal_id","p_client_request_id","p_expected_report_version","p_expected_hold_version","p_expected_incident_revision","p_outcome","p_appointment_outcome","p_incident_outcome","p_responsible_role","p_representative_reason_code","p_violation_class","p_violation_type"];
const adjudicationKeys = ["p_report_id","p_client_request_id","p_mode","p_expected_report_version","p_expected_hold_version","p_expected_incident_revision","p_appointment_outcome","p_incident_outcome","p_responsible_role","p_representative_reason_code","p_violation_class","p_violation_type"];
const minorTypes = ["spam", "rule_violation"];
const majorTypes = ["sexual_harassment", "threat", "violence", "stalking", "privacy_exposure", "sexual_exploitation"];
const safeRevision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
function adjudicationRequest(v: Record<string, JsonValue>): void {
  const hold=v.p_expected_hold_version, ap=v.p_appointment_outcome, outcome=v.p_incident_outcome;
  const role=v.p_responsible_role, kind=v.p_violation_class, type=v.p_violation_type, reason=v.p_representative_reason_code;
  if (!uuid(v.p_client_request_id) || !["initial","correction"].includes(v.p_mode as string) || !safeVersion(v.p_expected_report_version) || v.p_expected_report_version >= Number.MAX_SAFE_INTEGER || (hold !== null && (!safeVersion(hold) || hold >= Number.MAX_SAFE_INTEGER)) || !safeRevision(v.p_expected_incident_revision) || v.p_expected_incident_revision >= Number.MAX_SAFE_INTEGER || !["normal","no_show","unchanged"].includes(ap as string) || !["none","confirmed","invalidated"].includes(outcome as string) || !["none","author","companion","both","target"].includes(role as string) || !["none","minor","major"].includes(kind as string)) throw new HttpError("INVALID_REQUEST");
  if (hold === null && (ap !== "unchanged" || (role !== "none" && role !== "target"))) throw new HttpError("INVALID_REQUEST");
  if (hold !== null && role === "target") throw new HttpError("INVALID_REQUEST");
  if (v.p_mode === "initial" && v.p_expected_incident_revision !== 0) throw new HttpError("INVALID_REQUEST");
  if (outcome === "none") {
    if (role !== "none" || kind !== "none" || type !== null || reason !== (ap === "no_show" ? "no_show" : "no_action")) throw new HttpError("INVALID_REQUEST");
  } else if (outcome === "invalidated") {
    if (v.p_mode !== "correction" || v.p_expected_incident_revision === 0 || role !== "none" || kind !== "none" || type !== null || reason !== "decision_corrected") throw new HttpError("INVALID_REQUEST");
  } else {
    if (role === "none") throw new HttpError("INVALID_REQUEST");
    if (kind === "none" ? (type !== null || reason !== "no_show" || ap !== "no_show") : (typeof type !== "string" || reason !== type || !(kind === "minor" ? minorTypes : majorTypes).includes(type))) throw new HttpError("INVALID_REQUEST");
  }
}
function capture(value: JsonValue, reportId: string, assetId?: string): JsonValue {
  const v=exact(value,["reportId","assetId","bucket","path","objectId","mimeType","byteSize"],"EXTERNAL_UNAVAILABLE");
  if (v.reportId!==reportId || !uuid(v.assetId) || (assetId!==undefined && v.assetId!==assetId) || !uuid(v.objectId) || v.bucket!=="report-evidence" || typeof v.path!=="string" || !/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/.test(v.path) || !uuid(v.path.split("/")[0]) || v.path.split("/")[1].split(".")[0]!==v.assetId || !["image/jpeg","image/png","image/webp"].includes(String(v.mimeType)) || typeof v.mimeType!=="string" || !Number.isInteger(v.byteSize) || typeof v.byteSize!=="number" || v.byteSize<1 || v.byteSize>5242880) throw new HttpError("EXTERNAL_UNAVAILABLE");
  return v;
}
export function createReportOperatorClient(config: RuntimeConfig, principal: Principal, fetchImpl: FetchLike = fetch): RpcClient {
  const transport=createRpcTransport(config,config.supabaseAnonKey,getPrincipalToken(principal),names,fetchImpl);
  return Object.freeze({async rpc(name:string,args:Record<string,JsonValue>):Promise<JsonValue> {
    if (!names.has(name)) throw new HttpError("ACCESS_DENIED");
    const clockState=name==="get_assigned_cancellation_clock_state",clockRepair=name==="repair_assigned_cancellation_clocks";
    const closure=name==="final_close_assigned_member_report";
    const generalResolution=name==="resolve_assigned_general_sanction_appeal";
    const resolution=name==="resolve_assigned_appointment_cancel_appeal", resolutionState=name==="get_assigned_appointment_cancel_appeal_resolution_state";
    const keys=clockRepair?["p_report_id","p_client_request_id","p_expected_report_version","p_plan_fingerprint","p_mappings"]:closure?["p_report_id","p_client_request_id","p_expected_report_version","p_expected_incident_revision","p_resolution_summary"]:generalResolution?generalResolutionKeys:resolution?resolutionKeys:resolutionState?["p_report_id","p_appeal_id"]:name==="adjudicate_assigned_member_report"?adjudicationKeys:name==="get_assigned_report_capture"?["p_report_id","p_asset_id"]:name==="start_assigned_report_review"?["p_report_id","p_request_id","p_expected_version"]:["p_report_id"];
    exact(args,keys,"INVALID_REQUEST");
    if (!uuid(args.p_report_id) || (name==="get_assigned_report_capture" && !uuid(args.p_asset_id))) throw new HttpError("INVALID_REQUEST");
    if (name === "start_assigned_report_review" && (!uuid(args.p_request_id) || !safeVersion(args.p_expected_version) || args.p_expected_version >= Number.MAX_SAFE_INTEGER)) throw new HttpError("INVALID_REQUEST");
    if (resolution || resolutionState) {
      if (!uuid(args.p_appeal_id)) throw new HttpError("INVALID_REQUEST");
      if (resolution && (!uuid(args.p_client_request_id) || typeof args.p_mode!=="string" || !["initial","correction"].includes(args.p_mode) || typeof args.p_outcome!=="string" || !["accepted","rejected"].includes(args.p_outcome) || !safeVersion(args.p_expected_report_version) || args.p_expected_report_version>=Number.MAX_SAFE_INTEGER || !safeVersion(args.p_expected_result_revision) || args.p_expected_result_revision>=Number.MAX_SAFE_INTEGER || !safeRevision(args.p_expected_incident_revision) || args.p_expected_incident_revision>=Number.MAX_SAFE_INTEGER)) throw new HttpError("INVALID_REQUEST");
    }
    if (name === "adjudicate_assigned_member_report") adjudicationRequest(args);
    if (generalResolution) {
      if (!uuid(args.p_appeal_id) || !uuid(args.p_client_request_id) || !safeVersion(args.p_expected_report_version) || args.p_expected_report_version>=Number.MAX_SAFE_INTEGER || !safeVersion(args.p_expected_incident_revision) || args.p_expected_incident_revision>=Number.MAX_SAFE_INTEGER || (args.p_expected_hold_version!==null && (!safeVersion(args.p_expected_hold_version) || args.p_expected_hold_version>=Number.MAX_SAFE_INTEGER)) || !["accepted","rejected"].includes(String(args.p_outcome))) throw new HttpError("INVALID_REQUEST");
      if (args.p_outcome==="accepted") adjudicationRequest({...args,p_mode:"correction"});
      else if (["p_appointment_outcome","p_incident_outcome","p_responsible_role","p_representative_reason_code","p_violation_class","p_violation_type"].some(k=>args[k]!==null)) throw new HttpError("INVALID_REQUEST");
    }
    if (closure && (!uuid(args.p_client_request_id) || !safeVersion(args.p_expected_report_version) || args.p_expected_report_version>=Number.MAX_SAFE_INTEGER || !safeRevision(args.p_expected_incident_revision) || args.p_expected_incident_revision>=Number.MAX_SAFE_INTEGER || typeof args.p_resolution_summary!=="string" || args.p_resolution_summary!==args.p_resolution_summary.trim() || args.p_resolution_summary.length<1 || args.p_resolution_summary.length>4000 || /[\u0000-\u001f\u007f]/.test(args.p_resolution_summary))) throw new HttpError("INVALID_REQUEST");
    if(clockRepair) {
      if(!uuid(args.p_client_request_id) || !safeVersion(args.p_expected_report_version) || args.p_expected_report_version>=Number.MAX_SAFE_INTEGER || typeof args.p_plan_fingerprint!=="string" || !/^[a-f0-9]{64}$/.test(args.p_plan_fingerprint) || !Array.isArray(args.p_mappings) || args.p_mappings.length<1 || args.p_mappings.length>100)throw new HttpError("INVALID_REQUEST");
      const anchors=new Set<string>();
      for(const row of args.p_mappings) {
        const m=exact(row,["anchorAppointmentId","predecessorApplicationId"],"INVALID_REQUEST");
        if(!uuid(m.anchorAppointmentId) || (m.predecessorApplicationId!==null && !uuid(m.predecessorApplicationId)) || anchors.has(m.anchorAppointmentId))throw new HttpError("INVALID_REQUEST");
        anchors.add(m.anchorAppointmentId);
      }
    }
    const value=await transport.rpc(name,args);
    if(clockState) {
      const v=exact(value,["reportId","reportVersion","planFingerprint","actions"],"EXTERNAL_UNAVAILABLE");
      if(v.reportId!==args.p_report_id || !safeVersion(v.reportVersion) || typeof v.planFingerprint!=="string" || !/^[a-f0-9]{64}$/.test(v.planFingerprint) || !Array.isArray(v.actions))throw new HttpError("EXTERNAL_UNAVAILABLE");
      const anchors=new Set<string>();
      for(const row of v.actions) {
        const a=exact(row,["anchorAppointmentId","kind"],"EXTERNAL_UNAVAILABLE");
        if(!uuid(a.anchorAppointmentId) || !["cancel_warning","cancel_restriction"].includes(String(a.kind)) || anchors.has(a.anchorAppointmentId))throw new HttpError("EXTERNAL_UNAVAILABLE");
        anchors.add(a.anchorAppointmentId);
      }
      return v;
    }
    if(clockRepair) {
      const v=exact(value,["reportId","reportVersion","repairedCount","alreadyApplied"],"EXTERNAL_UNAVAILABLE");
      if(v.reportId!==args.p_report_id || v.reportVersion!==(args.p_expected_report_version as number)+1 || v.repairedCount!==(args.p_mappings as JsonValue[]).length || typeof v.alreadyApplied!=="boolean")throw new HttpError("EXTERNAL_UNAVAILABLE");
      return v;
    }

    if (closure) {
      const v=exact(value,["reportId","status","version","finalClosedAt","retentionDueAt","alreadyApplied"],"EXTERNAL_UNAVAILABLE");
      const date=(x:JsonValue)=>typeof x==="string" && /^\d{4}-\d{2}-\d{2}T/.test(x) && Number.isFinite(Date.parse(x));
      if (v.reportId!==args.p_report_id || v.status!=="resolved" || v.version!==(args.p_expected_report_version as number)+1 || typeof v.alreadyApplied!=="boolean" || !date(v.finalClosedAt) || !date(v.retentionDueAt) || Date.parse(v.retentionDueAt as string)-Date.parse(v.finalClosedAt as string)!==90*24*60*60*1000) throw new HttpError("EXTERNAL_UNAVAILABLE");
      return v;
    }
    if (generalResolution) {
      const v=exact(value,["reportId","appealId","appealState","reportVersion","decisionId","alreadyApplied"],"EXTERNAL_UNAVAILABLE");
      if (v.reportId!==args.p_report_id || v.appealId!==args.p_appeal_id || v.appealState!==args.p_outcome || v.reportVersion!==(args.p_expected_report_version as number)+1 || typeof v.alreadyApplied!=="boolean" || (args.p_outcome==="accepted" ? !uuid(v.decisionId) : v.decisionId!==null)) throw new HttpError("EXTERNAL_UNAVAILABLE");
      return v;
    }
    if (resolution || resolutionState) {
      const v=exact(value,resolution?["reportId","appealId","decisionId","reportVersion","resultRevision","appealState","alreadyApplied"]:["reportId","appealId","reportVersion","resultRevision","incidentRevision","appealState"],"EXTERNAL_UNAVAILABLE");
      if (v.reportId!==args.p_report_id || v.appealId!==args.p_appeal_id || !safeVersion(v.reportVersion) || !safeVersion(v.resultRevision) || typeof v.appealState!=="string" || !["reviewing","accepted","rejected"].includes(v.appealState)) throw new HttpError("EXTERNAL_UNAVAILABLE");
      if (resolution ? !uuid(v.decisionId) || typeof v.alreadyApplied!=="boolean" || v.appealState!==args.p_outcome || v.reportVersion!==(args.p_expected_report_version as number)+1 || v.resultRevision!==(args.p_expected_result_revision as number)+1 : !safeRevision(v.incidentRevision)) throw new HttpError("EXTERNAL_UNAVAILABLE");
      return v;
    }
    if (name === "get_assigned_report_adjudication_state") {
      const v=exact(value,["reportId","status","version","holdVersion","incidentRevision"],"EXTERNAL_UNAVAILABLE");
      if (v.reportId !== args.p_report_id || typeof v.status !== "string" || !["received","reviewing","more_evidence","resolved"].includes(v.status) || !safeVersion(v.version) || (v.holdVersion !== null && !safeVersion(v.holdVersion)) || !safeRevision(v.incidentRevision)) throw new HttpError("EXTERNAL_UNAVAILABLE");
      return v;
    }
    if (name === "adjudicate_assigned_member_report") {
      const v=exact(value,["reportId","status","version","decisionId","alreadyApplied"],"EXTERNAL_UNAVAILABLE");
      if (v.reportId !== args.p_report_id || v.status !== "reviewing" || !safeVersion(v.version) || v.version !== (args.p_expected_report_version as number) + 1 || !uuid(v.decisionId) || typeof v.alreadyApplied !== "boolean") throw new HttpError("EXTERNAL_UNAVAILABLE");
      return v;
    }
    if (name === "get_assigned_report_review_state") {
      const v=exact(value,["reportId","status","version"],"EXTERNAL_UNAVAILABLE");
      if (v.reportId !== args.p_report_id || typeof v.status !== "string" || !["received","reviewing","more_evidence","resolved"].includes(v.status) || !safeVersion(v.version)) throw new HttpError("EXTERNAL_UNAVAILABLE");
      return v;
    }
    if (name === "start_assigned_report_review") {
      const v=exact(value,["reportId","status","version","holdId","alreadyApplied"],"EXTERNAL_UNAVAILABLE");
      if (v.reportId !== args.p_report_id || v.status !== "reviewing" || !safeVersion(v.version) || v.version !== (args.p_expected_version as number) + 1 || (v.holdId !== null && !uuid(v.holdId)) || typeof v.alreadyApplied !== "boolean") throw new HttpError("EXTERNAL_UNAVAILABLE");
      return v;
    }
    if (name==="get_assigned_report_capture") return capture(value,args.p_report_id,args.p_asset_id as string);
    const v=exact(value,["reportId","targetType","context","reasonCodes","description","assets"],"EXTERNAL_UNAVAILABLE");
    if(v.reportId!==args.p_report_id || typeof v.targetType!=="string" || !["post","chat","appointment","member","event","ai_answer"].includes(v.targetType) || typeof v.context!=="string" || !["online","offline"].includes(v.context) || typeof v.description!=="string" || v.description.trim()!==v.description || [...v.description].length<1 || [...v.description].length>4000 || !Array.isArray(v.reasonCodes) || v.reasonCodes.length<1 || v.reasonCodes.length>7 || new Set(v.reasonCodes).size!==v.reasonCodes.length || v.reasonCodes.some(r=>typeof r!=="string" || !["sexual_harassment","threat","money_or_personal_data","impersonation","spam","no_show","other"].includes(r)) || !Array.isArray(v.assets) || v.assets.length>5) throw new HttpError("EXTERNAL_UNAVAILABLE");
    const ids=new Set<string>();for(const asset of v.assets){const c=capture(asset,args.p_report_id) as Record<string,JsonValue>;if(ids.has(c.assetId as string))throw new HttpError("EXTERNAL_UNAVAILABLE");ids.add(c.assetId as string);}
    return v;
  }});
}
