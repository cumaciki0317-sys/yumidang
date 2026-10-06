/** 민규담당. 명시된 경로·메서드·입력만 허용하며 임의 RPC 전달 기능은 없다. */
import type { JsonValue } from "../_shared/contracts/common.ts";
import { parseProfileTraits, parseProfilePreferences } from "../_shared/contracts/signup.ts";
import type { AppointmentLocationInput } from "../_shared/contracts/matching.ts";
import { POST_REGIONS } from "../_shared/contracts/search.ts";
import type { FreePostInput } from "../_shared/contracts/posts.ts";
import type { RpcClient } from "../_shared/db/transport.ts";
import { HttpError, toPublicError } from "../_shared/http/errors.ts";
import { inspectReviewSummaryConfig } from "../_shared/config/env.ts";
import * as completion from "../_shared/services/completion-service.ts";
import * as reviews from "../_shared/services/review-service.ts";
import { parseMemberReport, reportObject, reportUuid } from "../_shared/contracts/reports.ts";
import * as reports from "../_shared/services/report-service.ts";
import * as profiles from "../_shared/services/profile-service.ts";
import * as notifications from "../_shared/services/notification-service.ts";
import * as conversations from "../_shared/services/conversation-service.ts";
import * as posts from "../_shared/services/post-service.ts";
import * as matching from "../_shared/services/matching-service.ts";

