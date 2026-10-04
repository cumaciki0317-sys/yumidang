import assert from 'node:assert/strict';
import test from 'node:test';
import { POST_CATEGORIES, POST_REGIONS, normalizePublicPostListInput, encodePublicPostCursor, decodePublicPostCursor } from '../../../backend/supabase/functions/_shared/contracts/search.ts';
import { createInMemoryPublicPostSearchRepository, createRpcPublicPostSearchRepository, matchesPostKeyword } from '../../../backend/supabase/functions/_shared/db/repositories/search.ts';
import { searchPublicPosts, projectPublicPostCard } from '../../../backend/supabase/functions/_shared/services/search-service.ts';

const member = { caller: 'member' };
const card = { id: '00000000-0000-4000-8000-000000000001', title: '공개 전시', authorDisplayName: '김*현', publicArea: '서울특별시 종로구 종로1가', startsAt: '2026-10-05T03:00:00Z', endsAt: '2026-10-05T04:00:00Z', cost: { kind: 'free' }, state: 'recruiting', canApply: true };
const position = { sortAt: card.startsAt, id: card.id };

test('숫자 나이 양끝 19·99를 포함하며 전체는 99세보다 많은 작성자도 제외하지 않는다', async () => {
  for (const age of [{ min: 19, max: 19 }, { min: 99, max: 99 }, { min: 19, max: 99 }]) assert.deepEqual(normalizePublicPostListInput({ ...member, authorAge: age }).authorAge, age);
  for (const authorAge of ['20s', '30s', '40plus', null, 19, { min: 18, max: 99 }, { min: 19, max: 100 }, { min: 30, max: 29 }, { min: 19.5, max: 99 }, { min: 19, max: 99, extra: true }, { min: 19 }]) assert.throws(() => normalizePublicPostListInput({ ...member, authorAge }), /INVALID_FILTER/);
  const candidates = [19, 99, 100].map((age) => ({ category: '전시', region: '서울특별시', authorAge: age, index: { title: card.title }, publicRow: { ...card, id: String(age), maskedName: '김*현', publicAreaDistrict: card.publicArea, createdAt: card.startsAt, eligibleToApply: true } }));
  const repository = createInMemoryPublicPostSearchRepository(candidates);
  assert.deepEqual((await searchPublicPosts(repository, member)).posts.map((item) => item.id), ['100', '19', '99']);
  assert.deepEqual((await searchPublicPosts(repository, { ...member, authorAge: { min: 19, max: 99 }, region: '서울특별시' })).posts.map((item) => item.id), ['19', '99']);
  assert.deepEqual((await searchPublicPosts(repository, { ...member, region: '부산광역시' })).posts, []);
});

test('16분류·17시도·기본10을 정규화하며 구분류와 임의 지역을 허용하지 않는다', () => {
  assert.equal(POST_CATEGORIES.length, 16);
  assert.equal(POST_REGIONS.length, 17);
  assert.equal(normalizePublicPostListInput(member).limit, 10);
  for (const category of POST_CATEGORIES) assert.equal(normalizePublicPostListInput({ ...member, category }).category, category);
  for (const region of POST_REGIONS) assert.equal(normalizePublicPostListInput({ caller: 'anonymous', region }).region, region);
  for (const category of ['지금', '식사', '클래스']) assert.throws(() => normalizePublicPostListInput({ ...member, category }), /INVALID_FILTER/);
  for (const region of ['서울', '전체', '서울특별시 종로구', null]) assert.throws(() => normalizePublicPostListInput({ ...member, region }), /INVALID_FILTER/);
});

test('연결 행사명 한 필드의 부분 일치를 찾고 주소·행사·소개를 이어 붙이지 않는다', () => {
  const fields = { title: '공개 전시', registeredPlaceName: '아트홀', registeredAddress: '서울특별시 종로구', linkedEventName: '가을  문화 축제', description: '사적인 소개' };
  assert.equal(matchesPostKeyword(fields, '가을 문화'), true);
  assert.equal(matchesPostKeyword(fields, '종로구 가을'), false);
  assert.equal(matchesPostKeyword(fields, '사적인'), false);
});

test('지역·숫자나이·호출자 변경은 기존 커서를 사용할 수 없고 권한 근거로도 쓰지 않는다', () => {
  const input = { ...member, region: '서울특별시', authorAge: { min: 19, max: 99 } };
  const cursor = encodePublicPostCursor(input, position);
  for (const changes of [{ region: '경기도' }, { authorAge: { min: 20, max: 99 } }]) assert.throws(() => decodePublicPostCursor(cursor, { ...input, ...changes }), /INVALID_CURSOR/);
  const publicCursor = encodePublicPostCursor({ caller: 'anonymous' }, position);
  assert.throws(() => decodePublicPostCursor(publicCursor, member), /INVALID_CURSOR/);
});

test('익명 카드 응답은 null만 수락하며 직접 투영도 이름·추가 개인정보를 반환하지 않는다', async () => {
  for (const authorDisplayName of ['김종현', '김*현', '회원 1234', undefined]) {
    const repository = createRpcPublicPostSearchRepository({ rpc: async () => ({ items: [{ ...card, authorDisplayName }], nextCursor: null }) });
    await assert.rejects(repository.searchPage({ caller: 'anonymous' }), /INVALID_SEARCH_RESPONSE/);
  }
  const projected = projectPublicPostCard({ ...card, realName: '김종현', profilePhoto: 'private.png' }, 'anonymous');
  assert.equal(projected.authorDisplayName, null);
  assert.equal(projected.canApply, false);
  assert.doesNotMatch(JSON.stringify(projected), /김종현|김\*현|private\.png/);
});

test('새 계약 버전·별도 지역·숫자나이를 전달하며 구 SQL 준비 전 한 번의 RPC 실패로 끝낸다', async () => {
  const calls = [];
  const unavailable = new Error('EXTERNAL_UNAVAILABLE');
  const repository = createRpcPublicPostSearchRepository({ rpc: async (name, args) => { calls.push({ name, args }); throw unavailable; } });
  await assert.rejects(repository.searchPage({ ...member, region: '서울특별시', authorAge: { min: 19, max: 99 } }), (error) => error === unavailable);
  assert.deepEqual(calls, [{ name: 'search_public_posts_v2', args: { p_contract_version: '2026-10-05', p_region: '서울특별시', p_filters: { query: '', category: null, cost: 'all', availability: 'all', sort: 'created_desc', periodStart: null, periodEnd: null, authorAge: { min: 19, max: 99 } }, p_cursor: null, p_limit: 10 } }]);
});
