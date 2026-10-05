import React, { useCallback, useEffect, useRef, useState } from "react";
import { Image, Linking, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { ApiError } from "../api";
import { RemoteAiFeedback } from "./RemoteAiFeedback";
import { RemoteBlockControls, RemotePostManagement, RemoteProfilePhoto, RemoteReport } from "./RemoteMemberScreens";
import { serviceSessionEpoch, useService, useServiceSession } from "../remote";
import { normalizeMobileRegion } from "../service";
import { useApp } from "../state";
import {
  Badge,
  Body,
  Button,
  Card,
  Chip,
  Empty,
  Field,
  Row,
  Screen,
  TextButton,
  Title,
} from "../ui";
import { monthWeek, parseDateInput } from "../domain";
import type { Filters } from "../types";
import type { PublicPostCard } from "../../../../backend/supabase/functions/_shared/contracts/search";
import type {
  AiCard,
  AiChatResult,
  AiFilters,
  ChatMessage,
} from "../../../../backend/supabase/functions/_shared/contracts/ai";
import type { PublicEventItem } from "../../../../backend/supabase/functions/_shared/db/repositories/events";

const errorMessage = (error: unknown) =>
  error instanceof ApiError && error.code === "AUTH_REQUIRED"
    ? "로그인 후 확인할 수 있어요."
    : error instanceof ApiError && error.status === 404
    ? "삭제되었거나 접근할 수 없는 대상이에요."
    : "불러오지 못했어요. 입력한 조건을 유지했으니 다시 시도해 주세요.";

/** Every query/session has separate display state; an old response cannot restore revoked information. */
function useRemotePage<T extends { id: string }>(
  queryKey: string,
  load: (
    cursor?: string,
    signal?: AbortSignal,
  ) => Promise<{ items: T[]; nextCursor: string | null }>,
) {
  const { epoch } = useServiceSession();
  const [revision, retry] = useState(0);
  const key = `${epoch}:${queryKey}:${revision}`;
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  }, [load]);
  const controller = useRef<AbortController | null>(null);
  const [state, set] = useState<
    {
      key: string;
      items: T[];
      nextCursor: string | null;
      busy: boolean;
      error: string;
    }
  >({ key, items: [], nextCursor: null, busy: true, error: "" });
  useEffect(() => {
    const active = new AbortController();
    controller.current?.abort();
    controller.current = active;
    void loader.current(undefined, active.signal).then((page) => {
      if (!active.signal.aborted && serviceSessionEpoch() === epoch) {
        set({ key, ...page, busy: false, error: "" });
      }
    }).catch((error) => {
      if (!active.signal.aborted && serviceSessionEpoch() === epoch) {
        set({
          key,
          items: [],
          nextCursor: null,
          busy: false,
          error: errorMessage(error),
        });
      }
    });
    return () => {
      active.abort();
      controller.current?.abort();
    };
  }, [key, revision, epoch]);
  const visible = state.key === key
    ? state
    : { key, items: [], nextCursor: null, busy: true, error: "" };
  const more = async () => {
    if (visible.busy || !visible.nextCursor) return;
    const active = new AbortController();
    controller.current?.abort();
    controller.current = active;
    const cursor = visible.nextCursor;
    set({ ...visible, busy: true, error: "" });
    try {
      const page = await loader.current(cursor, active.signal);
      if (active.signal.aborted || serviceSessionEpoch() !== epoch) return;
      if (
        page.nextCursor === cursor ||
        page.items.some((item) =>
          visible.items.some((previous) => previous.id === item.id)
        )
      ) throw new ApiError(502, "INVALID_SERVICE_RESPONSE");
      set({
        key,
        items: [...visible.items, ...page.items],
        nextCursor: page.nextCursor,
        busy: false,
        error: "",
      });
    } catch (error) {
      if (!active.signal.aborted && serviceSessionEpoch() === epoch) {
        set({ ...visible, busy: false, error: errorMessage(error) });
      }
    }
  };
  return { ...visible, more, retry: () => retry((n) => n + 1) };
}

export function RemotePostCard({ post }: { post: PublicPostCard }) {
  const app = useApp();
  return (
    <Card onPress={() => app.navigate("S02", post.id)}>
      <Row between>
        <Badge>
          {post.state === "recruiting"
            ? "모집 중"
            : post.state === "confirmed"
            ? "확정"
            : "모집 종료"}
        </Badge>
        <Body small muted>
          {post.cost.kind === "free" ? "무료 동행" : "신청 불가"}
        </Body>
      </Row>
      <Title>{post.title}</Title>
      <Body small muted>{post.publicArea}</Body>
      <Body small muted>{post.startsAt} ~ {post.endsAt}</Body>
      <Body small muted>
        {post.authorDisplayName ?? "동행인은 로그인 후 확인할 수 있어요"}
      </Body>
    </Card>
  );
}

