import type { Appointment, Draft, EventItem, Filters, Member, Post, Review } from './types';

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
const KST = 9 * HOUR;
export const CATEGORIES = ['지금이당', '전시', '축제', '팝업', '공연', '영화', '맛집', '카페', '쇼핑', '여행', '운동', '산책', '게임', '반려동물', '스터디', '기타'] as const;
export const PRAISES = ['시간을 잘 지켜요', '약속한 내용을 지켜요', '소통이 원활해요', '배려심이 있어요', '대화가 즐거워요', '함께하니 편안해요'] as const;

export function maskName(name: string): string {
  const letters = [...name.trim()];
  if (letters.length <= 1) return '*';
  if (letters.length === 2) return letters[0] + '*';
  return letters[0] + '*'.repeat(letters.length - 2) + letters[letters.length - 1];
}

export function kstDay(now: number): string {
  return new Date(now + KST).toISOString().slice(0, 10);
}

export function currentWeek(now: number): { startsAt: number; endsAt: number } {
  const local = new Date(now + KST);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - KST;
  const startsAt = midnight - ((local.getUTCDay() + 6) % 7) * DAY;
  return { startsAt, endsAt: startsAt + 7 * DAY };
}

/** Monthly labels are a service rule: assign the entire Monday week to its Thursday's month. */
export function monthWeek(now: number): { year: number; month: number; week: number; label: string } {
  const thursday = new Date(currentWeek(now).startsAt + 3 * DAY + KST);
  const year = thursday.getUTCFullYear();
  const month = thursday.getUTCMonth() + 1;
  const week = Math.floor((thursday.getUTCDate() - 1) / 7) + 1;
  return { year, month, week, label: `${month}월 ${week}주차` };
}

export function finalRequestExpiresAt(requestAt: number, startsAt: number): number {
  return Math.min(requestAt + 6 * HOUR, startsAt);
}

export function changeExpiresAt(requestAt: number, oldStart: number, newStart: number): number {
  return Math.min(requestAt + 6 * HOUR, oldStart, newStart);
}

export function reviewDeadline(appointment: Appointment): number | null {
  if (appointment.completedAt === null) return null;
  return appointment.reviewDeadlineAt ?? appointment.completedAt + 7 * DAY;
}

export function canWriteReview(appointment: Appointment, viewerId: string, now: number): boolean {
  if (![appointment.hostId, appointment.applicantId].includes(viewerId)) return false;
  if (appointment.status === 'cancelled' || appointment.status === 'disputed' || now < appointment.endsAt) return false;
  if (appointment.completedAt === null) return appointment.confirmations.includes(viewerId);
  const deadline = reviewDeadline(appointment);
  return appointment.completedAt <= now && deadline !== null && now < deadline;
}

export function reviewVisible(appointment: Appointment, reviews: Review[], review: Review, now: number): boolean {
  if (review.appointmentId !== appointment.id || review.hidden || review.invalid) return false;
  const participants = [appointment.hostId, appointment.applicantId];
  if (!participants.includes(review.authorId) || !participants.includes(review.targetId) || review.authorId === review.targetId) return false;
  const publishedAt = (review as Review & { publishedAt?: number }).publishedAt;
  // Starting a dispute cannot automatically withdraw a previously public review.
  if (publishedAt !== undefined && publishedAt <= now && (appointment.status !== 'disputed' || appointment.disputeStartedAt === undefined || publishedAt < appointment.disputeStartedAt)) return true;
  if (appointment.status === 'disputed' || appointment.status === 'cancelled' || appointment.completedAt === null || appointment.completedAt > now) return false;
  const submissions = reviews.filter((item) => item.appointmentId === appointment.id && !item.invalid && item.submittedAt <= now && participants.includes(item.targetId) && item.authorId !== item.targetId);
  const bothSubmitted = participants.every((id) => submissions.some((item) => item.authorId === id));
  const deadline = reviewDeadline(appointment);
  return review.submittedAt <= now && (bothSubmitted || (deadline !== null && now >= deadline));
}

export function canAutoComplete(appointment: Appointment, now: number): boolean {
  return appointment.status === 'confirmed' && appointment.completedAt === null && now >= appointment.endsAt + DAY;
}

/** Pass only reviews whose score has become effective. Hidden reviews retain their contribution. */
export function sweetness(reviews: Review[], operational: number[] = []): number {
  const total = reviews.reduce((score, review) => {
    if (review.invalid || !Number.isInteger(review.stars) || review.stars < 1 || review.stars > 5) return score;
    const mood = review.mood === 'good' ? 1 : review.mood === 'bad' ? -2 : 0;
    const stars = review.stars <= 2 ? -2 : review.stars >= 4 ? 1 : 0;
    return score + mood + stars;
  }, 15) + operational.reduce((score, delta) => score + (Number.isFinite(delta) ? delta : 0), 0);
  return Math.max(0, Math.min(100, Math.round(total)));
}

/** Bare date/time inputs are interpreted in Korea, independent of the host device timezone. */
export function parseDateInput(value: string): number {
  if (!value.trim()) return NaN;
  const normalized = value.trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(normalized)) {
    const timestamp = Date.parse(normalized.length === 10 ? `${normalized}T00:00:00+09:00` : `${normalized}+09:00`);
    return Number.isFinite(timestamp) && kstDay(timestamp) === normalized.slice(0, 10) ? timestamp : NaN;
  }
  return Date.parse(normalized);
}

