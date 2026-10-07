import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeMobileRegion,
  YumidangService,
} from "../../../apps/mobile/src/service.ts";
import { ApiError, checkAbort, requestSignal, ServiceApiClient } from "../../../apps/mobile/src/api.ts";

test("native signal 기본 속성만으로 취소 확인", () => {
  checkAbort({ aborted: false } as AbortSignal);
  assert.throws(() => checkAbort({ aborted: true } as AbortSignal), error => error instanceof Error && error.name === "AbortError");
});
test("signal 합성은 부모 취소와 기한을 전달하고 listener 정리", async () => {
  const parent = new AbortController();
  const request = requestSignal([parent.signal], 1000);
  parent.abort();
  assert.equal(request.signal.aborted, true);
  request.dispose();
  const expired = requestSignal([], 1);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(expired.signal.aborted, true);
  expired.dispose();
  const untouched = new AbortController(), disposed = requestSignal([untouched.signal]);
  disposed.dispose(); untouched.abort();
  assert.equal(disposed.signal.aborted, false);
});
test("late API 응답은 native처럼 throwIfAborted 없는 부모 취소 후 거절", async () => {
  const parent = new AbortController();
  Object.defineProperty(parent.signal, "throwIfAborted", { value: undefined });
  const client = new ServiceApiClient("https://api.example.test", async () => "synthetic", async () => {
    parent.abort(); return new Response(JSON.stringify({ data: "late" }));
  });
  await assert.rejects(client.request("/me", { signal: parent.signal }), error => error instanceof ApiError && error.code === "CANCELLED");
});

const postId = "11111111-1111-4111-8111-111111111111";
const card = {
  id: postId,
  title: "가을 전시",
  authorDisplayName: null,
  publicArea: "서울특별시 종로구 종로1가",
  startsAt: "2026-10-05T03:00:00Z",
  endsAt: "2026-10-05T04:00:00Z",
  cost: { kind: "free" },
  state: "recruiting",
  canApply: false,
};
const filters = {
  query: "",
  category: "전체",
  region: "전체",
  from: "",
  to: "",
  ageMin: "",
  ageMax: "",
  recruiting: false,
  sort: "created_desc" as const,
};
const detail = {
  postId,
  title: card.title,
  description: "공개 소개",
  category: "전시",
  startsAt: card.startsAt,
  endsAt: card.endsAt,
  recruitmentEndsAt: card.startsAt,
  updatedAt: card.startsAt,
  publicArea: card.publicArea,
  status: "recruiting",
  costType: "free",
  amount: 0,
  preferenceNote: null,
  tags: [],
  eventId: null,
  linkedEvent: null,
  authorDisplayName: null,
};
const event = {
  id: postId,
  provider: "kopis",
  sourceId: "PF123456",
  sourceStatus: "active",
  title: "전시",
  category: null,
  region: null,
  placeName: null,
  publicAddress: null,
  admission: { kind: "unknown" },
  sourceUrl: null,
  collectedAt: card.startsAt,
  state: "ongoing",
  precision: "date",
  startsOn: "2026-10-01",
  endsOn: "2026-10-31",
};
function setup(data: unknown, token: string | null = null) {
  const calls: { url: string; init: RequestInit }[] = [];
  let tokenReads = 0;
  const service = new YumidangService({
    serviceApiUrl: "https://service.invalid/functions/v1/service-api",
    aiChatUrl: "https://service.invalid/functions/v1/ai-chat",
    accessToken: async () => {
      tokenReads++;
      return token;
    },
    fetcher: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify({ data, requestId: "request-1" }), {
        status: 200,
      });
    }) as typeof fetch,
  });
  return { service, calls, tokenReads: () => tokenReads };
}
const schemaError = (error: unknown) =>
  error instanceof ApiError && error.status === 502 &&
  error.code === "INVALID_SERVICE_RESPONSE";

