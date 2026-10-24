import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '../../apps/mobile');
const ts = createRequire(path.join(root, 'package.json'))('typescript');
const photo = { uri: 'blob:synthetic-only', mimeType: 'image/png', originalBytes: 99 };
const uid = '11111111-1111-4111-8111-111111111111';
const server = (overrides = {}) => ({ status: 'completion_required', avatarPath: null, interests: ['서버 관심사'], conversationStyles: ['서버 대화'], mbti: 'ISTJ', ...overrides });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const nodes = v => Array.isArray(v) ? v.flatMap(nodes) : v && typeof v === 'object' ? [v, ...nodes(v.props?.children), ...nodes(v.props?.footer)] : [];
const words = v => Array.isArray(v) ? v.map(words).join('') : typeof v === 'string' ? v : v && typeof v === 'object' ? words(v.props?.children) : '';
function fixture(signupState = async () => server()) {
  let epoch = 1, details = { userId: uid, status: 'completion_required', returnTo: '/', accessToken: 'synthetic' };
  let component, dirty = false, pickerResult = Promise.resolve({ canceled: true });
  const routes = [], focusCalls = [], focusKinds = [], counts = { upload: 0, complete: 0, login: 0 };
  const session = { signupState, complete: async () => { counts.complete++; return server({ status: 'ready' }); }, login: () => { counts.login++; } };
  const storage = {};
  const consents = { exploration: false, summary_view: false, summary_generate: false, summary_source: false };
  const consentCalls = [];
  const member = { aiConsents: async () => ({ ...consents }), setAiConsent: async (kind, allowed) => { consentCalls.push({ kind, allowed }); consents[kind] = allowed; return { ...consents }; }, appointment: async () => ({}), conversation: async () => ({}) };
  const service = { getPost: async () => ({}), getEvent: async () => ({}), getProfile: async () => ({}) };
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) { const c = component, i = c.cursor++; if (!(i in c.slots)) c.slots[i] = typeof initial === 'function' ? initial() : initial; return [c.slots[i], v => { c.slots[i] = typeof v === 'function' ? v(c.slots[i]) : v; dirty = true; }]; },
    useRef(initial) { const i = component.cursor++; return component.slots[i] ??= { current: initial }; },
    useCallback(fn, deps) { const i = component.cursor++, prev = component.slots[i]; if (!prev || !same(prev.deps, deps)) component.slots[i] = { fn, deps }; return component.slots[i].fn; },
    useEffect(fn, deps) { const c = component, i = c.cursor++, prev = c.slots[i]; if (!prev || !same(prev.deps, deps)) c.effects.push(() => { prev?.cleanup?.(); c.slots[i] = { deps, create: fn, cleanup: fn() }; }); },
  };
  const remote = { useMemberService: () => member, useService: () => service, serviceMode: true, serviceSessionEpoch: () => epoch, useServiceSession: () => ({ epoch }), useMemberPorts: () => ({ session, photo: storage }), useMemberSessionDetails: () => details, installMemberSessionDetails(v) { details = v; epoch++; lifecycle(); } };
  const focusController = { focusTarget(target, options) { focusKinds.push(options?.input === true ? "input" : "non-input"); target?.focus(); } };
  const ui = new Proxy({ colors: {}, art: {} }, { get: (o, k) => o[k] ?? k });
  const cache = new Map();
  function load(file) {
    file = path.resolve(file); if (!fs.existsSync(file)) file += '.ts';
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    let source = fs.readFileSync(file, 'utf8');
    if (file.endsWith('AuthAiScreens.tsx')) source += '\nexport { RemoteSignupScreen, PreviewSignupScreen, signupFailure, authMessage };';
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
    vm.runInNewContext(compiled, { module, exports: module.exports, AbortController, URL, Date, Intl, setTimeout, clearTimeout, require(id) {
      if (id === 'react') return React;
      if (id === 'react-native') return { Image: 'Image', Modal: 'Modal', Text: 'Text', Pressable: 'Pressable', View: 'View', Platform: { OS: 'web' } };
      if (id === 'expo-router') return { router: { replace: v => routes.push(['replace', v]), push: v => routes.push(['push', v]) }, useFocusEffect: fn => React.useEffect(fn, [fn]) };
      if (id === '../remote') return remote;
      if (id === '../ui' || id === './CommunityScreens') return ui;
      if (id === '../presentation/ux-form') return { useUxFocus: () => focusController };
      if (id === '../state') return { routes: { S00: '/', S01: '/explore', S02: '/post', S03: '/create', S05: '/login', S06: '/signup', S09: '/event', S11: '/chat', S14: '/profile', S16: '/appointment', S17: '/review', S18: '/cancel' }, useApp: () => ({ member: null, login() {}, updateMember() {} }) };
      if (id === './RemoteScreens' || id === '../web-member-connection' || id === '../auth-callback-task') return {};
      if (id === '../avatar-service') return { validateOriginalPhoto: load(path.join(root, 'src/avatar-service.ts')).validateOriginalPhoto, async uploadPhoto() { counts.upload++; } };
      if (id === 'expo-image-picker') return { launchImageLibraryAsync: () => pickerResult };
      if (id === 'expo-crypto') return { randomUUID: () => uid };
      if (id.startsWith('.')) return load(path.resolve(path.dirname(file), id));
      throw new Error('Unexpected dependency ' + id);
    } }, { filename: file });
    return module.exports;
  }
  const drafts = load(path.join(root, 'src/signup-draft.ts'));
  const auth = load(path.join(root, 'src/screens/AuthAiScreens.tsx'));
  function lifecycle() { drafts.observeSignupDraftSession(details && details.status !== 'ready' ? { userId: details.userId, epoch, session } : null); }
  const components = [];
  function render(c) { if (!c.alive) return; component = c; c.cursor = 0; c.tree = c.fn();
    for (const n of nodes(c.tree)) {
      const ref = n.props?.ref || n.props?.inputRef || n.props?.focusRef;
      if (ref) ref.current = { focus: () => focusCalls.push(n.props.accessibilityLabel || n.props.label || words(n)) };
    }
    c.effects.splice(0).forEach(f => f()); }
  function mount(preview = false) { const c = { fn: preview ? auth.PreviewSignupScreen : auth.RemoteSignupScreen, cursor: 0, slots: [], effects: [], alive: true }; components.push(c); render(c); return c; }
  function unmount(c) { c.alive = false; c.slots.forEach(v => v?.cleanup?.()); }
  async function flush() { for (let i = 0; i < 16; i++) { await new Promise(r => setImmediate(r)); if (!dirty) return; dirty = false; components.forEach(render); } throw new Error('Did not settle'); }
  const all = c => nodes(c.tree);
  const button = (c, text) => all(c).find(n => n.type === 'Button' && words(n) === text);
  return { member, service, consents, consentCalls, drafts, mount, unmount, flush, routes, counts, all, button, session, focusCalls, focusKinds, focusController, signupFailure: auth.signupFailure, authMessage: auth.authMessage, ApiError: load(path.join(root, "src/api.ts")).ApiError,
    blur(c) { c.slots.forEach(v => { if (v?.cleanup) { v.cleanup(); v.cleanup = undefined; } }); },
    focus(c) { c.slots.forEach(v => { if (v?.create) v.cleanup = v.create(); }); },
    text: c => words(c.tree),
    scope: () => ({ userId: details?.userId, epoch, session }),
    sessionSnapshot: () => details ? { ...details } : null,
    picker(value) { pickerResult = Promise.resolve({ canceled: false, assets: [value] }); },
    change(next) { epoch++; details = next; lifecycle(); dirty = true; },
    edit(c, label, value) {
      if (label === 'MBTI · 선택') { if (!value) all(c).find(n => n.type === 'TextButton' && words(n) === 'MBTI 비우기').props.onPress(); else for (const letter of value.toUpperCase()) { all(c).find(n => n.type === 'Chip' && words(n) === letter)?.props.onPress(); render(c); } return; }
      const n = all(c).find(n => n.props?.title === label || n.props?.label === label); (n.props.setValues || n.props.onChangeText)(value);
    },
  };
}
test('draft returns only to the same verified identity, epoch and port; completion/logout revoke access even unmounted', () => {
  const h = fixture(), store = h.drafts.createSignupDraftStore(), scope = h.scope();
  store.observe(scope); store.edit(scope, 'photo', photo); store.edit(scope, 'interests', ['내 선택']);
  store.observe({ ...scope }); assert.equal(store.read(scope).photo.uri, photo.uri);
  for (const next of [{ ...scope, epoch: 2 }, { ...scope, userId: 'other' }, { ...scope, session: {} }, null]) {
    store.observe(next); assert.equal(store.read(scope), null); assert.equal(store.edit(scope, 'mbti', 'ENFP'), null);
    store.observe(scope); assert.equal(store.read(scope).photo, null); store.edit(scope, 'photo', photo);
  }
  store.clear(scope); assert.equal(store.read(scope), null);
});
test('server refresh merges untouched defaults while retaining manually cleared or edited fields and selected photo', () => {
  const h = fixture(), store = h.drafts.createSignupDraftStore(), scope = h.scope();
  store.observe(scope); store.merge(scope, server());
  store.edit(scope, 'photo', photo); store.edit(scope, 'interests', []); store.edit(scope, 'mbti', '');
  const merged = store.merge(scope, server({ avatarPath: uid + '/' + uid + '.jpg', conversationStyles: ['갱신 기본'] }));
  assert.equal(merged.photo.uri, photo.uri); assert.equal(merged.avatarPath, null); assert.equal(merged.interests.length, 0); assert.equal(merged.mbti, ''); assert.equal(merged.conversationStyles[0], '갱신 기본');
  merged.photo.uri = 'changed'; merged.conversationStyles.push('outside mutation');
  assert.equal(store.read(scope).photo.uri, photo.uri); assert.equal(store.read(scope).conversationStyles.length, 1);
});
test('actual signup failure stops its loading text and offers a manual retry; malformed responses also recover', async () => {
  let calls = 0;
  const h = fixture(async () => { calls++; if (calls === 1) throw new Error('network'); if (calls === 2) return {}; return server(); });
  const c = h.mount(); await h.flush();
  assert.ok(h.button(c, '다시 불러오기')); assert.doesNotMatch(h.text(c), /현재 가입 정보를 확인/);
  await h.button(c, '다시 불러오기').props.onPress(); await h.flush();
  assert.ok(h.button(c, '다시 불러오기')); assert.doesNotMatch(h.text(c), /현재 가입 정보를 확인/);
  await h.button(c, '다시 불러오기').props.onPress(); await h.flush();
  assert.equal(h.button(c, '다시 불러오기'), undefined); assert.equal(calls, 3); assert.equal(h.counts.upload, 0); assert.equal(h.counts.login, 0);
});
test('actual retry preserves edits made before/during fetch and header return remount restores them without upload/auth', async () => {
  const request = deferred(); let calls = 0;
  const h = fixture(() => ++calls === 1 ? Promise.reject(new Error('network')) : request.promise);
  const c = h.mount(); await h.flush();
  h.edit(c, '관심사 · 선택', ['내 관심']); h.edit(c, '대화 방식 · 선택', ['내 방식']); h.edit(c, 'MBTI · 선택', 'enfp');
  h.picker({ uri: photo.uri, mimeType: photo.mimeType, fileSize: photo.originalBytes });
  await h.button(c, '프로필 사진 선택').props.onPress(); await h.flush();
  h.button(c, '다시 불러오기').props.onPress(); await h.flush();
  h.edit(c, '관심사 · 선택', ['요청 중 변경']);
  request.resolve(server()); await h.flush();
  const saved = h.drafts.signupDraftStore.read(h.scope());
  assert.equal(saved.photo.uri, photo.uri); assert.equal(saved.interests[0], '요청 중 변경'); assert.equal(saved.conversationStyles[0], '내 방식'); assert.equal(saved.mbti, 'ENFP');
  assert.equal(c.tree.props.backLabel, '로그인으로 돌아가기'); c.tree.props.onBack(); h.unmount(c);
  assert.deepEqual(h.routes, [['push', '/login']]);
  const returned = h.mount(); await h.flush();
  assert.equal(h.drafts.signupDraftStore.read(h.scope()).mbti, 'ENFP'); assert.equal(h.counts.upload, 0); assert.equal(h.counts.login, 0);
});
test('late requests from an old session cannot replace or clear the new account draft', async () => {
  const request = deferred(); const h = fixture(() => request.promise), c = h.mount();
  const oldScope = h.scope(); h.edit(c, '관심사 · 선택', ['old']);
  h.unmount(c); h.change({ userId: '22222222-2222-4222-8222-222222222222', accessToken: 'other-synthetic', status: 'completion_required', returnTo: '/' });
  const other = h.mount(); h.edit(other, '관심사 · 선택', ['new']); request.resolve(server()); await h.flush();
  assert.equal(h.drafts.signupDraftStore.read(oldScope), null); assert.equal(h.drafts.signupDraftStore.read(h.scope()).interests[0], 'new');
});

