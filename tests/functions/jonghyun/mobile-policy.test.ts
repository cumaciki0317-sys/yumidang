import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORIES, PRAISES, DAY, HOUR, canAutoComplete, canWriteReview,
  changeExpiresAt, currentWeek, detectPersonalInfo, filterPosts,
  finalRequestExpiresAt, kstDay, maskName, monthWeek, parseDateInput,
  reviewDeadline, reviewVisible, selectEvents, sweetness, validateDraft, summarySources,
} from '../../../apps/mobile/src/domain.ts';
import type { Appointment, Draft, EventItem, Filters, Member, Post, Review } from '../../../apps/mobile/src/types.ts';

const now = Date.parse('2026-10-05T12:00:00+09:00');
const ap: Appointment = { id: 'ap', postId: 'p', hostId: 'host', applicantId: 'guest', startsAt: now - HOUR, endsAt: now, completedAt: null, confirmations: [], status: 'confirmed' };
const review: Review = { id: 'r', appointmentId: 'ap', authorId: 'host', targetId: 'guest', mood: 'good', stars: 5, comment: '편안했어요', praises: [], submittedAt: now, hidden: false, invalid: false };
const post: Post = { id: 'p', authorId: 'host', title: '전시 함께 보기', introduction: '비공개검사문구', category: '전시', placeName: '미술관', publicArea: '서울 성동구 성수동', address: '서울 성동구 길1', meetingPoint: '비밀3층', startsAt: now + DAY, endsAt: now + DAY + HOUR, createdAt: now, deadlineAt: now + DAY, status: 'recruiting', eventId: 'e' };
const member: Member = { id: 'host', name: '김유미', age: 25, photo: '', interests: [], conversationStyles: [], mbti: '', introduction: '', sweetness: 15, completedCount: 0 };
const filters: Filters = { query: '', category: '', region: '', from: '', to: '', ageMin: '', ageMax: '', recruiting: false, sort: 'created_desc' };
const event: EventItem = { id: 'e', title: '연결전시이름', category: '전시', placeName: '미술관', publicArea: '서울', startsAt: now, endsAt: now + DAY, image: '', price: '무료', sourceName: '합성', description: '' };
const draft: Draft = { category: '전시', title: '전시 같이 봐요', introduction: '한 시간 정도 관람해요.', placeName: '미술관', publicArea: '서울 성수동', address: '서울 성수동 길1', meetingPoint: '입구 왼쪽 안내대', startsAt: '2026-10-06T12:00', endsAt: '2026-10-06T13:00', deadlineAt: '', desiredAgeMin: '19', desiredAgeMax: '99', wishes: '', updatedAt: now };

test('current categories, praise options and masked identities', () => {
  assert.equal(CATEGORIES.length, 16);
  assert.equal(PRAISES.length, 6);
  assert.equal(maskName('김유미'), '김*미');
  assert.equal(maskName('유미'), '유*');
  assert.equal(maskName('유'), '*');
});

test('Korean dates roll over at UTC15 and Monday boundaries do not depend on machine timezone', () => {
  assert.equal(kstDay(Date.parse('2026-10-04T14:59:59Z')), '2026-10-04');
  assert.equal(kstDay(Date.parse('2026-10-04T15:00:00Z')), '2026-10-05');
  assert.deepEqual(currentWeek(now), { startsAt: Date.parse('2026-10-05T00:00:00+09:00'), endsAt: Date.parse('2026-10-12T00:00:00+09:00') });
  assert.equal(parseDateInput('2026-10-05T12:00'), now);
  assert.equal(Number.isNaN(parseDateInput('2026-02-30T12:00')), true);
});

test('monthly Thursday attribution covers month and year boundaries', () => {
  assert.deepEqual(monthWeek(Date.parse('2023-09-01T12:00:00+09:00')), { year: 2023, month: 8, week: 5, label: '8월 5주차' });
  assert.equal(monthWeek(Date.parse('2026-09-01T00:00:00+09:00')).label, '9월 1주차');
  assert.deepEqual(monthWeek(Date.parse('2025-12-29T00:00:00+09:00')), { year: 2026, month: 1, week: 1, label: '1월 1주차' });
});

