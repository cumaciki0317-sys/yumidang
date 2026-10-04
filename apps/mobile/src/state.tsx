import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { router, usePathname, useGlobalSearchParams } from "expo-router";
import type {
  AppContextValue,
  AppState,
  Appointment,
  OperationResult,
  Review,
  ScreenId,
} from "./types";
import { initialState, emptyDraft } from "./data";
import {
  DAY,
  HOUR,
  canAutoComplete,
  canWriteReview,
  changeExpiresAt,
  detectPersonalInfo,
  finalRequestExpiresAt,
  kstDay,
  parseDateInput,
  reviewDeadline,
  reviewVisible,
  sweetness,
  validateDraft,
} from "./domain";
import * as storage from "./storage";
import { serviceMode, installServiceSession } from "./remote";

export const routes: Record<ScreenId, string> = {
  S00: "/",
  S01: "/explore",
  S02: "/post",
  S03: "/create",
  S04: "/publish",
  S05: "/login",
  S06: "/signup",
  S09: "/category",
  "S09-2": "/events",
  "S09-3": "/event",
  S10: "/chats",
  S11: "/chat",
  S12: "/notifications",
  S13: "/me",
  S14: "/profile",
  S15: "/photo",
  "S15-2": "/preferences",
  S16: "/appointment",
  S17: "/review",
  S18: "/cancel",
  S19: "/safety",
  S20: "/ai",
  S21: "/account",
};
const AppContext = createContext<AppContextValue | null>(null);
const uid = () => Math.random().toString(36).slice(2, 10);
const err = (message: string): OperationResult => ({ ok: false, message });
const ok = (id?: string): OperationResult => ({ ok: true, id });
const owner = (state: AppState) => state.viewerId || "anonymous";
function conflicts(
  state: AppState,
  userId: string,
  start: number,
  end: number,
  except?: string,
) {
  return state.appointments.some(
    (a) =>
      a.id !== except &&
      a.status === "confirmed" &&
      [a.hostId, a.applicantId].includes(userId) &&
      a.startsAt < end &&
      start < a.endsAt,
  );
}