export function RemotePostResults(
  { filters, reset }: { filters: Filters; reset: () => void },
) {
  const service = useService();
  const page = useRemotePage(
    JSON.stringify(filters),
    async (cursor, signal) => {
      if (!service) throw new ApiError(503, "SERVICE_NOT_CONFIGURED");
      const result = await service.searchPosts(filters, cursor, signal);
      return { items: result.posts, nextCursor: result.nextCursor };
    },
  );
  return (
    <View style={{ gap: 14 }}>
      {page.items.map((post) => <RemotePostCard key={post.id} post={post} />)}
      {page.error && (
        <Empty title={page.error} action="다시 시도" onPress={page.retry} />
      )}
      {page.busy && <Body muted>공개 가능한 동행을 확인하고 있어요…</Body>}
      {!page.busy && !page.error && !page.items.length && (
        <Empty
          title="조건에 맞는 동행이 없어요"
          action="조건 초기화"
          onPress={reset}
        />
      )}
      {page.nextCursor && !page.busy && (
        <Button
          secondary
          onPress={() => void page.more()}
        >
          공고 10개 더 보기
        </Button>
      )}
    </View>
  );
}

export function RemoteEventResults({
  category = "",
  includeOngoing = false,
  period,
  performanceGenre,
  freeOnly = false,
  region = "",
}: {
  category?: string;
  includeOngoing?: boolean;
  period?: { start: string; end: string };
  performanceGenre?: "concert" | "musical" | "play";
  freeOnly?: boolean;
  region?: string;
}) {
  const service = useService();
  const app = useApp();
  const query = {
    mode: period ? "overlapping" as const : "new_this_week" as const,
    ...(period ? { period } : {}),
    includeOngoing,
    freeOnly,
    ...(region ? { region } : {}),
    ...(performanceGenre ? { performanceGenre } : {}),
    ...(category && category !== "전체" ? { category } : {}),
  };
  const page = useRemotePage<PublicEventItem>(
    JSON.stringify(query),
    async (cursor, signal) => {
      if (!service) throw new ApiError(503, "SERVICE_NOT_CONFIGURED");
      const result = await service.listEvents(query, cursor, signal);
      return { items: result.events, nextCursor: result.nextCursor };
    },
  );
  return (
    <View style={{ gap: 14 }}>
      {page.items.map((event) => (
        <Card
          key={event.id}
          onPress={() => app.navigate("S09-3", event.id)}
        >
          <Badge>
            {event.state === "ongoing"
              ? "진행 중"
              : event.state === "upcoming"
              ? "예정"
              : "종료"}
          </Badge>
          <Title>{event.title}</Title>
          <Body small muted>{event.placeName ?? "장소 미확인"}</Body>
          <Body small muted>
            {event.precision === "date"
              ? `${event.startsOn} ~ ${event.endsOn}`
              : `${event.startsAt} ~ ${event.endsAt}`}
          </Body>
          <Body small muted>{event.provider} · {event.collectedAt}</Body>
        </Card>
      ))}
      {page.busy && <Body muted>행사를 확인하고 있어요…</Body>}
      {page.error && (
        <Empty title={page.error} action="다시 시도" onPress={page.retry} />
      )}
      {!page.busy && !page.error && !page.items.length && (
        <Empty title="조건에 맞는 행사가 없어요" />
      )}
      {page.nextCursor && !page.busy && (
        <Button
          secondary
          onPress={() => void page.more()}
        >
          행사 10개 더 보기
        </Button>
      )}
    </View>
  );
}