test('verified missing/ineligible information continues to block completion and supports explicit recheck', async () => {
  for (const status of ['information_required', 'ineligible']) {
    const h = fixture(async () => server({ status, avatarPath: uid + '/' + uid + '.jpg' }));
    const c = h.mount(); await h.flush();
    assert.ok(h.button(c, '다시 불러오기'));
    assert.equal(h.button(c, '가입 완료').props.disabled, true);
    assert.doesNotMatch(h.text(c), /현재 가입 정보를 확인/);
  }
});
test('back during completion aborts it; a same-route focus return allows a fresh explicit completion', async () => {
  const pending = deferred();
  const h = fixture(async () => server({ avatarPath: uid + '/' + uid + '.jpg' }));
  h.session.complete = async () => { h.counts.complete++; return pending.promise; };
  const c = h.mount(); await h.flush();
  h.button(c, '가입 완료').props.onPress(); await h.flush();
  assert.equal(h.button(c, '가입 완료').props.loading, true);
  c.tree.props.onBack(); h.blur(c); h.focus(c); await h.flush();
  assert.equal(h.button(c, '가입 완료').props.loading, false);
  assert.equal(h.button(c, '가입 완료').props.disabled, false);
  pending.resolve(server({ status: 'ready' })); await h.flush();
  assert.equal(h.counts.complete, 1);
  assert.equal(h.drafts.signupDraftStore.read(h.scope()) !== null, true);
  assert.deepEqual(h.routes, [['push', '/login']]);
});