test("검색은 optional 인증·기본10·canonical시도·숫자경계·KST 날짜의 다음날 배타적끝을 연결한다", async () => {
  const { service, calls, tokenReads } = setup({
    status: "results",
    posts: [{ ...card, authorDisplayName: "김*현", canApply: true }],
    nextCursor: null,
  }, "valid-token");
  const result = await service.searchPosts({
    ...filters,
    region: "서울",
    ageMin: "25",
    from: "2026-12-31",
    to: "2027-01-01",
  });
  assert.equal(result.posts[0].authorDisplayName, "김*현");
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("limit"), "10");
  assert.equal(url.searchParams.get("region"), "서울특별시");
  assert.equal(url.searchParams.get("ageMin"), "25");
  assert.equal(url.searchParams.get("ageMax"), "99");
  assert.equal(
    url.searchParams.get("periodStart"),
    "2026-12-31T00:00:00+09:00",
  );
  assert.equal(url.searchParams.get("periodEnd"), "2027-01-02T00:00:00+09:00");
  assert.equal(
    (calls[0].init.headers as Record<string, string>).Authorization,
    "Bearer valid-token",
  );
  assert.equal(tokenReads(), 1);
});

test("익명 검색은 실명/별칭/사진 응답을 삭제해 성공시키지 않고 명시실패한다", async () => {
  const okay = setup({ status: "results", posts: [card], nextCursor: null });
  await okay.service.searchPosts(filters);
  assert.equal(
    "Authorization" in (okay.calls[0].init.headers as object),
    false,
  );
  for (
    const value of [
      { ...card, authorDisplayName: "김종현" },
      { ...card, authorDisplayName: "김*현" },
      { ...card, authorDisplayName: "동행123" },
      { ...card, photo: "private.jpg" },
    ]
  ) {
    await assert.rejects(
      setup({ status: "results", posts: [value], nextCursor: null }).service
        .searchPosts(filters),
      schemaError,
    );
  }
});

test("한쪽 날짜·이상범위·구분류는 HTTP 호출 전에 거절하고 0결과로 바꾸지 않는다", async () => {
  const { service, calls } = setup({
    status: "no_results",
    posts: [],
    nextCursor: null,
  });
  for (
    const change of [
      { from: "2026-10-05" },
      { from: "2026-02-30", to: "2026-03-01" },
      { ageMax: "18" },
      { ageMin: "100" },
      { ageMin: "30", ageMax: "29" },
      { category: "식사" },
      { region: "종로구" },
    ]
  ) {
    await assert.rejects(
      service.searchPosts({ ...filters, ...change }),
      (error: unknown) => error instanceof ApiError && error.status === 400,
    );
  }
  assert.equal(calls.length, 0);
});

test("정상빈결과와 서버schema불일치·중복·11개페이지를 구분한다", async () => {
  assert.deepEqual(
    await setup({ status: "no_results", posts: [], nextCursor: null }).service
      .searchPosts(filters),
    { status: "no_results", posts: [], nextCursor: null },
  );
  for (
    const data of [
      { status: "no_results", posts: [card], nextCursor: null },
      { status: "results", posts: [card, card], nextCursor: null },
      { status: "results", posts: Array(11).fill(card), nextCursor: null },
      { status: "no_results", posts: [], nextCursor: "next" },
    ]
  ) await assert.rejects(setup(data).service.searchPosts(filters), schemaError);
});

test("행사는 includeOngoing·10개조회와 날짜정밀도/입장료미상/null원천필드를 보존한다", async () => {
  const { service, calls } = setup({ events: [event], nextCursor: null });
  assert.deepEqual(
    (await service.listEvents({ mode: "new_this_week", includeOngoing: true }))
      .events,
    [event],
  );
  assert.equal(
    new URL(calls[0].url).searchParams.get("includeOngoing"),
    "true",
  );
  assert.equal(new URL(calls[0].url).searchParams.get("limit"), "10");
  for (
    const bad of [{ mode: "overlapping" as const, includeOngoing: true }, {
      mode: "new_this_week" as const,
      includeOngoing: true,
      ongoingOnly: true,
    }]
  ) {
    await assert.rejects(
      service.listEvents(bad),
      (error: unknown) => error instanceof ApiError && error.status === 400,
    );
  }
  for (
    const badEvent of [
      { ...event, rawSourceBody: "secret" },
      { ...event, sourceStatus: "cancelled" },
      { ...event, admission: { kind: "free", secret: "secret" } },
      { ...event, sourceUrl: "https://provider.invalid/event?apiKey=SECRET" },
    ]
  ) {
    await assert.rejects(
      setup({ events: [badEvent], nextCursor: null }).service.listEvents({
        mode: "new_this_week",
      }),
      schemaError,
    );
  }
});