export function RemoteAiScreen() {
  const session = useServiceSession();
  return <RemoteAiSession key={session.epoch} />;
}
function RemoteAiSession() {
  const service = useService();
  const session = useServiceSession();
  const app = useApp();
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [region, setRegion] = useState("");
  const [fixedFilters, setFixedFilters] = useState<Filters | null>(null);
  const [messageEpoch, setMessageEpoch] = useState(session.epoch);
  const [result, setResult] = useState<AiChatResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const filters = useRef<AiFilters>({ target: "posts" });
  const active = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const lock = useRef(false);
  const clear = useCallback(() => {
    generation.current++;
    active.current?.abort();
    lock.current = false;
    setMessages([]);
    setInput("");
    setError("");
    setResult(null);
    setFixedFilters(null);
    setBusy(false);
    filters.current = { target: "posts" };
  }, []);
  useFocusEffect(useCallback(() => () => clear(), [clear]));
  const send = async (outputRetryOf?: string) => {
    const text = input.trim();
    if (!service || !text || lock.current) return;
    if (
      [...text].length > 500 || messages.length + 2 > 20 ||
      messages.reduce(
          (sum, message) => sum + [...message.content].length,
          [...text].length,
        ) > 4000
    ) {
      setError(
        "대화 한도에 도달했어요. 확인한 조건으로 새 탐색을 시작해 주세요.",
      );
      return;
    }
    let selectedRegion: AiFilters["region"];
    try {
      selectedRegion = normalizeMobileRegion(region);
    } catch {
      setError("지역은 시·도로 입력해 주세요.");
      return;
    }
    const next = [...(messageEpoch === session.epoch ? messages : []), {
      role: "user" as const,
      content: text,
    }];
    const sentEpoch = serviceSessionEpoch();
    const currentGeneration = generation.current;
    const controller = new AbortController();
    active.current = controller;
    lock.current = true;
    setBusy(true);
    setResult(null);
    setFixedFilters(null);
    setError("");
    try {
      const response = await service.askAi({
        clientRequestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        messages: next,
        currentFilters: {
          ...filters.current,
          ...(selectedRegion ? { region: selectedRegion } : {}),
        },
        ...(outputRetryOf ? { outputRetryOf } : {}),
      }, controller.signal);
      if (
        controller.signal.aborted || generation.current !== currentGeneration ||
        sentEpoch !== serviceSessionEpoch()
      ) return;
      setMessageEpoch(session.epoch);
      setResult(response);
      filters.current = response.interpretedFilters;
      if (response.status === "unavailable") {
        setError(
          response.notice ??
            "답변을 확인하지 못했어요. 입력을 유지했으니 다시 시도해 주세요.",
        );
      } else {
        const answer = response.clarificationQuestion ?? response.notice ??
          (response.cards.length
            ? "확인된 동행을 살펴보세요."
            : "조건에 맞는 결과가 없어요.");
        if (
          next.length + 1 > 20 ||
          next.reduce(
              (sum, message) => sum + [...message.content].length,
              [...answer].length,
            ) > 4000
        ) {
          setError(
            "답변을 저장할 대화 한도가 부족해요. 새 탐색을 시작해 주세요.",
          );
          setResult(null);
          return;
        }
        setMessages([...next, { role: "assistant", content: answer }]);
        setInput("");
      }
    } catch (error) {
      if (
        !controller.signal.aborted && generation.current === currentGeneration
      ) setError(errorMessage(error));
    } finally {
      if (generation.current === currentGeneration) {
        lock.current = false;
        setBusy(false);
      }
    }
  };
  const cards: AiCard[] = messageEpoch === session.epoch
    ? result?.cards ?? []
    : [];
  if (!session.authenticated) {
    return (
      <Screen title="유미당 AI">
        <Empty
          title="AI 탐색은 로그인 후 이용할 수 있어요"
          action="로그인"
          onPress={() => app.navigate("S05")}
        />
      </Screen>
    );
  }
  return (
    <Screen
      title="유미당 AI"
      right={<TextButton onPress={clear}>새 대화</TextButton>}
      footer={
        <View style={{ gap: 8 }}>
          <Field
            value={input}
            onChangeText={setInput}
            placeholder="찾고 싶은 동행과 지역을 알려 주세요"
            multiline
          />
          <Button
            disabled={busy}
            onPress={() => void send()}
          >
            보내기
          </Button>
          <Body small muted>대화는 화면 종료·로그아웃 시 지워져요.</Body>
        </View>
      }
    >
      <Card>
        <Body small muted>
          공개된 카드로 추천을 안내해요. 실명·전화번호·상세 만남 위치는 입력하지
          마세요.
        </Body>
      </Card>
      <Field
        label="지역 (시·도)"
        value={region}
        onChangeText={setRegion}
        placeholder="예: 서울"
      />
      <Row>
        {["전시", "산책", "카페"].map((category) => (
          <Chip
            key={category}
            disabled={busy}
            onPress={() => {
              setFixedFilters({
                query: "",
                category,
                region: "서울",
                recruiting: true,
                sort: "created_desc",
                ageMin: "",
                ageMax: "",
                from: "",
                to: "",
              });
              setResult(null);
              setError("");
            }}
          >
            서울 {category}
          </Chip>
        ))}
      </Row>
      <Body small muted>
        고정 조건과 일반 더보기는 AI 이용 횟수를 쓰지 않아요.
      </Body>
      {fixedFilters && (
        <RemotePostResults
          filters={fixedFilters}
          reset={() => setFixedFilters(null)}
        />
      )}
      {(messageEpoch === session.epoch ? messages : []).map((
        message,
        index,
      ) => (
        <Card key={index}>
          <Body>{message.content}</Body>
        </Card>
      ))}
      {cards.map((card) => (
        <Card
          key={`${card.kind}:${card.id}`}
          onPress={() =>
            app.navigate(card.kind === "post" ? "S02" : "S09-3", card.id)}
        >
          <Badge>{card.kind === "post" ? "동행 공고" : "행사"}</Badge>
          <Title>{card.title}</Title>
          <Body>{card.locationLabel}</Body>
          <Body small muted>{card.startsAtOrDate} ~ {card.endsAtOrDate}</Body>
          <Body small muted>{card.costLabel}</Body>
          {result?.explanations.filter((item) =>
            item.id === card.id && item.kind === card.kind
          ).map((item) => (
            <Body key={`${item.kind}:${item.id}`}>{item.text}</Body>
          ))}
          {card.kind === "event" && (
            <Body small muted>출처: {card.sourceName}</Body>
          )}
          {card.conditionStatus &&
            Object.entries(card.conditionStatus).filter(([, value]) =>
              value === "needs_check"
            ).map(([name]) => (
              <Body small muted key={name}>
                {name === "mbti"
                  ? "MBTI"
                  : name === "interests"
                  ? "관심사"
                  : "대화 방식"}는 미입력으로 확인이 필요해요.
              </Body>
            ))}
        </Card>
      ))}
      {result && result.status !== "unavailable" && (
        <RemoteAiFeedback
          key={result.requestId}
          requestId={result.requestId}
          onHide={() => {
            setMessages(previous => previous.at(-1)?.role === "assistant" ? previous.slice(0, -1) : previous);
            setResult(null);
            app.showToast("AI 신고를 접수했어요. 해당 답변을 숨겼어요.");
          }}
        />
      )}
      {busy && <Body muted>확인하고 있어요…</Body>}
      {error && (
        <Card>
          <Body>{error}</Body>
          {result?.recovery?.reason === "output_privacy" &&
            result.recovery.retryAllowed && (
            <Button
              secondary
              onPress={() => void send(result.requestId)}
            >
              답변 다시 확인하기
            </Button>
          )}
          <TextButton onPress={() => app.navigate("S01")}>
            일반 둘러보기
          </TextButton>
        </Card>
      )}
    </Screen>
  );
}