test('a verified ready recheck synchronizes the existing session and clears its draft without issuing credentials', async () => {
  let calls = 0;
  const h = fixture(async () => ++calls === 1 ? Promise.reject(new Error('network')) : server({ status: 'ready' }));
  const c = h.mount(); await h.flush();
  h.edit(c, '관심사 · 선택', ['나중에 완료된 가입']);
  const scope = h.scope(), before = h.sessionSnapshot();
  h.button(c, '다시 불러오기').props.onPress(); await h.flush();
  assert.deepEqual(h.sessionSnapshot(), { ...before, status: 'ready' });
  assert.equal(h.drafts.signupDraftStore.read(scope), null);
  assert.deepEqual(h.routes, []);
  assert.match(h.text(c), /가입 프로필을 완성/);
  h.button(c, '확인하고 계속').props.onPress(); await h.flush();
  assert.deepEqual(h.routes, [['replace', '/']]);
  assert.equal(h.counts.login, 0); assert.equal(h.counts.upload, 0); assert.equal(h.counts.complete, 0);
});
test('a late ready lookup cannot promote a replaced or expired identity or remove the replacement draft', async () => {
  for (const replacement of [null, { userId: '22222222-2222-4222-8222-222222222222', accessToken: 'other-synthetic', status: 'completion_required', returnTo: '/' }]) {
    const request = deferred(), h = fixture(() => request.promise), c = h.mount();
    const oldScope = h.scope(); h.unmount(c); h.change(replacement);
    const nextScope = h.scope();
    if (replacement) { h.drafts.signupDraftStore.edit(nextScope, 'mbti', 'ENFP'); }
    request.resolve(server({ status: 'ready' })); await h.flush();
    assert.deepEqual(h.sessionSnapshot(), replacement);
    assert.deepEqual(h.routes, []);
    assert.equal(h.drafts.signupDraftStore.read(oldScope), null);
    if (replacement) assert.equal(h.drafts.signupDraftStore.read(nextScope).mbti, 'ENFP');
  }
});