export function filterPosts(posts: Post[], filters: Filters, members: Record<string, Member>, viewerId: string | null, blockedIds: string[] = [], events: EventItem[] = []): Post[] {
  const query = filters.query.trim().toLocaleLowerCase();
  const from = parseDateInput(filters.from);
  const to = parseDateInput(filters.to);
  const end = Number.isFinite(to) && /^\d{4}-\d{2}-\d{2}$/.test(filters.to.trim()) ? to + DAY : to;
  const eventTitles = new Map(events.map((event) => [event.id, event.title]));
  return posts.filter((post) => {
    if (post.status === 'deleted') return false;
    if (viewerId && post.authorId !== viewerId && blockedIds.includes(post.authorId)) return false;
    if (filters.recruiting && post.status !== 'recruiting') return false;
    if (filters.category && filters.category !== '전체' && post.category !== filters.category) return false;
    if (filters.region && filters.region !== '전체' && !post.publicArea.includes(filters.region)) return false;
    const searchable = [post.title, post.placeName, post.address, post.eventId ? eventTitles.get(post.eventId) ?? '' : ''].join(' ').toLocaleLowerCase();
    if (query && !searchable.includes(query)) return false;
    if (viewerId) {
      if (Number.isFinite(from) && post.endsAt < from) return false;
      if (Number.isFinite(end) && post.startsAt >= end) return false;
      if (filters.ageMin || filters.ageMax) {
        const age = members[post.authorId]?.age;
        if (age === undefined || age < Number(filters.ageMin || 19) || age > Number(filters.ageMax || 99)) return false;
      }
    }
    return true;
  }).sort((a, b) => filters.sort === 'starts_asc' ? a.startsAt - b.startsAt || b.createdAt - a.createdAt : b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

export function selectEvents(events: EventItem[], now: number, includeOngoing = false, past = false): EventItem[] {
  const week = currentWeek(now);
  const statusOrder = (event: EventItem) => event.endsAt <= now ? 2 : event.startsAt <= now ? 0 : 1;
  return events.filter((event) => {
    if (past) return event.endsAt <= now;
    if (event.endsAt <= now) return false;
    return (event.startsAt >= week.startsAt && event.startsAt < week.endsAt) || (includeOngoing && event.startsAt < now);
  }).sort((a, b) => {
    const aStatus = statusOrder(a), bStatus = statusOrder(b);
    if (aStatus !== bStatus) return aStatus - bStatus;
    return aStatus === 0 ? b.startsAt - a.startsAt : aStatus === 1 ? a.startsAt - b.startsAt : b.endsAt - a.endsAt;
  });
}

/** Conservative local preview checks, not a server content-safety or privacy guarantee. */
export function detectPersonalInfo(text: string): boolean {
  const phone = /(^|[^\d])(?:01[016789][\s.-]?\d{3,4}[\s.-]?\d{4}|02[\s.-]?\d{3,4}[\s.-]?\d{4}|0[3-6]\d[\s.-]?\d{3,4}[\s.-]?\d{4})(?!\d)/;
  const account = /(?:계좌|입금|은행|농협|국민|신한|우리|하나|카카오뱅크|토스뱅크)[^\d\n]{0,15}((?:\d[ -]?){8,16})(?!\d)/g;
  return phone.test(text) || [...text.matchAll(account)].some((match) => !/^\d{4}-\d{2}-\d{2}$/.test(match[1].trim()));
}

export function validateDraft(draft: Draft, now = Date.now()): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!(CATEGORIES as readonly string[]).includes(draft.category)) errors.category = '카테고리를 선택해 주세요.';
  if (!draft.title.trim() || [...draft.title].length > 50) errors.title = '제목은 1~50자로 입력해 주세요.';
  if (!draft.introduction.trim() || [...draft.introduction].length > 2000) errors.introduction = '소개는 1~2,000자로 입력해 주세요.';
  if (!draft.placeName.trim() || !draft.address.trim() || !draft.publicArea.trim()) errors.placeName = '장소와 공개 지역을 선택해 주세요.';
  if ([...draft.meetingPoint].length > 300) errors.meetingPoint = '상세 만남 지점은 300자까지 입력할 수 있어요.';
  const start = parseDateInput(draft.startsAt), end = parseDateInput(draft.endsAt), deadline = parseDateInput(draft.deadlineAt);
  if (!Number.isFinite(start) || start <= now) errors.startsAt = '미래 시작 일시를 입력해 주세요.';
  if (!Number.isFinite(end) || end <= start) errors.endsAt = '종료는 시작 이후여야 해요.';
  if (draft.deadlineAt.trim() && (!Number.isFinite(deadline) || deadline <= now || deadline > start)) errors.deadlineAt = '모집 마감은 현재 이후, 시작 일시 이내로 입력해 주세요.';
  if (detectPersonalInfo(draft.title + '\n' + draft.introduction + '\n' + draft.wishes)) errors.personalInfo = '공개 글의 연락처나 계좌 정보를 지우고, 잘못 감지되었다면 문의해 주세요.';
  if (draft.meetingPoint.trim() && (draft.title.includes(draft.meetingPoint.trim()) || draft.introduction.includes(draft.meetingPoint.trim()))) errors.personalInfo = '상세 만남 지점은 공개 글 대신 전용 칸에 입력해 주세요.';
  const ageMin = Number(draft.desiredAgeMin || 19), ageMax = Number(draft.desiredAgeMax || 99);
  if (!Number.isInteger(ageMin) || !Number.isInteger(ageMax) || ageMin < 19 || ageMax > 99 || ageMin > ageMax) errors.desiredAgeMin = '희망 나이는 만 19~99세 안에서 선택해 주세요.';
  return errors;
}