export function RemotePostDetail({ id }: { id: string }) {
  const session = useServiceSession();
  const service = useService();
  const app = useApp();
  const page = useRemotePage(id, async (_cursor, signal) => {
    if (!service) throw new ApiError(503, "SERVICE_NOT_CONFIGURED");
    const details = await service.getPost(id, signal);
    return { items: [{ ...details, id: details.postId }], nextCursor: null };
  });
  const post = page.items[0];
  return (
    <Screen title="공고 상세">
      {page.busy && <Body muted>현재 공고를 확인하고 있어요…</Body>}
      {page.error && (
        <Empty title={page.error} action="다시 시도" onPress={page.retry} />
      )}
      {post && (
        <>
          <Card>
            <Badge>{post.category}</Badge>
            <Title large>{post.title}</Title>
            <Body>{post.startsAt} ~ {post.endsAt}</Body>
            <Body>{post.publicArea}</Body>
            <Body>{post.description}</Body>
          </Card>
          <Card>
            {post.authorDisplayName === null
              ? (
                <>
                  <View
                    style={{
                      height: 42,
                      borderRadius: 8,
                      backgroundColor: "#EAE6F2",
                    }}
                  />
                  <Body muted>동행인은 로그인 후 확인할 수 있어요</Body>
                </>
              )
              : <Body>{post.authorDisplayName}</Body>}
          </Card>
          {post.privateDetails && (
            <Card>
              <Title>확인된 만남 장소</Title>
              <Body>{post.privateDetails.registeredPlaceName}</Body>
              <Body>{post.privateDetails.registeredAddress}</Body>
              <Body>{post.privateDetails.meetingDetail}</Body>
            </Card>
          )}
          {post.linkedEvent && (
            <Card onPress={() => app.navigate("S09-3", post.linkedEvent!.id)}>
              <Title>연결된 행사</Title>
              <Body>{post.linkedEvent.title}</Body>
            </Card>
          )}
          <Button disabled={post.status !== "recruiting"} onPress={() => app.navigate(session.authenticated ? "S11" : "S05", session.authenticated ? post.postId : undefined)}>대화로 동행 신청하기</Button>
          {session.authenticated && <><RemotePostManagement postId={post.postId} onChanged={page.retry} /><RemoteReport targetId={post.postId} targetType="post" /></>}
          <TextButton onPress={() => app.navigate("S01")}>둘러보기</TextButton>
        </>
      )}
    </Screen>
  );
}

