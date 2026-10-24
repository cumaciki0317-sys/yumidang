import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

// Execute production TSX, read dispatcher and retirement store. React/native layout
// and transport are controlled here; these cases are not device/server evidence.
const appRoot = path.resolve(import.meta.dirname, '../../apps/mobile');
const ts = createRequire(path.join(appRoot, 'package.json'))('typescript');
const source = process.env.ACCESS_SCREEN_SOURCE || path.join(appRoot, 'src/screens/RemoteMemberScreens.tsx');
const uid = '11111111-1111-4111-8111-111111111111';
const id = n => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;
const room = id(1);
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const children = v => Array.isArray(v) ? v.flatMap(children) : v && typeof v === 'object' ? [v, ...children(v.props?.children), ...children(v.props?.footer), ...children(v.props?.right), ...children(v.props?.ListHeaderComponent), ...children(v.props?.ListFooterComponent)] : [];
const words = v => Array.isArray(v) ? v.map(words).join('') : typeof v === 'string' ? v : v && typeof v === 'object' ? words(v.props?.children) : '';
const ui = Object.fromEntries(['Body', 'Button', 'Card', 'Chip', 'Empty', 'Field', 'Row', 'Screen', 'TextButton', 'Title'].map(x => [x, x]));
function harness(kind = 'chat', options = {}) {
  const slots = [], effects = [], readCalls = [], retired = [], navigations = [], cleanupListeners = new Set();
  let cursor = 0, dirty = false, focused = true, value, epoch = 1, authenticated = true, readPort, cleanup = null, serial = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  function effect(create, deps, focus = false) {
    const i = cursor++, before = slots[i];
    if (!before || !same(before.deps, deps)) effects.push(() => { before?.cleanup?.(); const row = { deps, create, focus }; slots[i] = row; if (!focus || focused) row.cleanup = create(); });
  }
  const React = {
    createElement(type, props, ...nested) { return { type, props: { ...props, children: nested } }; },
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], next => { const v = typeof next === 'function' ? next(slots[i]) : next; if (!Object.is(v, slots[i])) { slots[i] = v; dirty = true; } }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useCallback(fn, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { fn, deps }; return slots[i].fn; },
    useEffect(create, deps) { effect(create, deps); },
    useLayoutEffect(create, deps) { effect(create, deps); },
    useSyncExternalStore(subscribe, get) { const [, set] = React.useState(0); React.useEffect(() => subscribe(() => set(n => n + 1)), [subscribe]); return get(); },
  };
  const compile = (file, require, tail = '') => {
    const out = {};
    const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(code + tail, { exports: out, require, AbortController, DOMException, Date, Intl, Map, Set, URL, TextEncoder, setTimeout, clearTimeout, queueMicrotask, console, process: { env: { EXPO_PUBLIC_DATA_MODE: 'service', EXPO_PUBLIC_SERVICE_API_URL: 'https://project.example/functions/v1/service-api' } } });
    return out;
  };
  const api = compile(path.join(appRoot, 'src/api.ts'), () => ({}));
  const member = compile(path.join(appRoot, 'src/member-service.ts'), () => api);
  const session = compile(path.join(appRoot, 'src/member-session.ts'), p => p === './api.ts' ? api : member);
  const dispatcher = compile(path.join(appRoot, 'src/chat-read-state.ts'), () => ({}));
  const service = {
    profile: async () => ({ userId: uid }), conversation: async () => ({ request_id: room, can_send: true, my_role: 'requester' }),
    messages: async () => ({ items: [{ messageId: id(2), content: 'received-private-message', senderId: id(3) }], nextCursor: null }), consent: async () => null,
    safety: async () => ({}), blocks: async () => ({ items: [], nextCursor: null }), reports: async () => ({ items: [], nextCursor: null }), hiddenTargets: async () => ({ items: [], nextCursor: null }),
  };
  const device = {
    async requestMemberDeviceCleanup() {},
    memberDeviceCleanupSnapshot: () => cleanup,
    subscribeMemberDeviceCleanup(listener) { cleanupListeners.add(listener); return () => cleanupListeners.delete(listener); },
    async retryMemberDeviceCleanup() { cleanup = { busy: false, failed: false }; cleanupListeners.forEach(f => f()); },
  };
  const rootRemote = compile(path.join(appRoot, 'src/remote.tsx'), p => {
    if (p === 'react') return React;
    if (p === './signup-draft') return { observeSignupDraftSession() {} };
    if (p === './service') return { YumidangService: class {} };
    if (p === './api') return api;
    if (p === './member-device-cleanup') return device;
    if (p === './member-service') return { ...member, MemberService: class { constructor() { return service; } } };
    if (p === './member-session') return session;
    if (p === './web-member-session') return { subscribeWebMemberSessionDiscard: () => () => {}, discardWebMemberSession() {} };
    return {};
  });
  const port = {
    restore: async () => null, login: async () => null, signupState: async () => ({}), complete: async () => ({}),
    logout: async () => { if (options.logout) return options.logout(); },
    retire: async (withdrawalId, signal) => { retired.push({ withdrawalId, signal }); return options.retire ? options.retire(withdrawalId, signal) : { withdrawalId, status: 'processing', memberAccessRevoked: true }; },
  };
  if (kind !== 'chat') { rootRemote.installMemberSessionPort(port); rootRemote.installMemberSessionDetails({ userId: uid, accessToken: 'synthetic-private-token', status: 'ready', returnTo: '/' }); }
  const makeReadPort = () => ({ markVisible(conversationId, ids, signal) { const result = deferred(); readCalls.push({ conversationId, ids, signal, ...result }); return result.promise; } });
  readPort = makeReadPort();
  const remote = kind === 'chat' ? {
    useMemberService: () => service, useServiceSession: () => ({ epoch, authenticated }), serviceSessionEpoch: () => epoch,
    useMessageReadPort: () => readPort, useMemberPorts: () => ({}), useService: () => null,
  } : rootRemote;
  const app = { now: 0, showToast() {}, navigate: (...args) => navigations.push(args), logout: async () => { if (options.localLogout) return options.localLogout(device, c => { cleanup = c; cleanupListeners.forEach(f => f()); }); } };
  const screen = compile(source, p => {
    if (p === 'react') return React;
    if (p === 'react-native') return { FlatList: 'FlatList', View: 'View', Image: 'Image', Modal: 'Modal', Pressable: 'Pressable', ScrollView: 'ScrollView' };
    if (p === 'expo-router') return { useFocusEffect(fn) { effect(fn, [fn], true); }, useNavigation: () => ({ dispatch() {} }) };
    if (p === 'expo-router/react-navigation') return { usePreventRemove() {} };
    if (p === 'expo-crypto') return { randomUUID: () => id(1000 + ++serial) };
    if (p === '../api') return api;
    if (p === '../member-service') return member;
    if (p === '../member-session') return session;
    if (p === '../chat-read-state') return dispatcher;
    if (p === '../remote') return remote;
    if (p === '../state') return { useApp: () => app };
    if (p === '../member-device-cleanup') return device;
    if (p === '../presentation/member-ai-consents') return { MemberAiConsentSettings: () => null };
    if (p === '../presentation/ux-form') return { useUxFocus: () => ({ focusTarget() {} }) };
    if (p === '../presentation/ux-time') return { formatKoreanDateTime: () => '', formatDeadline: () => '' };
    if (p === '../ui') return ui;
    return {};
  }, '\nexports.testChat=RemoteChat;exports.testAccount=RemoteAccount;exports.testRetirementStatus=typeof RemoteRetirementStatus === "function" ? RemoteRetirementStatus : null;');
  function expand(node) {
    if (Array.isArray(node)) return node.map(expand);
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function' && ['RemoteRetirementStatus', 'DeviceCleanupNotice'].includes(node.type.name)) return expand(node.type(node.props));
    return { ...node, props: { ...node.props, children: expand(node.props.children) } };
  }
  const render = () => { dirty = false; cursor = 0; value = expand(kind === 'chat' ? screen.testChat({ conversationId: room }) : kind === 'inner' ? screen.testAccount() : screen.RemoteAccountScreen()); effects.splice(0).forEach(f => f()); };
  const h = {
    service, screen, remote, port, api, readCalls, retired, navigations,
    render, get value() { return value; }, text: () => words(value), button: label => children(value).find(n => ['Button', 'TextButton'].includes(n.type) && words(n) === label),
    async flush() { for (let n = 0; n < 40; n++) { if (dirty) render(); await new Promise(r => setImmediate(r)); if (!dirty && !effects.length) return; } throw Error('Synthetic hooks did not settle'); },
    refresh() { h.button('새로고침').props.onPress(); },
    changeSession() { epoch++; dirty = true; },
    replaceReadPort() { readPort = makeReadPort(); dirty = true; },
    blur() { focused = false; for (const slot of slots) if (slot?.focus) slot.cleanup?.(); },
    focus() { focused = true; for (const slot of slots) if (slot?.focus) slot.cleanup = slot.create(); },
    observe(ids = [id(2)], delayed = false) {
      const list = children(value).find(n => n.type === 'FlatList');
      const viewport = children(value).find(n => n.type === 'View' && n.props.ref && n.props.onLayout);
      const pending = [];
      viewport.props.ref.current = { measureInWindow(fn) { fn(0, 0, 100, 100); } };
      for (const messageId of ids) {
        const row = list.props.renderItem({ item: { messageId, content: 'observed-body' } });
        const body = children(row).find(n => n.type === 'View' && typeof n.props.ref === 'function');
        body.props.ref({ measureInWindow(fn) { if (delayed) pending.push(fn); else fn(0, 5, 100, 20); } });
      }
      viewport.props.onLayout();
      const observedCallbacks = [...pending];
      return () => observedCallbacks.forEach(fn => fn(0, 5, 100, 20));
    },
    acknowledge(index) { const c = readCalls[index]; c.resolve({ confirmedMessageIds: [...c.ids], unreadCount: 0 }); },
    setCleanup(state) { cleanup = state; cleanupListeners.forEach(f => f()); },
    leaveAccount() { const inner = children(value).find(n => n.type?.name === 'RemoteAccount'); assert.ok(inner?.props.onLogout); inner.props.onLogout(port); },
  };
  render();
  return h;
}

