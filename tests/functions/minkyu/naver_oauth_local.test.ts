/** 민규 담당. 로컬 검증 서버만 가상 네트워크로 검사하며 실제 네이버 연결 증거와 구분한다. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { inspect } from 'node:util';
import {
  LOCAL_ORIGIN, LOCAL_API, LOCAL_PAGE, LOCAL_SCRIPT,
  createNaverOAuthLocalHandler, createGuardedLocalFetch,
  readSecureLocalConfig, validateLocalTarget, MAX_PHOTO_BYTES, MAX_ORIGINAL_PHOTO_BYTES, isLocalJpeg,
} from '../../../tools/local/run_naver_oauth_local.ts';
import { sha256 } from '../../../backend/supabase/functions/_shared/services/signup-service.ts';

const config = {
  API_URL: 'http://127.0.0.1:56221', ANON_KEY: 'synthetic-anon-'.repeat(3), SERVICE_ROLE_KEY: 'synthetic-service-'.repeat(3),
  NAVER_CLIENT_ID: 'synthetic-client', NAVER_CLIENT_SECRET: 'synthetic-client-secret',
  NAVER_REDIRECT_URI: 'http://127.0.0.1:5173/naver/callback',
};
const uid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const email = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc@naver.yumidang.invalid';
const verifier = 'v'.repeat(43);
const imageId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const avatarPath = `${uid}/${imageId}.jpg`;
const statusText = {
  photo_required: '로그인 확인 완료. 아래에서 JPG·JPEG·PNG 사진을 선택하고 선택 사진 업로드를 누르세요.',
  information_required: '네이버 정보 제공이 부족합니다. 이름·성별·생년월일 제공에 동의한 뒤 다시 로그인해 주세요.',
  ineligible: '네이버 로그인 연결은 확인됐지만 여성·만 19세 이상 가입 자격을 충족하지 못했습니다.',
};
// Pillow가 만든 합성 1x1 흰색 JPEG다. 파일 bytes와 가상 응답만 검사하며 실제 Storage 증거가 아니다.
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD6pooooA//2Q==', 'base64');
const encode = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64url');
const token = `${encode({ alg: 'HS256' })}.${encode({ sub: uid, role: 'authenticated', session_id: sid })}.c2lnbmF0dXJl`;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

function fixture(status = 'photo_required', options: { authUser?: unknown; authStatus?: number; storageFailure?: boolean; completionFailure?: boolean } = {}) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const challenges = new Map<string, Record<string, string>>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, init });
    const body = init?.body && url.pathname !== '/oauth2.0/token' && !url.pathname.startsWith('/storage/') ? JSON.parse(String(init.body)) : null;
    if (url.pathname.endsWith('/begin_naver_login')) {
      challenges.set(body.p_state_hash, body);
      return json({ expiresAt: '2099-01-01T00:00:00Z' });
    }
    if (url.pathname.endsWith('/consume_naver_login')) {
      const challenge = challenges.get(body.p_state_hash);
      if (!challenge || challenge.p_verifier_hash !== body.p_verifier_hash || challenge.p_origin !== body.p_origin) return json({ code: '22023' }, 400);
      challenges.delete(body.p_state_hash);
      return json({ returnTo: challenge.p_return_to });
    }
    if (url.pathname === '/oauth2.0/token') return json({ access_token: 'synthetic-naver-token', token_type: 'bearer', expires_in: '3600' });
    if (url.pathname === '/v1/nid/me') return json({ resultcode: '00', response: {
      id: 'synthetic-subject', ...(status === 'information_required' ? {} : { name: '합성 네이버회원' }),
      gender: status === 'ineligible' ? 'M' : 'F', birthday: '10-02', birthyear: '2000',
    } });
    const account = { status, authEmail: ['ineligible', 'information_required'].includes(status) ? null : email, userId: null };
    if (url.pathname.endsWith('/resolve_naver_account')) return json(account);
    if (url.pathname === '/auth/v1/admin/generate_link') return json({ id: uid, email, hashed_token: 'e'.repeat(64), verification_type: 'signup' });
    if (url.pathname === '/auth/v1/verify') return json({ access_token: token, refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer', user: { id: uid, email, role: 'authenticated', is_anonymous: false } });
    if (url.pathname.endsWith('/record_naver_session')) return json({ ...account, userId: uid });
    if (url.pathname === '/auth/v1/user') return json(options.authUser ?? { id: uid, role: 'authenticated', is_anonymous: false }, options.authStatus ?? 200);
    if (url.pathname === '/storage/v1/object/profile-images/' + avatarPath) {
      if (options.storageFailure) return json({ message: 'synthetic-private-storage-error ' + token }, 400);
      return json({ Id: imageId, Key: 'profile-images/' + avatarPath });
    }
    if (url.pathname.endsWith('/complete_naver_signup')) {
      if (options.completionFailure) return json({ code: '22023', message: 'synthetic-private-completion-error ' + token }, 400);
      return json({ status: 'ready', avatarPath: body.p_avatar_path, interests: body.p_interests, conversationStyles: body.p_conversation_styles, mbti: body.p_mbti });
    }
    if (url.pathname.endsWith('/get_naver_signup_state')) return json({ status, avatarPath: null, interests: [], conversationStyles: [], mbti: null });
    assert.fail('합성 응답이 없는 네트워크 경로');
  };
  const handler = createNaverOAuthLocalHandler(config, fetchImpl);
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}, method = body === undefined ? 'GET' : 'POST') => handler(new Request(LOCAL_ORIGIN + path, {
    method, headers: { host: '127.0.0.1:5173', origin: LOCAL_ORIGIN, 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { handler, request, calls };
}

test('고정 로컬 주소와 import 가능한 factory는 외부 환경 없이 제공된다', () => {
  assert.equal(LOCAL_ORIGIN, config.NAVER_REDIRECT_URI.replace('/naver/callback', ''));
  assert.equal(LOCAL_API, config.API_URL);
  assert.equal(typeof createNaverOAuthLocalHandler(config, async () => assert.fail('factory 생성은 네트워크를 호출하지 않는다')), 'function');
});

test('0600 정규 파일만 읽고 잘못된 권한·symlink·크기·구성은 거절한다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yumidang-naver-test-'));
  const file = join(directory, 'config.json');
  const write = async (value: unknown) => { await writeFile(file, JSON.stringify(value), { mode: 0o600 }); await chmod(file, 0o600); };
  try {
    await write(config);
    const secure = await readSecureLocalConfig(file);
    for (const key of Object.keys(config) as (keyof typeof config)[]) assert.equal(secure[key], config[key]);
    assert.doesNotMatch(JSON.stringify(secure), /synthetic-client-secret|synthetic-service|synthetic-anon/);
    assert.doesNotMatch(inspect(secure), /synthetic-client-secret|synthetic-service|synthetic-anon/);
    assert.doesNotThrow(() => createNaverOAuthLocalHandler(secure, async () => assert.fail('설정 전달은 네트워크를 호출하지 않는다')));
    await chmod(file, 0o644);
    await assert.rejects(async () => readSecureLocalConfig(file));
    await chmod(file, 0o600);
    const symlinkPath = join(directory, 'link.json'); await symlink(file, symlinkPath);
    await assert.rejects(async () => readSecureLocalConfig(symlinkPath));
    const hardlink = join(directory, 'hardlink.json'); await link(file, hardlink);
    await assert.rejects(async () => readSecureLocalConfig(file));
    await rm(hardlink);
    await chmod(directory, 0o755);
    await assert.rejects(async () => readSecureLocalConfig(file));
    await chmod(directory, 0o700);
    await assert.rejects(async () => readSecureLocalConfig('relative-config.json'));
    for (const bad of [{ ...config, API_URL: 'https://remote.example.test' }, { ...config, NAVER_REDIRECT_URI: 'http://localhost:5173/naver/callback' }, { ...config, extra: 'synthetic' }, { ...config, toJSON: 'synthetic' }, { ...config, NAVER_CLIENT_SECRET: '' }]) {
      await write(bad); await assert.rejects(async () => readSecureLocalConfig(file));
    }
    await writeFile(file, ' '.repeat(65537)); await chmod(file, 0o600);
    await assert.rejects(async () => readSecureLocalConfig(file));
  } finally { await chmod(directory, 0o700); await rm(directory, { recursive: true, force: true }); }
});

test('정확한 전용 Docker endpoint·project·빈 회원 자료만 허용한다', () => {
  const endpoint = 'unix://' + process.env.HOME + '/.colima/yumidang-minkyu/docker.sock';
  const container = { Name: '/supabase_db_yumidang-minkyu-naver-live', State: { Running: true }, Config: { Labels: { 'com.supabase.cli.project': 'yumidang-minkyu-naver-live' } } };
  assert.doesNotThrow(() => validateLocalTarget(endpoint, container, '0'));
  for (const [host, record, count] of [
    ['unix:///tmp/docker.sock', container, '0'], [endpoint, container, '1'],
    [endpoint, { ...container, State: { Running: false } }, '0'],
    [endpoint, { ...container, Config: { Labels: { 'com.supabase.cli.project': 'yumidang-minkyu-ordered' } } }, '0'],
  ] as const) assert.throws(() => validateLocalTarget(host, record, count));
});

test('회원이 있는 재개는 명시적 resume와 같은 전용 target일 때만 허용한다', () => {
  const endpoint = 'unix://' + process.env.HOME + '/.colima/yumidang-minkyu/docker.sock';
  const container = { Name: '/supabase_db_yumidang-minkyu-naver-live', State: { Running: true }, Config: { Labels: { 'com.supabase.cli.project': 'yumidang-minkyu-naver-live' } } };
  assert.throws(() => validateLocalTarget(endpoint, container, '1'));
  assert.doesNotThrow(() => validateLocalTarget(endpoint, container, '1', true));
  for (const count of ['-1', '1.5', 'unknown', '', ' 1', '1\n']) assert.throws(() => validateLocalTarget(endpoint, container, count, true));
  assert.throws(() => validateLocalTarget('unix:///tmp/docker.sock', container, '1', true));
  assert.throws(() => validateLocalTarget(endpoint, { ...container, Name: '/supabase_db_yumidang-minkyu-ordered' }, '1', true));
});

test('네트워크 guard는 고정 공급사·로컬 API만 허용하며 redirect:error를 강제한다', async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => { seen.push({ url: String(input), init }); return json({}); };
  const guarded = createGuardedLocalFetch(fetchImpl);
  for (const [url, method] of [['https://nid.naver.com/oauth2.0/token', 'POST'], ['https://openapi.naver.com/v1/nid/me', 'GET'], [LOCAL_API + '/auth/v1/user', 'GET'], [LOCAL_API + '/rest/v1/rpc/begin_naver_login', 'POST']]) {
    await guarded(url, { method, redirect: 'follow' }); assert.equal(seen.at(-1)?.init?.redirect, 'error');
  }
  const count = seen.length;
  for (const url of ['https://evil.example.test/v1/nid/me', 'https://nid.naver.com.evil.test/oauth2.0/token', 'https://user:pass@nid.naver.com/oauth2.0/token', 'http://localhost:56221/auth/v1/user', LOCAL_API + '/auth/v1/user?secret=1', LOCAL_API + '/rest/v1/rpc/unrelated', 'https://openapi.naver.com/v1/nid/me#secret', 'https://nid.naver.com/other']) {
    await assert.rejects(async () => guarded(url));
  }
  assert.equal(seen.length, count);
});

test('네트워크 guard는 허용 경로의 잘못된 method와 redirect 응답도 거절한다', async () => {
  let calls = 0;
  const guarded = createGuardedLocalFetch(async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://evil.example.test/' } }); });
  for (const [url, method] of [['https://nid.naver.com/oauth2.0/token', 'GET'], ['https://openapi.naver.com/v1/nid/me', 'POST'], [LOCAL_API + '/auth/v1/user', 'POST'], [LOCAL_API + '/rest/v1/rpc/begin_naver_login', 'GET']]) {
    await assert.rejects(async () => guarded(url, { method }));
  }
  assert.equal(calls, 0);
  await assert.rejects(async () => guarded('https://openapi.naver.com/v1/nid/me'));
  assert.equal(calls, 1);
});

test('Host·Origin·메서드·본문·경로 경계 위반은 네트워크 전에 거절한다', async () => {
  const f = fixture();
  for (const [path, body, headers, method] of [
    ['/api/signup/naver/start', {}, { host: 'evil.example.test' }, 'POST'],
    ['/api/signup/naver/start', {}, { origin: 'https://evil.example.test' }, 'POST'],
    ['/api/signup/naver/start', undefined, {}, 'GET'],
    ['/api/signup/state', undefined, {}, 'GET'],
    ['/api/signup/naver/start', { x: 'x'.repeat(8193) }, {}, 'POST'],
    ['/api/signup/complete', {}, {}, 'POST'],
    ['/api/signup/naver/start?secret=1', {}, {}, 'POST'],
  ] as const) {
    const response = await f.request(path, body, headers, method);
    assert.ok(response.status >= 400 && response.status < 500);
    assert.doesNotMatch(await response.text(), /synthetic-service|synthetic-client-secret/);
  }
  for (const request of [
    new Request(LOCAL_ORIGIN + '/api/signup/naver/start', { method: 'POST', headers: { host: '127.0.0.1:5173', 'content-type': 'application/json' }, body: '{}' }),
    new Request('http://evil.example.test/api/signup/naver/start', { method: 'POST', headers: { host: '127.0.0.1:5173', origin: LOCAL_ORIGIN, 'content-type': 'application/json' }, body: '{}' }),
    new Request(LOCAL_ORIGIN + '/api/signup/naver/start', { method: 'POST', headers: { host: '127.0.0.1:5173', origin: LOCAL_ORIGIN, 'content-type': 'text/plain' }, body: '{}' }),
    new Request(LOCAL_ORIGIN + '/api/signup/naver/start', { method: 'POST', headers: { host: '127.0.0.1:5173', origin: LOCAL_ORIGIN, 'content-type': 'application/json' }, body: '{' }),
  ]) {
    const response = await f.handler(request);
    assert.ok(response.status >= 400 && response.status < 500);
  }
  assert.equal(f.calls.length, 0);
});

test('상위 응답 오류와 비밀 원문은 공개 오류나 정적 진단에 포함하지 않는다', async () => {
  const handler = createNaverOAuthLocalHandler(config, async () => json({ message: 'synthetic-client-secret synthetic-service synthetic-subject' }, 500));
  const response = await handler(new Request(LOCAL_ORIGIN + '/api/signup/naver/start', {
    method: 'POST', headers: { host: '127.0.0.1:5173', origin: LOCAL_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ codeChallenge: await sha256(verifier), returnTo: '/' }),
  }));
  assert.ok(response.status >= 400);
  assert.doesNotMatch(await response.text(), /synthetic-client-secret|synthetic-service|synthetic-subject/);
});

test('로컬 상태 확인은 Origin이 있는 POST를 실제 signup GET 인증 경계로 연결한다', async () => {
  const f = fixture();
  assert.equal((await f.request('/api/signup/state', undefined, { authorization: `Bearer ${token}` }, 'POST')).status, 200);
  assert.deepEqual(f.calls.map(({ url }) => url.pathname), ['/auth/v1/user', '/rest/v1/rpc/get_naver_signup_state']);
  assert.equal(f.calls[1].init?.method, 'POST');
  assert.equal(new Headers(f.calls[1].init?.headers).get('authorization'), `Bearer ${token}`);
});

test('정적 진단은 안전한 누적 개수와 공개 상태만 제공하며 Auth 확인을 구분한다', async () => {
  const f = fixture();
  const start = await f.request('/api/signup/naver/start', { codeChallenge: await sha256(verifier), returnTo: '/' });
  const state = new URL((await start.json()).data.authorizationUrl).searchParams.get('state');
  await f.request('/api/signup/naver/callback', { code: 'synthetic-code', state, codeVerifier: verifier });
  let diagnostics = await (await f.request('/diagnostics')).json();
  assert.equal(diagnostics.starts, 1); assert.equal(diagnostics.callbacks, 1);
  assert.equal(diagnostics.sessionIssued, true); assert.equal(diagnostics.authStateVerified, false);
  await f.request('/api/signup/state', undefined, { authorization: `Bearer ${token}` }, 'POST');
  const response = await f.request('/diagnostics'); diagnostics = await response.json();
  assert.deepEqual(Object.keys(diagnostics).sort(), ['scope', 'starts', 'callbacks', 'stateChecks', 'uploads', 'completions', 'rejected', 'lastStatus', 'sessionIssued', 'authStateVerified', 'photoUploaded', 'signupCompleted'].sort());
  assert.equal(diagnostics.authStateVerified, true); assert.equal(diagnostics.lastStatus, 'photo_required');
  assert.doesNotMatch(JSON.stringify(diagnostics), /synthetic-client-secret|synthetic-subject|synthetic-refresh|accessToken|authEmail/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  const noOrigin = await f.handler(new Request(LOCAL_ORIGIN + '/diagnostics', { headers: { host: '127.0.0.1:5173' } }));
  assert.equal(noOrigin.status, 403);
});

test('실제 signup factory를 거친 photo_required·정보 누락·자격 불충족을 성공 가입과 구분한다', async () => {
  for (const status of ['photo_required', 'information_required', 'ineligible']) {
    const f = fixture(status);
    const start = await f.request('/api/signup/naver/start', { codeChallenge: await sha256(verifier), returnTo: '/' });
    assert.equal(start.status, 200);
    const state = new URL((await start.json()).data.authorizationUrl).searchParams.get('state');
    assert.ok(state);
    const callback = await f.request('/api/signup/naver/callback', { code: 'synthetic-code', state, codeVerifier: verifier });
    assert.equal(callback.status, 200);
    assert.equal(callback.headers.get('cache-control'), 'no-store');
    const wire = await callback.json(); assert.equal(wire.data.status, status);
    assert.equal(Boolean(wire.data.session), status === 'photo_required');
    assert.doesNotMatch(JSON.stringify(wire), /synthetic-subject|synthetic-naver-token|synthetic-client-secret|synthetic-service|hashed_token/);
    assert.equal(f.calls.some(({ url }) => url.pathname === '/auth/v1/verify'), status === 'photo_required');
    assert.ok(f.calls.every(({ init }) => init?.redirect === 'error'));
  }
});

test('다른 verifier·state 재사용은 네이버 요청 전에 차단된다', async () => {
  const f = fixture();
  const start = await f.request('/api/signup/naver/start', { codeChallenge: await sha256(verifier), returnTo: '/' });
  const state = new URL((await start.json()).data.authorizationUrl).searchParams.get('state');
  const body = { code: 'synthetic-code', state, codeVerifier: verifier };
  assert.equal((await f.request('/api/signup/naver/callback', { ...body, codeVerifier: 'x'.repeat(43) })).status, 400);
  assert.equal(f.calls.some(({ url }) => url.hostname === 'nid.naver.com'), false);
  assert.equal((await f.request('/api/signup/naver/callback', body)).status, 200);
  const count = f.calls.filter(({ url }) => url.hostname === 'nid.naver.com').length;
  assert.equal((await f.request('/api/signup/naver/callback', body)).status, 400);
  assert.equal(f.calls.filter(({ url }) => url.hostname === 'nid.naver.com').length, count);
});

test('콜백 HTML에는 code·state·오류 원문을 반영하지 않고 저장소에 세션을 기록하지 않는다', async () => {
  const f = fixture();
  const response = await f.request('/naver/callback?code=synthetic-private-code&state=synthetic-private-state&error_description=synthetic-private-error');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), LOCAL_PAGE);
  assert.doesNotMatch(LOCAL_PAGE, /synthetic-private/);
  assert.doesNotMatch(LOCAL_SCRIPT, /localStorage|console\.(?:log|error|warn)|document\.cookie/);
  assert.equal(f.calls.length, 0);
});

function browser(options: { query?: string; stored?: Map<string, string>; callback?: unknown; state?: string; authorizationUrl?: string; blockedStorage?: 'get' | 'remove' | 'set'; uploadFailure?: boolean; completionFailure?: boolean; decodeFailure?: boolean; encodingFailure?: 'context' | 'throw' | 'null' | 'large' | 'type'; stateAfterComplete?: string } = {}) {
  const events: string[] = [];
  const storage = new Map(options.stored);
  const writes: { key: string; value: string }[] = [];
  const navigation: string[] = [];
  const calls: { path: string; init: RequestInit }[] = [];
  const listeners = new Map<string, () => Promise<void>>();
  const node = (id: string) => ({ disabled: ['photo', 'upload', 'complete'].includes(id), hidden: id === 'photo-section', value: '', files: [] as File[],
    addEventListener: (event: string, callback: () => Promise<void>) => listeners.set(id + ':' + event, callback) });
  const nodes = Object.fromEntries(['start', 'photo-section', 'photo', 'upload', 'complete', 'interests', 'conversationStyles', 'mbti'].map((id) => [id, node(id)]));
  const button = nodes.start;
  const output = { textContent: '시작 전' };
  let completeRequested = false;
  let decoded = 0;
  let closed = 0;
  const canvasCalls: { width: number; height: number; type: string; quality: number }[] = [];
  const location = { pathname: options.query === undefined ? '/' : '/naver/callback', search: options.query ?? '', assign: (url: string) => navigation.push(url) };
  runInNewContext(LOCAL_SCRIPT, {
    document: { getElementById: (id: string) => id === 'status' ? output : nodes[id], createElement: (tag: string) => {
      assert.equal(tag, 'canvas');
      const canvas = { width: 0, height: 0,
        getContext: (kind: string) => { assert.equal(kind, '2d'); return options.encodingFailure === 'context' ? null : { drawImage: () => events.push('pixels_drawn') }; },
        toBlob: (callback: (blob: Blob | null) => void, type: string, quality: number) => {
          canvasCalls.push({ width: canvas.width, height: canvas.height, type, quality });
          if (options.encodingFailure === 'throw') throw new Error('synthetic-private-encoding-error');
          if (options.encodingFailure === 'null') return callback(null);
          callback(new Blob([options.encodingFailure === 'large' ? new Uint8Array(MAX_PHOTO_BYTES + 1).buffer : Uint8Array.from(jpeg).buffer], {
            type: options.encodingFailure === 'type' ? 'image/png' : type,
          }));
        } };
      return canvas;
    } }, location,
    history: { replaceState: (_state: unknown, _title: string, path: string) => { events.push('query_removed'); assert.equal(path, '/naver/callback'); location.search = ''; } },
    sessionStorage: {
      getItem: (key: string) => { events.push('verifier_read'); if (options.blockedStorage === 'get') throw new Error('synthetic-private-storage-error'); return storage.get(key) ?? null; },
      removeItem: (key: string) => { events.push('verifier_removed'); if (options.blockedStorage === 'remove') throw new Error('synthetic-private-storage-error'); storage.delete(key); },
      setItem: (key: string, value: string) => { if (options.blockedStorage === 'set') throw new Error('synthetic-private-storage-error'); writes.push({ key, value }); storage.set(key, value); },
    },
    crypto: { getRandomValues: crypto.getRandomValues.bind(crypto), subtle: crypto.subtle, randomUUID: () => imageId }, Uint8Array, TextEncoder, URL, URLSearchParams, btoa,
    createImageBitmap: async () => { if (options.decodeFailure) throw new Error('synthetic-private-decoder-error'); decoded++; return { width: 1, height: 1, close: () => { closed++; } }; },
    fetch: async (path: string, init: RequestInit) => {
      events.push('network'); calls.push({ path, init });
      if (path.endsWith('/photo')) return options.uploadFailure ? json({ error: { message: 'synthetic-private-upload-error' } }, 400) : json({ data: { avatarPath } });
      if (path.endsWith('/complete')) {
        completeRequested = true;
        return options.completionFailure ? json({ error: { message: 'synthetic-private-complete-error' } }, 400) : json({ data: { status: 'ready', avatarPath } });
      }
      const data = path.endsWith('/start') ? { authorizationUrl: options.authorizationUrl }
        : path.endsWith('/callback') ? options.callback : { status: completeRequested ? options.stateAfterComplete ?? 'ready' : options.state ?? 'photo_required', avatarPath: completeRequested ? avatarPath : null };
      return json({ data });
    },
  });
  const settle = async () => { for (let index = 0; index < 20 && button.disabled; index++) await setImmediate(); assert.equal(button.disabled, false); };
  return { events, storage, writes, navigation, calls, button, output, location, nodes, settle, decoded: () => decoded, closed: () => closed, canvasCalls,
    click: () => listeners.get('start:click')!(), upload: () => listeners.get('upload:click')!(), complete: () => listeners.get('complete:click')!(),
    select: (file: File) => { nodes.photo.files = [file]; listeners.get('photo:change')!(); } };
}

test('브라우저 시작은 무작위 verifier만 저장하고 SHA256 proof와 검증된 공식 주소로 이동한다', async () => {
  const state = 'a'.repeat(64);
  const url = new URL('https://nid.naver.com/oauth2.0/authorize');
  url.search = new URLSearchParams({ state, response_type: 'code', redirect_uri: config.NAVER_REDIRECT_URI }).toString();
  const b = browser({ authorizationUrl: url.href }); await b.click();
  assert.equal(b.calls.length, 1); assert.equal(b.calls[0].path, '/api/signup/naver/start');
  assert.equal(b.writes.length, 1);
  assert.equal(b.writes[0].key, 'yumidang-local-naver-verifier:' + state);
  assert.match(b.writes[0].value, /^[A-Za-z0-9_-]{43}$/);
  const submitted = JSON.parse(String(b.calls[0].init.body));
  assert.deepEqual(submitted, { codeChallenge: await sha256(b.writes[0].value), returnTo: '/' });
  assert.deepEqual(b.navigation, [url.href]);
  assert.equal(b.calls[0].init.redirect, 'error'); assert.equal(b.calls[0].init.credentials, 'omit');
});

test('브라우저 콜백은 네트워크 전에 query·verifier를 지우고 accessToken만 메모리로 상태를 확인한다', async () => {
  const state = 'a'.repeat(64), key = 'yumidang-local-naver-verifier:' + state;
  const b = browser({ query: '?code=synthetic-private-code&state=' + state,
    stored: new Map([[key, verifier]]), callback: { status: 'photo_required', session: { accessToken: token, refreshToken: 'synthetic-refresh', tokenType: 'bearer' } } });
  assert.deepEqual(b.events.slice(0, 4), ['query_removed', 'verifier_read', 'verifier_removed', 'network']);
  assert.equal(b.location.search, ''); assert.equal(b.storage.size, 0);
  await b.settle();
  assert.deepEqual(b.calls.map(({ path }) => path), ['/api/signup/naver/callback', '/api/signup/state']);
  assert.deepEqual(JSON.parse(String(b.calls[0].init.body)), { code: 'synthetic-private-code', state, codeVerifier: verifier });
  assert.equal(b.calls[1].init.body, undefined);
  assert.equal(new Headers(b.calls[1].init.headers).get('authorization'), 'Bearer ' + token);
  assert.equal(b.writes.length, 0); assert.equal(b.navigation.length, 0);
  assert.equal(b.output.textContent, statusText.photo_required);
  assert.doesNotMatch(b.output.textContent, /synthetic-refresh|synthetic-private-code/);
  const reload = browser(); assert.equal(reload.calls.length, 0); assert.equal(reload.storage.size, 0);
});

test('브라우저 정보 누락·자격 미충족은 세션 검증이나 사진 완료 성공으로 표시하지 않는다', async () => {
  for (const status of ['information_required', 'ineligible']) {
    const state = 'b'.repeat(64);
    const b = browser({ query: '?code=synthetic-code&state=' + state,
      stored: new Map([['yumidang-local-naver-verifier:' + state, verifier]]), callback: { status, session: null } });
    await b.settle();
    assert.deepEqual(b.calls.map(({ path }) => path), ['/api/signup/naver/callback']);
    assert.equal(b.output.textContent, statusText[status as keyof typeof statusText]);
    assert.equal(b.storage.size, 0); assert.equal(b.writes.length, 0);
  }
});

test('취소·중복 query·verifier 없는 콜백은 원문을 표시하거나 API를 호출하지 않는다', async () => {
  const state = 'c'.repeat(64), key = 'yumidang-local-naver-verifier:' + state;
  for (const query of ['?error=access_denied&error_description=synthetic-private-error&state=' + state,
    '?code=synthetic-code&code=duplicate&state=' + state, '?code=synthetic-code&state=' + state + '&state=' + state]) {
    const b = browser({ query, stored: new Map([[key, verifier]]) }); await b.settle();
    assert.equal(b.location.search, ''); assert.equal(b.storage.size, 0); assert.equal(b.calls.length, 0);
    assert.doesNotMatch(b.output.textContent, /access_denied|synthetic-private-error|synthetic-code|duplicate/);
  }
  const missing = browser({ query: '?code=synthetic-code&state=' + state }); await missing.settle();
  assert.equal(missing.calls.length, 0); assert.equal(missing.location.search, '');
});

test('브라우저는 비공식 authorization URL·잘못된 세션 상태를 고정 실패 안내로 숨긴다', async () => {
  for (const authorizationUrl of ['https://evil.example.test/?state=' + 'a'.repeat(64), 'https://nid.naver.com.evil.test/oauth2.0/authorize', 'https://user:pass@nid.naver.com/oauth2.0/authorize']) {
    const b = browser({ authorizationUrl }); await b.click();
    assert.equal(b.navigation.length, 0); assert.equal(b.storage.size, 0); assert.equal(b.button.disabled, false);
  }
  const state = 'd'.repeat(64), key = 'yumidang-local-naver-verifier:' + state;
  for (const callback of [{ status: 'photo_required', session: null }, { status: 'synthetic-private-error', session: null },
    { status: 'ready', session: { accessToken: 'synthetic-invalid-token', tokenType: 'bearer' } }]) {
    const b = browser({ query: '?code=synthetic-code&state=' + state, stored: new Map([[key, verifier]]), callback }); await b.settle();
    assert.equal(b.calls.length, 1); assert.equal(b.storage.size, 0); assert.equal(b.writes.length, 0);
    assert.doesNotMatch(b.output.textContent, /ready|photo_required|synthetic-private-error|synthetic-invalid-token/);
  }
});

test('브라우저 저장소가 차단돼도 query를 지우고 proof 없는 요청·원문 표시를 하지 않는다', async () => {
  const state = 'e'.repeat(64), key = 'yumidang-local-naver-verifier:' + state;
  for (const blockedStorage of ['get', 'remove'] as const) {
    const b = browser({ query: '?code=synthetic-code&state=' + state, stored: new Map([[key, verifier]]), blockedStorage });
    await b.settle();
    assert.equal(b.location.search, ''); assert.equal(b.calls.length, 0);
    assert.doesNotMatch(b.output.textContent, /synthetic-private-storage-error|synthetic-code/);
  }
  const authorize = new URL('https://nid.naver.com/oauth2.0/authorize');
  authorize.search = new URLSearchParams({ state, response_type: 'code', redirect_uri: config.NAVER_REDIRECT_URI }).toString();
  const b = browser({ authorizationUrl: authorize.href, blockedStorage: 'set' }); await b.click();
  assert.equal(b.navigation.length, 0); assert.equal(b.button.disabled, false);
  assert.doesNotMatch(b.output.textContent, /synthetic-private-storage-error/);
});

function photoRequest(bytes: Uint8Array = jpeg, options: { path?: string; method?: string; headers?: Record<string, string> } = {}) {
  const method = options.method ?? 'POST';
  return new Request(LOCAL_ORIGIN + (options.path ?? '/api/signup/photo'), {
    method, headers: { host: '127.0.0.1:5173', origin: LOCAL_ORIGIN, authorization: 'Bearer ' + token,
      'content-type': 'image/jpeg', 'x-image-id': imageId, ...options.headers },
    ...(['GET', 'HEAD'].includes(method) ? {} : { body: Uint8Array.from(bytes).buffer }),
  });
}

test('JPEG guard는 실제 합성 JPEG 구조를 인정하고 marker만·잘림·다른 형식을 거절한다', () => {
  assert.equal(MAX_PHOTO_BYTES, 2097152);
  assert.equal(isLocalJpeg(jpeg), true);
  for (const bytes of [Buffer.alloc(0), Buffer.from([0xff, 0xd8, 0xff, 0xd9]), jpeg.subarray(0, jpeg.length - 2), Buffer.from('<svg>synthetic</svg>')]) {
    assert.equal(isLocalJpeg(bytes), false);
  }
});

test('사진 bytes는 Auth가 검증한 UID 경로와 사용자 Bearer로 Storage INSERT하며 완료를 자동 호출하지 않는다', async () => {
  const f = fixture();
  const response = await f.handler(photoRequest()); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { avatarPath });
  assert.deepEqual(f.calls.map(({ url }) => url.pathname), ['/auth/v1/user', '/storage/v1/object/profile-images/' + avatarPath]);
  const upload = f.calls[1]; assert.equal(upload.init?.method, 'POST');
  assert.deepEqual(Buffer.from(upload.init?.body as ArrayBuffer), jpeg);
  const headers = new Headers(upload.init?.headers);
  assert.equal(headers.get('apikey'), config.ANON_KEY); assert.equal(headers.get('authorization'), 'Bearer ' + token);
  assert.equal(headers.get('content-type'), 'image/jpeg'); assert.equal(headers.get('x-upsert'), 'false');
  assert.notEqual(headers.get('apikey'), config.SERVICE_ROLE_KEY);
  assert.equal(upload.init?.redirect, 'error'); assert.equal(upload.init?.credentials, 'omit');
  const diagnostics = await (await f.request('/diagnostics')).json();
  assert.notEqual(diagnostics.lastStatus, 'ready');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('사진 endpoint의 Host·Origin·method·query·이미지 ID·타입·용량 오류는 Storage에 전송하지 않는다', async () => {
  for (const request of [
    photoRequest(jpeg, { headers: { host: 'evil.example.test' } }),
    photoRequest(jpeg, { headers: { origin: 'https://evil.example.test' } }),
    photoRequest(jpeg, { method: 'GET' }), photoRequest(jpeg, { path: '/api/signup/photo?path=other-user' }),
    photoRequest(jpeg, { headers: { 'x-image-id': uid + '/other.jpg' } }),
    photoRequest(jpeg, { headers: { 'x-image-id': 'dddddddd-dddd-1ddd-8ddd-dddddddddddd' } }),
    photoRequest(jpeg, { headers: { 'content-type': 'image/png' } }),
    photoRequest(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), photoRequest(Buffer.alloc(0)), photoRequest(Buffer.alloc(MAX_PHOTO_BYTES + 1)),
  ]) {
    const f = fixture(); const response = await f.handler(request);
    assert.ok(response.status >= 400 && response.status < 500);
    assert.equal(f.calls.some(({ url }) => url.pathname.startsWith('/storage/')), false);
  }
});

test('미인증·익명·잘못된 Auth role/id는 사용자 사진 업로드 권한으로 취급하지 않는다', async () => {
  for (const authorization of ['', 'Bearer synthetic-invalid-token', 'Bearer ' + config.SERVICE_ROLE_KEY, 'Bearer ' + config.ANON_KEY]) {
    const f = fixture(); const response = await f.handler(photoRequest(jpeg, { headers: { authorization } }));
    assert.equal(response.status, 401); assert.equal(f.calls.some(({ url }) => url.pathname.startsWith('/storage/')), false);
  }
  for (const options of [{ authStatus: 401 }, { authUser: { id: uid, role: 'service_role', is_anonymous: false } },
    { authUser: { id: uid, role: 'authenticated', is_anonymous: true } }, { authUser: { id: 'synthetic-bad-id', role: 'authenticated' } }]) {
    const f = fixture('photo_required', options); const response = await f.handler(photoRequest());
    assert.equal(response.status, 401); assert.equal(f.calls.some(({ url }) => url.pathname.startsWith('/storage/')), false);
  }
});

test('Storage 실패는 private 응답·token을 숨기고 업로드·가입 성공으로 표시하지 않는다', async () => {
  const f = fixture('photo_required', { storageFailure: true });
  const response = await f.handler(photoRequest()); assert.ok(response.status >= 400);
  assert.doesNotMatch(await response.text(), /synthetic-private-storage-error|synthetic-service|accessToken|avatarPath/);
  assert.equal(f.calls.some(({ url }) => url.pathname.endsWith('/complete_naver_signup')), false);
  const diagnostics = await (await f.request('/diagnostics')).json(); assert.notEqual(diagnostics.lastStatus, 'ready');
});

test('명시적 완료는 사용자 Auth와 Bearer RPC로 사진·선택 성향을 원자 계약에 전달한다', async () => {
  const f = fixture();
  const data = { avatarPath, interests: ['전시'], conversationStyles: ['차분한 대화'], mbti: 'INFP' };
  const response = await f.request('/api/signup/complete', data, { authorization: 'Bearer ' + token });
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).data, { status: 'ready', ...data });
  assert.deepEqual(f.calls.map(({ url }) => url.pathname), ['/auth/v1/user', '/rest/v1/rpc/complete_naver_signup']);
  const complete = f.calls[1]; assert.deepEqual(JSON.parse(String(complete.init?.body)), {
    p_avatar_path: avatarPath, p_interests: ['전시'], p_conversation_styles: ['차분한 대화'], p_mbti: 'INFP',
  });
  const headers = new Headers(complete.init?.headers);
  assert.equal(headers.get('authorization'), 'Bearer ' + token); assert.equal(headers.get('apikey'), config.ANON_KEY);
});

test('완료 입력·상위 실패는 ready를 가장하지 않고 서버의 소유권·자격 검증을 우회하지 않는다', async () => {
  const f = fixture('photo_required', { completionFailure: true });
  const missingAuth = await f.request('/api/signup/complete', { avatarPath }); assert.equal(missingAuth.status, 401);
  const invalid = await f.request('/api/signup/complete', { avatarPath, gender: 'female' }, { authorization: 'Bearer ' + token });
  assert.equal(invalid.status, 400); assert.equal(f.calls.some(({ url }) => url.pathname.endsWith('/complete_naver_signup')), false);
  const response = await f.request('/api/signup/complete', { avatarPath }, { authorization: 'Bearer ' + token });
  assert.equal(response.status, 400); assert.doesNotMatch(await response.text(), /synthetic-private-completion-error|accessToken/);
  const diagnostics = await (await f.request('/diagnostics')).json(); assert.notEqual(diagnostics.lastStatus, 'ready');
});

async function photoBrowser(options: NonNullable<Parameters<typeof browser>[0]> = {}) {
  const state = 'f'.repeat(64);
  const b = browser({ query: '?code=synthetic-code&state=' + state,
    stored: new Map([['yumidang-local-naver-verifier:' + state, verifier]]),
    callback: { status: 'photo_required', session: { accessToken: token, refreshToken: 'synthetic-refresh', tokenType: 'bearer' } }, ...options });
  await b.settle();
  b.nodes.interests.value = '전시, 산책'; b.nodes.conversationStyles.value = '차분한 대화'; b.nodes.mbti.value = 'infp';
  return b;
}
const syntheticMetadata = Buffer.from('Exif\0\0SYNTHETIC_GPS_METADATA');
const originalPhoto = Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1, 0, syntheticMetadata.length + 2]), syntheticMetadata, jpeg.subarray(2)]);
const selectedFile = () => new File([Uint8Array.from(originalPhoto).buffer], 'synthetic-private-filename.jpg', { type: 'image/jpeg' });

test('브라우저는 사진 디코딩·업로드 뒤 명시 완료 클릭과 실제 상태 ready를 따로 확인한다', async () => {
  const b = await photoBrowser(); const file = selectedFile();
  assert.equal(b.nodes['photo-section'].hidden, false); assert.equal(b.nodes.complete.disabled, true);
  b.select(file); await b.upload();
  assert.equal(b.decoded(), 1); assert.equal(b.nodes.complete.disabled, false);
  assert.deepEqual(b.calls.map(({ path }) => path), ['/api/signup/naver/callback', '/api/signup/state', '/api/signup/photo']);
  const upload = b.calls[2]; assert.deepEqual(Buffer.from(upload.init.body as ArrayBuffer), jpeg);
  assert.notDeepEqual(Buffer.from(upload.init.body as ArrayBuffer), originalPhoto);
  assert.equal(Buffer.from(upload.init.body as ArrayBuffer).includes(syntheticMetadata), false);
  assert.deepEqual(b.canvasCalls, [{ width: 1, height: 1, type: 'image/jpeg', quality: 0.9 }]);
  assert.equal(b.closed(), 1);
  const headers = new Headers(upload.init.headers);
  assert.equal(headers.get('x-image-id'), imageId); assert.equal(headers.get('authorization'), 'Bearer ' + token);
  assert.equal(headers.get('content-type'), 'image/jpeg');
  assert.doesNotMatch(b.output.textContent, /ready|synthetic-private-filename|synthetic-refresh/);
  await b.complete();
  assert.deepEqual(b.calls.slice(3).map(({ path }) => path), ['/api/signup/complete', '/api/signup/state']);
  assert.deepEqual(JSON.parse(String(b.calls[3].init.body)), { avatarPath, interests: ['전시', '산책'], conversationStyles: ['차분한 대화'], mbti: 'INFP' });
  assert.equal(b.output.textContent, '가입 완료 검증 성공');
  assert.equal(b.nodes['photo-section'].hidden, true);
  assert.equal(b.storage.size, 0); assert.equal(b.writes.length, 0);
});

test('브라우저 업로드·완료·상태 확인 실패는 선택 파일과 성향을 보존하며 false ready를 표시하지 않는다', async () => {
  for (const options of [{ uploadFailure: true }, { completionFailure: true }, { stateAfterComplete: 'photo_required' }]) {
    const b = await photoBrowser(options); const file = selectedFile(); b.select(file); await b.upload();
    if (!options.uploadFailure) await b.complete();
    assert.equal(b.nodes.photo.files[0], file); assert.equal(b.nodes.interests.value, '전시, 산책');
    assert.equal(b.nodes.conversationStyles.value, '차분한 대화'); assert.equal(b.nodes.mbti.value, 'infp');
    assert.equal(b.nodes['photo-section'].hidden, false); assert.equal(b.nodes.upload.disabled, false);
    assert.equal(b.nodes.complete.disabled, Boolean(options.uploadFailure));
    assert.doesNotMatch(b.output.textContent, /ready|가입 완료 검증 성공|synthetic-private-(?:upload|complete)-error/);
    assert.equal(b.storage.size, 0); assert.equal(b.writes.length, 0);
  }
});

test('브라우저는 잘못된 타입·크기·실제 디코딩 실패 파일을 업로드하지 않는다', async () => {
  for (const file of [new File([Uint8Array.from(jpeg).buffer], 'synthetic.gif', { type: 'image/gif' }),
    new File([], 'synthetic-empty.jpg', { type: 'image/jpeg' }),
    new File([new Uint8Array(MAX_ORIGINAL_PHOTO_BYTES + 1).buffer], 'synthetic-large.jpg', { type: 'image/jpeg' }),
    new File([new Uint8Array(MAX_ORIGINAL_PHOTO_BYTES + 1).buffer], 'synthetic-large.png', { type: 'image/png' })]) {
    const b = await photoBrowser(); b.select(file); await b.upload();
    assert.equal(b.calls.length, 2); assert.equal(b.nodes.complete.disabled, true);
    assert.equal(b.nodes.photo.files[0], file); assert.equal(b.decoded(), 0);
  }
  const b = await photoBrowser({ decodeFailure: true }); b.select(selectedFile()); await b.upload();
  assert.equal(b.calls.length, 2); assert.equal(b.nodes.complete.disabled, true);
  assert.doesNotMatch(b.output.textContent, /synthetic-private-decoder-error/);
});

test('JPEG 재인코딩 실패·다른 타입·출력 용량 초과는 원본 bytes를 우회 전송하지 않고 입력을 보존한다', async () => {
  for (const encodingFailure of ['context', 'throw', 'null', 'large', 'type'] as const) {
    const b = await photoBrowser({ encodingFailure }); const file = selectedFile(); b.select(file); await b.upload();
    assert.equal(b.calls.length, 2); assert.equal(b.nodes.complete.disabled, true);
    assert.equal(b.nodes.photo.files[0], file); assert.equal(b.nodes.interests.value, '전시, 산책');
    assert.equal(b.nodes.mbti.value, 'infp'); assert.equal(b.closed(), 1);
    assert.doesNotMatch(b.output.textContent, /synthetic-private-encoding-error|가입 완료 검증 성공/);
  }
});

test('브라우저의 세션 없는 자격 보류에서는 사진·완료 버튼으로 새 가입을 우회할 수 없다', async () => {
  for (const status of ['ineligible', 'information_required']) {
    const b = await photoBrowser({ callback: { status, session: null } }); b.select(selectedFile());
    await b.upload(); await b.complete();
    assert.equal(b.calls.length, 1); assert.equal(b.nodes['photo-section'].hidden, true);
    assert.equal(b.nodes.upload.disabled, true); assert.equal(b.nodes.complete.disabled, true);
    assert.equal(b.output.textContent, statusText[status as keyof typeof statusText]);
  }
});


test('원본 JPEG·PNG 10MB 경계는 저장 JPEG 2MiB와 분리하고 재인코딩만 전송한다', async () => {
  assert.equal(MAX_ORIGINAL_PHOTO_BYTES, 10 * 1024 * 1024);
  assert.equal(MAX_PHOTO_BYTES, 2 * 1024 * 1024);
  assert.match(LOCAL_PAGE, /accept="image\/jpeg,image\/png"/);
  for (const [type, extension] of [['image/jpeg', 'jpeg'], ['image/png', 'png']]) {
    const file = new File([new Uint8Array(MAX_ORIGINAL_PHOTO_BYTES).buffer], `synthetic.${extension}`, { type });
    const b = await photoBrowser(); b.select(file); await b.upload();
    assert.equal(b.decoded(), 1);
    assert.equal(b.calls.length, 3);
    assert.equal(b.nodes.complete.disabled, false);
    assert.equal(b.canvasCalls[0].type, 'image/jpeg');
    const upload = b.calls[2];
    assert.equal(new Headers(upload.init.headers).get('content-type'), 'image/jpeg');
    assert.equal(new Uint8Array(upload.init.body as ArrayBuffer).byteLength, jpeg.length);
    assert.equal(b.nodes.photo.files[0], file);
    assert.equal(b.calls.some(({ path }) => path === '/api/signup/complete'), false);
  }
});
