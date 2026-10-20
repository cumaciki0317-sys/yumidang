// Executes production hooks/components against synthetic focus and network ports.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
const appRoot = path.resolve(import.meta.dirname, '../../apps/mobile');
const appRequire = createRequire(path.join(appRoot, 'package.json'));
const ts = appRequire('typescript');
const sourcePath = process.env.MEMBER_FAILURE_SOURCE || path.join(appRoot, 'src/screens/RemoteMemberScreens.tsx');
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function nodes(value) { return Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children || []), ...nodes(value.props?.footer || []), ...nodes(value.props?.right || []), ...nodes(value.props?.ListHeaderComponent || []), ...nodes(value.props?.ListFooterComponent || [])] : []; }
function words(value) { return Array.isArray(value) ? value.map(words).join('') : typeof value === 'string' ? value : value && typeof value === 'object' ? words(value.props?.children || []) : ''; }
function harness(kind = 'action', supplied = {}) {
  const slots = [], effects = []; let cursor = 0, dirty = false, focused = true, value, epoch = 1, authenticated = true, nextId = 0;
  const service = { profile: async () => ({ userId: 'self' }), conversation: async () => ({ request_id: 'conversation', can_send: true, my_role: 'requester', post_title: '합성 공고' }), messages: async (_id, before) => before ? { items: [{ messageId: 'older', content: '이전 비공개 메시지', senderId: 'peer' }], nextCursor: null } : { items: [{ messageId: 'latest', content: '최신 비공개 메시지', senderId: 'peer' }], nextCursor: 'cursor' }, consent: async () => null, ...supplied };
  const same = (a, b) => a && b && a.length === b.length && a.every((item, i) => Object.is(item, b[i]));
  function effect(create, deps, focus = false) {
    const index = cursor++, previous = slots[index];
    if (!previous || !same(previous.deps, deps)) effects.push(() => { previous?.cleanup?.(); const record = { deps, create, focus, cleanup: undefined }; slots[index] = record; if (!focus || focused) record.cleanup = create(); });
  }
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], next => { const updated = typeof next === 'function' ? next(slots[index]) : next; if (!Object.is(updated, slots[index])) { slots[index] = updated; dirty = true; } }]; },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
    useCallback(fn, deps) { const index = cursor++; if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { fn, deps }; return slots[index].fn; },
    useEffect(create, deps) { effect(create, deps); },
  };
  const api = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(path.join(appRoot, 'src/api.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: api, AbortController, TextEncoder, setTimeout, clearTimeout, URL, fetch });
  const ui = Object.fromEntries(['Body','Button','Card','Chip','Empty','Field','Row','Screen','TextButton','Title'].map(name => [name, name]));
  const exports = {};
  const compiled = ts.transpileModule(readFileSync(sourcePath, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(`${compiled}\nexports.testRemoteChat = RemoteChat;`, { exports, Date, Intl, AbortController, console, require(id) {
    if (id === 'react') return React;
    if (id === 'react-native') return { FlatList: 'FlatList', Image: 'Image', View: 'View' };
    if (id === 'expo-router') return { useFocusEffect(callback) { effect(callback, [callback], true); } };
    if (id === 'expo-crypto') return { randomUUID: () => `synthetic-intent-${++nextId}` };
    if (id === '../api') return api;
    if (id === '../remote') return { useMemberService: () => service, useServiceSession: () => ({ epoch, authenticated }), serviceSessionEpoch: () => epoch, useMessageReadPort: () => null, useMemberPorts: () => ({}) };
    if (id === '../state') return { useApp: () => ({ now: 0, navigate() {}, showToast() {} }) };
    if (id === '../ui') return ui;
    return {};
  } });
  const render = () => { dirty = false; cursor = 0; value = kind === 'action' ? exports.useMemberAction() : kind === 'resource' ? exports.useMemberResource('test', (s, signal) => s.profile(signal)) : exports.testRemoteChat(kind === 'first' ? { postId: 'post' } : { conversationId: 'conversation' }); effects.splice(0).forEach(run => run()); };
  async function flush() { for (let count = 0; count < 30; count++) { if (dirty) render(); await new Promise(resolve => setImmediate(resolve)); if (!dirty && !effects.length) return; } throw new Error('Synthetic hooks did not settle'); }
  const blur = () => { focused = false; for (const slot of slots) if (slot?.focus) { slot.cleanup?.(); slot.cleanup = undefined; } };
  const focus = () => { focused = true; for (const slot of slots) if (slot?.focus) slot.cleanup = slot.create(); };
  render();
  return { flush, blur, focus, service, ApiError: api.ApiError, get value() { return value; }, changeSession() { epoch++; dirty = true; }, button(label) { return nodes(value).find(node => ['Button','TextButton'].includes(node.type) && words(node) === label); }, field() { return nodes(value).find(node => node.type === 'Field'); }, messages() { return nodes(value).find(node => node.type === 'FlatList').props.data; }, render };
}

test('request settling during blur cannot leave the refocused screen busy', async () => {
  const h = harness(); const request = deferred(); await h.flush();
  const running = h.value.run(() => request.promise); await h.flush(); assert.equal(h.value.busy, true);
  h.blur(); request.reject(new Error('cancelled while away')); await running; await h.flush(); h.focus(); await h.flush();
  assert.equal(h.value.busy, false);
});

test('previously paginated private messages disappear after refocus permission denial', async () => {
  const h = harness('chat', { consent: async () => ({ status: 'awaiting_consent', conditions: { registeredAddress: '가상 상세 만남 주소' } }) }); await h.flush();
  assert.ok(nodes(h.value).some(node => node.type?.name === 'ConsentConditions'));
  await h.button('이전 메시지 보기').props.onPress(); await h.flush();
  assert.ok(h.messages().some(row => row.content === '이전 비공개 메시지'));
  h.field().props.onChangeText('작성 중인 내 메시지'); await h.flush();
  h.service.messages = async () => { throw new h.ApiError(403, 'FORBIDDEN'); };
  h.blur(); h.focus(); await h.flush();
  assert.deepEqual(Array.from(h.messages()), []);
  assert.ok(!nodes(h.value).some(node => node.type?.name === 'ConsentConditions'));
  assert.equal(h.field().props.value, '작성 중인 내 메시지');
});

test('rapid action presses are locked and a blurred action cannot be dispatched', async () => {
  const h = harness(); await h.flush(); const request = deferred(); let calls = 0;
  const task = () => { calls++; return request.promise; };
  const running = h.value.run(task); assert.equal(await h.value.run(task), false); assert.equal(calls, 1);
  h.blur(); assert.equal(await h.value.run(task), false); assert.equal(calls, 1);
  request.resolve('old'); assert.equal(await running, false); await h.flush();
});

test('late response from an abandoned action cannot unlock a newer focused action', async () => {
  const h = harness(); await h.flush(); const old = deferred(), current = deferred(); const successes = [];
  const first = h.value.run(() => old.promise, result => successes.push(result)); await h.flush();
  h.blur(); h.focus(); await h.flush();
  const second = h.value.run(() => current.promise, result => successes.push(result)); await h.flush();
  old.resolve('old'); await first; await h.flush(); assert.equal(h.value.busy, true); assert.deepEqual(successes, []);
  current.resolve('current'); await second; await h.flush(); assert.equal(h.value.busy, false); assert.deepEqual(successes, ['current']);
});

for (const [status, expected] of [[401, '로그인'], [403, '접근 권한'], [409, '상태가 바뀌었거나'], [410, '응답 기한'], [503, '처리하지 못했어요']]) {
  test(`action ${status} preserves a failure and never invokes success or auto retry`, async () => {
    const h = harness(); await h.flush(); let calls = 0, successes = 0;
    assert.equal(await h.value.run(async () => { calls++; throw new h.ApiError(status, 'SYNTHETIC_FAILURE'); }, () => successes++), false);
    await h.flush(); assert.equal(calls, 1); assert.equal(successes, 0); assert.equal(h.value.busy, false); assert.match(h.value.error, new RegExp(expected));
  });
}

test('old session action responses cannot report success or error to the new session', async () => {
  const h = harness(); await h.flush(); const request = deferred(); let successes = 0;
  const running = h.value.run(() => request.promise, () => successes++); await h.flush();
  h.changeSession(); await h.flush(); request.reject(new h.ApiError(403, 'OLD_SESSION')); await running; await h.flush();
  assert.equal(successes, 0); assert.equal(h.value.busy, false); assert.equal(h.value.error, '');
});

test('late resource response from the previous session cannot restore private data', async () => {
  const first = deferred(), second = deferred(); let calls = 0;
  const h = harness('resource', { profile: () => ++calls === 1 ? first.promise : second.promise }); await h.flush();
  h.changeSession(); await h.flush(); second.resolve({ realName: '현재 세션 이름' }); await h.flush();
  first.resolve({ realName: '이전 세션 이름' }); await h.flush(); assert.equal(h.value.data.realName, '현재 세션 이름');
});

for (const status of [401, 403]) {
  test(`resource ${status} removes previously received private information`, async () => {
    const h = harness('resource', { profile: async () => ({ realName: '민감한 합성 이름' }) }); await h.flush(); assert.equal(h.value.data.realName, '민감한 합성 이름');
    h.service.profile = async () => { throw new h.ApiError(status, 'ACCESS_LOST'); };
    h.blur(); h.focus(); await h.flush(); assert.equal(h.value.data, null); assert.ok(h.value.error);
  });
}

test('lost first-message response retains input and retries the same message ID', async () => {
  const requests = []; let fail = true;
  const h = harness('first', { firstMessage: async (postId, messageId, content) => { requests.push({ postId, messageId, content }); if (fail) throw new Error('synthetic response lost'); return { id: 'conversation' }; } });
  await h.flush(); h.field().props.onChangeText('저장돼야 하는 내 첫 메시지'); await h.flush();
  h.button('메시지 보내기').props.onPress(); await h.flush(); assert.equal(h.field().props.value, '저장돼야 하는 내 첫 메시지'); assert.equal(requests.length, 1);
  fail = false; h.button('메시지 보내기').props.onPress(); await h.flush(); assert.equal(requests.length, 2); assert.deepEqual(requests[0], requests[1]); assert.equal(h.field().props.value, '');
});

test('permission denial during send clears received messages but keeps input until manual refresh', async () => {
  const h = harness('chat', { sendMessage: async () => { throw new h.ApiError(403, 'ACCESS_LOST'); } }); await h.flush();
  h.button('이전 메시지 보기').props.onPress(); await h.flush(); assert.ok(h.messages().length > 1);
  h.field().props.onChangeText('아직 전송하지 못한 내 입력'); await h.flush(); h.button('메시지 보내기').props.onPress(); await h.flush();
  assert.deepEqual(Array.from(h.messages()), []); assert.equal(h.field().props.value, '아직 전송하지 못한 내 입력'); assert.equal(h.button('메시지 보내기').props.disabled, true);
  h.button('새로고침').props.onPress(); await h.flush();
  assert.equal(h.messages().length, 1); assert.equal(h.messages()[0].messageId, 'latest'); assert.equal(h.button('메시지 보내기').props.disabled, false);
});

test('manual refresh after 403 never restores old history or conditions while access reads are pending', async () => {
  const h = harness('chat', { consent: async () => ({ status: 'awaiting_consent', conditions: { registeredAddress: '이전 합성 상세 만남 주소' } }), sendMessage: async () => { throw new h.ApiError(403, 'ACCESS_LOST'); } });
  await h.flush(); h.button('이전 메시지 보기').props.onPress(); await h.flush();
  assert.ok(h.messages().some(row => row.messageId === 'older')); assert.ok(nodes(h.value).some(node => node.type?.name === 'ConsentConditions'));
  h.field().props.onChangeText('재확인 중에도 보존할 내 입력'); await h.flush();
  h.button('메시지 보내기').props.onPress(); await h.flush(); assert.deepEqual(Array.from(h.messages()), []);
  const conversation = deferred(), messages = deferred();
  h.service.conversation = () => conversation.promise; h.service.messages = () => messages.promise;
  h.button('새로고침').props.onPress(); await h.flush();
  const assertPending = () => { assert.deepEqual(Array.from(h.messages()), []); assert.ok(!nodes(h.value).some(node => node.type?.name === 'ConsentConditions')); assert.equal(h.field().props.value, '재확인 중에도 보존할 내 입력'); assert.equal(h.button('메시지 보내기').props.disabled, true); };
  assertPending();
  conversation.resolve({ request_id: 'conversation', can_send: true, my_role: 'requester', post_title: '재확인한 합성 공고' }); await h.flush(); assertPending();
  messages.resolve({ items: [{ messageId: 'revalidated', content: '재확인한 합성 메시지', senderId: 'peer' }], nextCursor: null }); await h.flush();
  assert.deepEqual(Array.from(h.messages(), row => row.messageId), ['revalidated']); assert.ok(nodes(h.value).some(node => node.type?.name === 'ConsentConditions')); assert.equal(h.field().props.value, '재확인 중에도 보존할 내 입력');
});