test("공고상세는 실제SQL 공개DTO를 읽고 익명의 privateDetails/participantNames/실명을 거절한다", async () => {
  assert.deepEqual(await setup(detail).service.getPost(postId), detail);
  for (
    const bad of [
      { ...detail, authorDisplayName: "동행123" },
      { ...detail, privateDetails: null },
      { ...detail, participantNames: [] },
      { ...detail, authorId: postId },
      { ...detail, realName: "김종현" },
    ]
  ) await assert.rejects(setup(bad).service.getPost(postId), schemaError);
  const authorized = {
    ...detail,
    authorDisplayName: "김종현",
    privateDetails: {
      registeredPlaceName: "미술관",
      registeredAddress: "등록주소",
      meetingDetail: "확정지점",
    },
    participantNames: [{ userId: postId, realName: "김종현" }],
  };
  assert.deepEqual(
    await setup(authorized, "member-token").service.getPost(postId),
    authorized,
  );
});

test("AI는 별도정확엔드포인트 POST·required인증으로 전송하고 서버정책회복표시를 보존한다", async () => {
  const data = {
    requestId: "request-1",
    status: "unavailable",
    interpretedFilters: { target: "posts" },
    cards: [],
    explanations: [],
    notice: "동의 확인이 필요해요",
    recovery: { reason: "consent", retryAllowed: false },
  };
  const { service, calls } = setup(data, "member-token");
  const input = {
    clientRequestId: "request-1",
    messages: [{ role: "user" as const, content: "무료 전시" }],
    currentFilters: { target: "posts" as const },
  };
  assert.deepEqual(await service.askAi(input), data);
  assert.equal(calls[0].url, "https://service.invalid/functions/v1/ai-chat");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body as string), input);
  await assert.rejects(
    setup(data).service.askAi(input),
    (error: unknown) => error instanceof ApiError && error.status === 401,
  );
  const bad = {
    ...data,
    interpretedFilters: {
      target: "posts",
      date: { kind: "today", realName: "secret" },
    },
  };
  await assert.rejects(
    setup(bad, "member-token").service.askAi(input),
    schemaError,
  );
});

test("요약은 최신 서버 exact DTO·300Unicode문자를 검증하고 매조회 재호출한다", async () => {
  const data = {
    summary: {
      summaryId: postId,
      text: "😀".repeat(300),
      sourceCount: 3,
      updatedAt: card.startsAt,
    },
  };
  const { service, calls } = setup(data, "member-token");
  await service.profileSummary(postId);
  await service.profileSummary(postId);
  assert.equal(calls.length, 2);
  assert.equal(
    new URL(calls[0].url).pathname.endsWith(`/profiles/${postId}/review-summary`),
    true,
  );
  for (
    const bad of [
      { ...data, sourceRevision: "1" },
      { ...data, processingAllowed: false },
      { ...data, summary: { ...data.summary, text: "😀".repeat(301) } },
      { ...data, summary: { ...data.summary, sourceCount: 2 } },
    ]
  ) {
    await assert.rejects(
      setup(bad, "member-token").service.profileSummary(postId),
      schemaError,
    );
  }
});

test("공개 순위 HTTP 미연결은 미수신빈결과와 구분하고 내부 API로 우회하지 않는다", async () => {
  const { service, calls } = setup({ status: "unavailable", items: [] });
  await assert.rejects(service.performanceRankings(), { code: "EVENT_RANKINGS_NOT_CONNECTED" });
  await assert.rejects(service.performanceRankings("musical"), { code: "EVENT_RANKINGS_NOT_CONNECTED" });
  assert.equal(calls.length, 0);
});