test('preview S06 focuses the actual photo action for missing/invalid photo and the first missing MBTI choice for its existing partial-choice error', async () => {
  const h = fixture(), c = h.mount(true);
  h.button(c, '가입 완료').props.onPress(); await h.flush();
  assert.equal(h.focusCalls.at(-1), '프로필 사진 선택, 필수');
  assert.equal(c.tree.props.focusController, h.focusController);
  assert.equal(h.focusKinds.at(-1), 'non-input');
  h.picker({ uri: 'blob:invalid-fixture', mimeType: 'image/gif', fileSize: 10 });
  await h.all(c).find(n => n.props?.accessibilityLabel === '프로필 사진 선택, 필수').props.onPress(); await h.flush();
  assert.equal(h.focusCalls.at(-1), '프로필 사진 선택, 필수'); assert.equal(h.focusCalls.length, 2);
  h.picker({ uri: photo.uri, mimeType: photo.mimeType, fileSize: photo.originalBytes });
  await h.all(c).find(n => n.props?.accessibilityLabel === '프로필 사진 선택, 필수').props.onPress(); await h.flush();
  h.all(c).find(n => n.type === 'Chip' && words(n) === 'E').props.onPress(); await h.flush();
  h.button(c, '가입 완료').props.onPress(); await h.flush();
  assert.equal(h.focusCalls.at(-1), 'S'); assert.equal(h.focusKinds.at(-1), 'non-input'); assert.match(h.text(c), /MBTI를 모두 선택하거나 비워/);
});
test('remote S06 focuses a confirmed photo fault on its actual action and keeps unknown errors on the neutral notice', async () => {
  const h = fixture(async () => server({ avatarPath: uid + '/' + uid + '.jpg' })), c = h.mount(); await h.flush();
  h.session.complete = async () => { throw new h.ApiError(400, 'INVALID_PHOTO'); };
  h.button(c, '가입 완료').props.onPress(); await h.flush();
  assert.equal(h.focusCalls.at(-1), '프로필 사진 선택');
  assert.equal(c.tree.props.focusController, h.focusController);
  assert.equal(h.focusKinds.at(-1), 'non-input');
  h.session.complete = async () => { throw new h.ApiError(503, 'UNKNOWN_SERVER_FAULT'); };
  h.button(c, '가입 완료').props.onPress(); await h.flush();
  assert.match(h.focusCalls.at(-1), /^가입 정보 확인 안내[.] 연결하지 못했어요/);
  assert.equal(h.focusKinds.at(-1), 'non-input');
  assert.equal(h.drafts.signupDraftStore.read(h.scope()).mbti, 'ISTJ');
});

