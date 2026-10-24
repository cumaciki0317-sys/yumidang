import React, { useCallback, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { ApiError } from "../api";
import type { AiConsentKind, AiConsents } from "../member-service";
import { serviceSessionEpoch, useMemberService, useServiceSession } from "../remote";
import { Body, Button, Card, Title } from "../ui";

const options: { kind: AiConsentKind; label: string; description: string }[] = [
  { kind: "exploration", label: "AI 탐색", description: "철회하면 새 AI 탐색 처리를 중단해요. 일반 검색은 계속 이용할 수 있어요." },
  { kind: "summary_view", label: "후기 요약 열람", description: "철회하면 내가 AI 후기 요약을 볼 수 없어요. 일반 후기는 유지돼요." },
  { kind: "summary_generate", label: "내 프로필 요약 생성·노출", description: "철회하면 내 요약을 숨기고 새 생성과 갱신을 중단해요." },
  { kind: "summary_source", label: "내가 작성한 후기의 요약 활용", description: "철회하면 내가 쓴 후기를 요약 재료에서 제외하고 이를 사용한 요약을 우선 숨겨요. 조건을 충족한 요약만 다시 생성돼요." },
];

/** Server values are confirmed state, never optimistic checkbox values. */
export function MemberAiConsentSettings() {
  const service = useMemberService(), session = useServiceSession();
  const [value, setValue] = useState<{ epoch: number; consents: AiConsents } | null>(null);
  const [busy, setBusy] = useState(false), [issue, setIssue] = useState("");
  const [confirm, setConfirm] = useState<{ kind: AiConsentKind; epoch: number } | null>(null);
  const active = useRef<AbortController | null>(null), focused = useRef(false), generation = useRef(0);
  const load = useCallback(async (change?: { kind: AiConsentKind; allowed: boolean }) => {
    if (!service || !session.authenticated || !focused.current || serviceSessionEpoch() !== session.epoch || active.current) return;
    const expected = session.epoch, request = ++generation.current;
    const controller = new AbortController(); active.current = controller;
    const current = () => focused.current && !controller.signal.aborted && generation.current === request && serviceSessionEpoch() === expected;
    setBusy(true); setIssue(""); setValue(null); setConfirm(null);
    let changeFailed = false;
    try {
      if (change) {
        if (!current()) return;
        try { await service.setAiConsent(change.kind, change.allowed, controller.signal); }
        catch (error) { if (!current()) return; if (error instanceof ApiError && error.status === 401) throw error; changeFailed = true; }
      }
      if (!current()) return;
      const consents = await service.aiConsents(controller.signal);
      if (!current()) return;
      setValue({ epoch: expected, consents });
      if (changeFailed || change && consents[change.kind] !== change.allowed) setIssue("변경 결과를 확정하지 못했어요. 아래는 서버에서 다시 확인한 현재 상태예요. 원하는 항목을 다시 변경해 주세요.");
    } catch (error) {
      if (current()) setIssue(error instanceof ApiError && error.status === 401 ? "로그인 상태를 다시 확인해 주세요. 동의 상태를 확인하지 못했어요." : "동의 상태를 확인하지 못했어요. 다시 확인해 주세요.");
    } finally { if (active.current === controller) { const visible = current(); active.current = null; if (visible) setBusy(false); } }
  }, [service, session.authenticated, session.epoch]);
  useFocusEffect(useCallback(() => {
    focused.current = true; void load();
    return () => { focused.current = false; generation.current++; active.current?.abort(); active.current = null; };
  }, [load]));
  const consents = value?.epoch === session.epoch ? value.consents : null;
  const target = consents && confirm?.epoch === session.epoch ? options.find(option => option.kind === confirm.kind) : undefined;
  return <>
    <Body muted>AI 동의는 선택 사항이에요. 철회해도 계정과 일반 동행은 유지돼요.</Body>
    {busy && <Body>동의 상태를 확인하고 있어요…</Body>}
    {issue && <Card><Body>{issue}</Body><Button secondary disabled={busy} onPress={() => { void load(); }}>동의 상태 다시 확인</Button></Card>}
    {!service && <Body>동의 서버 연결을 준비하고 있어요.</Body>}
    {options.map(option => <Card key={option.kind}>
      <Title>{option.label}</Title><Body>{option.description}</Body>
      <Body>{consents ? consents[option.kind] ? "동의함" : "동의하지 않음" : "상태 확인 필요"}</Body>
      <Button secondary disabled={!consents || busy} onPress={() => {
        if (!consents) return;
        if (serviceSessionEpoch() !== session.epoch) return;
        if (consents[option.kind]) setConfirm({ kind: option.kind, epoch: session.epoch });
        else void load({ kind: option.kind, allowed: true });
      }}>{option.label} {consents?.[option.kind] ? "동의 철회" : "동의하기"}</Button>
    </Card>)}
    {target && <Card><Title>{target.label} 동의를 철회할까요?</Title><Body>{target.description}</Body>
      <Button disabled={busy} onPress={() => { void load({ kind: target.kind, allowed: false }); }}>철회 확인</Button>
      <Button secondary disabled={busy} onPress={() => setConfirm(null)}>취소</Button>
    </Card>}
    <Body small muted>필요한 AI 사본의 삭제 완료 여부는 별도 확인이 필요해요.</Body>
  </>;
}