test("401/네트워크장애는 익명재시도·자동재시도·빈결과fallback 없이 실패한다", async () => {
  let calls = 0;
  const input = {
    serviceApiUrl: "https://service.invalid/service-api",
    accessToken: async () => "bad-token",
  };
  const unauthorized = new YumidangService({
    ...input,
    fetcher: (async () => {
      calls++;
      return new Response(
        JSON.stringify({ error: { code: "AUTH_REQUIRED" } }),
        { status: 401 },
      );
    }) as typeof fetch,
  });
  await assert.rejects(
    unauthorized.searchPosts(filters),
    (error: unknown) => error instanceof ApiError && error.status === 401,
  );
  assert.equal(calls, 1);
  const offline = new YumidangService({
    ...input,
    fetcher: (async () => {
      calls++;
      throw new TypeError("offline");
    }) as typeof fetch,
  });
  await assert.rejects(
    offline.searchPosts(filters),
    (error: unknown) =>
      error instanceof ApiError && error.code === "SERVICE_UNAVAILABLE",
  );
  assert.equal(calls, 2);
});

test("시도 변환은17개 alias와공식명·전체를 구분하고 임의지역을거절한다", () => {
  assert.equal(normalizeMobileRegion("서울"), "서울특별시");
  assert.equal(normalizeMobileRegion("전북특별자치도"), "전북특별자치도");
  assert.equal(normalizeMobileRegion("전체"), undefined);
  assert.throws(
    () => normalizeMobileRegion("종로"),
    (error: unknown) => error instanceof ApiError && error.status === 400,
  );
});

test("행사 상세 HTTP 미연결은 대상삭제로 오해하지 않고 추측 경로를 호출하지 않는다", async () => {
  const { service, calls } = setup(event);
  await assert.rejects(service.getEvent(postId), { code: "EVENT_DETAIL_NOT_CONNECTED" });
  await assert.rejects(service.getEvent("invalid"), { code: "INVALID_REQUEST" });
  assert.equal(calls.length, 0);
});

const profile = {
  profileId: postId,
  displayName: "김*현",
  age: 100,
  gender: "female",
  avatarPath: "profiles/photo.jpg",
  bio: "전시를 좋아해요",
  interests: ["전시"],
  conversationStyles: ["차분한 대화"],
  mbti: "INFP",
  completedCount: 7,
};
const reviews = {
  reviews: [{
    reviewId: postId,
    rating: 5,
    experience: "positive",
    text: "약속 시간을 지켰어요",
    praises: ["punctual"],
    submittedAt: card.startsAt,
  }],
  praisesTop5: [{ code: "punctual", label: "시간을 잘 지켜요", count: 1 }],
  nextCursor: null,
  completedCount: 7,
};

test("회원프로필은 실제DTO·19세이상·성향을보존하고 당도미수신을15로발명하지않는다", async () => {
  const { service, calls } = setup(profile, "member-token");
  const result = await service.getProfile(postId);
  assert.deepEqual(result, profile);
  assert.equal("sweetness" in result, false);
  assert.equal(
    new URL(calls[0].url).pathname.endsWith(`/profiles/${postId}`),
    true,
  );
  assert.deepEqual(
    await setup({ ...profile, sweetness: 67 }, "member-token").service
      .getProfile(postId),
    { ...profile, sweetness: 67 },
  );
  for (
    const bad of [
      { ...profile, realName: "secret" },
      { ...profile, birthDate: "2000-01-01" },
      { ...profile, gender: "male" },
      { ...profile, age: 18 },
      { ...profile, sweetness: 101 },
      { ...profile, mbti: "XXXX" },
      { ...profile, interests: ["가".repeat(41)] },
    ]
  ) {
    await assert.rejects(
      setup(bad, "member-token").service.getProfile(postId),
      schemaError,
    );
  }
  const anonymous = setup(profile);
  await assert.rejects(
    anonymous.service.getProfile(postId),
    (error: unknown) => error instanceof ApiError && error.status === 401,
  );
  assert.equal(anonymous.calls.length, 0);
});