test('signup recovery classifies explicit auth, unavailable and network errors without replacing known eligibility semantics', () => {
  const h = fixture();
  for (const [status, code, kind] of [[401, 'AUTH_REQUIRED', 'login'], [403, 'FORBIDDEN', 'unavailable'], [404, 'NOT_FOUND', 'unavailable'], [503, 'NETWORK_UNAVAILABLE', 'retry']]) {
    const failure = h.signupFailure(new h.ApiError(status, code));
    assert.equal(failure.kind, kind);
    if (kind === 'login') assert.match(failure.message, /상단 뒤로가기/);
    if (kind === 'unavailable') { assert.match(failure.message, /이용할 수 없어요/); assert.doesNotMatch(failure.message, /삭제|탈퇴|0건|연결하지 못/); }
  }
  assert.equal(h.signupFailure(new Error('network')).kind, 'retry');
  assert.equal(h.authMessage(new h.ApiError(403, 'NAVER_INELIGIBLE')), '여성·만 19세 이상 가입 자격을 충족하지 않아 가입을 완료할 수 없어요.');
  assert.equal(h.authMessage(new h.ApiError(403, 'NAVER_INFORMATION_REQUIRED')), '네이버 필수 정보가 누락됐어요. 네이버 정보와 동의 항목을 확인한 뒤 다시 로그인해 주세요.');
});
test('actual auth/unavailable fetch failures use the header recovery, retain local inputs and omit the network retry button', async () => {
  for (const status of [401, 403, 404, 503]) {
    const pending = deferred(), h = fixture(() => pending.promise), c = h.mount();
    h.edit(c, '관심사 · 선택', ['내가 고른 관심사']); h.edit(c, 'MBTI · 선택', 'enfp');
    h.picker({ uri: photo.uri, mimeType: photo.mimeType, fileSize: photo.originalBytes });
    await h.button(c, '프로필 사진 선택').props.onPress(); await h.flush();
    pending.reject(new h.ApiError(status, status === 401 ? 'AUTH_REQUIRED' : 'GENERIC_SERVER_ERROR')); await h.flush();
    assert.equal(Boolean(h.button(c, '다시 불러오기')), status === 503);
    assert.equal(c.tree.props.backLabel, '로그인으로 돌아가기');
    assert.equal(h.all(c).some(n => ['Button', 'TextButton'].includes(n.type) && /로그인/.test(words(n))), false);
    assert.doesNotMatch(h.text(c), /현재 가입 정보를 확인/);
    const saved = h.drafts.signupDraftStore.read(h.scope());
    assert.equal(saved.photo.uri, photo.uri); assert.equal(saved.mbti, 'ENFP'); assert.equal(saved.interests[0], '내가 고른 관심사');
    assert.equal(h.counts.login, 0); assert.equal(h.counts.upload, 0);
    if (status === 401) assert.match(h.text(c), /상단 뒤로가기/);
    else if (status === 403 || status === 404) assert.match(h.text(c), /이용할 수 없어요/);
  }
});
test('auth/unavailable completion failures retain input but require recovery before another submission', async () => {
  for (const status of [401, 403]) {
    const h = fixture(async () => server({ avatarPath: uid + '/' + uid + '.jpg' })), c = h.mount(); await h.flush();
    h.edit(c, 'MBTI · 선택', 'enfp'); await h.flush();
    h.session.complete = async () => { throw new h.ApiError(status, 'AUTHORITY_FAILURE'); };
    h.button(c, '가입 완료').props.onPress(); await h.flush();
    assert.equal(h.button(c, '가입 완료').props.disabled, true);
    assert.equal(h.drafts.signupDraftStore.read(h.scope()).mbti, 'ENFP');
    assert.equal(h.button(c, '다시 불러오기'), undefined);
  }
});
test('both S06 variants render photo label and separate required badge, format help, action, then a plain field error', async () => {
  for (const preview of [true, false]) {
    const h = fixture(async () => server({ avatarPath: uid + '/' + uid + '.jpg' })), c = h.mount(preview); await h.flush();
    if (preview) h.button(c, '가입 완료').props.onPress();
    else { h.session.complete = async () => { throw new h.ApiError(400, 'INVALID_PHOTO'); }; h.button(c, '가입 완료').props.onPress(); }
    await h.flush();
    const all = h.all(c), label = all.findIndex(n => n.type === 'Title' && words(n) === '프로필 사진');
    const badge = all.findIndex(n => n.type === 'Badge' && words(n) === '필수');
    const hint = all.findIndex(n => n.type === 'Body' && /^JPG[·]/.test(words(n)));
    const action = all.findIndex(n => preview ? n.type === 'Pressable' && n.props.accessibilityLabel === '프로필 사진 선택, 필수' : n.type === 'Button' && words(n) === '프로필 사진 선택');
    const error = all.findIndex(n => n.type === 'Body' && (preview ? words(n) === '프로필 사진을 선택해 주세요.' : words(n).startsWith('원본 10MB 이하')));
    assert.ok(label >= 0 && badge > label && hint > badge && action > hint && error > action);
    assert.equal(all.filter(n => n.type === 'Body' && (preview ? words(n) === '프로필 사진을 선택해 주세요.' : words(n).startsWith('원본 10MB 이하'))).length, 1);
    assert.equal(all.some(n => n.type === 'Card' && /프로필 사진을 선택해 주세요[.]|원본 10MB 이하/.test(words(n))), false);
  }
});