test('permission loss aborts pending read ACK and rejects old viewport measurements without losing typed input', async () => {
  const h = harness(); await h.flush(); h.observe(); assert.equal(h.readCalls.length, 1);
  const lateMeasurement = h.observe([id(4)], true);
  children(h.value).find(n => n.type === 'Field').props.onChangeText('keep-my-unsent-input'); await h.flush();
  h.service.conversation = async () => { throw new h.api.ApiError(403, 'REVOKED'); };
  h.refresh(); await h.flush();
  assert.equal(h.readCalls[0].signal.aborted, true);
  lateMeasurement(); h.acknowledge(0); await h.flush();
  assert.equal(h.readCalls.length, 1);
  assert.deepEqual(Array.from(children(h.value).find(n => n.type === 'FlatList').props.data), []);
  assert.equal(children(h.value).find(n => n.type === 'Field').props.value, 'keep-my-unsent-input');
});
test('old ACK completion cannot unlock the new permission generation or acknowledge its IDs', async () => {
  const h = harness(); await h.flush(); h.observe();
  const read = deferred(); h.service.conversation = () => read.promise; h.refresh(); await h.flush();
  read.resolve({ can_send: true, my_role: 'requester' }); await h.flush(); h.observe([id(5)]);
  assert.equal(h.readCalls.length, 2); assert.equal(h.readCalls[1].signal.aborted, false);
  h.acknowledge(0); await h.flush(); assert.equal(h.readCalls.length, 2);
  assert.equal(h.readCalls[1].signal.aborted, false);
  h.acknowledge(1); await h.flush(); assert.equal(h.readCalls.length, 3);
  assert.deepEqual(Array.from(h.readCalls[2].ids), [id(5)]);
  h.acknowledge(2); await h.flush(); assert.equal(h.readCalls.length, 3);
});
test('late read failure after revocation cannot restore a retry UI or dispatch a request', async () => {
  const h = harness(); await h.flush(); h.observe();
  h.service.conversation = async () => { throw new h.api.ApiError(401, 'EXPIRED'); }; h.refresh(); await h.flush();
  h.readCalls[0].reject(new Error('late-private-transport-failure')); await h.flush();
  assert.equal(h.button('읽음 다시 시도'), undefined); assert.equal(h.readCalls.length, 1);
});
for (const boundary of ['blur', 'session', 'port']) test(`read observers are invalidated across ${boundary}`, async () => {
  const h = harness(); await h.flush(); h.observe(); const oldMeasure = h.observe([id(7)], true);
  if (boundary === 'blur') h.blur(); else if (boundary === 'session') h.changeSession(); else h.replaceReadPort();
  await h.flush(); assert.equal(h.readCalls[0].signal.aborted, true);
  const validGenerationCalls = h.readCalls.length;
  oldMeasure(); h.acknowledge(0); await h.flush(); assert.equal(h.readCalls.length, validGenerationCalls);
  assert.ok(h.readCalls.slice(1).every(c => !c.ids.includes(id(7))));
});
test('read batches keep the existing 100-ID maximum and acknowledge only observed bodies', async () => {
  const h = harness(); await h.flush(); h.observe(Array.from({ length: 102 }, (_, n) => id(100 + n)));
  h.acknowledge(0); await h.flush();
  while (h.readCalls.some(c => !c.signal.aborted && !c.done)) {
    const index = h.readCalls.findIndex(c => !c.signal.aborted && !c.done); h.readCalls[index].done = true; h.acknowledge(index); await h.flush();
  }
  assert.ok(h.readCalls.every(c => c.ids.length <= 100 && c.ids.length >= 1));
  assert.equal(new Set(h.readCalls.flatMap(c => Array.from(c.ids))).size, 102);
});
test('a read transport failure waits for explicit retry and never uses watermark fallback', async () => {
  const h = harness(); await h.flush(); h.observe(); h.readCalls[0].reject(new Error('lost')); await h.flush();
  assert.equal(h.readCalls.length, 1); h.observe([id(9)]); await h.flush(); assert.equal(h.readCalls.length, 1);
  h.button('읽음 다시 시도').props.onPress(); assert.equal(h.readCalls.length, 2);
  assert.ok(h.readCalls[1].ids.includes(id(9))); h.acknowledge(1); await h.flush();
});

