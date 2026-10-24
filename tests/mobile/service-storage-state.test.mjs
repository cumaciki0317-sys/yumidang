// Actual storage controller and AppProvider, with an in-memory device and synthetic session.
// No OAuth, real member, server, provider or native device is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import test from 'node:test';

const appRoot = path.resolve(import.meta.dirname, '../../apps/mobile');
const ts = createRequire(path.join(appRoot, 'package.json'))('typescript');
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = Date.parse('2026-10-24T09:00:00Z'), DAY = 86400000;
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function device(existing = new Map()) {
  const values = existing, calls = [], controls = { failRead: false, failWrite: false, failDelete: false, beforeSet: null, beforeGet: null };
  const backend = {
    async getItem(key) { calls.push(['get', key]); await controls.beforeGet?.(key); if (controls.failRead) throw new Error('synthetic read'); return values.get(key) ?? null; },
    async setItem(key, value) { calls.push(['set', key]); await controls.beforeSet?.(key, value); if (controls.failWrite) throw new Error('synthetic write'); values.set(key, value); },
    async removeItem(key) { calls.push(['remove', key]); if (controls.failDelete) throw new Error('synthetic delete'); values.delete(key); },
    async multiRemove(keys) { calls.push(['multiRemove', keys]); if (controls.failDelete) throw new Error('synthetic delete'); for (const key of keys) values.delete(key); },
  };
  return { backend, values, calls, controls };
}
function environment(options = {}) {
  const disk = options.disk ?? device();
  let now = options.now ?? NOW, details = { userId: A }, epoch = 4, authenticated = true;
  let slots = [], cursor = 0, dirty = true, tree, effects = [], intervalCallback = null;
  const routes = [], cache = new Map();
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    createContext: () => ({ Provider: 'Provider' }), createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), useContext: () => null,
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], next => { const result = typeof next === 'function' ? next(slots[index]) : next; if (!Object.is(result, slots[index])) { slots[index] = result; dirty = true; } }]; },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
    useCallback(fn, deps) { const index = cursor++; if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { deps, fn }; return slots[index].fn; },
    useEffect(create, deps) { const index = cursor++; if (!slots[index] || !same(slots[index].deps, deps)) { const previous = slots[index]; slots[index] = { deps, cleanup: previous?.cleanup }; effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = create(); }); } },
  };
  const remote = {
    serviceMode: true, useServiceSession: () => ({ epoch, authenticated }), serviceSessionEpoch: () => epoch,
    memberSessionDetailsSnapshot: () => details,
    installServiceSession() { details = null; authenticated = false; epoch++; dirty = true; },
  };
  class Clock extends Date { static now() { return now; } }
  function load(relative) {
    const absolute = path.resolve(appRoot, 'src', relative);
    if (cache.has(absolute)) return cache.get(absolute);
    const exports = {}; cache.set(absolute, exports);
    const js = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(js, {
      exports, Date: Clock, Map, Set, Intl, URL, AbortController, TextEncoder, setInterval: callback => { intervalCallback = callback; return 0; }, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
      require(id) {
        if (id === 'react') return react;
        if (id === '@react-native-async-storage/async-storage') return disk.backend;
        if (id === './remote') return remote;
        if (id === 'expo-router') return { router: { push(route) { routes.push(route); }, replace(route) { routes.push(route); }, canGoBack: () => false }, usePathname: () => '/create', useGlobalSearchParams: () => ({}) };
        let target = path.relative(path.join(appRoot, 'src'), path.resolve(path.dirname(absolute), id));
        if (!path.extname(target)) target += fs.existsSync(path.join(appRoot, 'src', target + '.ts')) ? '.ts' : '.tsx';
        return load(target);
      },
    });
    return exports;
  }
  const storage = load('storage.ts'), store = storage.serviceDeviceStore, data = load('data.ts');
  let provider;
  const render = () => { cursor = 0; dirty = false; tree = provider.AppProvider({ children: null }); const run = effects; effects = []; for (const effect of run) effect(); };
  return {
    disk, storage, store, routes, load, remote,
    draft: patch => ({ ...data.emptyDraft(now), title: '합성 공고', serviceDraftEpoch: epoch, ...patch }),
    async ready(userId = A, selectedEpoch = 4) { store.activate(userId, selectedEpoch); for (let i=0;i<10 && store.snapshot().status==='loading';i++) await tick(); return store.lease(); },
    async mount() { provider = load('state.tsx'); await this.flush(); },
    async flush() { for (let i = 0; i < 25; i++) { if (provider && dirty) render(); await tick(); if (!dirty) return; } throw new Error('render loop'); },
    get app() { return tree.props.value; },
    session(userId) { details = userId ? { userId } : null; authenticated = !!userId; epoch++; dirty = true; },
    time(value) { now = value; intervalCallback?.(); dirty = true; },
    get epoch() { return epoch; },
  };
}
const serviceDraftKey = userId => `yumidang:service:v1:${userId}:draft`;

