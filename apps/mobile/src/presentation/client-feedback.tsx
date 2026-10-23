import React from "react";
import { router, useLocalSearchParams, usePathname } from "expo-router";
import { ApiError } from "../api";
import { Body, Button, Card, Title } from "../ui";

export type RecoveryKind = "retry" | "login" | "unavailable" | "pending";
export function recoveryKind(error: unknown): RecoveryKind {
  if (!(error instanceof ApiError)) return "retry";
  if (error.status === 401 || error.code === "AUTH_REQUIRED") return "login";
  if (error.status === 403 || error.status === 404) return "unavailable";
  if (["EVENT_DETAIL_NOT_CONNECTED", "EVENT_RANKINGS_NOT_CONNECTED"].includes(error.code)) return "pending";
  return "retry";
}

/** Recovery actions never infer deletion/blocking or resend a previous mutation. */
export function RecoveryCard({ message, kind, onRetry }: {
  message: string; kind: RecoveryKind; onRetry?: () => void;
}) {
  const path = usePathname(), params = useLocalSearchParams();
  const login = () => {
    const query = new URLSearchParams();
    for (const key of ["id", "postId", "conversationId"]) {
      const value = params[key];
      if (typeof value === "string") query.set(key, value);
    }
    const suffix = query.toString();
    router.push({ pathname: "/login", params: { returnPath: path + (suffix ? `?${suffix}` : "") } });
  };
  return <Card>
    <Title>{kind === "login" ? "로그인이 필요해요" : kind === "unavailable" ? "현재 이 항목을 열 수 없어요" : "현재 상태 확인"}</Title>
    <Body>{message}</Body>
    {kind === "login" ? <Button onPress={login}>로그인</Button>
      : kind === "unavailable" ? <Button secondary onPress={() => router.push("/(tabs)/explore")}>목록으로</Button>
      : kind === "retry" && onRetry ? <Button secondary onPress={onRetry}>다시 시도</Button> : null}
  </Card>;
}