/** Local scenario adapter. No OAuth, member data or model calls leave this preview. */
export function AppProvider({ children }: { children: React.ReactNode }) {
  const defaultMemberId = useRef("me");
  const pathname = usePathname();
  const params = useGlobalSearchParams();
  const [state, setState] = useState<AppState>(() => {
    const initial = initialState();
    return serviceMode ? { ...initial, viewerId: null, members: {}, posts: [], events: [], conversations: [], appointments: [], reviews: [], notifications: [], aiDiscoveryAllowed: false, aiSummaryAllowed: false } : initial;
  });
  const ref = useRef(state);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aiLock = useRef(false);
  const aiGeneration = useRef(0);
  const blockedByOwner = useRef<Record<string, string[]>>({});
  const usageByOwner = useRef<Record<string, { day: string; used: number }>>(
    {},
  );
  const consentsByOwner = useRef<
    Record<string, { discovery: boolean; summary: boolean }>
  >({});
  const commit = useCallback((patch: Partial<AppState>) => {
    const next = { ...ref.current, ...patch };
    ref.current = next;
    setState(next);
  }, []);
  const notify = (
    title: string,
    text: string,
    screen: ScreenId,
    targetId?: string,
  ) => ({
    id: uid(),
    title,
    text,
    screen,
    targetId,
    at: ref.current.now,
    read: false,
  });
  const showToast = useCallback(
    (message: string) => {
      commit({ toast: message });
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => commit({ toast: "" }), 4200);
    },
    [commit],
  );
  const navigate = (screen: ScreenId, id?: string) => {
    router.push({
      pathname: routes[screen] as any,
      params:
        screen === "S05"
          ? {
              returnPath:
                pathname +
                (typeof params.id === "string"
                  ? "?id=" + encodeURIComponent(params.id)
                  : ""),
            }
          : id
            ? { id }
            : {},
    });
  };
  const back = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };
  const fail = () => {
    if (ref.current.failNext) {
      commit({ failNext: false });
      return true;
    }
    return false;
  };
  const restricted = () =>
    ref.current.accountStatus === "permanent" ||
    (ref.current.accountStatus === "restricted" &&
      (ref.current.restrictionsEndAt === null ||
        ref.current.now < ref.current.restrictionsEndAt));
  const refresh = useCallback(
    (patch: Partial<AppState> = {}) => {
      const s = { ...ref.current, ...patch };
      const appointments = s.appointments.map((a) =>
        canAutoComplete(a, s.now)
          ? { ...a, status: "completed" as const, completedAt: s.now }
          : a,
      );
      const reviews = s.reviews.map((r) => {
        const a = appointments.find((a) => a.id === r.appointmentId);
        return a &&
          reviewVisible(a, s.reviews, r, s.now) &&
          r.publishedAt === undefined
          ? { ...r, publishedAt: s.now }
          : r;
      });
      const members = { ...s.members };
      for (const id of Object.keys(members)) {
        const effective = reviews.filter(
          (r) => r.targetId === id && r.publishedAt !== undefined && !r.invalid,
        );
        members[id] = {
          ...members[id],
          sweetness: sweetness(effective),
          completedCount: appointments.filter(
            (a) =>
              a.completedAt !== null &&
              [a.hostId, a.applicantId].includes(id) &&
              a.status !== "cancelled",
          ).length,
        };
      }
      const conversations = s.conversations.map((c) =>
        c.requestExpiresAt !== undefined && s.now >= c.requestExpiresAt
          ? { ...c, requestAt: undefined, requestExpiresAt: undefined }
          : c,
      );
      const posts = s.posts.map((p) =>
        appointments.some(
          (a) =>
            a.postId === p.id &&
            a.completedAt !== null &&
            a.status === "completed",
        )
          ? { ...p, status: "completed" as const }
          : p.status === "awaiting_consent" &&
              !conversations.some(
                (c) => c.postId === p.id && c.requestExpiresAt !== undefined,
              )
            ? { ...p, status: "recruiting" as const }
            : p,
      );
      commit({
        ...s,
        appointments,
        reviews,
        members,
        conversations,
        posts,
        aiDay: kstDay(s.now),
        aiUsed: kstDay(s.now) === s.aiDay ? s.aiUsed : 0,
      });
    },
    [commit],
  );
  const clearAi = useCallback(() => {
    aiGeneration.current++;
    aiLock.current = false;
    commit({ aiMessages: [], aiBusy: false });
  }, [commit]);
  useEffect(() => {
    const t = setInterval(() => refresh({ now: ref.current.now + 1000 }), 1000);
    return () => {
      clearInterval(t);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, [refresh]);
  useEffect(() => {
    let active = true;
    const id = state.viewerId || "anonymous";
    Promise.all([
      storage.loadDraft(id, ref.current.now),
      storage.loadSearches(id, ref.current.now),
    ])
      .then(([draft, recentSearches]) => {
        if (active) commit({ draft, recentSearches });
      })
      .catch(() => {
        if (active)
          showToast("기기 저장 내용을 불러오지 못했어요. 다시 시도해 주세요.");
      });
    return () => {
      active = false;
    };
  }, [state.viewerId, commit, showToast]);

  const value: AppContextValue = {
    ...state,
    member: state.viewerId ? state.members[state.viewerId] || null : null,
    navigate,
    back,
    showToast,
    login: (requestedId = "me") => {
      let id = requestedId === "me" ? defaultMemberId.current : requestedId;
      const s = ref.current;
      if (s.viewerId) {
        blockedByOwner.current[s.viewerId] = s.blockedIds;
        usageByOwner.current[s.viewerId] = { day: s.aiDay, used: s.aiUsed };
        consentsByOwner.current[s.viewerId] = {
          discovery: s.aiDiscoveryAllowed,
          summary: s.aiSummaryAllowed,
        };
      }
      aiGeneration.current++;
      aiLock.current = false;
      if (!s.members[id]) {
        const fresh = initialState(s.now).members.me;
        id = "member-" + uid();
        defaultMemberId.current = id;
        commit({
          viewerId: id,
          members: {
            ...s.members,
            [id]: { ...fresh, id, sweetness: 15, completedCount: 0, photo: "" },
          },
          aiMessages: [],
        });
        navigate("S06");
      } else {
        const usage = usageByOwner.current[id],
          consent = consentsByOwner.current[id];
        commit({
          viewerId: id,
          aiMessages: [],
          aiBusy: false,
          blockedIds: blockedByOwner.current[id] || [],
          aiDay: kstDay(s.now),
          aiUsed: usage?.day === kstDay(s.now) ? usage.used : 0,
          aiDiscoveryAllowed: consent?.discovery ?? true,
          aiSummaryAllowed: consent?.summary ?? true,
        });
      }
    },
    logout: async () => {
      const id = owner(ref.current);
      blockedByOwner.current[id] = ref.current.blockedIds;
      usageByOwner.current[id] = {
        day: ref.current.aiDay,
        used: ref.current.aiUsed,
      };
      consentsByOwner.current[id] = {
        discovery: ref.current.aiDiscoveryAllowed,
        summary: ref.current.aiSummaryAllowed,
      };
      aiGeneration.current++;
      await storage.clearOwnerStorage(id);
      commit({
        viewerId: null,
        draft: null,
        recentSearches: [],
        aiMessages: [],
        blockedIds: [],
        aiBusy: false,
      });
      router.replace("/");
    },
    updateMember: (patch) => {
      const s = ref.current;
      if (!s.viewerId) return;
      commit({
        members: {
          ...s.members,
          [s.viewerId]: { ...s.members[s.viewerId], ...patch, id: s.viewerId },
        },
      });
      showToast("프로필을 저장했어요.");
    },
    saveDraft: async (draft) => {
      const fresh = { ...draft, updatedAt: ref.current.now };
      await storage.saveDraft(owner(ref.current), fresh);
      commit({ draft: fresh });
    },
    clearDraft: async () => {
      await storage.clearDraft(owner(ref.current));
      commit({ draft: null });
    },
    publish: (draft) => {
      const s = ref.current;
      if (!s.viewerId) return err("로그인 후 공고를 작성할 수 있어요.");
      if (restricted()) return err("현재 신규 공고 작성이 제한되어 있어요.");
      const original = draft.editingPostId
        ? s.posts.find((p) => p.id === draft.editingPostId)
        : undefined;
      if (
        draft.editingPostId &&
        (!original || original.authorId !== s.viewerId)
      )
        return err("수정할 공고의 권한을 확인해 주세요.");
      if (
        original &&
        s.appointments.some(
          (a) => a.postId === original.id && a.status === "confirmed",
        )
      )
        return err("확정 약속은 변경 제안으로 수정해 주세요.");
      const errors = validateDraft(draft, s.now);
      if (Object.keys(errors).length) return err(Object.values(errors)[0]);
      if (fail())
        return err("등록하지 못했어요. 입력을 유지했으니 다시 시도해 주세요.");
      const event = s.events.find((e) => e.id === draft.eventId);
      const start = parseDateInput(draft.startsAt),
        end = parseDateInput(draft.endsAt);
      if (
        event &&
        (event.endsAt <= s.now ||
          start >= event.endsAt ||
          end <= event.startsAt)
      )
        return err("행사 기간과 동행 일정이 겹치는지 확인해 주세요.");
      const id = original?.id || "post-" + uid();
      const { editingPostId, ...fields } = draft;
      const post = {
        ...fields,
        id,
        authorId: s.viewerId,
        startsAt: start,
        endsAt: end,
        createdAt: original?.createdAt || s.now,
        deadlineAt: draft.deadlineAt ? parseDateInput(draft.deadlineAt) : start,
        status:
          original?.status === "closed"
            ? ("closed" as const)
            : ("recruiting" as const),
        image: event?.image,
      };
      const changed =
        original &&
        (original.startsAt !== start ||
          original.endsAt !== end ||
          original.placeName !== draft.placeName ||
          original.meetingPoint !== draft.meetingPoint ||
          original.address !== draft.address ||
          original.deadlineAt !== post.deadlineAt);
      commit({
        posts: original
          ? s.posts.map((p) => (p.id === id ? post : p))
          : [post, ...s.posts],
        draft: null,
        conversations: changed
          ? s.conversations.map((c) =>
              c.postId === id
                ? { ...c, requestAt: undefined, requestExpiresAt: undefined }
                : c,
            )
          : s.conversations,
      });
      void storage.clearDraft(s.viewerId);
      return ok(id);
    },
    sendMessage: (postId, text, conversationId) => {
      const s = ref.current;
      if (!s.viewerId) return err("로그인이 필요해요.");
      if (!text.trim()) return err("메시지를 입력해 주세요.");
      if (fail())
        return err("전송에 실패했어요. 내용을 유지했으니 다시 전송해 주세요.");
      const post = s.posts.find((p) => p.id === postId);
      if (!post) return err("공고를 찾을 수 없어요.");
      let c = conversationId
        ? s.conversations.find((c) => c.id === conversationId)
        : s.conversations.find(
            (c) =>
              c.postId === postId &&
              (c.applicantId === s.viewerId || post.authorId === s.viewerId),
          );
      if (
        c &&
        (c.postId !== postId ||
          ![c.applicantId, post.authorId].includes(s.viewerId))
      )
        return err("이 대화에 접근할 수 없어요.");
      if (c && ["rejected", "ended"].includes(c.status))
        return err("종료된 대화는 읽기만 할 수 있어요.");
      if (
        s.blockedIds.includes(post.authorId) ||
        (c && s.blockedIds.includes(c.applicantId))
      )
        return err("차단된 상대에게 메시지를 보낼 수 없어요.");
      if (!c || c.status === "withdrawn") {
        if (post.authorId === s.viewerId)
          return err("먼저 신청자를 선택해 주세요.");
        if (restricted()) return err("현재 신규 신청이 제한되어 있어요.");
        if (post.status !== "recruiting" || s.now >= post.deadlineAt)
          return err("현재 새 신청을 받지 않는 공고예요.");
        if (c?.withdrawnAt !== undefined && s.now < c.withdrawnAt + 60000)
          return err("철회 후 1분이 지나면 재신청할 수 있어요.");
        if (!c)
          c = {
            id: "conversation-" + uid(),
            postId,
            applicantId: s.viewerId,
            status: "active",
            messages: [],
            hiddenBy: [],
          };
      }
      const first = c.messages.length === 0 || c.status === "withdrawn";
      const next = {
        ...c,
        status: c.status === "withdrawn" ? ("active" as const) : c.status,
        messages: [
          ...c.messages,
          { id: uid(), senderId: s.viewerId, text: text.trim(), at: s.now },
        ],
        hiddenBy: [],
      };
      commit({
        conversations: [
          ...s.conversations.filter((item) => item.id !== c!.id),
          next,
        ],
        notifications: first
          ? [
              notify("첫 채팅이 도착했어요", post.title, "S11", post.id),
              ...s.notifications,
            ]
          : s.notifications,
      });
      return ok(next.id);
    },
    requestMatch: (id) => {
      const s = ref.current;
      const c = s.conversations.find((c) => c.id === id),
        p = s.posts.find((p) => p.id === c?.postId);
      if (!c || !p || p.authorId !== s.viewerId)
        return err("작성자만 확정 요청을 보낼 수 있어요.");
      if (restricted() || s.blockedIds.includes(c.applicantId))
        return err("현재 확정 요청을 보낼 수 없어요.");
      if (c.status !== "active" || s.now >= p.startsAt)
        return err("유효한 신청과 시작 시각을 확인해 주세요.");
      if (
        s.conversations.some(
          (other) =>
            other.postId === p.id &&
            other.requestExpiresAt !== undefined &&
            s.now < other.requestExpiresAt,
        )
      )
        return err("한 번에 한 명에게만 요청할 수 있어요.");
      if (conflicts(s, p.authorId, p.startsAt, p.endsAt))
        return err("기존 확정 약속과 일정이 겹쳐요.");
      commit({
        conversations: s.conversations.map((v) =>
          v.id === id
            ? {
                ...v,
                requestAt: s.now,
                requestExpiresAt: finalRequestExpiresAt(s.now, p.startsAt),
              }
            : v,
        ),
        posts: s.posts.map((v) =>
          v.id === p.id ? { ...v, status: "awaiting_consent" } : v,
        ),
        notifications: [
          notify("확정 요청이 도착했어요", p.title, "S11", p.id),
          ...s.notifications,
        ],
      });
      return ok();
    },
    acceptMatch: (id) => {
      const s = ref.current;
      const c = s.conversations.find((c) => c.id === id),
        p = s.posts.find((p) => p.id === c?.postId);
      if (
        !c ||
        !p ||
        c.applicantId !== s.viewerId ||
        c.requestExpiresAt === undefined
      )
        return err("수락할 확정 요청이 없어요.");
      if (s.now >= c.requestExpiresAt) {
        refresh();
        return err("확정 요청이 만료됐어요. 신청과 대화는 유지돼요.");
      }
      if (restricted() || s.blockedIds.includes(p.authorId))
        return err("현재 새 동행을 확정할 수 없어요.");
      if (
        conflicts(s, c.applicantId, p.startsAt, p.endsAt) ||
        conflicts(s, p.authorId, p.startsAt, p.endsAt)
      )
        return err("기존 확정 약속과 일정이 겹쳐요.");
      if (fail())
        return err("확정하지 못했어요. 현재 상태를 다시 확인해 주세요.");
      const a: Appointment = {
        id: "appointment-" + uid(),
        postId: p.id,
        hostId: p.authorId,
        applicantId: c.applicantId,
        startsAt: p.startsAt,
        endsAt: p.endsAt,
        completedAt: null,
        confirmations: [],
        status: "confirmed",
      };
      commit({
        appointments: [a, ...s.appointments],
        conversations: s.conversations.map((v) =>
          v.postId === p.id && (v.id === id || v.status === "active")
            ? {
                ...v,
                status: v.id === id ? "confirmed" : "ended",
                endedReason: v.id === id ? undefined : "recruitment",
                requestAt: undefined,
                requestExpiresAt: undefined,
              }
            : v,
        ),
        posts: s.posts.map((v) =>
          v.id === p.id ? { ...v, status: "confirmed" } : v,
        ),
        notifications: [
          notify("동행 약속이 확정됐어요", p.title, "S16", a.id),
          ...s.notifications,
        ],
      });
      return ok(a.id);
    },
    withdrawMatch: (id) => {
      const s = ref.current;
      const c = s.conversations.find((c) => c.id === id),
        p = s.posts.find((p) => p.id === c?.postId);
      if (!c || !p || ![p.authorId, c.applicantId].includes(s.viewerId || ""))
        return err("권한을 확인해 주세요.");
      commit({
        conversations: s.conversations.map((v) =>
          v.id === id
            ? { ...v, requestAt: undefined, requestExpiresAt: undefined }
            : v,
        ),
        posts: s.posts.map((v) =>
          v.id === p.id && v.status === "awaiting_consent"
            ? { ...v, status: "recruiting" }
            : v,
        ),
      });
      return ok();
    },
    rejectApplicant: (id) => {
      const s = ref.current;
      const c = s.conversations.find((c) => c.id === id),
        p = s.posts.find((p) => p.id === c?.postId);
      if (!c || p?.authorId !== s.viewerId) return err("권한을 확인해 주세요.");
      commit({
        conversations: s.conversations.map((v) =>
          v.id === id
            ? {
                ...v,
                status: "rejected",
                requestAt: undefined,
                requestExpiresAt: undefined,
              }
            : v,
        ),
      });
      return ok();
    },
    reopenPost: (id) => {
      const s = ref.current;
      const p = s.posts.find((p) => p.id === id);
      if (
        !p ||
        p.authorId !== s.viewerId ||
        p.startsAt <= s.now ||
        s.appointments.some((a) => a.postId === id && a.status === "confirmed")
      )
        return err("이 공고의 모집을 재개할 수 없어요.");
      if (restricted()) return err("현재 새 모집이 제한되어 있어요.");
      commit({
        posts: s.posts.map((p) =>
          p.id === id ? { ...p, status: "recruiting" } : p,
        ),
        conversations: s.conversations.map((c) =>
          c.postId === id &&
          c.status === "ended" &&
          c.endedReason === "recruitment"
            ? { ...c, status: "active", endedReason: undefined }
            : c,
        ),
      });
      showToast("모집을 재개하고 유효한 신청을 복원했어요.");
      return ok();
    },
    closePost: (id) => {
      const s = ref.current;
      const p = s.posts.find((p) => p.id === id);
      if (
        p?.authorId !== s.viewerId ||
        !["recruiting", "awaiting_consent"].includes(p.status)
      )
        return err("현재 공고를 마감할 수 없어요.");
      commit({
        posts: s.posts.map((v) =>
          v.id === id ? { ...v, status: "closed" } : v,
        ),
      });
      return ok();
    },
    deletePost: (id) => {
      const s = ref.current;
      const p = s.posts.find((p) => p.id === id);
      if (p?.authorId !== s.viewerId) return err("권한을 확인해 주세요.");
      if (
        s.appointments.some((a) => a.postId === id && a.status === "confirmed")
      )
        return err("확정 약속은 약속 취소 절차를 먼저 진행해 주세요.");
      commit({
        posts: s.posts.map((p) =>
          p.id === id ? { ...p, status: "deleted" } : p,
        ),
        conversations: s.conversations.map((c) =>
          c.postId === id
            ? {
                ...c,
                status: "ended",
                endedReason: "deleted",
                requestAt: undefined,
                requestExpiresAt: undefined,
              }
            : c,
        ),
      });
      return ok();
    },
    editPost: (id) => {
      const p = ref.current.posts.find((p) => p.id === id);
      if (p?.authorId !== ref.current.viewerId) return;
      commit({
        draft: {
          ...emptyDraft(ref.current.now),
          ...p,
          editingPostId: id,
          startsAt: new Date(p.startsAt + 9 * HOUR).toISOString().slice(0, 16),
          endsAt: new Date(p.endsAt + 9 * HOUR).toISOString().slice(0, 16),
          deadlineAt: "",
        },
      });
      navigate("S03", "resume");
    },
    cancel: (postId, reason) => {
      const s = ref.current;
      if (!s.viewerId || !reason.trim()) return err("사유를 선택해 주세요.");
      const a = s.appointments.find(
        (a) =>
          a.postId === postId &&
          a.status === "confirmed" &&
          [a.hostId, a.applicantId].includes(s.viewerId!),
      );
      if (a) {
        if (s.now >= a.startsAt) {
          commit({
            appointments: s.appointments.map((v) =>
              v.id === a.id
                ? {
                    ...v,
                    status: "disputed",
                    disputeStartedAt: s.now,
                    reviewRemainingMs: reviewDeadline(v)
                      ? Math.max(0, reviewDeadline(v)! - s.now)
                      : undefined,
                  }
                : v,
            ),
          });
          showToast("중단·불발 신고를 접수했어요. 운영 검토를 기다려 주세요.");
          return ok();
        }
        commit({
          appointments: s.appointments.map((v) =>
            v.id === a.id ? { ...v, status: "cancelled" } : v,
          ),
          posts: s.posts.map((p) =>
            p.id === postId ? { ...p, status: "closed" } : p,
          ),
          conversations: s.conversations.map((c) =>
            c.postId === postId && c.status === "confirmed"
              ? { ...c, status: "ended", endedReason: "cancelled" }
              : c,
          ),
          notifications: [
            notify(
              "동행이 취소됐어요",
              "취소 사유 이의 신청은 24시간 이내 접수할 수 있어요.",
              "S21",
            ),
            ...s.notifications,
          ],
        });
        return ok();
      }
      const c = s.conversations.find(
        (c) => c.postId === postId && c.applicantId === s.viewerId,
      );
      if (!c || c.status !== "active") return err("철회할 신청이 없어요.");
      commit({
        conversations: s.conversations.map((v) =>
          v.id === c.id
            ? {
                ...v,
                status: "withdrawn",
                withdrawnAt: s.now,
                requestAt: undefined,
                requestExpiresAt: undefined,
              }
            : v,
        ),
      });
      return ok();
    },
    proposeChange: (id, start, end, placeName) => {
      const s = ref.current;
      const a = s.appointments.find((a) => a.id === id);
      if (
        !a ||
        a.status !== "confirmed" ||
        ![a.hostId, a.applicantId].includes(s.viewerId || "")
      )
        return err("변경할 약속을 확인해 주세요.");
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start <= s.now ||
        end <= start ||
        !placeName.trim()
      )
        return err("미래 일정과 장소를 입력해 주세요.");
      if (a.proposal && s.now < a.proposal.expiresAt)
        return err("현재 제안을 먼저 처리해 주세요.");
      if (s.now >= a.startsAt)
        return err("시작한 약속은 변경 제안을 보낼 수 없어요.");
      const place = s.posts.find((p) => p.placeName === placeName.trim());
      if (!place)
        return err(
          "예시 등록 장소인 국립현대미술관 서울·서울숲·여의도 한강공원 중 선택해 주세요.",
        );
      commit({
        appointments: s.appointments.map((v) =>
          v.id === id
            ? {
                ...v,
                proposal: {
                  startsAt: start,
                  endsAt: end,
                  placeName: place.placeName,
                  address: place.address,
                  publicArea: place.publicArea,
                  meetingPoint: place.meetingPoint,
                  proposedBy: s.viewerId!,
                  requestedAt: s.now,
                  expiresAt: changeExpiresAt(s.now, v.startsAt, start),
                },
              }
            : v,
        ),
      });
      return ok();
    },
    acceptChange: (id) => {
      const s = ref.current;
      const a = s.appointments.find((a) => a.id === id),
        q = a?.proposal;
      if (
        !a ||
        !q ||
        q.proposedBy === s.viewerId ||
        ![a.hostId, a.applicantId].includes(s.viewerId || "")
      )
        return err("수락할 변경 제안이 없어요.");
      if (s.now >= q.expiresAt)
        return err("변경 제안이 만료됐어요. 기존 약속은 유지돼요.");
      if (
        conflicts(s, a.hostId, q.startsAt, q.endsAt, id) ||
        conflicts(s, a.applicantId, q.startsAt, q.endsAt, id)
      )
        return err("기존 확정 약속과 일정이 겹쳐요.");
      commit({
        appointments: s.appointments.map((v) =>
          v.id === id
            ? {
                ...v,
                startsAt: q.startsAt,
                endsAt: q.endsAt,
                proposal: undefined,
              }
            : v,
        ),
        posts: s.posts.map((p) =>
          p.id === a.postId
            ? {
                ...p,
                startsAt: q.startsAt,
                endsAt: q.endsAt,
                placeName: q.placeName,
                address: q.address,
                publicArea: q.publicArea,
                meetingPoint: q.meetingPoint,
              }
            : p,
        ),
      });
      return ok();
    },
    rejectChange: (id) => {
      const s = ref.current;
      const a = s.appointments.find((a) => a.id === id);
      if (!a || ![a.hostId, a.applicantId].includes(s.viewerId || ""))
        return err("권한을 확인해 주세요.");
      commit({
        appointments: s.appointments.map((v) =>
          v.id === id ? { ...v, proposal: undefined } : v,
        ),
      });
      return ok();
    },
    confirmCompletion: (id) => {
      const s = ref.current;
      const a = s.appointments.find((a) => a.id === id);
      if (
        !a ||
        a.status !== "confirmed" ||
        ![a.hostId, a.applicantId].includes(s.viewerId || "")
      )
        return err("완료할 약속을 확인해 주세요.");
      if (s.now < a.endsAt)
        return err("예상 종료 이후에 완료 확인을 할 수 있어요.");
      if (fail()) return err("완료 확인에 실패했어요. 다시 시도해 주세요.");
      const confirmations = [...new Set([...a.confirmations, s.viewerId!])];
      const complete = confirmations.length === 2;
      refresh({
        appointments: s.appointments.map((v) =>
          v.id === id
            ? {
                ...v,
                confirmations,
                status: complete ? "completed" : "confirmed",
                completedAt: complete ? s.now : null,
              }
            : v,
        ),
      });
      return ok();
    },
    submitReview: (id, mood, stars, comment, praises) => {
      const s = ref.current;
      const a = s.appointments.find((a) => a.id === id);
      if (!a || !s.viewerId || !canWriteReview(a, s.viewerId, s.now))
        return err("현재 후기를 작성할 수 없어요.");
      if (
        s.reviews.some(
          (r) => r.appointmentId === id && r.authorId === s.viewerId,
        )
      )
        return err("이미 제출한 후기는 수정하거나 다시 제출할 수 없어요.");
      if (
        !["good", "neutral", "bad"].includes(mood) ||
        stars < 1 ||
        stars > 5 ||
        !Number.isInteger(stars)
      )
        return err("경험과 별점을 선택해 주세요.");
      if (praises.length > 3 || (mood !== "good" && praises.length > 0))
        return err("좋아요일 때만 칭찬을 최대 3개 선택할 수 있어요.");
      if (detectPersonalInfo(comment))
        return err("후기에 연락처나 계좌를 넣을 수 없어요.");
      if (fail())
        return err(
          "후기 제출에 실패했어요. 입력을 유지했으니 다시 시도해 주세요.",
        );
      const review: Review = {
        id: uid(),
        appointmentId: id,
        authorId: s.viewerId,
        targetId: a.hostId === s.viewerId ? a.applicantId : a.hostId,
        mood,
        stars,
        comment,
        praises,
        submittedAt: s.now,
        hidden: false,
        invalid: false,
      };
      refresh({ reviews: [...s.reviews, review] });
      return ok();
    },
    block: (id) => {
      if (!ref.current.viewerId) return err("로그인이 필요해요.");
      commit({ blockedIds: [...new Set([...ref.current.blockedIds, id])] });
      showToast("차단했어요. 확정 약속 취소는 별도 절차예요.");
      return ok();
    },
    unblock: (id) =>
      commit({ blockedIds: ref.current.blockedIds.filter((v) => v !== id) }),
    leaveChat: (id) =>
      commit({
        conversations: ref.current.conversations.map((c) =>
          c.id === id
            ? {
                ...c,
                hiddenBy: [
                  ...new Set([...c.hiddenBy, ref.current.viewerId || ""]),
                ],
              }
            : c,
        ),
      }),
    markNotificationsRead: (id) =>
      commit({
        notifications: ref.current.notifications.map((n) =>
          !id || n.id === id ? { ...n, read: true } : n,
        ),
      }),
    report: (target, description, attachment) => {
      if (!description.trim()) return err("상황 설명을 입력해 주세요.");
      if (!attachment && !/노쇼|대면|불발|위협/.test(target))
        return err("온라인 신고에는 캡처를 함께 제출해 주세요.");
      if (fail()) return err("접수하지 못했어요. 다시 시도해 주세요.");
      showToast("신고를 접수했어요. 접수는 위반 확정을 뜻하지 않아요.");
      return ok();
    },
    addSearch: (text) => {
      const s = ref.current;
      const clean = text.trim();
      if (!clean) return;
      const recentSearches = [
        { text: clean, at: s.now },
        ...s.recentSearches.filter(
          (v) => v.text !== clean && s.now < v.at + 7 * DAY,
        ),
      ].slice(0, 10);
      commit({ recentSearches });
      void storage
        .saveSearches(owner(s), recentSearches, s.now)
        .catch(() => showToast("최근 검색어를 기기에 저장하지 못했어요."));
    },
    clearSearches: async () => {
      await storage.clearSearches(owner(ref.current));
      commit({ recentSearches: [] });
    },
    sendAi: async (text, modelRequest = true) => {
      const s = ref.current;
      if (!s.viewerId) return err("로그인 후 이용할 수 있어요.");
      if (!s.aiDiscoveryAllowed)
        return err("AI 탐색 동의 철회 요청으로 새 처리를 중단했어요.");
      if (aiLock.current) return err("진행 중인 답변을 기다려 주세요.");
      if (!text.trim()) return err("찾고 싶은 동행을 입력해 주세요.");
      if (detectPersonalInfo(text))
        return err("개인정보를 지우고 다시 입력해 주세요.");
      if ([...text].length > 500)
        return err("한 메시지는 500자까지 입력할 수 있어요.");
      if (
        s.aiMessages.length + 2 > 20 ||
        s.aiMessages.reduce((n, m) => n + [...m.text].length, 0) +
          [...text].length +
          120 >
          4000
      )
        return err(
          "대화 한도에 가까워졌어요. 확인한 조건으로 새 탐색을 시작해 주세요.",
        );
      if (modelRequest && s.aiUsed >= 20)
        return err(
          "오늘의 AI 탐색을 모두 이용했어요. 일반 둘러보기는 계속 이용할 수 있어요.",
        );
      const generation = aiGeneration.current;
      aiLock.current = true;
      const user = { id: uid(), role: "user" as const, text };
      commit({
        aiBusy: true,
        aiUsed: s.aiUsed + (modelRequest ? 1 : 0),
        aiMessages: [...s.aiMessages, user],
      });
      await new Promise((resolve) => setTimeout(resolve, 450));
      if (generation !== aiGeneration.current) {
        return err("새 대화를 시작해 이전 요청을 중단했어요.");
      }
      aiLock.current = false;
      const current = ref.current;
      if (fail()) {
        commit({
          aiBusy: false,
          aiMessages: current.aiMessages.filter((m) => m.id !== user.id),
        });
        return err(
          "답변을 확인하지 못했어요. 입력을 유지했으니 다시 시도해 주세요.",
        );
      }
      const conditions = current.aiMessages
        .filter((m) => m.role === "user")
        .map((m) => m.text)
        .join(" ");
      const query = conditions.includes("전시")
        ? "전시"
        : conditions.includes("산책")
          ? "산책"
          : conditions.includes("카페")
            ? "카페"
            : "";
      const regions = conditions.match(/서울|성수|종로|강남|여의도|부산|인천/g);
      const region = regions?.at(-1);
      const weekend = conditions.includes("주말");
      const postIds = current.posts
        .filter(
          (p) =>
            p.status === "recruiting" &&
            p.deadlineAt > current.now &&
            (!query || p.category === query) &&
            (!region || p.publicArea.includes(region)) &&
            (!weekend ||
              [0, 6].includes(new Date(p.startsAt + 9 * HOUR).getUTCDay())) &&
            !current.blockedIds.includes(p.authorId),
        )
        .slice(0, 5)
        .map((p) => p.id);
      const hasRegion = !!region;
      const answer =
        hasRegion || !modelRequest
          ? postIds.length
            ? "확인할 수 있는 동행을 모았어요. 일정과 취향이 맞는지 카드에서 함께 확인해 보세요."
            : "지금 조건에 맞는 예시 동행이 없어요. 조건을 조금 넓혀 보세요."
          : "어느 지역에서 동행을 찾고 있나요? 지역명을 알려주시면 함께 살펴볼게요.";
      commit({
        aiBusy: false,
        aiMessages: [
          ...current.aiMessages,
          {
            id: uid(),
            role: "assistant",
            text: answer,
            postIds: hasRegion || !modelRequest ? postIds : [],
          },
        ],
      });
      return ok();
    },
    clearAi,
    hideAiReply: (id) =>
      commit({
        aiMessages: ref.current.aiMessages.map((m) =>
          m.id === id ? { ...m, hidden: true } : m,
        ),
      }),
    withdrawAi: (kind) => {
      if (kind === "discovery") {
        aiGeneration.current++;
        aiLock.current = false;
        commit({ aiDiscoveryAllowed: false, aiMessages: [], aiBusy: false });
      } else {
        const id = ref.current.viewerId;
        if (!id) return;
        commit({ aiSummaryAllowed: false, aiSummaryWithdrawnIds: [...new Set([...ref.current.aiSummaryWithdrawnIds, id])] });
      }
      showToast("철회 요청을 접수했어요. 계정과 일반 동행은 유지돼요.");
    },
    deleteAccount: async () => {
      const s = ref.current;
      if (!s.viewerId) return err("로그인이 필요해요.");
      if (
        s.appointments.some(
          (a) =>
            a.status === "confirmed" &&
            [a.hostId, a.applicantId].includes(s.viewerId!) &&
            a.completedAt === null,
        )
      )
        return err("진행 중인 확정 약속을 먼저 정리해 주세요.");
      await storage.clearOwnerStorage(s.viewerId);
      const members = { ...s.members };
      delete members[s.viewerId];
      aiGeneration.current++;
      aiLock.current = false;
      commit({
        viewerId: null,
        members,
        aiBusy: false,
        draft: null,
        recentSearches: [],
        aiMessages: [],
        posts: s.posts.map((p) =>
          p.authorId === s.viewerId
            ? { ...p, status: "deleted", meetingPoint: "", address: "" }
            : p,
        ),
        conversations: s.conversations.map((c) =>
          (c.applicantId === s.viewerId ||
            s.posts.some(
              (p) => p.id === c.postId && p.authorId === s.viewerId,
            )) &&
          c.status === "active"
            ? {
                ...c,
                status: c.applicantId === s.viewerId ? "withdrawn" : "ended",
                endedReason: "deleted",
                requestAt: undefined,
                requestExpiresAt: undefined,
              }
            : c,
        ),
      });
      router.replace("/");
      return ok();
    },
    setPreview: (patch) => refresh(patch),
    reset: async () => {
      defaultMemberId.current = "me";
      blockedByOwner.current = {};
      usageByOwner.current = {};
      consentsByOwner.current = {};
      aiGeneration.current++;
      aiLock.current = false;
      await Promise.all(
        ["me", "host", "peer", "anonymous"].map(storage.clearOwnerStorage),
      );
      const fresh = initialState();
      ref.current = fresh;
      setState(fresh);
      router.replace("/");
    },
  };
  if (serviceMode) {
    // Core writes require the real service/auth adapter. Never report a local mutation as server success.
    const unavailable = () => err("서비스 연결을 준비 중이에요. 잠시 후 다시 이용해 주세요.");
    for (const action of ["publish", "sendMessage", "requestMatch", "acceptMatch", "withdrawMatch", "rejectApplicant", "reopenPost", "closePost", "deletePost", "cancel", "proposeChange", "acceptChange", "rejectChange", "confirmCompletion", "submitReview", "block", "report"] as const) {
      value[action] = unavailable;
    }
    for (const action of ["login", "updateMember", "unblock", "leaveChat", "markNotificationsRead", "withdrawAi", "setPreview", "editPost"] as const) {
      value[action] = () => showToast(unavailable().message!);
    }
    value.saveDraft = async () => { throw new Error("SERVICE_DRAFT_CONTEXT_NOT_CONNECTED"); };
    value.deleteAccount = async () => unavailable();
    value.reset = async () => { showToast(unavailable().message!); };
    value.sendAi = async () => unavailable();
    value.logout = async () => { installServiceSession(null); clearAi(); commit({ viewerId: null, members: {}, posts: [], events: [], recentSearches: [], draft: null }); };
  }
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error("AppProvider is required");
  return context;
}