export interface MaintenanceConfig { modelVersion?: string; promptVersion?: string }
interface RouteContext {
  db: RpcClient;
  url: URL;
  body: JsonValue;
  maintenance?: MaintenanceConfig;
}
export interface Route {
  method: "GET" | "POST";
  internal: boolean;
  /** 경로·UUID·메서드 검증을 마친 공개 공고 상세 GET에만 표시한다. */
  publicPostDetail?: true;
  execute(context: RouteContext): Promise<JsonValue>;
}
const invalid = (): never => { throw new HttpError("INVALID_REQUEST"); };
function object(value: JsonValue, required: string[], optional: string[] = []): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const allowed = [...required, ...optional];
  if (Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) return invalid();
  return value;
}
function text(value: JsonValue | undefined, min: number, max: number): string {
  if (typeof value !== "string" || value !== value.trim() || [...value].length < min || [...value].length > max) return invalid();
  return value;
}
function uuid(value: JsonValue | undefined): string {
  const result = text(value, 36, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result)) return invalid();
  return result;
}
function integer(value: JsonValue | undefined, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return invalid();
  return value;
}
function strings(value: JsonValue | undefined, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) return invalid();
  const result = value.map((item) => text(item, 1, maxLength));
  if (new Set(result).size !== result.length) return invalid();
  return result;
}
function optionalText(value: JsonValue | undefined, max: number): string | null {
  return value === null || value === undefined ? null : text(value, 1, max);
}
function timestamp(value: JsonValue | undefined): string {
  const result = text(value, 20, 35);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(result) || !Number.isFinite(Date.parse(result))) return invalid();
  // Date.parse는 2월 30일을 다음 달로 보정할 수 있으므로 달력 날짜도 검사한다.
  const date = result.slice(0, 10);
  if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) return invalid();
  return result;
}
function query(url: URL, allowed: string[]) {
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => !allowed.includes(key)) || new Set(keys).size !== keys.length) invalid();
}
function page(url: URL): [number, string | null] {
  query(url, ["limit", "before"]);
  const limit = url.searchParams.get("limit");
  if (limit !== null && !/^[1-9]\d*$/.test(limit)) invalid();
  const before = url.searchParams.get("before");
  return [integer(limit === null ? 20 : Number(limit), 1, 100), before === null ? null : uuid(before)];
}
/** 공고 등록과 장소 제안의 위치 필드 길이·공백·선택 장소명 검증을 공유한다. */
function placeFields(data: Record<string, JsonValue>): AppointmentLocationInput {
  return { publicArea: text(data.publicArea, 1, 60), registeredPlaceName: optionalText(data.registeredPlaceName, 200),
    registeredAddress: text(data.registeredAddress, 1, 300), meetingDetail: text(data.meetingDetail, 2, 300) };
}
function proposedLocation(value: JsonValue): AppointmentLocationInput {
  const result = placeFields(object(value, ["publicArea", "registeredPlaceName", "registeredAddress", "meetingDetail"]));
  const aliases: Record<string, string> = { 서울: "서울특별시", 부산: "부산광역시", 대구: "대구광역시", 인천: "인천광역시",
    광주: "광주광역시", 대전: "대전광역시", 울산: "울산광역시", 세종: "세종특별자치시", 경기: "경기도", 강원: "강원특별자치도",
    강원도: "강원특별자치도", 충북: "충청북도", 충남: "충청남도", 전북: "전북특별자치도", 전라북도: "전북특별자치도",
    전남: "전라남도", 경북: "경상북도", 경남: "경상남도", 제주: "제주특별자치도" };
  const first = result.publicArea.split(" ", 1)[0], region = aliases[first] ?? first;
  if (!POST_REGIONS.some((value) => value === region)) invalid();
  result.publicArea = region + result.publicArea.slice(first.length);
  if (!/^[가-힣]+(특별시|광역시|특별자치시|특별자치도|도) [가-힣]+(시|군|구)( [가-힣]+구)? [가-힣0-9]+(동|읍|면|가)$/.test(result.publicArea)) invalid();
  return result;
}
function postInput(body: JsonValue, postId?: string): { id: string; input: FreePostInput; expectedUpdatedAt?: string } {
  const data = object(body, [postId === undefined ? "postId" : "expectedUpdatedAt", "title", "description", "category", "startsAt", "endsAt", "publicArea", "registeredAddress", "meetingDetail", "costType", "amount"], ["recruitmentEndsAt", "registeredPlaceName", "preferenceNote", "tags", "eventId"]);
  if (["paid_request", "paid_offer"].includes(String(data.costType))) throw new HttpError("EXTERNAL_UNAVAILABLE");
  if (data.costType !== "free" || data.amount !== 0) invalid();
  const startsAt = timestamp(data.startsAt), endsAt = timestamp(data.endsAt), recruitmentEndsAt = data.recruitmentEndsAt === undefined ? startsAt : timestamp(data.recruitmentEndsAt);
  if (Date.parse(startsAt) >= Date.parse(endsAt) || Date.parse(recruitmentEndsAt) > Date.parse(startsAt)) invalid();
  const category = text(data.category, 1, 20);
  if (!["지금이당", "전시", "축제", "팝업", "공연", "영화", "맛집", "카페", "쇼핑", "여행", "운동", "산책", "게임", "반려동물", "스터디", "기타"].includes(category)) invalid();
  return { id: postId ?? uuid(data.postId), ...(postId === undefined ? {} : { expectedUpdatedAt: timestamp(data.expectedUpdatedAt) }), input: {
    title: text(data.title, 2, 50), description: text(data.description, 1, 2000), category,
    startsAt, endsAt, recruitmentEndsAt, ...placeFields(data), preferenceNote: optionalText(data.preferenceNote, 300),
    tags: strings(data.tags ?? [], 5, 20), costType: "free", amount: 0,
    // 키를 생략한 기존 수정 요청은 연결을 보존한다. 명시 null로 바꾸지 않는다.
    ...(Object.hasOwn(data, "eventId") ? { eventId: data.eventId === null ? null : uuid(data.eventId) } : {}),
  } };
}

