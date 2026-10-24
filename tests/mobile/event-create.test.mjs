// Actual PublishForm and event editor with synthetic ports only. No external calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '../../apps/mobile');
const ts = createRequire(path.join(root, 'package.json'))('typescript');
const EVENT = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-10-24T00:00:00Z');
const manual = { title: '합성 취미 공연', placeName: '', publicAddress: '', publicAddressConfirmed: false };
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const nodes = v => Array.isArray(v) ? v.flatMap(nodes) : v && typeof v === 'object' ? [v, ...nodes(v.props?.children), ...nodes(v.props?.footer)] : [];
const words = v => Array.isArray(v) ? v.map(words).join('') : typeof v === 'string' ? v : v && typeof v === 'object' ? words(v.props?.children) : '';
function fixture(patch = {}) {
  let epoch = 1, n = 0, slots = [], cursor = 0, tree, error = '', busy = false;
  const requests = [], reads = [], routes = [], clears = [], pending = [], toasts = [];
  const controls = { getEvent: async () => ({ id: EVENT, sourceStatus: 'active', state: 'upcoming', title: '합성 행사' }), create: async () => ({ postId: 'ok', alreadyCreated: false }) };
  const react = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], v => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; }, useMemo: fn => fn() };
  const app = { now: NOW, events: [], member: null, deviceStorage: { status: 'ready', draftCleanupPending: false }, showToast: v => toasts.push(v), navigate: (...v) => routes.push(v), clearDraft: async v => clears.push(v), saveDraft: async () => {} };
  const remote = { serviceMode: true, useServiceSession: () => ({ authenticated: true, epoch }), serviceSessionEpoch: () => epoch, useService: () => ({ getEvent: async (...v) => { reads.push(v); return controls.getEvent(...v); } }) };
  const ui = new Proxy({ colors: {}, dateLabel: () => '날짜', timeLabel: () => '시각', rangeLabel: () => '일정' }, { get: (o,k) => o[k] ?? k });
  const action = { get busy() { return busy; }, get error() { return error; }, run(op, done) { if (busy) return false; busy = true; const captured = epoch; const p = (async () => { try { const result = await op({ create: async (...v) => { requests.push(v); return controls.create(...v); } }, new AbortController().signal); if (captured === epoch) done(result); } catch { error = '등록 실패'; } finally { busy = false; } })(); pending.push(p); return p; } };
  const cache = new Map();
  function load(file) {
    file = path.resolve(file); if (!fs.existsSync(file)) file += '.ts'; if (cache.has(file)) return cache.get(file);
    const out = {}; cache.set(file, out);
    let source = fs.readFileSync(file, 'utf8'); if (file.endsWith('BrowseScreens.tsx')) source += '\nexport { PublishForm };';
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(js, { exports: out, Date, Intl, Map, Set, URL, AbortController, TextEncoder, setTimeout, clearTimeout, require(id) {
      if (id === 'react') return react;
      if (id === 'react-native') return { StyleSheet: { create: x => x }, View: 'View', Text: 'Text', Pressable: 'Pressable', Modal: 'Modal', ScrollView: 'ScrollView' };
      if (id === 'expo-crypto') return { randomUUID: () => `11111111-1111-4111-8111-${String(++n).padStart(12,'0')}` };
      if (id.endsWith('/remote')) return remote;
      if (id.endsWith('/state')) return { useApp: () => app };
      if (id.endsWith('/ui')) return ui;
      if (id.endsWith('/RemoteMemberScreens')) return { useMemberAction: () => action };
      if (id.endsWith('/RemoteScreens')) return { useRemoteEventSource: () => ({ event: null }), RemoteEventPicker: 'RemoteEventPicker' };
      if (id.endsWith('/RemotePlacePicker')) return { __esModule: true, default: 'RemotePlacePicker' };
      if (id.includes('/ux-form') || id.includes('/ux-modal-sheet')) return {};
      return load(path.resolve(path.dirname(file), id));
    } }); return out;
  }
  const data = load(path.join(root, 'src/data.ts'));
  app.draft = { ...data.emptyDraft(NOW), title: '합성 동행 공고', introduction: '함께 공연을 관람해요', category: '공연', publicArea: '서울 종로구', placeName: '공개 문화관', address: '서울 종로구 세종대로 175', serviceDraftEpoch: 1, serviceDraftRevision: 'revision', ...patch };
  const screen = load(path.join(root, 'src/screens/BrowseScreens.tsx'));
  let renderFn = () => screen.PublishForm();
  const render = () => { cursor = 0; tree = renderFn(); };
  render();
  const button = label => nodes(tree).find(v => v.type === 'Button' && words(v) === label);
  return { app, controls, requests, reads, routes, clears, toasts, load, render, button,
    text: () => words(tree), all: () => nodes(tree),
    async flush() { await Promise.all(pending); render(); },
    confirm() { nodes(tree).find(v => v.type === 'Pressable' && v.props.accessibilityRole === 'checkbox').props.onPress(); render(); },
    submit() { button('공고 등록하기').props.onPress(); },
    changeEpoch() { epoch++; },
    editor(value, onChange, disabled = false) { slots = []; const component = load(path.join(root,'src/screens/RemoteEventEditor.tsx')); renderFn = () => component.RemoteEventEditor({value,onChange,disabled}); render(); },
  };
}

