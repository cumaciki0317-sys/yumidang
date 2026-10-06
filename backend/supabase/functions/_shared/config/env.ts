/** 민규담당: 기능별 필수 환경을 검사하며 비밀값을 오류에 넣지 않는다. */
import { HttpError } from "../http/errors.ts";

export interface RuntimeConfig {
  readonly supabaseUrl: string;
  readonly supabaseAnonKey: string;
  readonly upstreamTimeoutMs: number;
  readonly maxRequestBytes: number;
  readonly allowedOrigins: readonly string[];
  readonly supabaseServiceRoleKey?: string;
  readonly internalWorkerSecret?: string;
  readonly reviewSummaryModelVersion?: string;
  readonly reviewSummaryPromptVersion?: string;
}
export type EnvReader = (key: string) => string | undefined;
const fail = (): never => { throw new HttpError("EXTERNAL_UNAVAILABLE"); };
function required(read: EnvReader, key: string): string {
  const value = read(key);
  if (!value || value.trim() !== value || /[\r\n]/.test(value)) return fail();
  return value;
}
function positive(read: EnvReader, key: string, maximum = 2147483647): number {
  const value = required(read, key);
  if (!/^[1-9][0-9]*$/.test(value)) return fail();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > maximum) return fail();
  return number;
}
function optional(read: EnvReader, key: string): string | undefined {
  const value = read(key);
  // 빈 example 항목은 미설정이다. 내부 기능의 누락이 공개·사용자 기능을 막지 않는다.
  if (value === undefined || value === "") return undefined;
  if (value.trim() !== value || /[\r\n]/.test(value)) return fail();
  return value;
}
export function loadRuntimeConfig(read: EnvReader): RuntimeConfig {
  try {
    const parsed = new URL(required(read, "SUPABASE_URL"));
    const local = ["localhost", "127.0.0.1", "[::1]", "kong"].includes(parsed.hostname);
    if ((parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) ||
      parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") return fail();
    const origins: unknown = JSON.parse(required(read, "ALLOWED_ORIGINS"));
    if (!Array.isArray(origins) || origins.some((origin: unknown) => {
      if (typeof origin !== "string") return true;
      const url = new URL(origin);
      return !["http:", "https:"].includes(url.protocol) || url.origin !== origin;
    })) return fail();
    const config: RuntimeConfig = {
      supabaseUrl: parsed.origin,
      supabaseAnonKey: required(read, "SUPABASE_ANON_KEY"),
      upstreamTimeoutMs: positive(read, "UPSTREAM_TIMEOUT_MS"),
      maxRequestBytes: positive(read, "MAX_REQUEST_BYTES"),
      allowedOrigins: Object.freeze([...new Set(origins as string[])]),
      supabaseServiceRoleKey: optional(read, "SUPABASE_SERVICE_ROLE_KEY"),
      internalWorkerSecret: optional(read, "INTERNAL_WORKER_SECRET"),
      // 요약 전용 설정은 공개 처리와 분리한다. 빈 값·잘못된 값도 전용 검사까지 보존한다.
      reviewSummaryModelVersion: read("REVIEW_SUMMARY_MODEL_VERSION"),
      reviewSummaryPromptVersion: read("REVIEW_SUMMARY_PROMPT_VERSION"),
    };
    // 내부 기능의 키 누락은 사용자 전용 기능의 시작을 차단하지 않는다.
    // 키를 출력하는 실수를 줄인다. 기능은 명시적 필드 접근으로만 사용한다.
    Object.defineProperty(config, "toJSON", { value: () => ({ configured: true }) });
    return Object.freeze(config);
  } catch { return fail(); }
}
export type ReviewSummaryConfigState =
  | { status: "ready"; modelVersion: string; promptVersion: string }
  | { status: "pending_configuration" | "configuration_error" };
export function inspectReviewSummaryConfig(config?: { modelVersion?: string; promptVersion?: string }): ReviewSummaryConfigState {
  const values = [config?.modelVersion, config?.promptVersion];
  const version = /^[A-Za-z0-9_.-]{1,64}$/;
  if (values.some((value) => value !== undefined && (typeof value !== "string" || value.trim() !== value || !version.test(value)))) {
    return { status: "configuration_error" };
  }
  if (values.some((value) => value === undefined)) return { status: "pending_configuration" };
  return { status: "ready", modelVersion: config!.modelVersion!, promptVersion: config!.promptVersion! };
}
export function requireInternalConfig(config: RuntimeConfig): { serviceKey: string; workerSecret: string } {
  const serviceKey = config.supabaseServiceRoleKey;
  const workerSecret = config.internalWorkerSecret;
  if (!serviceKey || !workerSecret || workerSecret.length < 32 || workerSecret.length > 4096 ||
    !/^[A-Za-z0-9_-]+$/.test(workerSecret) || workerSecret === serviceKey || workerSecret === config.supabaseAnonKey || serviceKey === config.supabaseAnonKey) return fail();
  return { serviceKey, workerSecret };
}

export interface PotensServerAccount {
 readonly accountId:string;
 /** 서버 factory에서만 명시 접근. enumerable/JSON 출력에서 제외한다. */
 readonly apiKey:string;
 readonly dailyTokenBudget:number;
}
export interface PotensAccountPoolConfig {
 readonly accounts:readonly PotensServerAccount[];
 readonly model:"claude-5-sonnet";
 readonly resetTimezone:"Asia/Seoul";
 readonly globalDailyTokenBudget:number;
}
/** 다중 계정 전용 검사. null은 기존 단일키 설정 경로이며 새 설정 오류 때 fallback하지 않는다.
 * 로더 성공은 공급사 승인·원자 DB 원장·실제 호출 준비를 뜻하지 않는다. */
export function loadPotensAccountPoolConfig(read:EnvReader):PotensAccountPoolConfig|null{
 try{
  const approved=["yumi","jonghyun","minkyu","sungho"];
  const order=optional(read,"POTENS_ACCOUNT_ORDER");
  const keys=approved.map(account=>optional(read,"POTENS_API_KEY_"+account.toUpperCase()));
  const budget=optional(read,"POTENS_ACCOUNT_TOKEN_BUDGET"),timezone=optional(read,"POTENS_RESET_TIMEZONE");
  if(order===undefined){if(keys.some(Boolean)||budget!==undefined||timezone!==undefined)return fail();return null;}
  const ids=order.split(",");
  if(!ids.length||ids.some(id=>!approved.includes(id))||new Set(ids).size!==ids.length||
   ids.some((id,index)=>index>0&&approved.indexOf(id)<approved.indexOf(ids[index-1])))return fail();
  if(required(read,"POTENS_MODEL")!=="claude-5-sonnet"||timezone!=="Asia/Seoul")return fail();
  const daily=positive(read,"POTENS_ACCOUNT_TOKEN_BUDGET");
  // 사용자 선택320만을 설정에서 명시한다. 코드에서 기본값·공급사 포함량을 추정하지 않는다.
  if(daily!==3200000)return fail();
  if(keys.some((key,index)=>Boolean(key)!==ids.includes(approved[index]))||new Set(keys.filter(Boolean)).size!==ids.length)return fail();
  const accounts=ids.map(accountId=>{
   const apiKey=keys[approved.indexOf(accountId)]!;
   if(apiKey.length>4096||!/^[\x21-\x7e]+$/.test(apiKey))return fail();
   const item={accountId,dailyTokenBudget:daily}as PotensServerAccount;
   Object.defineProperty(item,"apiKey",{value:apiKey,enumerable:false});return Object.freeze(item);
  });
  const config:PotensAccountPoolConfig={accounts:Object.freeze(accounts),model:"claude-5-sonnet",resetTimezone:"Asia/Seoul",globalDailyTokenBudget:daily*accounts.length};
  Object.defineProperty(config,"toJSON",{value:()=>({configured:true,accountCount:accounts.length})});return Object.freeze(config);
 }catch{return fail();}
}
