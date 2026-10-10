import { createContentWriteClient } from "../_shared/db/content-inspection-client.ts";
import { createContentInspectionExecutor } from "./content-inspection-http.ts";
import { createMemberCleanupReconcileExecutor, createMemberCleanupFinalizationExecutor, type MemberCleanupReconcileReadiness } from "./member-cleanup-reconcile-http.ts";
import type { ContentClassifier, ContentInspectionReadiness } from "../_shared/services/content-inspection.ts";
/** 민규담당. Deno/Supabase 런타임 진입점. 설정·원문·자격 증명을 출력하지 않는다. */
import { HttpError, toPublicError } from "../_shared/http/errors.ts";
import { loadRuntimeConfig, type EnvReader } from "../_shared/config/env.ts";
import { requireOptionalPrincipal, requirePrincipal } from "../_shared/auth/principal.ts";
import { requireInternalCaller } from "../_shared/auth/internal-caller.ts";
import { createPublicClient } from "../_shared/db/public-client.ts";
import type { PublicPostSearchExecutor } from "./search-http.ts";
import { createUserClient, createRetirementReceiptClient } from "../_shared/db/user-client.ts";
import { createInternalClient } from "../_shared/db/internal-client.ts";
import { createReportOperatorExecutor } from "./report-operator-http.ts";
import { createProfileImageExecutor } from "./profile-image-http.ts";
import { createServiceApi } from "./handler.ts";
import type { DiagnosticLogger } from "../_shared/observability/logger.ts";
import { createRpcPublicPostSearchRepository } from "../_shared/db/repositories/search.ts";
import { searchPublicPosts } from "../_shared/services/search-service.ts";
import { createRpcEventRepository, listEventFilterValues } from "../_shared/db/repositories/events.ts";
import { createMemberCleanupExecutor, type MemberCleanupExecutionOptions } from "../_shared/services/member-lifecycle-service.ts";

/** 실제 실행과 통합 검증이 같은 설정·인증·DB 의존성 조립을 사용한다. */
export function createRuntimeHandler(
  read: EnvReader,
  options: { diagnostics?: DiagnosticLogger; publicPostSearch?: PublicPostSearchExecutor; memberCleanup?: boolean; memberRetirement?: boolean; memberCleanupExecution?: MemberCleanupExecutionOptions; memberCleanupReconcile?: MemberCleanupReconcileReadiness; contentInspection?: { readiness: ContentInspectionReadiness; classifier: ContentClassifier } } = {},
): (request: Request) => Promise<Response> {
  const config = loadRuntimeConfig(read);
  // 신고 상세 4000자와 JSON 이스케이프를 실제 서비스 진입점에서 수용한다.
  if (config.maxRequestBytes < 65536) throw new HttpError("EXTERNAL_UNAVAILABLE");
  // 명시적인 로컬 검증 옵션에서만 연결한다. DB 권한이나 삭제 승인을 변경하지 않는다.
  if (options.memberRetirement === true && options.memberCleanup !== true) throw new HttpError("EXTERNAL_UNAVAILABLE");
  const content = options.contentInspection;
  if (content && (content.readiness?.approved !== true || ![content.readiness.decisionId, content.readiness.policyVersion, content.readiness.scannerVersion].every(value => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(value)))) throw new HttpError("EXTERNAL_UNAVAILABLE");
  const inspect = content ? createContentInspectionExecutor(config, content.readiness, content.classifier) : undefined;
  const cleanup = options.memberCleanup === true ? createMemberCleanupExecutor(config, fetch, options.memberCleanupExecution) : undefined;
  const reconcile = options.memberCleanupReconcile ? createMemberCleanupReconcileExecutor(config, options.memberCleanupReconcile) : undefined;
  const finalize = options.memberCleanupReconcile ? createMemberCleanupFinalizationExecutor(config, options.memberCleanupReconcile) : undefined;
  const authenticatePublic = async (request: Request) => {
    const principal = await requireOptionalPrincipal(request, config);
    return principal
      ? { db: createUserClient(config, principal), caller: "member" as const }
      : { db: createPublicClient(config), caller: "anonymous" as const };
  };
  return createServiceApi({
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
    allowedOrigins: config.allowedOrigins,
    maxBodyBytes: config.maxRequestBytes,
    ...(options.memberRetirement === true ? { memberRetirement: true as const } : {}),
    ...(inspect ? { contentInspection: { execute: inspect } } : {}),
    ...(reconcile && finalize ? { memberCleanupReconcile: { execute: reconcile, finalize } } : {}),
    profileImages: { execute: createProfileImageExecutor(config) },
    reportOperator: { execute: createReportOperatorExecutor(config) },
    ...(cleanup ? { memberCleanup: { execute: (_db, token, signal, allocation) => {
      if (!allocation) return cleanup(token, signal);
      // 영속 배정의 시간·수량을 기존 실제 drain에 전달한다. 로컬 검증 상한도 넓히지 않는다.
      const execution = options.memberCleanupExecution;
      const bounded = createMemberCleanupExecutor(config, fetch, {
        limit: Math.min(allocation.limit, execution?.limit ?? allocation.limit),
        maxExecutionMs: Math.min(allocation.remainingMs, execution?.maxExecutionMs ?? allocation.remainingMs),
      });
      return bounded(token, signal);
    } } } : {}),
    publicSearch: {
      authenticate: authenticatePublic,
      execute: options.publicPostSearch ?? ((db, input) =>
        searchPublicPosts(createRpcPublicPostSearchRepository(db), input)),
    },
    publicEvents: {
      authenticate: authenticatePublic,
      execute: (db, input) => createRpcEventRepository(db).listPage(input.query, input.cursor, input.limit),
      filters: listEventFilterValues,
    },
    publicPostDetails: { authenticate: authenticatePublic },
    authenticateUser: async (request) => {
      const principal = await requirePrincipal(request, config);
      return inspect ? createContentWriteClient(config, principal, request) : createUserClient(config, principal);
    },
    ...(options.memberRetirement===true?{authenticateRetirement:async(request:Request)=>{
      let sessionRejected=false;
      try{
        const principal=await requirePrincipal(request,config,async(url,init)=>{
          const response=await fetch(url,init);
          // 구조/키/비정상 Auth body/장애가 아니라 실제 /user의 세션 거절만 허용한다.
          sessionRejected=response.status===401||response.status===403;
          return response;
        });
        return {kind:"active" as const,db:createUserClient(config,principal)};
      }catch(error){
        if(!sessionRejected||toPublicError(error).error.code!=="AUTH_REQUIRED")throw error;
        return {kind:"revoked" as const,receipt:createRetirementReceiptClient(config,request)};
      }
    }}:{}),
    authenticateInternal: async (request) => {
      await requireInternalCaller(request, config);
      return createInternalClient(config);
    },
    maintenance: { modelVersion: config.reviewSummaryModelVersion, promptVersion: config.reviewSummaryPromptVersion },
  });
}

// 공개 검색은 종현 검색 서비스·RPC repository를 거쳐 공통 인증 client로 실행한다.
// 호스팅 런타임이 모듈을 import해도 fetch 진입점이 존재한다.
// import 자체는 환경을 읽거나 서버를 시작하지 않아 factory 기반 검증과 분리된다.
let runtimeHandler: ((request: Request) => Promise<Response>) | undefined;
const entrypoint = {
  fetch(request: Request): Promise<Response> {
    runtimeHandler ??= createRuntimeHandler((key) => Deno.env.get(key));
    return runtimeHandler(request);
  },
};
export default entrypoint;

if (import.meta.main) Deno.serve(entrypoint.fetch);
