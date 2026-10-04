import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Image, Pressable, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { useFocusEffect } from "expo-router";
import { randomUUID } from "expo-crypto";
import { ApiError } from "../api";
import {
  aiReportCaptureUploadEpoch, serviceAccessToken, serviceSessionEpoch, useAiReportCaptureUpload, useAiReportCaptureUploadEpoch,
  useService, useServiceSession,
} from "../remote";
import { Body, Button, Card, Field } from "../ui";
import type { AiFeedbackInput } from "../../../../backend/supabase/functions/_shared/contracts/ai";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Props = { requestId: string; onHide: () => void };
/** requestId만 받고 답변/대화 원문을 받지 않는다. 선택 구간은 빈 값으로 시작한다. */
export function RemoteAiFeedback(props: Props) {
  const session = useServiceSession();
  const uploadEpoch = useAiReportCaptureUploadEpoch();
  const key = `${session.epoch}:${props.requestId}:${uploadEpoch}`;
  const scope = useRef(key);
  useLayoutEffect(() => { scope.current = key; return () => { scope.current = ""; }; }, [key]);
  return <FeedbackSession key={key} {...props} authenticated={session.authenticated}
    isCurrent={() => scope.current === key && serviceSessionEpoch() === session.epoch && aiReportCaptureUploadEpoch() === uploadEpoch} />;
}
function FeedbackSession({ requestId, onHide, authenticated, isCurrent }: Props & {
  authenticated: boolean; isCurrent: () => boolean;
}) {
  const service = useService();
  const upload = useAiReportCaptureUpload();
  const [reporting, setReporting] = useState(false);
  const [kind, setKind] = useState<"answer" | "capture">("answer");
  const [text, setText] = useState("");
  const [asset, setAsset] = useState<ImagePicker.ImagePickerAsset | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [helpful, setHelpful] = useState(false);
  const [notice, setNotice] = useState("");
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const processing = useRef(false);
  const focused = useRef(true);
  // 응답 유실 재접수는 같은 키/업로드 결과를 쓴다. 영구 저장하지 않는다.
  const attempt = useRef<{ fingerprint: string; clientRequestId: string; assetId?: string } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.abort(); };
  }, []);
  useFocusEffect(useCallback(() => {
    focused.current = true;
    return () => {
      focused.current = false; active.current?.abort(); active.current = null; processing.current = false;
      setBusy(false); setConfirmed(false); setText(""); setAsset(null); attempt.current = null;
    };
  }, []));
  const live = (controller: AbortController) => mounted.current && focused.current && isCurrent() &&
    !controller.signal.aborted && active.current === controller;
  const selectedValid = kind === "answer"
    ? Boolean(text.trim()) && [...text].length <= 500
    : Boolean(asset && upload);
  const chooseKind = (next: "answer" | "capture") => {
    if (processing.current || next === kind) return;
    setKind(next); setConfirmed(false); setNotice(""); setText(""); setAsset(null); attempt.current = null;
  };
  async function chooseCapture() {
    if (processing.current || !focused.current || !authenticated || !isCurrent()) return;
    if (!upload) { setNotice("캡처 업로드가 아직 연결되지 않았어요. 답변 구간을 직접 입력해 주세요."); return; }
    const controller = new AbortController(); active.current?.abort(); active.current = controller;
    processing.current = true; setBusy(true); setNotice(""); setConfirmed(false);
    try {
      const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: false });
      if (!live(controller) || picked.canceled) return;
      if (picked.assets.length !== 1) { setNotice("캡처 한 개만 선택해 주세요."); return; }
      setAsset(picked.assets[0]); attempt.current = null;
    } catch { if (live(controller)) setNotice("캡처를 선택하지 못했어요. 다시 선택해 주세요."); }
    finally { if (live(controller)) { processing.current = false; active.current = null; setBusy(false); } }
  }
  async function send(action: "helpful" | "report") {
    if (processing.current || !focused.current || !isCurrent() || action === "helpful" && helpful) return;
    if (!authenticated) { setNotice("로그인 후 의견을 남길 수 있어요."); return; }
    if (!service || !uuid.test(requestId)) { setNotice("의견 접수가 아직 연결되지 않았어요."); return; }
    if (action === "report" && (!selectedValid || !confirmed)) return;
    const snapshot = action === "report" && kind === "capture" ? asset : null;
    const chosenText = action === "report" && kind === "answer" ? text : "";
    const fingerprint = JSON.stringify({ requestId, action, kind: action === "report" ? kind : null,
      text: chosenText, uri: snapshot?.uri ?? null });
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, clientRequestId: randomUUID() };
    const pending = attempt.current!;
    const controller = new AbortController(); active.current?.abort(); active.current = controller;
    processing.current = true; setBusy(true); setNotice("");
    try {
      let input: AiFeedbackInput;
      if (action === "helpful") input = { clientRequestId: pending.clientRequestId, requestId, action };
      else if (snapshot) {
        if (!upload) { setNotice("캡처 업로드가 아직 연결되지 않았어요."); return; }
        if (!pending.assetId) {
          const token = await serviceAccessToken();
          if (!live(controller)) return;
          if (!token) { setNotice("로그인 후 다시 접수해 주세요."); return; }
          // 파일 전송은 미리보기 확인 후 이 버튼을 누른 때만 시작한다.
          const uploaded = await upload({ asset: snapshot, requestId, clientRequestId: pending.clientRequestId,
            accessToken: token, signal: controller.signal });
          if (!live(controller)) return;
          if (!uploaded || typeof uploaded.assetId !== "string" || !uuid.test(uploaded.assetId)) {
            setNotice("캡처 업로드를 확인하지 못했어요. 접수하지 않았어요."); return;
          }
          pending.assetId = uploaded.assetId;
        }
        input = { clientRequestId: pending.clientRequestId, requestId, action, confirmed: true,
          attachment: { kind: "capture", assetId: pending.assetId } };
      } else input = { clientRequestId: pending.clientRequestId, requestId, action, confirmed: true,
        attachment: { kind: "answer", text: chosenText } };
      if (!live(controller)) return;
      const result = await service.sendAiFeedback(input, controller.signal);
      if (!live(controller)) return;
      if (result.status !== "accepted") { setNotice("의견 접수 기능을 준비 중이에요. 답변은 숨기지 않았어요."); return; }
      if (action === "report" && result.hideAnswer === true) { setNotice("접수했어요. 이 답변을 내 화면에서 숨겨요."); onHide(); }
      else if (action === "helpful" && result.hideAnswer === false) { setHelpful(true); setNotice("의견을 접수했어요."); }
      else setNotice("접수 결과를 확인하지 못했어요. 답변은 숨기지 않았어요.");
    } catch (error) {
      if (live(controller)) setNotice(error instanceof ApiError && error.code === "AUTH_REQUIRED"
        ? "로그인 후 다시 접수해 주세요." : "접수하지 못했어요. 선택한 자료를 유지했으니 다시 시도해 주세요.");
    } finally { if (live(controller)) { processing.current = false; active.current = null; setBusy(false); } }
  }
  return <Card style={{ gap: 12 }}>
    <Body small muted>이 AI 답변에 대한 의견</Body>
    <View style={{ gap: 8 }}>
      <Button testID="ai-feedback-helpful" secondary disabled={busy || helpful || !authenticated}
        onPress={() => { void send("helpful"); }}>{helpful ? "의견 접수됨" : "도움이 됐어요"}</Button>
      <Button testID="ai-feedback-report-open" secondary disabled={busy || !authenticated}
        onPress={() => { setReporting(value => !value); setConfirmed(false); setNotice(""); }}>문제 있어요</Button>
    </View>
    {!authenticated && <Body small muted>로그인 후 의견을 남길 수 있어요.</Body>}
    {reporting && <View style={{ gap: 12 }}>
      <Body>해당 답변 구간 또는 캡처 한 개를 직접 선택해 주세요.</Body>
      <View style={{ gap: 8 }}>
        <Button secondary disabled={busy} onPress={() => chooseKind("answer")}>답변 구간 입력</Button>
        <Button secondary disabled={busy} onPress={() => chooseKind("capture")}>캡처 한 개</Button>
      </View>
      {kind === "answer" ? <Field testID="ai-feedback-text" label="제출할 답변 구간" multiline editable={!busy}
        value={text} placeholder="신고할 답변 구간을 직접 붙여 넣거나 입력해 주세요."
        onChangeText={value => { setText(value); setConfirmed(false); setNotice(""); }}
        error={[...text].length > 500 ? "500자 이내의 구간을 직접 선택해 주세요." : undefined}
        hint={`${[...text].length}/500자 · 전체 대화를 자동 첨부하지 않아요.`} />
        : <View style={{ gap: 8 }}>
          <Button testID="ai-feedback-capture" secondary disabled={busy || !upload} onPress={() => { void chooseCapture(); }}>캡처 선택</Button>
          {!upload && <Body small muted>캡처 업로드가 아직 연결되지 않았어요. 답변 구간으로 접수할 수 있어요.</Body>}
        </View>}
      <Card style={{ gap: 8 }}>
        <Body small muted>제출 전 미리보기</Body>
        {kind === "answer" ? <Body>{text || "선택한 답변 구간이 없어요."}</Body>
          : asset ? <Image source={{ uri: asset.uri }} accessibilityLabel="선택한 신고 캡처 미리보기"
              style={{ height: 200, width: "100%", resizeMode: "contain" }} />
            : <Body>선택한 캡처가 없어요.</Body>}
      </Card>
      <Pressable testID="ai-feedback-confirm" accessibilityRole="checkbox" accessibilityState={{ checked: confirmed, disabled: busy || !selectedValid }}
        disabled={busy || !selectedValid} onPress={() => setConfirmed(value => !value)}>
        <Body>{confirmed ? "☑" : "☐"} 위 자료 하나만 제출하는 것을 확인했어요.</Body>
      </Pressable>
      <Button testID="ai-feedback-submit" disabled={busy || !selectedValid || !confirmed} loading={busy}
        onPress={() => { void send("report"); }}>확인한 자료로 접수</Button>
    </View>}
    {notice ? <Body small>{notice}</Body> : null}
  </Card>;
}