export function resolveRoute(url: URL): Route {
  // 정확한 function prefix만 제거한다. /evil/.../service-api 같은 suffix 일치는 금지한다.
  const prefix = ["/functions/v1/service-api", "/service-api"].find((value) => url.pathname.startsWith(value + "/"));
  if (!prefix) throw new HttpError("RESOURCE_NOT_FOUND");
  const path = url.pathname.slice(prefix.length);
  if (path.includes("%") || path.includes("//")) throw new HttpError("RESOURCE_NOT_FOUND");
  function route(method: "GET" | "POST", run: (context: RouteContext) => Promise<JsonValue>, internal = false, paginated = false): Route {
    return { method, internal, execute: (context) => {
      if (!paginated) query(context.url, []);
      return run(context);
    } };
  }
  function empty(body: JsonValue) { object(body, []); }
  if (path === "/me/avatar") return route("POST", ({ db, body }) => {
    const avatarPath = text(object(body, ["avatarPath"]).avatarPath, 77, 77);
    if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/.test(avatarPath)) invalid();
    // 소유자·존재·MIME·용량은 DB가 실제 storage 객체로 검증한다.
    return profiles.setProfileAvatar(db, avatarPath);
  });
  if(path==="/me/hidden-targets")return route("GET",({db,url})=>reports.listMyHiddenTargets(db,...page(url)),false,true);
  if(path==="/me/hidden-targets/unhide")return route("POST",({db,body,url})=>{
    query(url,[]);const input=reportObject(body,["targetType","targetId"]);
    if(typeof input.targetType!=="string"||!["post","chat","appointment","member","event"].includes(input.targetType))return invalid();
    return reports.unhideMyReportTarget(db,input.targetType,reportUuid(input.targetId));
  });
  if (path === "/reports") return route("POST", ({ db, body }) => reports.submitMemberReport(db, parseMemberReport(body)));
  if (path === "/cancellation-notices") return route("GET", ({ db, url }) => {
    const [limit,before]=page(url);
    return reports.listMyCancellationNotices(db,limit,before);
  }, false, true);
  const cancellationNoticeMatch = /^\/cancellation-notices\/([^/]+)\/read$/.exec(path);
  if (cancellationNoticeMatch) { const id=reportUuid(cancellationNoticeMatch[1]); return route("POST", ({ db, body, url }) => {
    query(url,[]); empty(body); return reports.readMyCancellationNotice(db,id);
  }); }
  if (path === "/decision-notices") return route("GET", ({ db, url }) => reports.listMyDecisionNotices(db, ...page(url)), false, true);
  const decisionNoticeMatch = /^\/decision-notices\/([^/]+)\/read$/.exec(path);
  if (decisionNoticeMatch) { const id = reportUuid(decisionNoticeMatch[1]); return route("POST", ({ db, body, url }) => {
    query(url, []); empty(body); return reports.readMyDecisionNotice(db, id);
  }); }
  const generalDeliveryMatch = /^\/decision-notices\/([^/]+)\/(prepare-delivery|provided)$/.exec(path);
  if (generalDeliveryMatch) { const id = reportUuid(generalDeliveryMatch[1]); return route("POST", ({ db, body, url }) => {
    query(url, []);
    if (generalDeliveryMatch[2] === "prepare-delivery") { empty(body); return reports.prepareMyGeneralNoticeDelivery(db, id); }
    const input = reportObject(body, ["deliveryId"]);
    return reports.acknowledgeMyGeneralNoticeProvided(db, id, reportUuid(input.deliveryId));
  }); }
  if (path === "/me/general-sanction-appeals") return route("POST", ({ db, body, url }) => {
    query(url, []); const input = reportObject(body, ["noticeId", "clientRequestId", "reason"]);
    if (typeof input.reason !== "string" || input.reason.trim() !== input.reason || [...input.reason].length < 1 || [...input.reason].length > 4000 || /[\x00-\x1f\x7f]/.test(input.reason)) invalid();
    return reports.submitMyGeneralSanctionAppeal(db, reportUuid(input.noticeId), reportUuid(input.clientRequestId), input.reason as string);
  });
  const generalAppealMatch = /^\/me\/general-sanction-appeals\/([^/]+)$/.exec(path);
  if (generalAppealMatch) { const id = reportUuid(generalAppealMatch[1]); return route("GET", ({ db, url }) => {
    query(url, []); return reports.getMyGeneralSanctionAppeal(db, id);
  }, false, true); }
  if (path === "/me/safety") return route("GET", ({ db }) => reports.getMySafetyState(db));
  if (path === "/me/sanctions") return route("GET", ({ db, url }) => reports.listMySanctions(db, ...page(url)), false, true);
  if (path === "/me/reports") return route("GET", ({ db, url }) => reports.listMyReports(db, ...page(url)), false, true);
  if (path === "/report-captures") return route("POST", ({ db, body }) => {
    const input = reportObject(body, ["assetId", "extension"]);
    if (typeof input.extension !== "string" || !["jpg", "png", "webp"].includes(input.extension)) invalid();
    return reports.reserveReportCapture(db, reportUuid(input.assetId), input.extension as string);
  });
  const reportMatch = /^\/me\/reports\/([^/]+)$/.exec(path);
  if (reportMatch) { const id = reportUuid(reportMatch[1]); return route("GET", ({ db }) => reports.getMyReport(db, id)); }
  const captureMatch = /^\/report-captures\/([^/]+)\/(confirm|cancel)$/.exec(path);
  if (captureMatch) { const id = reportUuid(captureMatch[1]); return route("POST", ({ db, body }) => {
    empty(body); return captureMatch[2] === "confirm" ? reports.confirmReportCapture(db, id) : reports.cancelReportCapture(db, id);
  }); }
  if (path === "/me/blocks") return route("GET", ({ db, url }) => profiles.listMyBlocks(db, ...page(url)), false, true);
  if (path === "/me") return route("GET", ({ db }) => profiles.getOwnProfile(db));
  if (path === "/me/preferences") return route("POST", ({ db, body }) => profiles.setProfilePreferences(db, parseProfilePreferences(body)));
  if (path === "/me/traits") return route("GET", ({ db }) => db.rpc("get_my_profile_traits", {}));
  if (path === "/me/ai-processing/withdraw") return route("POST", ({ db, body }) => {
    const input = object(body, ["kind"]);
    if (input.kind !== "exploration" && input.kind !== "review_summary") invalid();
    return db.rpc("withdraw_my_ai_processing", { p_kind: input.kind });
  });
  if (path === "/reviews/praises") return route("GET", ({ db }) => reviews.getPraiseCatalog(db));
  if (path === "/appointments") return route("GET", ({ db }) => completion.listAppointments(db));
  let match = /^\/appointments\/([^/]+)\/cancellation-appeals\/submit$/.exec(path);
  if (match) {
    const id = uuid(match[1]);
    return route("POST", ({ db, body, url }) => {
      query(url, []);
      const input = object(body, ["clientRequestId", "expectedResultRevision", "reasonCodes", "description", "assetIds", "hideTarget"]);
      const report = parseMemberReport({ clientRequestId: input.clientRequestId, targetType: "appointment", targetId: id, context: "offline",
        reasonCodes: input.reasonCodes, description: input.description, assetIds: input.assetIds, hideTarget: input.hideTarget });
      return completion.submitAppointmentCancelAppealWithReport(db, id, { ...report,
        expectedResultRevision: integer(input.expectedResultRevision, 1, Number.MAX_SAFE_INTEGER - 1) });
    });
  }
  match = /^\/appointments\/([^/]+)\/cancellation-appeals$/.exec(path);
  if (match) {
    const id = uuid(match[1]);
    return route("GET", ({ db, url }) => { query(url, []); return completion.getMyAppointmentCancelAppeal(db, id); });
  }
  match = /^\/appointments\/([^/]+)\/schedule-change(?:\/(propose|accept|decline|withdraw))?$/.exec(path);
  if (match) {
    const id = uuid(match[1]), action = match[2];
    if (!action) return route("GET", ({ db }) => completion.getAppointmentChangeState(db, id));
    return route("POST", ({ db, body }) => {
      if (action === "propose") {
        const data = object(body, ["changeId", "startsAt", "endsAt", "expectedUpdatedAt"], ["location"]);
        const startsAt = timestamp(data.startsAt), endsAt = timestamp(data.endsAt);
        if (Date.parse(startsAt) >= Date.parse(endsAt)) invalid();
        return completion.proposeAppointmentScheduleChange(db, id, { changeId: uuid(data.changeId), startsAt, endsAt, expectedUpdatedAt: timestamp(data.expectedUpdatedAt),
          ...(Object.hasOwn(data, "location") ? { location: proposedLocation(data.location) } : {}) });
      }
      const data = object(body, ["changeId", "conditionVersion"]);
      const input = { changeId: uuid(data.changeId), conditionVersion: text(data.conditionVersion, 1, 200) };
      if (action === "accept") return completion.acceptAppointmentScheduleChange(db, id, input);
      if (action === "decline") return completion.declineAppointmentScheduleChange(db, id, input);
      return completion.withdrawAppointmentScheduleChange(db, id, input);
    });
  }
  match = /^\/appointments\/([^/]+)\/cancel$/.exec(path);
  if (match) {
    const id = uuid(match[1]);
    return route("POST", ({ db, body }) => {
      const data = object(body, ["cancellationId", "reason"]);
      return completion.cancelAppointment(db, id, { cancellationId: uuid(data.cancellationId), reason: text(data.reason, 1, 300) });
    });
  }
  match = /^\/appointments\/([^/]+)(?:\/(confirm-completion|reviews))?$/.exec(path);
  if (match) {
    const id = uuid(match[1]);
    if (match[2] === "confirm-completion") return route("POST", ({ db, body }) => { empty(body); return completion.confirmCompletion(db, id); });
    if (match[2] === "reviews") {
      // 같은 경로의 GET·POST는 resolveRouteForMethod에서 구분한다.
      return route("GET", ({ db }) => reviews.getReviewState(db, id));
    }
    return route("GET", ({ db }) => completion.getAppointment(db, id));
  }
  match = /^\/profiles\/([^/]+)\/(block|unblock)$/.exec(path);
  if (match) {
    const id = uuid(match[1]), action = match[2];
    return route("POST", ({ db, body }) => { empty(body); return action === "block" ? profiles.blockMember(db, id) : profiles.unblockMember(db, id); });
  }
  match = /^\/profiles\/([^/]+)\/review-summary$/.exec(path);
  if (match) { const id = uuid(match[1]); return route("GET", ({ db, url }) => { query(url, []); return reviews.getVisibleSummary(db, id); }); }
  match = /^\/profiles\/([^/]+)\/reviews$/.exec(path);
  if (match) { const id = uuid(match[1]); return route("GET", ({ db, url }) => reviews.getPublicReviews(db, id, ...page(url)), false, true); }
  match = /^\/profiles\/([^/]+)$/.exec(path);
  if (match) { const id = uuid(match[1]); return route("GET", ({ db }) => profiles.getPublicProfile(db, id)); }
  if (path === "/notifications") return route("GET", ({ db, url }) => notifications.listNotifications(db, ...page(url)), false, true);
  if (path === "/notifications/read-all") return route("POST", ({ db, body }) => { empty(body); return notifications.readAllNotifications(db); });
  match = /^\/notifications\/([^/]+)\/read$/.exec(path);
  if (match) { const id = uuid(match[1]); return route("POST", ({ db, body }) => { empty(body); return notifications.readNotification(db, id); }); }
  if (path === "/conversations") return route("GET", ({ db }) => conversations.listConversations(db));
  match = /^\/conversations\/([^/]+)\/leave$/.exec(path);
  if (match) {
    const id = uuid(match[1]);
    return route("POST", ({ db, body }) => { empty(body); return conversations.leaveConversation(db, id); });
  }
  match = /^\/conversations\/([^/]+)(?:\/(messages))?$/.exec(path);
  if (match) {
    const id = uuid(match[1]);
    return match[2] === "messages"
      ? route("GET", ({ db, url }) => conversations.listMessages(db, id, ...page(url)), false, true)
      : route("GET", ({ db }) => conversations.getConversation(db, id));
  }
  if (path === "/posts") return route("POST", ({ db, body }) => { const { id, input } = postInput(body); return posts.createPost(db, id, input); });
  match = /^\/posts\/([^/]+)(?:\/(requests|update|close|delete|reopen))?$/.exec(path);
  if (match) {
    const id = uuid(match[1]);
    if (match[2] === "update") return route("POST", ({ db, body }) => {
      const { input, expectedUpdatedAt } = postInput(body, id);
      return posts.updatePost(db, id, input, expectedUpdatedAt!);
    });
    if (match[2] === "reopen") return route("POST", ({ db, body }) => { empty(body); return posts.reopenPost(db, id); });
    if (match[2] === "close" || match[2] === "delete") {
      const action = match[2];
      return route("POST", ({ db, body }) => { empty(body); return action === "close" ? posts.closePost(db, id) : posts.deletePost(db, id); });
    }
    return match[2] === "requests"
      ? route("POST", ({ db, body }) => {
        const input = object(body, ["messageId", "message"]);
        return matching.createRequest(db, id, uuid(input.messageId), text(input.message, 1, 1000));
      })
      : route("GET", ({ db }) => posts.getPost(db, id));
  }
  if (path === "/requests/sent") return route("GET", ({ db }) => matching.listSentRequests(db));
  if (path === "/requests/received") return route("GET", ({ db }) => matching.listReceivedRequests(db));
  match = /^\/requests\/([^/]+)\/consent$/.exec(path);
  if (match) { const id = uuid(match[1]); return route("GET", ({ db }) => matching.getMatchConsent(db, id)); }
  match = /^\/requests\/([^/]+)\/consent\/(withdraw|decline)$/.exec(path);
  if (match) {
    const id = uuid(match[1]), action = match[2];
    return route("POST", ({ db, body }) => {
      const version = text(object(body, ["conditionVersion"]).conditionVersion, 1, 200);
      return action === "withdraw" ? matching.withdrawMatchConsent(db, id, version) : matching.declineMatchConsent(db, id, version);
    });
  }
  match = /^\/requests\/([^/]+)\/(withdraw|decline|propose|accept)$/.exec(path);
  if (match) {
    const id = uuid(match[1]), action = match[2];
    return route("POST", ({ db, body }) => {
      if (action === "accept") return matching.acceptMatch(db, id, text(object(body, ["conditionVersion"]).conditionVersion, 1, 200));
      empty(body);
      return action === "withdraw" ? matching.withdrawRequest(db, id) : action === "decline" ? matching.declineRequest(db, id) : matching.proposeMatch(db, id);
    });
  }
  if (path === "/internal/events/kopis-top10") return route("POST", ({ db, body }) => {
    const snapshot = object(body, ["snapshot"]).snapshot;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) invalid();
    // 순위·기간·수집 시각의 기술 검증은 service_role 전용 RPC가 수행한다.
    return db.rpc("store_kopis_top10_snapshot", { p_snapshot: snapshot });
  }, true);
  match = /^\/internal\/events\/kopis-top10\/([^/]+)$/.exec(path);
  if (match) {
    const mode = match[1];
    if (mode !== "all" && mode !== "musical") invalid();
    return route("GET", ({ db }) => db.rpc("get_kopis_top10_snapshot", { p_mode: mode }), true);
  }
  if (path === "/internal/maintenance") return route("POST", async ({ db, body, maintenance }): Promise<JsonValue> => {
    const limit = integer(object(body, ["limit"]).limit, 1, 100);
    const counts = (value: JsonValue, keys: string[]): Record<string, number> => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError("EXTERNAL_UNAVAILABLE");
      const result: Record<string, number> = {};
      for (const key of keys) {
        const count = value[key];
        if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new HttpError("EXTERNAL_UNAVAILABLE");
        result[key] = count;
      }
      return result;
    };
    // 만료 시각·관계·알림은 DB가 판단한다. 모델 설정과 무관하게 만료를 먼저 처리한다.
    const expired = counts(await matching.expireMatchConsents(db, limit), ["expiredCount"]);
    const scheduleExpired = counts(await completion.expireAppointmentChanges(db, limit), ["expiredCount"]);
    // 공개 실패 뒤 요약을 진행하거나 빈 성공으로 바꾸지 않는다.
    const published = counts(await reviews.processDueReviewPublications(db, limit), ["publishedCount"]);
    const result = {
      completion: { status: "managed_by_reservation" },
      consent: { status: "expired", ...expired },
      scheduleChange: { status: "expired", ...scheduleExpired },
      reviews: { status: "published", ...published },
    };
    const settings = inspectReviewSummaryConfig(maintenance);
    if (settings.status !== "ready") return { ...result, status: "partial", summary: { status: settings.status } };
    try {
      const queued = counts(await reviews.processReviewSummaryRefresh(db, limit, settings.modelVersion, settings.promptVersion), ["processedCount", "enqueuedCount"]);
      return { ...result, status: "ok", summary: { status: "queued", ...queued } };
    } catch (error) {
      const safe = toPublicError(error).error;
      return { ...result, status: "partial", summary: { status: "failed", code: safe.code, retryable: safe.retryable } };
    }
  }, true);
  throw new HttpError("RESOURCE_NOT_FOUND");
}

