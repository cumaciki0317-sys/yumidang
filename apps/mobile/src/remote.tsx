import { useSyncExternalStore } from "react";
import { YumidangService } from "./service";

/** The Naver auth integration installs a verified user session here. Never an EXPO_PUBLIC token. */
let token: string | null = null;
let epoch = 0;
const listeners = new Set<() => void>();
export function installServiceSession(accessToken: string | null) {
  token = accessToken;
  epoch++;
  listeners.forEach((listener) => listener());
}
export const serviceSessionEpoch = () => epoch;
export const serviceAccessToken = async () => token;
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
  } catch {
    serviceConfigurationError = true;
  }
}
export function useService() {
  return service;
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
