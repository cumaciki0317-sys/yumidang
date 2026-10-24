import React, { useState } from "react";
import { Pressable } from "react-native";
import { Body, Button, Card, Field, Row, TextButton, Title } from "../ui";
import type { ManualEvent } from "../types";
import { RemoteEventPicker } from "./RemoteScreens";
import RemotePlacePicker from "./RemotePlacePicker";
import { manualEventError, manualEventPatch, safeManualEvent } from "../presentation/events/event-draft";

export interface EventEditorValue { eventId?: string | null; manualEvent?: ManualEvent | null; }
export interface EventEditorPatch { eventId: string | null; manualEvent: ManualEvent | null; }
const empty = (): ManualEvent => ({ title: "", placeName: "", publicAddress: "", publicAddressConfirmed: false });
/** Only edits a selection. Server inspection, latest-state checks and persistence belong to the caller. */
export function RemoteEventEditor({ value, onChange, disabled = false }: {
  value: EventEditorValue; onChange: (patch: EventEditorPatch) => void; disabled?: boolean;
}) {
  const [mode, setMode] = useState<"closed" | "source" | "manual" | "address">("closed");
  const [manual, setManual] = useState<ManualEvent>(() => safeManualEvent(value.manualEvent) ?? empty());
  const [error, setError] = useState("");
  const openManual = () => { if (disabled) return; setManual(safeManualEvent(value.manualEvent) ?? empty()); setError(""); setMode("manual"); };
  const apply = (patch: EventEditorPatch) => { if (disabled) return; onChange(patch); setMode("closed"); setError(""); };
  return <Card><Title>행사 연결</Title>
    <Row><Button secondary disabled={disabled} onPress={() => { if (!disabled) setMode("source"); }}>행사 선택·변경</Button><Button secondary disabled={disabled} onPress={openManual}>직접 입력</Button></Row>
    {(value.eventId || value.manualEvent) && <Button secondary disabled={disabled} onPress={() => apply({ eventId: null, manualEvent: null })}>행사 연결 삭제</Button>}
    {!disabled && mode === "source" && <RemoteEventPicker onSelect={event => apply({ eventId: event.id, manualEvent: null })} onDirectInput={openManual} />}
    {!disabled && mode === "manual" && <>
      <Body small muted>이 공고 안에만 표시해요. 행사 일정과 만남 일정은 별개예요.</Body>
      <Field label="행사명 *" value={manual.title} onChangeText={title => { setManual({ ...manual, title }); setError(""); }} />
      <Field label="장소명 (선택)" value={manual.placeName} onChangeText={placeName => { setManual({ ...manual, placeName }); setError(""); }} />
      <Button secondary onPress={() => setMode("address")}>공개 행사장 주소 검색 (선택)</Button>
      {manual.publicAddress ? <><Body>{manual.publicAddress}</Body><TextButton onPress={() => setManual({ ...manual, publicAddress: "", publicAddressConfirmed: false })}>주소 삭제</TextButton>
        <Pressable accessibilityRole="checkbox" accessibilityLabel="공개 행사장 주소임을 확인했어요" accessibilityState={{ checked: manual.publicAddressConfirmed }} onPress={() => setManual({ ...manual, publicAddressConfirmed: !manual.publicAddressConfirmed })}><Body>{manual.publicAddressConfirmed ? "☑" : "☐"} 공개 행사장 주소임을 확인했어요.</Body></Pressable>
      </> : <Body small muted>주소를 찾지 못하면 생략할 수 있어요. 만남 장소는 별도로 유지해요.</Body>}
      <Body small muted>개인 집 주소나 비공개 만남 지점은 입력하지 마세요. 등록할 때 서버 검사를 받아요.</Body>
      {error ? <Body>{error}</Body> : null}
      <Button onPress={() => { const next = manualEventError(manual); if (next) { setError(next); return; } apply({ eventId: null, manualEvent: manualEventPatch(manual).manualEvent! }); }}>이 공고에 연결</Button>
    </>}
    {!disabled && mode === "address" && <RemotePlacePicker onCancel={() => setMode("manual")} onSelect={place => { if (disabled) return; setManual({ ...manual, placeName: manual.placeName || place.placeName, publicAddress: place.address, publicAddressConfirmed: false }); setError(""); setMode("manual"); }} />}
    {!disabled && mode !== "closed" && <TextButton onPress={() => setMode("closed")}>행사 변경 닫기</TextButton>}
  </Card>;
}