test('final consent and changes expire at the earliest applicable limit', () => {
  assert.equal(finalRequestExpiresAt(now, now + DAY), now + 6 * HOUR);
  assert.equal(finalRequestExpiresAt(now, now + HOUR), now + HOUR);
  assert.equal(changeExpiresAt(now, now + 4 * HOUR, now + 2 * HOUR), now + 2 * HOUR);
  assert.equal(changeExpiresAt(now, now + 7 * HOUR, now + 8 * HOUR), now + 6 * HOUR);
});

test('early reviews require own confirmation; a stranger or pre-end viewer cannot write', () => {
  assert.equal(canWriteReview(ap, 'host', now), false);
  const confirmed = { ...ap, confirmations: ['host'] };
  assert.equal(canWriteReview(confirmed, 'host', now), true);
  assert.equal(canWriteReview(confirmed, 'guest', now), false);
  assert.equal(canWriteReview(confirmed, 'host', now - 1), false);
  assert.equal(canWriteReview(confirmed, 'stranger', now), false);
  assert.equal(reviewVisible(ap, [review], review, now), false);
  assert.equal(reviewDeadline(ap), null);
});

test('review writing uses exclusive deadlines; one-sided publication uses inclusive deadlines', () => {
  const completed = { ...ap, status: 'completed' as const, completedAt: now };
  assert.equal(reviewDeadline(completed), now + 7 * DAY);
  assert.equal(canWriteReview(completed, 'host', now + 7 * DAY - 1), true);
  assert.equal(canWriteReview(completed, 'host', now + 7 * DAY), false);
  assert.equal(reviewVisible(completed, [review], review, now + 7 * DAY - 1), false);
  assert.equal(reviewVisible(completed, [review], review, now + 7 * DAY), true);
  const other = { ...review, id: 'r2', authorId: 'guest', targetId: 'host' };
  assert.equal(reviewVisible(completed, [review, other], review, now), true);
  assert.equal(reviewVisible(ap, [review, other], review, now), false);
});

test('disputes freeze new publications but preserve already public reviews unless hidden or invalidated', () => {
  const disputed = { ...ap, status: 'disputed' as const, completedAt: now, disputeStartedAt: now + HOUR };
  assert.equal(canWriteReview(disputed, 'host', now + HOUR), false);
  assert.equal(reviewVisible(disputed, [review], review, now + 10 * DAY), false);
  const published = { ...review, publishedAt: now };
  assert.equal(reviewVisible(disputed, [published], published, now + HOUR), true);
  assert.equal(reviewVisible(disputed, [], { ...published, publishedAt: now + HOUR }, now + HOUR), false);
  assert.equal(reviewVisible(disputed, [], { ...published, hidden: true }, now + HOUR), false);
  assert.equal(reviewVisible(disputed, [], { ...published, invalid: true }, now + HOUR), false);
  const resumed = { ...ap, status: 'completed' as const, completedAt: now, reviewDeadlineAt: now + 20 * DAY };
  assert.equal(reviewVisible(resumed, [review], review, now + 7 * DAY), false);
  assert.equal(canWriteReview(resumed, 'host', now + 19 * DAY), true);
});

test('automatic completion boundary excludes cancelled, disputed and previously completed appointments', () => {
  assert.equal(canAutoComplete(ap, now + DAY - 1), false);
  assert.equal(canAutoComplete(ap, now + DAY), true);
  assert.equal(canAutoComplete({ ...ap, status: 'cancelled' }, now + DAY), false);
  assert.equal(canAutoComplete({ ...ap, status: 'disputed' }, now + DAY), false);
  assert.equal(canAutoComplete({ ...ap, completedAt: now }, now + DAY), false);
});

test('sweetness sums valid history before clamping, retains hidden contributions and removes invalid ones', () => {
  assert.equal(sweetness([]), 15);
  assert.equal(sweetness([review]), 17);
  assert.equal(sweetness([{ ...review, mood: 'bad', stars: 1 }]), 11);
  assert.equal(sweetness([{ ...review, hidden: true }]), 17);
  assert.equal(sweetness([{ ...review, invalid: true }]), 15);
  assert.equal(sweetness(Array.from({ length: 50 }, () => review), [-30]), 85);
  assert.equal(sweetness([], [-30]), 0);
});