export function RemoteEventDetail({ id }: { id: string }) {
  const service = useService();
  const page = useRemotePage(id, async (_cursor, signal) => {
    if (!service) throw new ApiError(503, "SERVICE_NOT_CONFIGURED");
    return { items: [await service.getEvent(id, signal)], nextCursor: null };
  });
  const event = page.items[0];
  return (
    <Screen title="행사 상세">
      {page.busy && <Body muted>행사를 확인하고 있어요…</Body>}
      {page.error && (
        <Empty title={page.error} action="다시 시도" onPress={page.retry} />
      )}
      {event && (
        <Card>
          <Title large>{event.title}</Title>
          <Body>{event.placeName ?? "장소 미확인"}</Body>
          <Body>{event.publicAddress ?? ""}</Body>
          <Body>
            {event.precision === "date"
              ? `${event.startsOn} ~ ${event.endsOn}`
              : `${event.startsAt} ~ ${event.endsAt}`}
          </Body>
          <Body>
            {event.admission.kind === "free"
              ? "무료 입장"
              : event.admission.kind === "described"
              ? event.admission.text
              : "입장료 미확인"}
          </Body>
          <Body muted>출처: {event.provider} · {event.collectedAt}</Body>
          {event.posterUrl && (
            <Image
              accessibilityLabel={`${event.title} 공식 포스터`}
              source={{ uri: event.posterUrl }}
              style={{ height: 240, width: "100%" }}
              resizeMode="contain"
            />
          )}
          {event.description && <Body>{event.description}</Body>}
          {event.operatingInfo && <Body>{event.operatingInfo}</Body>}
          {event.sourceUrl && (
            <TextButton onPress={() => void Linking.openURL(event.sourceUrl!)}>
              공식 안내 보기
            </TextButton>
          )}
        </Card>
      )}
    </Screen>
  );
}

export function RemoteRankings({ mode }: { mode: "all" | "musical" }) {
  const service = useService();
  const [value, setValue] = useState<
    {
      mode: string;
      text: string;
      items: { rank: number; sourceId: string; title: string }[];
    }
  >({ mode, text: "순위를 확인하고 있어요…", items: [] });
  useEffect(() => {
    const controller = new AbortController();
    if (service) {
      void service.performanceRankings(mode, controller.signal).then(
        (response) => {
          if (!controller.signal.aborted) {
            setValue({
              mode,
              text: response.status === "available"
                ? `KOPIS · ${response.period!.start} ~ ${
                  response.period!.end
                } · 갱신 ${response.collectedAt}`
                : "공식 순위가 아직 수신되지 않았어요.",
              items: response.items,
            });
          }
        },
      ).catch((error) => {
        if (!controller.signal.aborted) {
          setValue({ mode, text: errorMessage(error), items: [] });
        }
      });
    }
    return () => controller.abort();
  }, [mode, service]);
  return (
    <View style={{ gap: 8 }}>
      <Body small muted>
        {value.mode === mode ? value.text : "순위를 확인하고 있어요…"}
      </Body>
      {value.mode === mode &&
        value.items.map((item) => (
          <Row key={item.sourceId}>
            <Badge>{item.rank}</Badge>
            <Body>{item.title}</Body>
          </Row>
        ))}
    </View>
  );
}