test('S21 initial confirmation uses the retained retirement request store', async () => {
  const h = harness('inner'); await h.flush(); h.button('회원 탈퇴').props.onPress(); await h.flush();
  h.button('회원 탈퇴').props.onPress(); await h.flush(); h.button('탈퇴 요청 확인').props.onPress(); await h.flush();
  assert.equal(h.retired.length, 1); assert.equal(h.remote.memberRetirementSnapshot().receipt.status, 'processing');
  assert.equal(h.remote.useServiceSession().authenticated, false); assert.deepEqual(h.navigations, []);
});
test('processing receipt remains outside Guard after authority revocation, then manual same-ID check reaches completed', async () => {
  let status = 'processing'; const h = harness('wrapper', { retire: async withdrawalId => ({ withdrawalId, status, memberAccessRevoked: true }) }); await h.flush();
  await h.remote.requestMemberRetirement(id(40)); await h.flush(); assert.match(h.text(), /탈퇴를 처리하고/); assert.doesNotMatch(h.text(), /로그인하고 동행/);
  assert.equal(h.retired.length, 1); await h.flush(); assert.equal(h.retired.length, 1);
  status = 'completed'; h.button('탈퇴 상태 다시 확인').props.onPress(); await h.flush();
  assert.match(h.text(), /탈퇴 처리가 완료/); assert.equal(h.button('탈퇴 상태 다시 확인'), undefined);
  assert.deepEqual(h.retired.map(x => x.withdrawalId), [id(40), id(40)]);
  assert.doesNotMatch(h.text(), /synthetic-private-token|11111111|22222222/);
});
test('lost retirement response stays unconfirmed and only an explicit same-ID recheck dispatches', async () => {
  const h = harness('wrapper', { retire: async () => { throw new Error('lost'); } }); await h.flush();
  await assert.rejects(h.remote.requestMemberRetirement(id(41))); await h.flush();
  assert.match(h.text(), /상태를 확인하지 못했/); assert.doesNotMatch(h.text(), /탈퇴 처리가 완료/);
  assert.equal(h.retired.length, 1); h.button('탈퇴 상태 다시 확인').props.onPress(); await h.flush();
  assert.equal(h.retired.length, 2); assert.deepEqual(h.retired.map(x => x.withdrawalId), [id(41), id(41)]);
});
test('pending retirement presses send once and a new account cannot receive the old receipt', async () => {
  const late = deferred(); const h = harness('wrapper', { retire: () => late.promise }); await h.flush();
  const pending = h.remote.requestMemberRetirement(id(42)); await h.flush();
  assert.equal(h.button('탈퇴 상태 다시 확인').props.disabled, true);
  h.button('탈퇴 상태 다시 확인').props.onPress(); await h.flush(); assert.equal(h.retired.length, 1);
  h.remote.installMemberSessionPort({ ...h.port });
  h.remote.installMemberSessionDetails({ userId: id(44), accessToken: 'new-session', status: 'ready', returnTo: '/' }); await h.flush();
  late.resolve({ withdrawalId: id(42), status: 'completed', memberAccessRevoked: true }); await assert.rejects(pending); await h.flush();
  assert.equal(h.remote.memberRetirementSnapshot(), null); assert.equal(h.remote.useServiceSession().authenticated, true); assert.doesNotMatch(h.text(), /탈퇴 처리가 완료/);
});
test('logout revokes local authority even if both server and device cleanup fail, with separate recovery', async () => {
  const h = harness('wrapper', { logout: async () => { throw new Error('server-lost'); }, localLogout: async (_device, update) => { update({ busy: false, failed: true }); throw new Error('storage-failed'); } }); await h.flush();
  h.leaveAccount(); await h.flush(); assert.equal(h.remote.useServiceSession().authenticated, false);
  assert.match(h.text(), /서버의 세션 종료를 확인하지 못했/); assert.match(h.text(), /기기 정보 정리를 확인/);
  h.button('기기 정보 정리 다시 시도').props.onPress(); await h.flush(); assert.doesNotMatch(h.text(), /기기 정보 정리를 확인/);
  assert.match(h.text(), /서버의 세션 종료를 확인하지 못했/);
});
test('expired retirement confirmation keeps minimal metadata without claiming completion or auto retry', async () => {
  const h = harness('wrapper', { retire: async () => { throw new h.api.ApiError(401, 'EXPIRED'); } }); await h.flush();
  await assert.rejects(h.remote.requestMemberRetirement(id(45))); await h.flush();
  assert.match(h.text(), /권한이 만료됐거나 변경/); assert.equal(h.button('탈퇴 상태 다시 확인').props.disabled, true); assert.equal(h.retired.length, 1);
});
test('a stale logout callback cannot revoke or log out the replacement account', async () => {
  let requests = 0;
  const h = harness('wrapper', { logout: async () => { requests++; } }); await h.flush();
  const oldLeave = children(h.value).find(n => n.type?.name === 'RemoteAccount').props.onLogout;
  h.remote.installMemberSessionDetails({ userId: id(46), accessToken: 'replacement', status: 'ready', returnTo: '/' }); await h.flush();
  oldLeave(h.port); await h.flush();
  assert.equal(requests, 0); assert.equal(h.remote.useServiceSession().authenticated, true);
});
test('a stale retirement confirmation never submits its old intent for the replacement account', async () => {
  const h = harness('inner'); await h.flush(); h.button('회원 탈퇴').props.onPress(); await h.flush();
  h.button('회원 탈퇴').props.onPress(); await h.flush(); const oldConfirm = h.button('탈퇴 요청 확인').props.onPress;
  h.remote.installMemberSessionDetails({ userId: id(47), accessToken: 'replacement', status: 'ready', returnTo: '/' }); await h.flush();
  oldConfirm(); await h.flush(); assert.equal(h.retired.length, 0); assert.equal(h.remote.useServiceSession().authenticated, true);
});
test('device cleanup failure remains distinct from a server-confirmed retirement completion', async () => {
  const h = harness('wrapper', { retire: async withdrawalId => ({ withdrawalId, status: 'completed', memberAccessRevoked: true }) }); await h.flush();
  await h.remote.requestMemberRetirement(id(48)); h.setCleanup({ busy: false, failed: true }); await h.flush();
  assert.match(h.text(), /탈퇴 처리가 완료/); assert.match(h.text(), /기기 정보 정리를 확인/);
  h.button('기기 정보 정리 다시 시도').props.onPress(); await h.flush();
  assert.match(h.text(), /탈퇴 처리가 완료/); assert.doesNotMatch(h.text(), /기기 정보 정리를 확인/); assert.equal(h.retired.length, 1);
});

test('an earlier device cleanup failure does not label a newly authenticated account as logged out',async()=>{const h=harness('wrapper');await h.flush();h.setCleanup({busy:false,failed:true});await h.flush();assert.ok(children(h.value).some(node=>node.type?.name==='RemoteAccount'));assert.doesNotMatch(h.text(),/기기에서 로그아웃/);});
