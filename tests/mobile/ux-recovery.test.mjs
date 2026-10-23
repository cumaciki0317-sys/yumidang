// Actual recovery component, synthetic router: no browser or server claims.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

const appRoot = path.resolve(import.meta.dirname, '../../apps/mobile');
const ts = createRequire(path.join(appRoot, 'package.json'))('typescript');
class ApiError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const routes = [], exports = {};
const code = ts.transpileModule(readFileSync(path.join(appRoot, 'src/presentation/client-feedback.tsx'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
}).outputText;
vm.runInNewContext(code, { exports, URLSearchParams, require(id) {
  if (id === 'react') return { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
  if (id === 'expo-router') return { router: { push: value => routes.push(value) }, usePathname: () => '/post-detail', useLocalSearchParams: () => ({ id: 'fixture-id', token: 'should-not-copy', unrelated: 'ignore' }) };
  if (id === '../api') return { ApiError };
  if (id === '../ui') return { Body: 'Body', Button: 'Button', Card: 'Card', Title: 'Title' };
  throw new Error(id);
} });
const button = node => node.props.children.flat().find(child => child?.type === 'Button');

test('authentication, inaccessible, pending and retryable failures lead to different recovery actions', () => {
  const { recoveryKind } = exports;
  assert.equal(recoveryKind(new ApiError(401, 'TOKEN_EXPIRED')), 'login');
  assert.equal(recoveryKind(new ApiError(403, 'DENIED')), 'unavailable');
  assert.equal(recoveryKind(new ApiError(404, 'MISSING')), 'unavailable');
  assert.equal(recoveryKind(new ApiError(503, 'EVENT_DETAIL_NOT_CONNECTED')), 'pending');
  assert.equal(recoveryKind(new Error('network')), 'retry');
});

test('login preserves the current item without copying arbitrary sensitive route parameters or retrying', () => {
  let retries = 0;
  const tree = exports.RecoveryCard({ kind: 'login', message: '확인 필요', onRetry: () => retries++ });
  assert.equal(button(tree).props.children[0], '로그인');
  button(tree).props.onPress();
  assert.equal(routes.at(-1).pathname, '/login');
  assert.equal(routes.at(-1).params.returnPath, '/post-detail?id=fixture-id');
  assert.equal(retries, 0);
});

test('pending has no retry control, while manual retry is invoked only after a press', () => {
  let retries = 0;
  assert.equal(button(exports.RecoveryCard({ kind: 'pending', message: '연결 대기' })), undefined);
  const tree = exports.RecoveryCard({ kind: 'retry', message: '일시 실패', onRetry: () => retries++ });
  assert.equal(retries, 0);
  button(tree).props.onPress();
  assert.equal(retries, 1);
});