export function RemoteProfileSummary({ id }: { id: string }) {
  const service = useService();
  const session = useServiceSession();
  const [expanded, setExpanded] = useState(false);
  const [version, recheck] = useState(0);
  const key = `${session.epoch}:${id}:${version}`;
  const [result, set] = useState<
    { key: string; text: string | null; error: string; notice?: string }
  >({ key, text: null, error: "" });
  useFocusEffect(useCallback(() => {
    recheck((n) => n + 1);
    return () => {
      setExpanded(false);
      set({ key: "", text: null, error: "" });
    };
  }, []));
  useEffect(() => {
    const controller = new AbortController();
    if (service && session.authenticated) {
      void service.profileSummary(id, controller.signal).then((response) => {
        if (
          !controller.signal.aborted && serviceSessionEpoch() === session.epoch
        ) {
          set({ key, text: response.summary?.text ?? null, error: "", notice:
            response.status === "withdrawn" ? "후기 요약 제공이 중단되었어요. 공개 후기는 아래에서 확인할 수 있어요."
              : response.status === "insufficient_reviews" ? "요약에 사용할 공개 후기가 3개 이상 모이면 안내해요."
              : "후기 요약을 준비하고 있어요." });
        }
      }).catch((error) => {
        if (
          !controller.signal.aborted && serviceSessionEpoch() === session.epoch
        ) set({ key, text: null, error: errorMessage(error) });
      });
    }
    return () => controller.abort();
  }, [key, service, session.authenticated, id, session.epoch]);
  const text = result.key === key ? result.text : null;
  return (
    <Card>
      <Title>후기 요약</Title>
      {result.key === key && result.error
        ? <Body>{result.error}</Body>
        : text
        ? (
          <>
            <Button
              secondary
              onPress={() => {
                setExpanded((value) => !value);
                recheck((n) => n + 1);
              }}
            >
              {expanded ? "접기" : "요약 펼치기"}
            </Button>
            {expanded && <Body>{text}</Body>}
          </>
        )
        : <Body muted>{result.key === key ? result.notice ?? "현재 공개할 수 있는 요약을 확인하고 있어요." : "현재 공개할 수 있는 요약을 확인하고 있어요."}</Body>}
    </Card>
  );
}

/** Profile, public reviews and AI summary fail independently. */
export function RemoteProfileScreen({ id }: { id: string }) {
  const service = useService();
  const session = useServiceSession();
  const app = useApp();
  const page = useRemotePage(id, async (_cursor, signal) => {
    if (!service) throw new ApiError(503, "SERVICE_NOT_CONFIGURED");
    const profile = await service.getProfile(id, signal);
    return { items: [{ ...profile, id: profile.profileId }], nextCursor: null };
  });
  const profile = page.items[0];
  if (!session.authenticated) {
    return (
      <Screen title="프로필">
        <Empty
          title="동행인은 로그인 후 확인할 수 있어요"
          action="로그인"
          onPress={() => app.navigate("S05")}
        />
      </Screen>
    );
  }
  return (
    <Screen title="프로필">
      {page.busy && <Body muted>프로필을 확인하고 있어요…</Body>}
      {page.error && (
        <Empty title={page.error} action="다시 시도" onPress={page.retry} />
      )}
      {profile && (
        <>
          <Card>
            <Title large>{profile.displayName}</Title>
            <RemoteProfilePhoto path={profile.avatarPath} />
            <Body>만 {profile.age}세 · 완료 {profile.completedCount}회</Body>
            {profile.sweetness !== undefined && (
              <Body>당도 {profile.sweetness}</Body>
            )}
            {profile.bio && <Body>{profile.bio}</Body>}
            <Body>관심사: {profile.interests.join(" · ") || "미입력"}</Body>
            <Body>
              대화 방식: {profile.conversationStyles.join(" · ") || "미입력"}
            </Body>
            <Body>MBTI: {profile.mbti || "미입력"}</Body>
          </Card>
          <RemoteProfileSummary id={id} />
          <RemoteProfileReviews id={id} />
          <RemoteBlockControls profileId={profile.profileId} />
        </>
      )}
    </Screen>
  );
}
function RemoteProfileReviews({ id }: { id: string }) {
  const service = useService();
  const [praises, setPraises] = useState<
    { key: string; items: { code: string; label: string; count: number }[] }
  >({ key: "", items: [] });
  const session = useServiceSession();
  const key = `${session.epoch}:${id}`;
  const page = useRemotePage(id, async (cursor, signal) => {
    if (!service) throw new ApiError(503, "SERVICE_NOT_CONFIGURED");
    const response = await service.getProfileReviews(id, cursor, signal);
    if (!signal?.aborted && serviceSessionEpoch() === session.epoch) {
      setPraises({ key, items: response.praisesTop5 });
    }
    return {
      items: response.reviews.map((review) => ({
        ...review,
        id: review.reviewId,
      })),
      nextCursor: response.nextCursor,
    };
  });
  return (
    <View style={{ gap: 12 }}>
      <Card>
        <Title>많이 받은 칭찬</Title>
        {praises.key === key &&
          praises.items.map((praise) => (
            <Body key={praise.code}>{praise.label} · {praise.count}회</Body>
          ))}
      </Card>
      <Title>공개 후기</Title>
      {page.items.map((review) => (
        <Card key={review.id}>
          <Body>
            별점 {review.rating} · {review.experience === "positive"
              ? "좋았어요"
              : review.experience === "neutral"
              ? "보통이에요"
              : "아쉬웠어요"}
          </Body>
          {review.text && <Body>{review.text}</Body>}
          <Body small muted>{review.submittedAt}</Body>
        </Card>
      ))}
      {page.busy && <Body muted>후기를 확인하고 있어요…</Body>}
      {page.error && (
        <Empty title={page.error} action="다시 시도" onPress={page.retry} />
      )}
      {!page.busy && !page.error && !page.items.length && (
        <Body muted>공개된 후기가 없어요.</Body>
      )}
      {page.nextCursor && !page.busy && (
        <Button
          secondary
          onPress={() => void page.more()}
        >
          후기 5개 더 보기
        </Button>
      )}
    </View>
  );
}