test('manual create sends normalized private event with no source link and cleans only after saved receipt', async () => {
  const h = fixture({ manualEvent: { ...manual, title: '  합성 취미 공연  ' } }); h.confirm(); h.submit(); await h.flush();
  assert.equal(h.requests.length, 1); assert.equal(h.reads.length, 0);
  assert.equal(h.requests[0][1].manualEvent.title, manual.title); assert.equal('eventId' in h.requests[0][1], false);
  assert.deepEqual(h.clears, ['revision']); assert.equal(h.routes[0][0], 'S02');
});
test('inspection failure preserves draft and explicit retry retains same post ID and input', async () => {
  const h = fixture({ manualEvent: manual }); h.controls.create = async () => { throw new Error('inspection unavailable'); }; h.confirm(); h.submit(); await h.flush();
  assert.equal(h.clears.length, 0); assert.equal(h.routes.length, 0); assert.match(h.text(), /검사를 건너뛰어 등록하지/);
  h.submit(); await h.flush(); assert.equal(h.requests.length, 2); assert.equal(h.requests[0][0], h.requests[1][0]);
  assert.equal(JSON.stringify(h.requests[0][1]), JSON.stringify(h.requests[1][1])); assert.equal(h.app.draft.manualEvent.title, manual.title);
});
test('source registration rechecks current server event before sending, without meeting overlap filtering', async () => {
  const h = fixture({ eventId: EVENT }); h.confirm(); h.submit(); await h.flush();
  assert.equal(h.reads.length,1); assert.equal(h.reads[0][0],EVENT); assert.equal(h.requests.length,1); assert.equal(h.requests[0][1].eventId,EVENT);
});
test('source cancellation or fetch failure prevents creation and offers explicit correction', async () => {
  for (const getEvent of [async () => ({ sourceStatus:'cancelled', state:'upcoming' }), async () => { throw new Error('network'); }]) {
    const h = fixture({ eventId: EVENT }); h.controls.getEvent=getEvent; h.confirm(); h.submit(); await h.flush();
    assert.equal(h.requests.length,0); assert.equal(h.clears.length,0); assert.equal(h.app.draft.eventId,EVENT); assert.match(h.text(), /입력은 유지돼요/);
    assert.ok(h.all().find(v=>v.type==='TextButton'&&words(v)==='행사 연결 수정·삭제'));
  }
});
test('late event read after account change cannot submit old draft', async () => {
  const wait=deferred(), h=fixture({eventId:EVENT}); h.controls.getEvent=()=>wait.promise; h.confirm(); h.submit(); h.changeEpoch(); wait.resolve({sourceStatus:'active',state:'upcoming'}); await h.flush();
  assert.equal(h.requests.length,0); assert.equal(h.clears.length,0);
});
test('stale submit handler after account change does not start a request', async () => {
  const h=fixture({manualEvent:manual});h.confirm();const old=h.button('공고 등록하기').props.onPress;h.changeEpoch();old();await h.flush();assert.equal(h.requests.length,0);
});
test('manual validation matches length limits and rejects extra keys and controls', () => {
  const h=fixture(), validation=h.load(path.join(root,'src/presentation/events/event-draft.ts'));
  for(const value of [{...manual,title:'가'.repeat(201)},{...manual,placeName:'가'.repeat(201)},{...manual,publicAddress:'가'.repeat(301),publicAddressConfirmed:true},{...manual,title:'합성\n공연'},{...manual,unknown:'field'}]) assert.ok(validation.manualEventError(value));
  assert.equal(validation.manualEventError({...manual,title:'가'.repeat(200)}),null);
});
test('reusable editor keeps direct-input edits local until confirmed and emits explicit replacement', () => {
  const h=fixture(), changes=[]; h.editor({eventId:EVENT}, value=>changes.push(value));h.button('직접 입력').props.onPress();h.render();
  h.all().find(v=>v.type==='Field'&&v.props.label==='행사명 *').props.onChangeText('수정한 합성 행사');h.render();assert.equal(changes.length,0);
  h.button('이 공고에 연결').props.onPress();h.render();assert.equal(changes[0].eventId,null);assert.equal(changes[0].manualEvent.title,'수정한 합성 행사');
});


test('same dispatched source intent resolves original receipt without a new event-state gate', async () => {
  const h = fixture({ eventId: EVENT }); let dispatched = 0;
  h.controls.create = async () => { if (++dispatched === 1) throw new Error('lost response'); return { postId: 'ok', alreadyCreated: true }; };
  h.confirm(); h.submit(); await h.flush(); assert.equal(h.reads.length, 1); assert.equal(h.requests.length, 1); assert.equal(h.clears.length, 0);
  h.controls.getEvent = async () => ({ sourceStatus: 'cancelled', state: 'ended' });
  h.submit(); await h.flush(); assert.equal(h.reads.length, 1); assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0][0], h.requests[1][0]); assert.equal(JSON.stringify(h.requests[0][1]), JSON.stringify(h.requests[1][1])); assert.deepEqual(h.clears, ['revision']);
});
test('failed preflight remains undispatched and must recheck the event on explicit retry', async () => {
  const h = fixture({ eventId: EVENT }); h.controls.getEvent = async () => { throw new Error('network'); };
  h.confirm(); h.submit(); await h.flush(); assert.equal(h.requests.length, 0);
  h.controls.getEvent = async () => ({ sourceStatus: 'active', state: 'upcoming' }); h.submit(); await h.flush();
  assert.equal(h.reads.length, 2); assert.equal(h.requests.length, 1);
});
test('manual inspection block and unavailable responses have different recovery guidance', async () => {
  for (const [code, expected] of [['CONTENT_BLOCKED', /내용을 수정한 뒤/], ['CONTENT_INSPECTION_UNAVAILABLE', /검사 서비스를 확인하지 못했어요/]]) {
    const h = fixture({ manualEvent: manual }), { ApiError } = h.load(path.join(root, 'src/api.ts'));
    h.controls.create = async () => { throw new ApiError(503, code); }; h.confirm(); h.submit(); await h.flush();
    assert.match(h.text(), expected); assert.equal(h.clears.length, 0); assert.equal(h.routes.length, 0);
  }
});