test('restart restores only current service owner; preview and guest never migrate', async () => {
  const e = environment(); const lease = await e.ready();
  await e.storage.saveDraft('anonymous', e.draft({ title: '프리뷰 원본' }));
  await e.store.saveDraft(lease, e.draft({ title: '회원 A', eventId: B, eventSectionPosition: 'top' }));
  await e.store.addSearch(lease, '회원 검색');
  e.store.activate(null, 5); await tick(); await e.store.addSearch(e.store.lease(), '비회원 검색');
  const restart = environment({ disk: e.disk }); await restart.ready(B, 100);
  assert.equal(restart.store.snapshot().draft, null); assert.deepEqual(Array.from(restart.store.snapshot().recentSearches), []);
  await restart.ready(A, 101);
  assert.equal(restart.store.snapshot().draft.title, '회원 A'); assert.equal(restart.store.snapshot().draft.serviceDraftEpoch, 101);
  assert.equal(restart.store.snapshot().draft.eventId, B); assert.equal(restart.store.snapshot().recentSearches[0].text, '회원 검색');
  const stored = JSON.parse(e.disk.values.get(serviceDraftKey(A)));
  assert.equal('serviceDraftEpoch' in stored.draft, false); assert.equal('serviceDraftRevision' in stored.draft, false);
  assert.equal((await e.storage.loadDraft('anonymous')).title, '프리뷰 원본');
});

test('ten recent searches, duplicate order and exact seven-day expiry use device timestamps', async () => {
  const e = environment(), lease = await e.ready();
  for (let i = 0; i < 12; i++) { e.time(NOW + i); await e.store.addSearch(lease, `검색 ${i}`); }
  e.time(NOW + 20); await Promise.all([e.store.addSearch(lease, '먼저'), e.store.addSearch(lease, '나중')]);
  assert.equal(e.store.snapshot().recentSearches.length, 10); assert.equal(e.store.snapshot().recentSearches[0].text, '나중'); assert.equal(e.store.snapshot().recentSearches[1].text, '먼저');
  await e.store.addSearch(lease, '검색 11'); assert.equal(e.store.snapshot().recentSearches.filter(item => item.text === '검색 11').length, 1);
  await e.store.saveDraft(lease, e.draft());
  e.time(NOW + 20 + 7 * DAY); await e.store.retryLoad();
  assert.equal(e.store.snapshot().draft, null); assert.equal(e.store.snapshot().recentSearches.length, 0);
});

test('failed hydration performs no write and rejects writes; explicit retry can recover preserved draft', async () => {
  const e = environment(), lease = await e.ready(); await e.store.saveDraft(lease, e.draft());
  const before = new Map(e.disk.values); e.disk.calls.length = 0; e.disk.controls.failRead = true;
  await e.store.retryLoad(); assert.equal(e.store.snapshot().status, 'error');
  await assert.rejects(e.store.saveDraft(e.store.lease(), e.draft({ title: '덮어쓰기 금지' })));
  assert.equal(e.disk.calls.every(call => call[0] === 'get'), true); assert.deepEqual(e.disk.values, before);
  e.disk.controls.failRead = false; await e.store.retryLoad(); assert.equal(e.store.snapshot().draft.title, '합성 공고');
});

test('loading blocks a save and a late old-account read never replaces the new account', async () => {
  const e = environment(), gate = deferred();
  e.disk.controls.beforeGet = key => key.includes(A) ? gate.promise : undefined;
  e.store.activate(A, 1);
  await assert.rejects(e.store.saveDraft(e.store.lease(), e.draft()));
  e.store.activate(B, 2); await tick(); await e.store.saveDraft(e.store.lease(), e.draft({ title: '회원 B' }));
  gate.resolve(); await tick(); assert.equal(e.store.snapshot().draft.title, '회원 B'); assert.equal(e.store.lease().userId, B);
});

