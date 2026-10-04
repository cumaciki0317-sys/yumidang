import type { AppState, Draft, Member, Post } from "./types";
import { currentWeek, DAY, HOUR, kstDay } from "./domain";

export function emptyDraft(now: number): Draft {
  const start = new Date(now + 2 * DAY + 9 * HOUR).toISOString().slice(0, 16);
  const end = new Date(now + 2 * DAY + 2 * HOUR + 9 * HOUR)
    .toISOString()
    .slice(0, 16);
  return {
    category: "전시",
    title: "",
    introduction: "",
    placeName: "",
    publicArea: "",
    address: "",
    meetingPoint: "",
    startsAt: start,
    endsAt: end,
    deadlineAt: "",
    desiredAgeMin: "",
    desiredAgeMax: "",
    wishes: "",
    updatedAt: now,
  };
}
export function initialState(now = Date.now()): AppState {
  const member = (
    id: string,
    name: string,
    age: number,
    photo: string,
    interests: string[],
  ): Member => ({
    id,
    name,
    age,
    photo,
    interests,
    conversationStyles: ["편안한 대화", "천천히 알아가기"],
    mbti: "INFJ",
    introduction: "일상의 취향을 함께 나눌 동행을 찾아요.",
    sweetness: 15,
    completedCount: 0,
  });
  const members = {
    me: member("me", "김민지", 27, "peer", ["전시", "산책"]),
    host: member("host", "박수빈", 29, "avatar", ["전시", "공연"]),
    peer: member("peer", "이지은", 26, "peer", ["카페", "영화"]),
  };
  const week = currentWeek(now);
  const events = [
    {
      id: "festival",
      title: "가을의 취향, 서울 문화 산책",
      category: "축제",
      placeName: "서울숲",
      publicArea: "서울 성동구 성수동",
      startsAt: Math.min(now - HOUR, week.startsAt + DAY),
      endsAt: week.endsAt + 2 * DAY,
      image: "festival",
      price: "무료",
      sourceName: "서울 열린데이터",
      description:
        "음악과 문화, 가을의 분위기를 느끼는 축제예요. 이 화면은 디자인 확인을 위한 예시 행사입니다.",
    },
    {
      id: "gallery",
      title: "빛과 색을 만나는 현대미술전",
      category: "전시",
      placeName: "국립현대미술관 서울",
      publicArea: "서울 종로구 소격동",
      startsAt: week.startsAt + DAY,
      endsAt: week.endsAt + 7 * DAY,
      image: "gallery",
      price: "입장료 확인 필요",
      sourceName: "전시 제공처",
      description:
        "색과 빛을 천천히 살펴보는 전시. 편안한 걸음으로 취향을 나눠 보세요. 실제 운영 정보는 제공처에서 확인해야 합니다.",
    },
    {
      id: "ongoing",
      title: "이야기가 흐르는 뮤지컬",
      category: "공연",
      placeName: "대학로 공연장",
      publicArea: "서울 종로구 혜화동",
      startsAt: week.startsAt - 5 * DAY,
      endsAt: week.endsAt + 9 * DAY,
      image: "gallery",
      price: "가격 확인 필요",
      sourceName: "KOPIS",
      description:
        "지난주부터 진행 중인 예시 공연입니다. 공식 Top 10 순위를 의미하지 않습니다.",
    },
    {
      id: "ended",
      title: "지난 주말의 작은 팝업",
      category: "팝업",
      placeName: "성수 문화공간",
      publicArea: "서울 성동구 성수동",
      startsAt: week.startsAt - 2 * DAY,
      endsAt: week.startsAt - DAY,
      image: "festival",
      price: "무료",
      sourceName: "행사 제공처",
      description:
        "종료된 예시 행사예요. 행사 정보는 볼 수 있지만 새 모집에는 연결할 수 없어요.",
    },
  ];
  const titles = [
    "삼청동 전시 천천히 같이 볼 분",
    "여의도 한강에서 피크닉 같이해요",
    "성수에서 조용한 카페 찾아갈 분",
    "서울숲 가을 산책 함께해요",
    "영화 보고 취향 이야기 나눠요",
    "작은 서점에서 책 같이 골라요",
    "취향이 통하는 쇼핑 동행",
    "대학로 공연 함께 보러 가요",
    "한강에서 가볍게 걷고 싶어요",
    "주말 맛집 같이 찾아가요",
    "퇴근 후 편안한 저녁 한 끼",
    "전시 끝나고 커피 한 잔 어때요",
  ];
  const categories = [
    "전시",
    "산책",
    "카페",
    "산책",
    "영화",
    "스터디",
    "쇼핑",
    "공연",
    "산책",
    "맛집",
    "맛집",
    "전시",
  ];
  const posts: Post[] = titles.map((title, i) => ({
    id: "post-" + (i + 1),
    authorId: i % 3 === 2 ? "peer" : "host",
    title,
    introduction:
      "같은 취향을 가진 분과 부담 없이 함께하고 싶어요. 천천히 둘러보고 서로의 이야기도 나누면 좋겠어요.",
    category: categories[i],
    placeName:
      i === 0 ? "국립현대미술관 서울" : i === 1 ? "여의도 한강공원" : "서울숲",
    publicArea:
      i === 0
        ? "서울 종로구 소격동"
        : i === 1
          ? "서울 영등포구 여의도동"
          : "서울 성동구 성수동",
    address:
      i === 0
        ? "서울 종로구 삼청로 30"
        : i === 1
          ? "서울 영등포구 여의동로 330"
          : "서울 성동구 뚝섬로 273",
    meetingPoint: "정문 안내 데스크 앞에서 만나요.",
    startsAt: now + (i + 2) * DAY,
    endsAt: now + (i + 2) * DAY + 2 * HOUR,
    createdAt: now - i * HOUR,
    deadlineAt: now + (i + 2) * DAY,
    status: i === 7 ? "closed" : "recruiting",
    eventId: i === 0 ? "gallery" : undefined,
    image: i === 0 ? "gallery" : undefined,
  }));
  const future = posts[0];
  future.status = "confirmed";
  const completedPost = {
    ...posts[1],
    id: "post-completed",
    startsAt: now - 2 * DAY,
    endsAt: now - 2 * DAY + 2 * HOUR,
    status: "completed" as const,
  };
  posts.push(completedPost);
  const appointments = [
    {
      id: "appointment-1",
      postId: future.id,
      hostId: "host",
      applicantId: "me",
      startsAt: future.startsAt,
      endsAt: future.endsAt,
      completedAt: null,
      confirmations: [],
      status: "confirmed" as const,
    },
    {
      id: "appointment-completed",
      postId: completedPost.id,
      hostId: "host",
      applicantId: "me",
      startsAt: completedPost.startsAt,
      endsAt: completedPost.endsAt,
      completedAt: now - 12 * HOUR,
      confirmations: ["host", "me"],
      status: "completed" as const,
    },
  ];
  const conversations = [
    {
      id: "conversation-1",
      postId: future.id,
      applicantId: "me",
      status: "confirmed" as const,
      messages: [
        {
          id: "m1",
          senderId: "me",
          text: "안녕하세요! 전시 천천히 같이 보고 싶어요.",
          at: now - HOUR,
        },
        {
          id: "m2",
          senderId: "host",
          text: "반가워요. 약속한 날에 편안하게 만나요 :)",
          at: now - HOUR + 1000,
        },
      ],
      hiddenBy: [],
    },
    {
      id: "conversation-completed",
      postId: completedPost.id,
      applicantId: "me",
      status: "ended" as const,
      messages: [
        {
          id: "m3",
          senderId: "host",
          text: "오늘 즐거웠어요. 조심히 들어가세요!",
          at: now - DAY,
        },
      ],
      hiddenBy: [],
    },
  ];
  return {
    viewerId: null,
    members,
    posts,
    events,
    conversations,
    appointments,
    reviews: [],
    notifications: [
      {
        id: "n1",
        title: "동행 약속이 확정됐어요",
        text: future.title,
        at: now - HOUR,
        read: false,
        screen: "S16",
        targetId: "appointment-1",
      },
      {
        id: "n2",
        title: "함께한 동행은 어땠나요?",
        text: "완료한 동행의 후기를 남겨 주세요.",
        at: now - 12 * HOUR,
        read: false,
        screen: "S17",
        targetId: "appointment-completed",
      },
    ],
    draft: null,
    recentSearches: [],
    blockedIds: [],
    aiMessages: [],
    aiUsed: 0,
    aiDay: kstDay(now),
    aiBusy: false,
    aiDiscoveryAllowed: true,
    aiSummaryAllowed: true,
    failNext: false,
    now,
    toast: "",
    accountStatus: "normal",
    restrictionsEndAt: null,
  };
}