test('a later local photo error cannot hide the pending authentication recovery or unblock completion', async () => {
  const h = fixture(async () => server({ avatarPath: uid + '/' + uid + '.jpg' })), c = h.mount(); await h.flush();
  h.session.complete = async () => { throw new h.ApiError(401, 'AUTH_REQUIRED'); };
  h.button(c, '가입 완료').props.onPress(); await h.flush();
  h.picker({ uri: 'blob:invalid-fixture', mimeType: 'image/gif', fileSize: 10 });
  await h.button(c, '프로필 사진 선택').props.onPress(); await h.flush();
  assert.match(h.text(c), /상단 뒤로가기/); assert.match(h.text(c), /원본 10MB 이하/);
  assert.equal(h.button(c, '가입 완료').props.disabled, true);
  assert.equal(h.all(c).filter(n => n.type === 'Body' && /상단 뒤로가기/.test(words(n))).length, 1);
});


test('service signup uses paired optional MBTI choices and blocks partial selection before upload or complete', async () => {
  const h = fixture(async () => server({ mbti: null, avatarPath: uid + '/' + uid + '.jpg' })), c = h.mount(); await h.flush();
  h.all(c).find(n => n.type === 'Chip' && words(n) === 'E').props.onPress(); await h.flush();
  h.button(c, '가입 완료').props.onPress(); await h.flush();
  assert.match(h.text(c), /MBTI를 모두 선택하거나 비워/); assert.equal(h.focusCalls.at(-1), 'S');
  assert.equal(h.counts.complete, 0); assert.equal(h.counts.upload, 0);
  h.all(c).find(n => n.type === 'TextButton' && words(n) === 'MBTI 비우기').props.onPress(); await h.flush();
  h.button(c, '가입 완료').props.onPress(); await h.flush();
  assert.equal(h.counts.complete, 1); assert.match(h.text(c), /가입 프로필을 완성/);
});