test('post search matches allowed fields and event titles, never introduction or private meeting points', () => {
  const run = (query: string) => filterPosts([post], { ...filters, query }, { host: member }, 'guest', [], [event]);
  assert.equal(run('미술관').length, 1);
  assert.equal(run('길1').length, 1);
  assert.equal(run('연결전시이름').length, 1);
  assert.equal(run('비공개검사문구').length, 0);
  assert.equal(run('비밀3층').length, 0);
});

test('anonymous filters ignore private age/date restrictions and account blocking without excluding older writers by default', () => {
  const restrictive = { ...filters, ageMin: '40', ageMax: '50', from: '2028-01-01' };
  assert.equal(filterPosts([post], restrictive, { host: member }, null, ['host']).length, 1);
  assert.equal(filterPosts([post], restrictive, { host: member }, 'guest').length, 0);
  assert.equal(filterPosts([post], filters, { host: { ...member, age: 105 } }, 'guest').length, 1);
  assert.equal(filterPosts([post], filters, { host: member }, 'guest', ['host']).length, 0);
  assert.equal(filterPosts([post], filters, { host: member }, 'host', ['host']).length, 1);
  assert.equal(filterPosts([{ ...post, status: 'deleted' }], filters, {}, null).length, 0);
});

test('event defaults exclude last-week ongoing and ended entries, and sort ongoing before future', () => {
  const old = { ...event, id: 'old', startsAt: now - 10 * DAY };
  const ended = { ...event, id: 'ended', startsAt: now - HOUR, endsAt: now };
  const upcoming = { ...event, id: 'future', startsAt: now + DAY, endsAt: now + 2 * DAY };
  assert.deepEqual(selectEvents([upcoming, old, event, ended], now).map((item) => item.id), ['e', 'future']);
  assert.deepEqual(selectEvents([upcoming, old, event, ended], now, true).map((item) => item.id), ['e', 'old', 'future']);
  assert.deepEqual(selectEvents([upcoming, old, event, ended], now, false, true).map((item) => item.id), ['ended']);
});

test('privacy preview catches phone/account patterns without treating ordinary dates as private information', () => {
  assert.equal(detectPersonalInfo('2026-10-06 12:00 만나서 10,000원 입장료'), false);
  assert.equal(detectPersonalInfo('은행 앞에서 2026-10-06 만나기'), false);
  assert.equal(detectPersonalInfo('010-1234-5678로 연락해요'), true);
  assert.equal(detectPersonalInfo('계좌 신한 110-123-456789'), true);
});

test('draft validation preserves valid times and finds bad bounds or private disclosure', () => {
  assert.deepEqual(validateDraft(draft, now), {});
  assert.ok(validateDraft({ ...draft, title: '가'.repeat(51) }, now).title);
  assert.ok(validateDraft({ ...draft, endsAt: draft.startsAt }, now).endsAt);
  assert.ok(validateDraft({ ...draft, startsAt: '2026-10-05T11:00' }, now).startsAt);
  assert.ok(validateDraft({ ...draft, deadlineAt: '2026-10-07T12:00' }, now).deadlineAt);
  assert.ok(validateDraft({ ...draft, introduction: '01012345678로 연락주세요' }, now).personalInfo);
  assert.ok(validateDraft({ ...draft, title: draft.meetingPoint }, now).personalInfo);
});


test('search does not match across fields and uses positive overlap and server tie order', () => {
  assert.equal(filterPosts([post], { ...filters, query: '보기 미술관' }, { host: member }, 'guest').length, 0);
  assert.equal(filterPosts([{ ...post, endsAt: now, startsAt: now - HOUR }], { ...filters, from: '2026-10-05T12:00' }, { host: member }, 'guest').length, 0);
  const sameStart = [{ ...post, id: 'b', createdAt: now + HOUR }, { ...post, id: 'a', createdAt: now }];
  assert.deepEqual(filterPosts(sameStart, { ...filters, sort: 'starts_asc' }, { host: member }, 'guest').map((item) => item.id), ['a', 'b']);
});

test('review AI withdrawal excludes written sources and owner summary but keeps public reviews intact', () => {
  const written = { ...review, authorId: 'withdrawn', targetId: 'target' };
  const other = { ...review, id: 'other', authorId: 'allowed', targetId: 'target' };
  assert.deepEqual(summarySources([written, other], 'target', ['withdrawn']), [other]);
  assert.deepEqual(summarySources([written, other], 'target', ['target']), []);
  assert.equal([written, other].length, 2);
  assert.equal(written.hidden, false);
});
