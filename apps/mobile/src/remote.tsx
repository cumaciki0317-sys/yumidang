import { useSyncExternalStore } from "react";
import { YumidangService } from "./service";
import { ApiError, ServiceApiClient } from "./api";
import { MemberService, uuid } from "./member-service";
import type { MemberSessionPort, SessionResult } from "./member-session";
import { retirementResult, sessionResult } from "./member-session";
import { createPhotoStoragePort, createMemberReportCaptureUpload, type PhotoStoragePort, type ReportCaptureInput } from "./avatar-service";
import { createWebMemberSessionPort, discardWebMemberSession, subscribeWebMemberSessionDiscard, type WebSessionOptions } from "./web-member-session";

/** The Naver auth integration installs a verified user session here. Never an EXPO_PUBLIC token. */
let token: string | null = null;
let epoch = 0;
const listeners = new Set<() => void>();
export function installServiceSession(accessToken: string | null) {
  clearRetirementBinding(true);
  if (sessionDetails?.accessToken !== accessToken) sessionDetails = null;
  token = accessToken;
  epoch++;
  listeners.forEach((listener) => listener());
}
export const serviceSessionEpoch = () => epoch;
export const serviceAccessToken = async () => {
  if (token === null) return null;
  const expectedEpoch = epoch, expectedPort = sessionPort;
  if (!expectedPort?.accessToken) return token;
  try {
    const current = await expectedPort.accessToken();
    if (epoch !== expectedEpoch || sessionPort !== expectedPort) return null;
    if (!current) { clearNormalMemberSession(); return null; }
    token = current;
    if (sessionDetails) sessionDetails = { ...sessionDetails, accessToken: current };
    return current;
  } catch (error) {
    if (epoch === expectedEpoch && sessionPort === expectedPort) clearNormalMemberSession();
    throw error;
  }
};
export function useServiceSession() {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => epoch,
    () => 0,
  );
  return { authenticated: token !== null, epoch };
}
export const serviceMode = process.env.EXPO_PUBLIC_DATA_MODE === "service";
let service: YumidangService | null = null;
let memberService: MemberService | null = null;
export let serviceConfigurationError = false;
if (serviceMode) {
  try {
    const serviceApiUrl = process.env.EXPO_PUBLIC_SERVICE_API_URL;
    if (!serviceApiUrl) throw new Error("SERVICE_URL_NOT_CONFIGURED");
    service = new YumidangService({
      serviceApiUrl,
      aiChatUrl: process.env.EXPO_PUBLIC_AI_CHAT_URL,
      accessToken: serviceAccessToken,
    });
    memberService = new MemberService(new ServiceApiClient(serviceApiUrl, serviceAccessToken));
  } catch {
    serviceConfigurationError = true;
  }
}
export function useService() {
  return service;
}
export function useMemberService() { return memberService; }
let sessionPort: MemberSessionPort | null = null;
let unsubscribeSessionDiscard: (() => void) | null = null;
let photoPort: PhotoStoragePort | null = null;
let memberReportCapture: ((input: ReportCaptureInput) => Promise<{ assetId: string }>) | null = null;
let sessionDetails: SessionResult | null = null;
let portsEpoch = 0;
const portListeners = new Set<() => void>();
function changedPorts() { portsEpoch++; portListeners.forEach(f => f()); }
/** Trusted integration only. The app never invents an Origin or a callback URL. */
export function installMemberSessionPort(port: MemberSessionPort | null) {
  if (sessionPort !== port) {
    unsubscribeSessionDiscard?.(); unsubscribeSessionDiscard = null;
    clearRetirementBinding(true); clearNormalMemberSession(); sessionPort = port;
    if (port) unsubscribeSessionDiscard = subscribeWebMemberSessionDiscard(port, () => { if (sessionPort === port) { clearRetirementBinding(false); clearNormalMemberSession(); } });
  }
  changedPorts();
}
export function installPhotoStoragePort(port: PhotoStoragePort | null) { photoPort = port; changedPorts(); }
export function installMemberReportCaptureUpload(port: typeof memberReportCapture) { memberReportCapture = port; changedPorts(); }
export function installMemberSessionDetails(details: SessionResult | null) {
  const verified = details === null ? null : sessionResult(details);
  clearRetirementBinding(details === null);
  sessionDetails = verified; token = verified?.accessToken ?? null; epoch++; listeners.forEach(listener => listener());
}
export function useMemberPorts() {
  useSyncExternalStore(f => { portListeners.add(f); return () => { portListeners.delete(f); }; }, () => portsEpoch, () => 0);
  return { session: sessionPort, photo: photoPort, reportCapture: memberReportCapture };
}
export function useMemberSessionDetails() { useServiceSession(); return sessionDetails; }
export type MemberRetirementReceipt = ReturnType<typeof retirementResult>;
/** JWT·UID·프로필은 공개 상태에 넣지 않는다. receipt:null은 응답 미확정이며 탈퇴 완료가 아니다. */
export interface MemberRetirementState {
  readonly withdrawalId: string;
  readonly receipt: Readonly<MemberRetirementReceipt> | null;
  readonly busy: boolean;
  readonly errorCode: "AUTH_REQUIRED" | "RETIREMENT_STATUS_UNCONFIRMED" | null;
}
let retirementState: Readonly<MemberRetirementState> | null = null;
let retirementBinding: { port: MemberSessionPort; userId: string; epoch: number } | null = null;
const retirementListeners = new Set<() => void>();
function publishRetirement(state: MemberRetirementState | null) {
  retirementState = state === null ? null : Object.freeze({ ...state, receipt: state.receipt === null ? null : Object.freeze({ ...state.receipt }) });
  retirementListeners.forEach(listener => listener());
}
function clearRetirementBinding(discard: boolean) {
  if (discard) discardWebMemberSession(retirementBinding?.port ?? sessionPort);
  retirementBinding = null;
  if (retirementState !== null) publishRetirement(null);
}
/** 정상 회원 권한만 회수하고 같은 요청의 최소 영수증은 남긴다. */
function clearNormalMemberSession() {
  sessionDetails = null; token = null; epoch++;
  if (retirementBinding) retirementBinding.epoch = epoch;
  listeners.forEach(listener => listener());
}
export const memberRetirementSnapshot = () => retirementState;
export function subscribeMemberRetirement(listener: () => void) { retirementListeners.add(listener); return () => { retirementListeners.delete(listener); }; }
export function useMemberRetirement() { return useSyncExternalStore(subscribeMemberRetirement, memberRetirementSnapshot, () => null); }
/** UI는 최초 확인과 수동 같은-ID 상태 확인에만 이 함수를 호출한다. 자동 재시도/폴링 없음. */
export async function requestMemberRetirement(withdrawalId: string, signal: AbortSignal = new AbortController().signal) {
  const id = uuid(withdrawalId).toLowerCase();
  let created = false;
  if (!retirementBinding) {
    if (!sessionPort?.retire) throw new ApiError(503, "RETIREMENT_NOT_CONFIGURED");
    if (!sessionDetails || sessionDetails.status !== "ready" || token === null) throw new ApiError(401, "AUTH_REQUIRED");
    retirementBinding = { port: sessionPort, userId: sessionDetails.userId, epoch }; created = true;
    publishRetirement({ withdrawalId: id, receipt: null, busy: false, errorCode: null });
  }
  const binding = retirementBinding;
  if (!retirementState || retirementState.withdrawalId !== id) throw new ApiError(409, "RETIREMENT_REQUEST_CHANGED");
  if (retirementState.busy) throw new ApiError(409, "RETIREMENT_IN_PROGRESS");
  const checkBinding = () => {
    if (binding !== retirementBinding || sessionPort !== binding.port || epoch !== binding.epoch || (sessionDetails !== null && sessionDetails.userId !== binding.userId)) throw new ApiError(401, "SESSION_CHANGED");
  };
  checkBinding();
  publishRetirement({ ...retirementState, busy: true, errorCode: null });
  try {
    const receipt = retirementResult(await binding.port.retire!(id, signal), id);
    checkBinding();
    if (retirementState?.receipt?.status === "completed" && receipt.status !== "completed") throw new ApiError(502, "INVALID_SERVICE_RESPONSE");
    publishRetirement({ withdrawalId: id, receipt, busy: false, errorCode: null });
    clearNormalMemberSession();
    return { ...receipt };
  } catch (error) {
    if (created && error instanceof ApiError && error.code === "SESSION_CHANGED" && retirementBinding === binding) { clearRetirementBinding(false); throw error; }
    if (retirementBinding === binding && sessionPort === binding.port && retirementState?.withdrawalId === id) publishRetirement({ ...retirementState, busy: false, errorCode: error instanceof ApiError && (error.status === 401 || error.status === 403) ? "AUTH_REQUIRED" : "RETIREMENT_STATUS_UNCONFIRMED" });
    throw error;
  }
}

