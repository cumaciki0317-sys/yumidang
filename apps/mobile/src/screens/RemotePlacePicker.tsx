import React, { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { ApiError } from "../api";
import { useService, useServiceSession, serviceSessionEpoch } from "../remote";
import { useApp } from "../state";
import { Body, Button, Card, Chip, Field, Row } from "../ui";
import PostcodePicker from "../components/PostcodePicker";
import { postalMatchesPlace, type SelectedPostalAddress } from "../components/postcode";
import type { PlaceInputCandidate } from "../../../../backend/supabase/functions/_shared/integrations/places/port.ts";

export interface SelectedPlaceInput {
  placeName: string;
  address: string;
  publicArea: string;
  postalCode?: string;
}
export interface RemotePlacePickerProps {
  onSelect: (input: SelectedPlaceInput) => void;
  onCancel?: () => void;
  /** A source venue name may prefill search; it never auto-selects an address. */
  initialQuery?: string;
}
/** Precise addresses belong only to this authenticated creation input, never a public post card. */
export default function RemotePlacePicker({ onSelect, onCancel, initialQuery = "" }: RemotePlacePickerProps) {
  const session = useServiceSession();
  const { navigate } = useApp();
  if (!session.authenticated) return <View style={{ gap: 12 }}><Body>장소와 주소는 로그인 후 선택할 수 있어요.</Body><Button onPress={() => navigate("S05")}>로그인하기</Button>{onCancel && <Button secondary onPress={onCancel}>닫기</Button>}</View>;
  return <MemberPlacePicker key={`${session.epoch}:${initialQuery}`} onSelect={onSelect} onCancel={onCancel} initialQuery={initialQuery} epoch={session.epoch} />;
}
function MemberPlacePicker({ onSelect, onCancel, initialQuery = "", epoch }: RemotePlacePickerProps & {epoch: number}) {
  const service = useService();
  const session = {authenticated: true, epoch};
  const [mode, setMode] = useState<"place" | "address">("place");
  const [query, setQuery] = useState(initialQuery);
  const [placeName, setPlaceName] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [places, setPlaces] = useState<PlaceInputCandidate[]>([]);
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedPage, setFailedPage] = useState<number | null>(null);
  const [candidate, setCandidate] = useState<PlaceInputCandidate | null>(null);
  const [addressOpen, setAddressOpen] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const requestVersion = useRef(0);
  const selectEpoch = useRef(session.epoch);
  const cancelRequest = useCallback(() => {
    controller.current?.abort(); requestVersion.current++;
  }, []);
  useEffect(() => cancelRequest, [cancelRequest]);
  const lookup = async (requestedQuery: string, page: number) => {
    if (!service || !session.authenticated || busy) return;
    const version = ++requestVersion.current;
    const epoch = session.epoch;
    controller.current?.abort();
    const pending = new AbortController(); controller.current = pending;
    setBusy(true); setError(null); setFailedPage(null);
    setAppliedQuery(requestedQuery);
    if (page === 1) { setPlaces([]); setNextPage(null); setSearched(false); }
    try {
      const result = await service.searchPlaces(requestedQuery, page, pending.signal);
      if (version !== requestVersion.current || epoch !== serviceSessionEpoch()) return;
      if (page !== 1 && result.places.some((value) => places.some((prior) => value.sourceId === prior.sourceId))) {
        throw new ApiError(502, "INVALID_SERVICE_RESPONSE");
      }
      setPlaces((prior) => page === 1 ? result.places : [...prior, ...result.places]);
      setNextPage(result.nextPage); setSearched(true);
    } catch (failure) {
      if (pending.signal.aborted || version !== requestVersion.current || epoch !== serviceSessionEpoch()) return;
      const authFailure = failure instanceof ApiError && [401, 403].includes(failure.status);
      setError(authFailure ? "로그인 상태를 확인해 주세요. 장소 조회 권한이 필요해요."
        : "장소를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.");
      setFailedPage(authFailure ? null : page);
    } finally { if (version === requestVersion.current) setBusy(false); }
  };
  const receivePostal = (selection: SelectedPostalAddress) => {
    if (!session.authenticated || selectEpoch.current !== serviceSessionEpoch()) return;
    if (candidate && !postalMatchesPlace(candidate, selection)) {
      setError("선택한 장소와 같은 주소를 골라주세요. 주소가 다르면 장소를 연결할 수 없어요."); return;
    }
    const name = candidate?.placeName || placeName.trim();
    if (!name || /[<>\u0000-\u001f\u007f]/u.test(name)) {
      setError("장소 이름을 입력해 주세요."); return;
    }
    onSelect({ placeName: name, address: selection.address, publicArea: selection.publicArea, postalCode: selection.postalCode });
  };
  if (!service) return <View style={{ gap: 12 }}><Body>장소 조회 연결이 준비되지 않았어요.</Body>{onCancel && <Button secondary onPress={onCancel}>닫기</Button>}</View>;
  return <View style={{ gap: 12 }}>
    <Row><Chip selected={mode === "place"} onPress={() => { setMode("place"); setAddressOpen(false); setCandidate(null); setError(null); }}>장소명 검색</Chip><Chip selected={mode === "address"} onPress={() => { controller.current?.abort(); requestVersion.current++; setBusy(false); setMode("address"); setCandidate(null); setAddressOpen(false); setError(null); }}>주소 검색</Chip></Row>
    <Body small muted>정확한 주소는 작성 입력으로 사용해요. 공개 공고에는 동·읍·면까지만 표시해요.</Body>
    {mode === "place" && !addressOpen && <>
      <Field label="장소 이름" value={query} maxLength={300} onChangeText={setQuery} placeholder="찾을 장소 이름을 입력해 주세요" />
      <Button disabled={!query.trim() || busy} loading={busy} onPress={() => lookup(query.trim(), 1)}>장소 검색</Button>
      {searched && places.length === 0 && !error && <Body muted>검색된 장소가 없어요. 다른 검색어로 찾아보세요.</Body>}
      {places.map((place) => <Card key={place.sourceId} onPress={place.roadAddress || place.address ? () => { selectEpoch.current = session.epoch; setCandidate(place); setAddressOpen(true); setError(null); } : undefined}><Body>{place.placeName}</Body><Body small muted>{place.roadAddress || place.address || "주소가 확인되지 않아 선택할 수 없는 장소"}</Body></Card>)}
      {nextPage !== null && <Button secondary disabled={busy || !!error} onPress={() => lookup(appliedQuery, nextPage)}>장소 10개 더 보기</Button>}
    </>}
    {mode === "address" && !addressOpen && <>
      <Field label="장소 이름" value={placeName} maxLength={300} onChangeText={setPlaceName} placeholder="함께 만날 장소 이름을 입력해 주세요" />
      <Button disabled={!placeName.trim()} onPress={() => { selectEpoch.current = session.epoch; setAddressOpen(true); setError(null); }}>주소 검색 열기</Button>
    </>}
    {addressOpen && <>
      {candidate && <><Body>{candidate.placeName}</Body><Body small muted>같은 주소를 선택하면 공개 지역을 확인해요.</Body><Body small>{candidate.roadAddress || candidate.address}</Body></>}
      <PostcodePicker onSelect={receivePostal} onCancel={() => { setAddressOpen(false); setCandidate(null); setError(null); }} />
    </>}
    {error && <Body>{error}</Body>}
    {failedPage !== null && !addressOpen && <Button secondary disabled={busy} onPress={() => lookup(appliedQuery, failedPage)}>장소 조회 다시 시도</Button>}
    {onCancel && <Button secondary onPress={onCancel}>장소 선택 닫기</Button>}
  </View>;
}