export function RemoteEventListScreen(
  { selecting = false }: { selecting?: boolean },
) {
  const service = useService();
  const app = useApp();
  const [category, setCategory] = useState("");
  const [region, setRegion] = useState("");
  const [genre, setGenre] = useState<
    "concert" | "musical" | "play" | undefined
  >();
  const [ongoing, setOngoing] = useState(false);
  const [past, setPast] = useState(false);
  const [freeOnly, setFreeOnly] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [ranking, setRanking] = useState<"all" | "musical">("all");
  const filters = useRemotePage("event-filters", async (_cursor, signal) => {
    if (!service) throw new ApiError(503, "SERVICE_NOT_CONFIGURED");
    return {
      items: [{ id: "filters", ...await service.getEventFilters(signal) }],
      nextCursor: null,
    };
  });
  const categoryValues = [
    ...new Set(filters.items[0]?.categories.map((item) => item.value) ?? []),
  ];
  const regionValues = [
    ...new Set(filters.items[0]?.regions.map((item) => item.value) ?? []),
  ];
  const validPeriod = Number.isFinite(parseDateInput(start)) &&
    Number.isFinite(parseDateInput(end)) &&
    parseDateInput(start) <= parseDateInput(end);
  return (
    <Screen title={selecting ? "연결할 행사 선택" : "행사 둘러보기"}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Chip selected={!region} onPress={() => setRegion("")}>전국</Chip>
        {regionValues.map((value) => (
          <Chip
            key={value}
            selected={region === value}
            onPress={() => setRegion(value)}
          >
            {value}
          </Chip>
        ))}
      </View>
      {!selecting && (
        <Card>
          <Title>KOPIS 공식 공연 Top 10</Title>
          <Body small muted>어제까지 최근 7일 집계 · 매일 갱신 기준</Body>
          <Row>
            <Chip
              selected={ranking === "all"}
              onPress={() => setRanking("all")}
            >
              전체 공연
            </Chip>
            <Chip
              selected={ranking === "musical"}
              onPress={() => setRanking("musical")}
            >
              뮤지컬
            </Chip>
          </Row>
          <RemoteRankings mode={ranking} />
        </Card>
      )}
      <Title>{past ? "과거 기간 행사" : "이번 주 문화 행사"}</Title>
      <Body muted>
        {monthWeek(app.now).label} ·{" "}
        {past ? "선택 기간과 겹치는 행사" : "이번 주 신규 중 미종료"}
      </Body>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Chip selected={!category} onPress={() => setCategory("")}>전체</Chip>
        {categoryValues.map((value) => (
          <Chip
            key={value}
            selected={category === value}
            onPress={() => {
              setCategory(value);
              setGenre(undefined);
            }}
          >
            {value}
          </Chip>
        ))}
      </View>
      {filters.error && (
        <Empty
          title="행사 분류를 불러오지 못했어요"
          action="다시 시도"
          onPress={filters.retry}
        />
      )}
      <Row>
        {([{ value: "concert", label: "콘서트" }, {
          value: "musical",
          label: "뮤지컬",
        }, { value: "play", label: "연극" }] as const).map((item) => (
          <Chip
            key={item.value}
            selected={genre === item.value}
            onPress={() => {
              setGenre(genre === item.value ? undefined : item.value);
              setCategory("");
            }}
          >
            {item.label}
          </Chip>
        ))}
      </Row>
      <View style={{ gap: 8 }}>
        <Chip
          selected={ongoing}
          disabled={past}
          onPress={() => setOngoing(!ongoing)}
        >
          진행 중인 행사도 포함
        </Chip>
        <Chip selected={freeOnly} onPress={() => setFreeOnly(!freeOnly)}>
          무료 입장
        </Chip>
        <Chip selected={past} onPress={() => setPast(!past)}>
          과거 행사 조회
        </Chip>
      </View>
      {past && (
        <>
          <Field
            label="시작 날짜"
            value={start}
            onChangeText={setStart}
            placeholder="YYYY-MM-DD"
          />
          <Field
            label="종료 날짜"
            value={end}
            onChangeText={setEnd}
            placeholder="YYYY-MM-DD"
          />
        </>
      )}
      {selecting && (
        <Body muted>
          행사 조회를 제공하고 있어요. 작성 저장 연결은 준비 중이에요.
        </Body>
      )}
      {!past || validPeriod
        ? (
          <RemoteEventResults
            category={category}
            region={region}
            performanceGenre={genre}
            freeOnly={freeOnly}
            includeOngoing={!past && ongoing}
            period={past ? { start, end } : undefined}
          />
        )
        : <Body muted>올바른 시작·종료 날짜를 입력해 주세요.</Body>}
    </Screen>
  );
}