/** Supplied by trusted app initialization after M verifies exact deployed URLs/public key. No new env or secret. */
export function installWebMemberConnection(options: WebSessionOptions) {
  if (!memberService) throw new Error("SERVICE_NOT_CONFIGURED");
  if (options.retirementContract !== undefined) {
    const configured = new URL(process.env.EXPO_PUBLIC_SERVICE_API_URL ?? ""), project = new URL(options.supabaseUrl);
    if (configured.protocol !== "https:" || configured.origin !== project.origin || configured.pathname !== "/functions/v1/service-api" || configured.username || configured.password || configured.search || configured.hash) throw new ApiError(400, "INVALID_RETIREMENT_CONFIGURATION");
  }
  const port = createWebMemberSessionPort(options);
  const storage = { supabaseUrl: options.supabaseUrl, publicApiKey: options.publicApiKey, accessToken: serviceAccessToken, fetcher: options.fetcher };
  const photo = createPhotoStoragePort(storage), capture = createMemberReportCaptureUpload(storage, memberService);
  installMemberSessionPort(port);
  installPhotoStoragePort(photo);
  installMemberReportCaptureUpload(capture);
  const messages = memberService;
  installMessageReadPort(options.messageReadContract === "2026-10-08-individual-message-read"
    ? { markVisible: (conversationId, messageIds, signal) => messages.markMessagesRead(conversationId, messageIds, signal) }
    : null);
}