test("원문후기5개조회·UUIDbefore커서·칭찬top5는작성자식별필드없이연결한다", async () => {
  const { service, calls } = setup(reviews, "member-token");
  assert.deepEqual(
    await service.getProfileReviews(
      postId,
      "22222222-2222-4222-8222-222222222222",
    ),
    reviews,
  );
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("limit"), "5");
  assert.equal(
    url.searchParams.get("before"),
    "22222222-2222-4222-8222-222222222222",
  );
  for (
    const bad of [
      { ...reviews, reviews: [{ ...reviews.reviews[0], reviewerId: postId }] },
      { ...reviews, reviews: [{ ...reviews.reviews[0], rating: 6 }] },
      {
        ...reviews,
        reviews: [{ ...reviews.reviews[0], experience: "neutral" }],
      },
      { ...reviews, reviews: Array(6).fill(reviews.reviews[0]) },
      { ...reviews, nextCursor: "opaqueNotUuid" },
      { ...reviews, praisesTop5: [{ ...reviews.praisesTop5[0], count: 0 }] },
    ]
  ) {
    await assert.rejects(
      setup(bad, "member-token").service.getProfileReviews(postId),
      schemaError,
    );
  }
  await assert.rejects(
    setup(reviews).service.getProfileReviews(postId),
    (error: unknown) => error instanceof ApiError && error.status === 401,
  );
});

test("행사필터목록은제공처/value/count의실제RPC값을보존한다", async () => {
  const data = {
    regions: [{ provider: "kopis", value: "서울특별시", count: 3 }],
    categories: [{ provider: "tourapi", value: "축제", count: 2 }],
  };
  const { service, calls } = setup(data);
  assert.deepEqual(await service.getEventFilters(), data);
  assert.equal(
    new URL(calls[0].url).pathname.endsWith("/events/filters"),
    true,
  );
  for (
    const bad of [
      { ...data, regions: [{ value: "서울", label: "서울" }] },
      { ...data, regions: [data.regions[0], data.regions[0]] },
      { ...data, regions: [{ ...data.regions[0], count: -1 }] },
      { ...data, regions: [{ ...data.regions[0], value: "<b>서울</b>" }] },
    ]
  ) await assert.rejects(setup(bad).service.getEventFilters(), schemaError);
});

test("공식행사소개/운영안내/포스터/공연구분옵션은보존하되HTML·제어문자·credentialURL은거절한다", async () => {
  const readEvent = async (value: unknown) => (await setup({ events: [value], nextCursor: null }).service.listEvents({ mode: "overlapping" })).events[0];
  const source = {
    ...event,
    description: "제공처가 확인한 소개",
    operatingInfo: "공식 운영 안내",
    posterUrl: "https://images.invalid/poster.jpg",
    performanceGenre: "concert",
  };
  assert.deepEqual(await readEvent(source), source);
  assert.deepEqual(
    await readEvent({
      ...source,
      description: null,
      operatingInfo: null,
      posterUrl: null,
      performanceGenre: null,
    }),
    {
      ...source,
      description: null,
      operatingInfo: null,
      posterUrl: null,
      performanceGenre: null,
    },
  );
  for (
    const bad of [
      { ...source, description: "<b>소개</b>" },
      { ...source, operatingInfo: "정상\u0000비정상" },
      { ...source, posterUrl: "https://user:secret@images.invalid/poster.jpg" },
      {
        ...source,
        posterUrl: "https://images.invalid/poster.jpg?token=secret",
      },
      { ...source, posterUrl: "https://images.invalid/poster.jpg#token" },
      { ...source, performanceGenre: "unknown" },
    ]
  ) await assert.rejects(readEvent(bad), schemaError);
});

test("무료/공연장르선택은정확히전달하고미확인입장료를무료로추정하지않는다", async () => {
  const source = {
    ...event,
    admission: { kind: "free" },
    performanceGenre: "concert",
  };
  const { service, calls } = setup({ events: [source], nextCursor: null });
  assert.deepEqual(
    (await service.listEvents({
      mode: "overlapping",
      freeOnly: true,
      performanceGenre: "concert",
    })).events,
    [source],
  );
  const params = new URL(calls[0].url).searchParams;
  assert.equal(params.get("freeOnly"), "true");
  assert.equal(params.get("performanceGenre"), "concert");
  await assert.rejects(
    setup({ events: [event], nextCursor: null }).service.listEvents({
      mode: "overlapping",
      freeOnly: true,
    }),
    schemaError,
  );
  await assert.rejects(
    setup({ events: [source], nextCursor: null }).service.listEvents({
      mode: "overlapping",
      performanceGenre: "musical",
    }),
    schemaError,
  );
});