test('optional manual/event/edit metadata is checked and authority/unknown fields cannot persist', async () => {
  const e = environment(), lease = await e.ready();
  const draft = e.draft({ manualEvent: { title: '합성 행사', placeName: '', publicAddress: '', publicAddressConfirmed: false }, editingPostId: B, serviceExpectedUpdatedAt: '2026-10-24T00:00:00Z' });
  await e.store.saveDraft(lease, draft); await e.store.retryLoad(); assert.equal(e.store.snapshot().draft.manualEvent.title, '합성 행사');
  for (const patch of [{ eventId: 'not-a-uuid' }, { editingPostId: 3 }, { eventSectionPosition: 'other' }, { serviceExpectedUpdatedAt: 'bad' }, { serviceExpectedUpdatedAt: '1' }, { manualEvent: { title: '불완전' } }, { privateToken: 'never-store' }]) {
    await assert.rejects(e.store.saveDraft(e.store.lease(), { ...e.draft(), ...patch }));
  }
  assert.equal([...e.disk.values.values()].some(value => value.includes('never-store')), false);
});

test('successful publish cleanup fences a delayed save and restart never restores its cancelled revision', async () => {
  const e = environment(), lease = await e.ready(); await e.store.saveDraft(lease, e.draft());
  const publishedRevision = e.store.snapshot().draft.serviceDraftRevision, gate = deferred(); let delayed = false;
  e.disk.controls.beforeSet = key => { if (!delayed && key.endsWith(':draft')) { delayed = true; return gate.promise; } };
  const lateSave = e.store.saveDraft(lease, e.draft({ title: '늦은 저장' })); await tick();
  const rejected = assert.rejects(lateSave), cleanup = e.store.clearDraft(lease, publishedRevision);
  gate.resolve(); await rejected; await cleanup;
  await assert.rejects(e.store.saveDraft(lease, e.draft()));
  const restart = environment({ disk: e.disk }); await restart.ready(); assert.equal(restart.store.snapshot().draft, null);
});

test('a newer acknowledged draft survives cleanup of an older published revision', async () => {
  const e = environment(), lease = await e.ready(); await e.store.saveDraft(lease, e.draft()); const old = e.store.snapshot().draft.serviceDraftRevision;
  await e.store.saveDraft(lease, e.draft({ title: '새 초안' })); await e.store.clearDraft(lease, old);
  assert.equal(e.store.snapshot().draft.title, '새 초안');
});

test('publish cleanup failure hides the draft and a manual cleanup only deletes device data', async () => {
  const e = environment(), lease = await e.ready(); await e.store.saveDraft(lease, e.draft());
  e.disk.controls.failDelete = true; await assert.rejects(e.store.clearDraft(lease));
  assert.equal(e.store.snapshot().draft, null); assert.equal(e.store.snapshot().draftCleanupPending, true);
  const restart = environment({ disk: e.disk }); await restart.ready(); assert.equal(restart.store.snapshot().draft, null); assert.equal(restart.store.snapshot().draftCleanupPending, true);
  e.disk.controls.failDelete = false; await restart.store.retryDraftCleanup(restart.store.lease());
  assert.equal(restart.store.snapshot().draftCleanupPending, false); assert.equal(e.disk.values.has(serviceDraftKey(A)), false);
});

test('explicit owner cleanup cannot be undone by in-flight writes; a failed cleanup blocks next login', async () => {
  const e = environment(), lease = await e.ready(); await e.store.saveDraft(lease, e.draft()); await e.store.addSearch(lease, '회원 A');
  const gate = deferred(); let delayed = false;
  e.disk.controls.beforeSet = key => { if (!delayed && key.endsWith(':draft')) { delayed = true; return gate.promise; } };
  const lateSave = e.store.saveDraft(lease, e.draft({ title: '뒤늦은 쓰기' })); await tick(); const rejected = assert.rejects(lateSave);
  e.store.invalidate(A); const cleanup = e.store.clearOwner(A); gate.resolve(); await rejected; await cleanup;
  assert.equal([...e.disk.values.keys()].some(key => key.includes(A)), false);
  e.store.activate(A, 50); await tick(); await e.store.saveDraft(e.store.lease(), e.draft());
  e.disk.controls.failDelete = true; await assert.rejects(e.store.clearOwner(A));
  const restart = environment({ disk: e.disk }); await restart.ready(A, 51);
  assert.equal(restart.store.snapshot().status, 'cleanup-required'); assert.equal(restart.store.snapshot().draft, null);
  e.disk.controls.failDelete = false; await restart.store.clearOwner(A); restart.store.activate(A, 52); await tick(); assert.equal(restart.store.snapshot().draft, null);
});