/** Draft selection uses the explicit drafting interval; a selected event never replaces that interval. */
export function RemoteEventPicker(
  { startsAt, endsAt, onSelect }: {
    startsAt: string;
    endsAt: string;
    onSelect: (event: PublicEventItem) => void;
  },
) {
  const service = useService();
  const start = parseDateInput(startsAt), end = parseDateInput(endsAt);
  const valid = Number.isFinite(start) && Number.isFinite(end) && start < end;
  const page = useRemotePage<PublicEventItem>(
    JSON.stringify({ startsAt, endsAt }),
    async (cursor, signal) => {
      if (!valid) return { items: [], nextCursor: null };
      if (!service) throw new ApiError(503, "SERVICE_NOT_CONFIGURED");
      const result = await service.listEvents(
        {
          mode: "post_selection",
          period: { start: startsAt.slice(0, 10), end: endsAt.slice(0, 10) },
        },
        cursor,
        signal,
      );
      return { items: result.events, nextCursor: result.nextCursor };
    },
  );
  if (!valid) {
    return <Body muted>작성할 시작·종료 일정을 먼저 입력해 주세요.</Body>;
  }
  return (
    <View style={{ gap: 12 }}>
      <Body small muted>
        작성 일정과 겹치는 진행 중·예정 행사를 선택해요. 행사 선택으로 동행
        일정은 바뀌지 않아요.
      </Body>
      {page.items.map((event) => {
        const eventStart = event.precision === "date"
          ? Date.parse(`${event.startsOn}T00:00:00+09:00`)
          : Date.parse(event.startsAt);
        const eventEnd = event.precision === "date"
          ? Date.parse(`${event.endsOn}T00:00:00+09:00`) + 86400000
          : Date.parse(event.endsAt);
        const eligible = event.sourceStatus === "active" &&
          event.state !== "ended" && eventStart < end && eventEnd > start;
        return (
          <Card key={event.id}>
            <Title>{event.title}</Title>
            <Body>{event.placeName || "장소 미확인"}</Body>
            <Button
              secondary
              disabled={!eligible}
              onPress={() => onSelect(event)}
            >
              {eligible ? "이 행사 연결하기" : "작성 일정에 연결할 수 없어요"}
            </Button>
          </Card>
        );
      })}
      {page.busy && <Body muted>선택할 행사를 확인하고 있어요…</Body>}
      {page.error && (
        <Empty title={page.error} action="다시 시도" onPress={page.retry} />
      )}
      {!page.busy && !page.error && !page.items.length && (
        <Empty title="작성 일정에 맞는 행사가 없어요" />
      )}
      {page.nextCursor && !page.busy && (
        <Button
          secondary
          onPress={() => void page.more()}
        >
          행사 10개 더 보기
        </Button>
      )}
    </View>
  );
}