export function resolveRouteForMethod(url: URL, method: string): Route {
  const base = resolveRoute(url);
  if (method === "POST" && /^(?:\/functions\/v1)?\/service-api\/me\/traits$/.test(url.pathname)) {
    return { method: "POST", internal: false, execute: ({ db, body, url }) => {
      query(url, []);
      const traits = parseProfileTraits(body);
      return db.rpc("set_my_profile_traits", { p_interests: traits.interests, p_conversation_styles: traits.conversationStyles, p_mbti: traits.mbti });
    } };
  }
  if (method === "POST" && base.method === "GET") {
    const appeal = /\/appointments\/([^/]+)\/cancellation-appeals$/.exec(url.pathname);
    if (appeal) return { method: "POST", internal: false, execute: ({ db, body, url }) => {
      query(url, []);
      const input = object(body, ["clientRequestId", "expectedResultRevision", "reportId"]);
      return completion.submitAppointmentCancelAppeal(db, uuid(appeal[1]), {
        clientRequestId: uuid(input.clientRequestId), expectedResultRevision: integer(input.expectedResultRevision, 1, Number.MAX_SAFE_INTEGER - 1), reportId: uuid(input.reportId),
      });
    } };
    const review = /\/appointments\/([^/]+)\/reviews$/.exec(url.pathname);
    if (review) return { method: "POST", internal: false, execute: ({ db, body, url }) => {
      query(url, []);
      const input = object(body, ["rating", "experience"], ["comment", "praises"]);
      const experience = input.experience;
      if (experience !== "positive" && experience !== "neutral" && experience !== "negative") return invalid();
      const praises = strings(input.praises ?? [], 3, 40);
      if (experience !== "positive" && praises.length) return invalid();
      return reviews.submitReview(db, uuid(review[1]), { rating: integer(input.rating, 1, 5), experience, comment: optionalText(input.comment, 300), praises });
    } };
    const messages = /\/conversations\/([^/]+)\/messages$/.exec(url.pathname);
    if (messages) return { method: "POST", internal: false, execute: ({ db, body, url }) => {
      query(url, []);
      const input = object(body, ["messageId", "content"]);
      return conversations.sendMessage(db, uuid(messages[1]), uuid(input.messageId), text(input.content, 1, 1000));
    } };
  }
  if (method !== base.method) throw new HttpError("METHOD_NOT_ALLOWED");
  if (method === "GET" && /^(?:\/functions\/v1)?\/service-api\/posts\/[^/]+$/.test(url.pathname)) {
    // resolveRoute의 정확한 prefix/UUID 검사 뒤에만 허용한다. 잘못된 query는 공개 인증 전에 거절한다.
    query(url, []);
    return { ...base, publicPostDetail: true };
  }
  return base;
}