test('actual AppProvider binds service UUID and remembers it after auth loss for logout cleanup', async () => {
  const e = environment(); await e.mount();
  await e.app.saveDraft(e.draft()); e.app.addSearch('실제 상태 연결'); await e.flush();
  assert.equal(e.app.draft.title, '합성 공고'); assert.equal(e.app.recentSearches[0].text, '실제 상태 연결');
  e.session(null); await e.flush(); assert.equal(e.app.draft, null); assert.equal(e.app.recentSearches.length, 0);
  await e.app.logout(); await e.flush(); assert.equal(e.disk.values.has(serviceDraftKey(A)), false);
  e.session(A); await e.flush(); assert.equal(e.app.draft, null);
});

test('actual AppProvider never reports save success before hydration or after a device write failure', async () => {
  const disk = device(), gate = deferred(); disk.controls.beforeGet = () => gate.promise;
  const e = environment({ disk }); await e.mount();
  await assert.rejects(e.app.saveDraft(e.draft())); assert.equal(e.app.draft, null);
  gate.resolve(); disk.controls.beforeGet = null; await e.flush();
  disk.controls.failWrite = true; await assert.rejects(e.app.saveDraft(e.draft())); assert.equal(e.app.draft, null);
});

function screenHarness(e, kind) {
  let slots = [], cursor = 0, dirty = true, value;
  const actions = [], requests = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; dirty = true; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useMemo: fn => fn(),
  };
  const uiNames = ['Artwork', 'Badge', 'Body', 'Button', 'Card', 'Chip', 'Divider', 'Empty', 'EventCard', 'Field', 'Icon', 'MemberBox', 'PostCard', 'Row', 'Screen', 'Section', 'TextButton', 'Title'];
  const ui = { ...Object.fromEntries(uiNames.map(name => [name, name])), colors: {}, dateLabel: () => '날짜', timeLabel: () => '시각', rangeLabel: () => '일정' };
  const focus = { focusTarget() {}, setEnabled() {} };
  const module = {};
  const js = ts.transpileModule(fs.readFileSync(path.join(appRoot, 'src/screens/BrowseScreens.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js + '\nexports.testCreate=CreateForm;exports.testPublish=PublishForm;', {
    exports: module, Date, Intl, Map, Set,
    require(id) {
      if (id === 'react') return react;
      if (id === 'react-native') return { StyleSheet: { create: styles => styles }, View: 'View', Text: 'Text', Pressable: 'Pressable', Modal: 'Modal', ScrollView: 'ScrollView' };
      if (id === 'expo-crypto') return { randomUUID: () => B };
      if (id === '../state') return { useApp: () => e.app };
      if (id === '../remote') return e.remote;
      if (id === '../ui') return ui;
      if (id === './RemoteMemberScreens') return { useMemberAction: () => ({ busy: false, run(operation, success) { const task = (async () => { const result = await operation({ create: async (...args) => { requests.push(args); return { id: B }; } }, new AbortController().signal); success(result); })(); actions.push(task); return task; } }) };
      if (id === './RemoteScreens') return { useRemoteEventSource: () => ({ event: null }) };
      if (id === '../presentation/ux-form') return { FormErrors: 'FormErrors', FormErrorTarget: 'FormErrorTarget', useFormErrors: () => ({ focusFirstError() {} }), useUxFocus: () => focus, createUxFocusController: () => focus };
      if (id === '../presentation/ux-modal-sheet') return { UxModalSheet: 'UxModalSheet' };
      if (id === './RemotePlacePicker') return 'RemotePlacePicker';
      return e.load(path.relative(path.join(appRoot, 'src'), path.resolve(appRoot, 'src/screens', id)) + '.ts');
    },
  });
  const nodes = node => { const found = []; function walk(value) { if (Array.isArray(value)) { value.forEach(walk); return; } if (!value || typeof value !== 'object') return; if ('type' in value) { found.push(value); walk(value.props?.children); walk(value.props?.footer); } } walk(node); return found; };
  const text = node => nodes(node).filter(item => ['Body', 'Button', 'TextButton', 'Title'].includes(item.type)).map(item => item.props.children.flat(Infinity).filter(value => typeof value === 'string').join('')).join('');
  const render = () => { dirty = true; for (let i = 0; dirty && i < 15; i++) { dirty = false; cursor = 0; value = kind === 'create' ? module.testCreate({}) : module.testPublish(); } if (dirty) throw new Error('screen render loop'); };
  render();
  return { render, nodes: () => nodes(value), requests, actions, text: () => text(value), get value() { return value; }, find: predicate => nodes(value).find(predicate) };
}

