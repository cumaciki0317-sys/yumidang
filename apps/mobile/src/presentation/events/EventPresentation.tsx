import React, { useState } from "react";
import { Image, Text, View } from "react-native";
import { Badge, Body, Card, Row, Title, colors } from "../../ui";
import {
  eventAdmissionLabel, eventCategoryLabel, eventDateLabel, eventLocationLabel,
  eventProviderLabel, eventStatusLabel, type EventDisplayInput,
} from "./event-display";

/** A failed image leaves no placeholder or reserved image space. Remount on URI changes. */
export function EventPoster({ uri, title }: { uri?: string | null; title: string }) {
  return uri ? <PosterImage key={uri} uri={uri} title={title} /> : null;
}
function PosterImage({ uri, title }: { uri: string; title: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return <Image
    accessibilityLabel={`${title} 행사 이미지`}
    source={{ uri }}
    resizeMode="contain"
    onError={() => setFailed(true)}
    style={{ width: "100%", height: 240 }}
  />;
}

function EventLabels({ event }: { event: EventDisplayInput }) {
  return <Row style={{ flexWrap: "wrap" }}>
    <Badge tone="gray">{eventCategoryLabel(event.category)}</Badge>
    <Badge tone={event.sourceStatus === "cancelled" ? "pink" : "purple"}>{eventStatusLabel(event)}</Badge>
  </Row>;
}

export function EventListCard({ event, onPress }: { event: EventDisplayInput; onPress: () => void }) {
  return <Card onPress={onPress}>
    <EventPoster uri={event.posterUrl} title={event.title} />
    <EventLabels event={event} />
    <Text numberOfLines={2} ellipsizeMode="tail" style={{ fontSize: 19, fontWeight: "700", color: colors.ink, lineHeight: 27 }}>{event.title}</Text>
    <Body small>{eventDateLabel(event)}</Body>
    <Body small muted>{eventLocationLabel(event)}</Body>
    <Body small>{eventAdmissionLabel(event.admission)}</Body>
    <Body small muted>출처: {eventProviderLabel(event.provider)}</Body>
  </Card>;
}

/** Public DTO values only. This component performs no fetch, linking or eligibility policy. */
export function EventDetailContent({ event }: { event: EventDisplayInput }) {
  return <View style={{ gap: 12 }}>
    <Title large>{event.title}</Title>
    <EventLabels event={event} />
    <EventPoster uri={event.posterUrl} title={event.title} />
    {event.sourceStatus === "cancelled" && <Body>제공기관 정보에 따르면 이 행사는 취소되었습니다. 동행 약속은 자동으로 취소되지 않아요. 상대방과 진행 여부를 확인해 주세요.</Body>}
    {event.sourceStatus === "unknown" && <Body>최신 행사 상태를 확인하지 못했어요. 공식 안내를 확인해 주세요.</Body>}
    <Body>기간: {eventDateLabel(event)}</Body>
    <Body>시간: {event.operatingInfo || "시간 정보 없음"}</Body>
    <Body>장소: {eventLocationLabel(event)}</Body>
    <Body>주소: {event.publicAddress || "주소 정보 없음"}</Body>
    <Body>요금: {event.admission.kind === "described" ? event.admission.text.trim() || "요금 정보 없음" : eventAdmissionLabel(event.admission)}</Body>
    <Body small muted>진행 상태는 행사 기간 기준이며, 현재 개장·잔여석·예약 가능 여부를 뜻하지 않아요.</Body>
    <Title>행사 소개</Title>
    <Body>{event.description || "행사 소개 정보 없음"}</Body>
    <Body small muted>출처: {eventProviderLabel(event.provider)} · 수집 시각: {event.collectedAt}</Body>
  </View>;
}