test("AI요약장애에도프로필·원문후기·칭찬API성공을독립적으로유지한다", async () => {
  const calls: string[] = [];
  const service = new YumidangService({
    serviceApiUrl: "https://service.invalid/service-api",
    accessToken: async () => "member-token",
    fetcher: (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      if (path.endsWith("/review-summary")) {
        return new Response(
          JSON.stringify({ error: { code: "EXTERNAL_UNAVAILABLE" } }),
          { status: 503 },
        );
      }
      return new Response(
        JSON.stringify({ data: path.endsWith("/reviews") ? reviews : profile }),
        { status: 200 },
      );
    }) as typeof fetch,
  });
  const results = await Promise.allSettled([
    service.getProfile(postId),
    service.getProfileReviews(postId),
    service.profileSummary(postId),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "fulfilled");
  assert.equal(results[2].status, "rejected");
  assert.equal(calls.length, 3);
});

const placeResult = {
  status: "results",
  places: [{
    source: "kakao",
    sourceId: "12345",
    placeName: "국립현대미술관 서울",
    address: "서울 종로구 삼청로 30",
    roadAddress: null,
  }],
  nextPage: 2,
};
test("장소명검색은기존회원전용places엔드포인트·query/page·10개공개입력후보를연결한다", async () => {
  const { service, calls } = setup(placeResult, "member-token");
  assert.deepEqual(await service.searchPlaces("미술관"), placeResult);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/functions/v1/places");
  assert.equal(url.searchParams.get("query"), "미술관");
  assert.equal(url.searchParams.get("page"), "1");
  assert.equal(
    (calls[0].init.headers as Record<string, string>).Authorization,
    "Bearer member-token",
  );
  const anonymous = setup(placeResult);
  await assert.rejects(
    anonymous.service.searchPlaces("미술관"),
    (error: unknown) => error instanceof ApiError && error.status === 401,
  );
  assert.equal(anonymous.calls.length, 0);
});
test("장소응답은전화/좌표/거리/개인필드·11개·역행페이지를반환하지않고빈결과와장애를분리한다", async () => {
  assert.deepEqual(
    await setup(
      { status: "no_results", places: [], nextPage: null },
      "member-token",
    ).service.searchPlaces("없는 장소"),
    { status: "no_results", places: [], nextPage: null },
  );
  for (
    const bad of [
      {
        ...placeResult,
        places: [{ ...placeResult.places[0], phone: "secret" }],
      },
      {
        ...placeResult,
        places: [{ ...placeResult.places[0], distance: "100" }],
      },
      { ...placeResult, places: [{ ...placeResult.places[0], latitude: 37 }] },
      { ...placeResult, places: Array(11).fill(placeResult.places[0]) },
      { ...placeResult, nextPage: 1 },
      { status: "no_results", places: [], nextPage: 2 },
    ]
  ) {
    await assert.rejects(
      setup(bad, "member-token").service.searchPlaces("미술관"),
      schemaError,
    );
  }
  const { service, calls } = setup(placeResult, "member-token");
  for (
    const [query, page] of [["", 1], ["미술관", 0], ["미술관", 46], [
      "미술관",
      1.5,
    ], ["가".repeat(301), 1]] as const
  ) {
    await assert.rejects(
      service.searchPlaces(query, page),
      (error: unknown) => error instanceof ApiError && error.status === 400,
    );
  }
  assert.equal(calls.length, 0);
});
test("장소URL명시설정은기존단일endpoint를사용하고미설정custom경로를임의로만들지않는다", async () => {
  const calls: string[] = [];
  const options = {
    serviceApiUrl: "https://service.invalid/custom",
    accessToken: async () => "member-token",
    fetcher: (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ data: placeResult }), {
        status: 200,
      });
    }) as typeof fetch,
  };
  await assert.rejects(
    new YumidangService(options).searchPlaces("미술관"),
    (error: unknown) =>
      error instanceof ApiError && error.code === "PLACES_NOT_CONFIGURED",
  );
  assert.equal(calls.length, 0);
  await new YumidangService({
    ...options,
    placesUrl: "https://places.invalid/functions/v1/places",
  }).searchPlaces("미술관");
  assert.equal(new URL(calls[0]).pathname, "/functions/v1/places");
});