test('actual create screen preserves typed input through hydration and restores only after explicit choice', async () => {
  const seed = environment(), lease = await seed.ready(); await seed.store.saveDraft(lease, seed.draft({ title: '저장된 예전 초안' }));
  const gate = deferred(); seed.disk.controls.beforeGet = () => gate.promise;
  const e = environment({ disk: seed.disk }); await e.mount(); const screen = screenHarness(e, 'create');
  let title = screen.find(node => node.type === 'Field' && node.props.label?.includes('제목'));
  title.props.onChangeText('현재 화면에서 작성 중'); screen.render();
  gate.resolve(); seed.disk.controls.beforeGet = null; await e.flush(); screen.render();
  title = screen.find(node => node.type === 'Field' && node.props.label?.includes('제목'));
  assert.equal(title.props.value, '현재 화면에서 작성 중');
  const restore = screen.find(node => node.props?.title === '작성 중이던 공고가 있어요'); assert.ok(restore);
  restore.props.onConfirm(); screen.render();
  assert.equal(screen.find(node => node.type === 'Field' && node.props.label?.includes('제목')).props.value, '저장된 예전 초안');
});

test('actual publish success remains success when device cleanup fails and retry never republishes', async () => {
  const e = environment(); await e.mount(); await e.app.saveDraft(e.draft({ introduction: '함께 관람할 합성 안내', placeName: '공개 문화관', publicArea: '서울 종로구', address: '서울 종로구 세종대로 175' })); await e.flush();
  const screen = screenHarness(e, 'publish'); screen.find(node => node.type === 'Pressable' && node.props.accessibilityRole === 'checkbox').props.onPress(); screen.render();
  e.disk.controls.failDelete = true;
  screen.find(node => node.type === 'Button' && node.props.children.includes('공고 등록하기')).props.onPress();
  await Promise.all(screen.actions); await e.flush();
  assert.equal(screen.requests.length, 1); assert.equal(e.routes.at(-1).pathname, '/post'); assert.equal(e.routes.at(-1).params.id, B);
  assert.equal(e.app.draft, null); assert.equal(e.app.deviceStorage.draftCleanupPending, true); assert.match(e.app.toast, /공고는 등록됐지만/);
  e.disk.controls.failDelete = false; await e.app.retryDraftCleanup(); await e.flush(); assert.equal(e.app.deviceStorage.draftCleanupPending, false); assert.equal(screen.requests.length, 1);
});

test('a cleanup marker after restart offers actual owner cleanup without the previous process queue', async () => {
  const seed = environment(), lease = await seed.ready(); await seed.store.saveDraft(lease, seed.draft());
  seed.disk.controls.failDelete = true; await assert.rejects(seed.store.clearOwner(A));
  const e = environment({ disk: seed.disk }); await e.mount(); assert.equal(e.app.deviceStorage.status, 'cleanup-required');
  seed.disk.controls.failDelete = false; await e.app.retryDeviceStorage(); await e.flush();
  assert.equal(e.app.deviceStorage.status, 'ready'); assert.equal(e.app.draft, null); assert.equal(seed.disk.values.has(serviceDraftKey(A)), false);
});

test('same-owner storage recheck does not prevent an exact published revision from being cleared', async () => {
  const e = environment(), lease = await e.ready(); await e.store.saveDraft(lease, e.draft());
  const revision = e.store.snapshot().draft.serviceDraftRevision;
  await e.store.retryLoad(); await e.store.clearDraft(lease, revision);
  assert.equal(e.disk.values.has(serviceDraftKey(A)), false); assert.equal(e.store.snapshot().draft, null);
});

test('an open Provider stops offering expired saved drafts and searches at the exact 7-day boundary without reloading',async()=>{
 const e=environment();await e.mount();await e.app.saveDraft(e.draft());e.app.addSearch('기한 경계');await e.flush();
 e.time(NOW+7*DAY-1);await e.flush();assert.ok(e.app.draft);assert.equal(e.app.recentSearches.length,1);
 e.time(NOW+7*DAY);await e.flush();assert.equal(e.app.draft,null);assert.deepEqual(Array.from(e.app.recentSearches),[]);
});
test('a successful restart read removes expired service records from the device',async()=>{
 const e=environment(),lease=await e.ready();await e.store.saveDraft(lease,e.draft());await e.store.addSearch(lease,'삭제될 검색');
 const restarted=environment({disk:e.disk,now:NOW+7*DAY});await restarted.ready();
 assert.equal(restarted.store.snapshot().draft,null);assert.equal(e.disk.values.has(serviceDraftKey(A)),false);assert.equal(e.disk.values.has('yumidang:service:v1:'+A+':searches'),false);
});