test('three signup consent choices default false, bulk selection excludes exploration, and survive same-session reentry', async () => {
  const h = fixture(), c = h.mount(); await h.flush();
  const chip = (screen, text) => h.all(screen).find(n => n.type === 'Chip' && words(n) === text);
  assert.equal(chip(c, '후기 AI 전체 동의').props.selected, false);
  chip(c, '후기 AI 전체 동의').props.onPress(); await h.flush();
  assert.equal(chip(c, '후기 AI 전체 동의').props.selected, true);
  chip(c, '내 프로필 요약 생성·노출').props.onPress(); await h.flush();
  assert.equal(chip(c, '후기 AI 전체 동의').props.selected, false);
  assert.equal(chip(c, '후기 요약 열람').props.selected, true);
  assert.equal(chip(c, '내가 작성한 후기의 요약 활용').props.selected, true);
  h.unmount(c); const returned = h.mount(); await h.flush();
  assert.equal(chip(returned, '후기 요약 열람').props.selected, true);
  assert.equal(chip(returned, '내 프로필 요약 생성·노출').props.selected, false);
  assert.equal(h.consentCalls.length, 0); assert.equal(h.consents.exploration, false);
  const snapshot = h.drafts.signupDraftStore.read(h.scope()); snapshot.summaryConsents.summary_view = false;
  assert.equal(h.drafts.signupDraftStore.read(h.scope()).summaryConsents.summary_view, true);
});

test('successful signup and partial consent save remain separate; manual retry only saves missing choices', async () => {
  const h = fixture(async () => server({ avatarPath: uid + '/' + uid + '.jpg' })), c = h.mount(); await h.flush();
  h.all(c).find(n => n.type === 'Chip' && words(n) === '후기 AI 전체 동의').props.onPress(); await h.flush();
  const setter = h.member.setAiConsent; let failed = false;
  h.member.setAiConsent = async (kind, allowed) => { if (kind === 'summary_generate' && !failed) { failed = true; throw new Error('synthetic partial network failure'); } return setter(kind, allowed); };
  h.button(c, '가입 완료').props.onPress(); await h.flush();
  assert.equal(h.sessionSnapshot().status, 'ready'); assert.equal(h.counts.complete, 1);
  assert.match(h.text(c), /가입 프로필을 완성/); assert.match(h.text(c), /내 프로필 요약 생성·노출 · 미동의/);
  assert.ok(h.button(c, '나중에 설정하고 계속')); assert.equal(h.routes.length, 0);
  assert.deepEqual(h.consentCalls.map(x => x.kind), ['summary_view', 'summary_source']);
  h.button(c, '동의 저장 다시 시도').props.onPress(); await h.flush();
  assert.equal(h.counts.complete, 1); assert.equal(h.counts.upload, 0);
  assert.deepEqual(h.consentCalls.map(x => x.kind), ['summary_view', 'summary_source', 'summary_generate']);
  assert.equal(h.consents.exploration, false); assert.ok(h.button(c, '확인하고 계속'));
  h.button(c, '확인하고 계속').props.onPress(); await h.flush(); assert.deepEqual(h.routes, [['replace', '/']]);
});

