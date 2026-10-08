import { useSyncExternalStore } from "react";
import { YumidangService } from "./service";
import { ServiceApiClient } from "./api";
import { MemberService } from "./member-service";
import type { MemberSessionPort, SessionResult } from "./member-session";
import { sessionResult } from "./member-session";
import { createPhotoStoragePort, createMemberReportCaptureUpload, type PhotoStoragePort, type ReportCaptureInput } from "./avatar-service";
import { createWebMemberSessionPort, type WebSessionOptions } from "./web-member-session";

/** The Naver auth integration installs a verified user session here. Never an EXPO_PUBLIC token. */
let token: string | null = null;
let epoch = 0;
const listeners = new Set<() => void>();
export function installServiceSession(accessToken: string | null) {
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
    if (!current) { installMemberSessionDetails(null); return null; }
    token = current;
    if (sessionDetails) sessionDetails = { ...sessionDetails, accessToken: current };
    return current;
  } catch (error) {
    if (epoch === expectedEpoch && sessionPort === expectedPort) installMemberSessionDetails(null);
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
let photoPort: PhotoStoragePort | null = null;
let memberReportCapture: ((input: ReportCaptureInput) => Promise<{ assetId: string }>) | null = null;
let sessionDetails: SessionResult | null = null;
let portsEpoch = 0;
const portListeners = new Set<() => void>();
function changedPorts() { portsEpoch++; portListeners.forEach(f => f()); }
/** Trusted integration only. The app never invents an Origin or a callback URL. */
export function installMemberSessionPort(port: MemberSessionPort | null) { if (sessionPort !== port) installMemberSessionDetails(null); sessionPort = port; changedPorts(); }
export function installPhotoStoragePort(port: PhotoStoragePort | null) { photoPort = port; changedPorts(); }
export function installMemberReportCaptureUpload(port: typeof memberReportCapture) { memberReportCapture = port; changedPorts(); }
export function installMemberSessionDetails(details: SessionResult | null) { sessionDetails = details === null ? null : sessionResult(details); installServiceSession(sessionDetails?.accessToken ?? null); }
export function useMemberPorts() {
  useSyncExternalStore(f => { portListeners.add(f); return () => { portListeners.delete(f); }; }, () => portsEpoch, () => 0);
  return { session: sessionPort, photo: photoPort, reportCapture: memberReportCapture };
}
export function useMemberSessionDetails() { useServiceSession(); return sessionDetails; }
/** Supplied by trusted app initialization after M verifies exact deployed URLs/public key. No new env or secret. */
export function installWebMemberConnection(options: WebSessionOptions) {
  if (!memberService) throw new Error("SERVICE_NOT_CONFIGURED");
  const port = createWebMemberSessionPort(options);
  const storage = { supabaseUrl: options.supabaseUrl, publicApiKey: options.publicApiKey, accessToken: serviceAccessToken, fetcher: options.fetcher };
  const photo = createPhotoStoragePort(storage), capture = createMemberReportCaptureUpload(storage, memberService);
  installMemberSessionPort(port);
  installPhotoStoragePort(photo);
  installMemberReportCaptureUpload(capture);
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