test("AI 평가는 회원 전용 경로에 원문 없이 보내고 접수 ID를 검증한다", async () => {
  const { service, calls } = setup({ status: "accepted", feedbackId: postId, hideAnswer: false }, "valid-token");
  const input = { clientRequestId: "feedback-1", requestId: postId, action: "helpful" as const };
  assert.deepEqual(await service.sendAiFeedback(input), { status: "accepted", feedbackId: postId, hideAnswer: false });
  assert.equal(new URL(calls[0].url).pathname, "/functions/v1/ai-chat/feedback");
  assert.equal((calls[0].init.headers as Record<string,string>).Authorization, "Bearer valid-token");
  assert.deepEqual(JSON.parse(calls[0].init.body as string), input);
  const anonymous = setup({ status: "accepted", feedbackId: postId, hideAnswer: false });
  await assert.rejects(() => anonymous.service.sendAiFeedback(input), e => e instanceof ApiError && e.code === "AUTH_REQUIRED");
  assert.equal(anonymous.calls.length, 0);
});

test("AI 신고는 확인한 첨부 하나만 보내며 미준비 응답을 성공으로 바꾸지 않는다", async () => {
  const { service, calls } = setup({ status: "not_enabled", reason: "AI_REPORT_EVIDENCE_HANDLING_NOT_CONNECTED" }, "valid-token");
  const input = { clientRequestId: "report-1", requestId: postId, action: "report" as const, confirmed: true as const, attachment: { kind: "answer" as const, text: "신고할 답변 일부" } };
  assert.deepEqual(await service.sendAiFeedback(input), { status: "not_enabled", reason: "AI_REPORT_EVIDENCE_HANDLING_NOT_CONNECTED" });
  assert.deepEqual(JSON.parse(calls[0].init.body as string), input);
  for (const bad of [ { ...input, confirmed: false }, { ...input, messages: [] }, { ...input, attachment: { kind: "answer", text: "가".repeat(501) } }, { ...input, attachment: { kind: "capture", assetId: "https://private.invalid/file" } }, { ...input, attachment: { kind: "answer", text: "일부", assetId: postId } } ]) {
    await assert.rejects(() => service.sendAiFeedback(bad as never), e => e instanceof ApiError && e.code === "INVALID_REQUEST");
  }
  assert.equal(calls.length, 1);
});

test("AI 신고 응답의 숨김 플래그·외부 첨부 필드 변조는 거부한다", async () => {
  const input = { clientRequestId: "report-2", requestId: postId, action: "report" as const, confirmed: true as const, attachment: { kind: "capture" as const, assetId: postId } };
  for (const data of [ { status: "accepted", feedbackId: postId, hideAnswer: false }, { status: "accepted", feedbackId: "not-id", hideAnswer: true }, { status: "accepted", feedbackId: postId, hideAnswer: true, transcript: "private" }, { status: "not_enabled", reason: "unknown" } ]) {
    await assert.rejects(() => setup(data, "valid-token").service.sendAiFeedback(input), schemaError);
  }
  assert.equal((await setup({ status: "accepted", feedbackId: postId, hideAnswer: true }, "valid-token").service.sendAiFeedback(input)).status, "accepted");
});


test("AI 공연 해석 응답의 콘서트·뮤지컬·연극을 보존하고 미지원 장르를 거절한다", async () => {
  const request = { clientRequestId: "genre-1", messages: [{role: "user" as const, content: "클래식 공연"}], currentFilters: {target: "events" as const, region: "서울특별시" as const} };
  for (const performanceGenre of ["concert", "musical", "play"]) {
    const data = {requestId: postId, status: "no_results", cards: [], explanations: [], interpretedFilters: {target: "events", region: "서울특별시", performanceGenre}};
    assert.equal((await setup(data, "valid-token").service.askAi(request)).interpretedFilters.performanceGenre, performanceGenre);
  }
  await assert.rejects(() => setup({requestId: postId, status: "no_results", cards: [], explanations: [], interpretedFilters: {target: "events", performanceGenre: "opera"}}, "valid-token").service.askAi(request), schemaError);
});