test('failed consent readback shows unknown and still permits continuation without repeating signup', async () => {
  const h = fixture(async () => server({ avatarPath: uid + '/' + uid + '.jpg' })), c = h.mount(); await h.flush();
  h.member.aiConsents = async () => { throw new Error('synthetic read failure'); };
  h.button(c, '가입 완료').props.onPress(); await h.flush();
  assert.equal(h.sessionSnapshot().status, 'ready'); assert.match(h.text(c), /후기 요약 열람 · 확인 필요/);
  assert.doesNotMatch(h.text(c), /후기 요약 열람 · 미동의/);
  h.button(c, '나중에 설정하고 계속').props.onPress(); await h.flush();
  assert.equal(h.counts.complete, 1); assert.deepEqual(h.routes, [['replace', '/']]);
});

test('late post-signup consent responses cannot affect a replacement account or show the old completion', async () => {
  const pending = deferred(), h = fixture(async () => server({ avatarPath: uid + '/' + uid + '.jpg' })), c = h.mount(); await h.flush();
  h.member.aiConsents = () => pending.promise;
  h.button(c, '가입 완료').props.onPress(); await h.flush();
  assert.match(h.text(c), /AI 선택 동의 상태를 확인/);
  h.change({ userId: '22222222-2222-4222-8222-222222222222', status: 'completion_required', returnTo: '/', accessToken: 'replacement' }); await h.flush();
  assert.doesNotMatch(h.text(c), /가입 프로필을 완성/);
  pending.resolve({ exploration: false, summary_view: true, summary_generate: true, summary_source: true }); await h.flush();
  assert.doesNotMatch(h.text(c), /가입 프로필을 완성/); assert.equal(h.consentCalls.length, 0); assert.deepEqual(h.routes, []);
});

test('completion popup preserves a failed return target for manual recheck and falls home on confirmed denial', async () => {
  for (const denied of [false, true]) {
    const h = fixture(async () => server({ avatarPath: uid + '/' + uid + '.jpg' }));
    h.change({ ...h.sessionSnapshot(), returnTo: '/post?id=' + uid });
    const c = h.mount(); await h.flush(); let attempts = 0;
    h.service.getPost = async () => { attempts++; if (attempts === 1) throw denied ? new h.ApiError(404, 'NOT_FOUND') : new Error('network'); return {}; };
    h.button(c, '가입 완료').props.onPress(); await h.flush();
    assert.equal(h.routes.length, 0);
    h.button(c, '확인하고 계속').props.onPress(); await h.flush();
    if (denied) assert.deepEqual(h.routes, [['replace', '/']]);
    else { assert.equal(h.routes.length, 0); assert.match(h.text(c), /돌아갈 화면의 현재 상태를 확인하지 못/); h.button(c, '목적 화면 다시 확인').props.onPress(); await h.flush(); assert.deepEqual(h.routes, [['replace', '/post?id=' + uid]]); }
    assert.equal(h.counts.complete, 1);
  }
});


test('a lost signup response reuses its uploaded photo on manual completion retry and preserves selected optional consents', async () => {
  const h = fixture(), c = h.mount(); await h.flush();
  h.picker({ uri: photo.uri, mimeType: photo.mimeType, fileSize: photo.originalBytes });
  await h.button(c, '프로필 사진 선택').props.onPress(); await h.flush();
  h.all(c).find(n => n.type === 'Chip' && words(n) === '후기 요약 열람').props.onPress(); await h.flush();
  h.session.complete = async () => { h.counts.complete++; if (h.counts.complete === 1) throw new Error('synthetic response loss'); return server({ status: 'ready' }); };
  h.button(c, '가입 완료').props.onPress(); await h.flush();
  assert.equal(h.counts.upload, 1); assert.equal(h.counts.complete, 1);
  h.button(c, '가입 완료').props.onPress(); await h.flush();
  assert.equal(h.counts.upload, 1); assert.equal(h.counts.complete, 2);
  assert.deepEqual(h.consentCalls, [{ kind: 'summary_view', allowed: true }]);
  assert.match(h.text(c), /후기 요약 열람 · 동의/);
});