/** 민규가 실제 Storage 업로드를 설치한다. 파일/토큰은 요청 메모리에서만 사용한다.
 * signal 취소·응답 유실·신고 접수 실패로 연결되지 않은 업로드의 정리는 실제 Storage 구현이 처리한다.
 * clientRequestId로 재시도 업로드를 멱등 처리하고 임시 자료 보관 숫자를 여기서 새로 정하지 않는다.
 */
export type AiReportCaptureUpload = (input: {
  asset: import("expo-image-picker").ImagePickerAsset;
  requestId: string;
  clientRequestId: string;
  accessToken: string;
  signal: AbortSignal;
}) => Promise<{ assetId: string }>;
let reportCaptureUpload: AiReportCaptureUpload | null = null;
let captureUploadEpoch = 0;
const captureListeners = new Set<() => void>();
export function installAiReportCaptureUpload(upload: AiReportCaptureUpload | null) {
  if (reportCaptureUpload === upload) return;
  reportCaptureUpload = upload;
  captureUploadEpoch++;
  captureListeners.forEach(listener => listener());
}
export function useAiReportCaptureUpload() {
  return useSyncExternalStore(
    listener => { captureListeners.add(listener); return () => { captureListeners.delete(listener); }; },
    () => reportCaptureUpload,
    () => null,
  );
}

export const aiReportCaptureUploadEpoch = () => captureUploadEpoch;
export function useAiReportCaptureUploadEpoch() {
  return useSyncExternalStore(
    listener => { captureListeners.add(listener); return () => { captureListeners.delete(listener); }; },
    aiReportCaptureUploadEpoch,
    () => 0,
  );
}

/** No watermark fallback: unseen earlier messages must remain unread. */
let messageReadPort: import("./chat-read-state").MessageReadPort | null = null;
const messageReadListeners = new Set<() => void>();
export function installMessageReadPort(port: import("./chat-read-state").MessageReadPort | null) {
  if (messageReadPort === port) return;
  messageReadPort = port;
  messageReadListeners.forEach(listener => listener());
}
export function useMessageReadPort() {
  return useSyncExternalStore(listener => { messageReadListeners.add(listener); return () => { messageReadListeners.delete(listener); }; }, () => messageReadPort, () => null);
}
