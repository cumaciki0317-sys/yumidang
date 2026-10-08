/** Local Expo web UI + synthetic authenticated session/HTTP only. No DB/provider/device evidence. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const preview = process.env.FOLLOWUP_PREVIEW_ROOT;
if (!preview) throw Error('FOLLOWUP_PREVIEW_ROOT_REQUIRED');
const base = process.env.PREVIEW_URL || 'http://127.0.0.1:8099';
if (new URL(base).hostname !== '127.0.0.1') throw Error('LOCAL_PREVIEW_ONLY');
const require = createRequire(path.join(preview, 'apps/mobile/package.json'));
const { chromium } = require('playwright');
const root = path.resolve(import.meta.dirname, '../../..');
const sources = ['apps/mobile/src/screens/RemoteMemberScreens.tsx', 'apps/mobile/src/member-service.ts', 'apps/mobile/src/chat-read-state.ts', 'apps/mobile/src/remote.tsx'];
const hashes = {};
for (const source of sources) {
  const canonical = await readFile(path.join(root, source)), copied = await readFile(path.join(preview, source));
  assert.deepEqual(copied, canonical, `preview source matches canonical: ${source}`);
  hashes[source] = createHash('sha256').update(canonical).digest('hex');
}
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const api = 'https://api.example.test', userId = '11111111-1111-4111-8111-111111111111', requestId = '22222222-2222-4222-8222-222222222222';
const postId = '33333333-3333-4333-8333-333333333333', instant = '2026-10-08T01:00:00Z';
const messages = Array.from({ length: 24 }, (_, index) => ({ messageId: `44444444-4444-4444-8444-${String(index + 1).padStart(12, '0')}`, senderId: userId, content: `표시 검증 메시지 ${index + 1}`, createdAt: new Date(Date.parse(instant) + index * 1000).toISOString() }));
const calls = [], readCalls = [], checks = [], errors = [], unexpected = [], observations = [];
let longMessage = false;
const output = path.join(preview, 'evidence'); await mkdir(output, { recursive: true });
const check = (name, ok) => { assert.ok(ok, name); checks.push(name); };
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin === base) return route.continue();
  if (url.origin !== api) { unexpected.push(url.origin); return route.abort(); }
  const pathname = url.pathname.replace('/functions/v1/service-api', '');
  const input = request.postData() ? JSON.parse(request.postData()) : null;
  const call = { pathname, method: request.method(), input, syntheticAuth: request.headers().authorization === 'Bearer browser-synthetic-member' }; calls.push(call);
  let data;
  if (pathname === '/me') data = { userId, realName: '합성 회원', avatarUrl: null, bio: null, sweetness: 15 };
  else if (pathname === '/me/posts') data = { items: [{ postId, title: '신청 없는 본인 공고', status: 'recruiting', createdAt: instant, isOwner: true }], nextCursor: null };
  else if (['/appointments', '/requests/sent', '/requests/received'].includes(pathname)) data = [];
  else if (pathname === '/conversations') data = [];
  else if (pathname === `/conversations/${requestId}`) data = [{ request_id: requestId, post_title: '합성 대화', my_role: 'applicant', can_send: false, request_status: 'pending', last_read_message_id: null, read_at: null, unread_count: 24 }];
  else if (pathname === `/conversations/${requestId}/messages`) data = { items: longMessage ? [{ ...messages[0], content: '합성 긴 메시지\n'.repeat(100) }] : messages, nextCursor: null };
  else if (pathname === `/requests/${requestId}/consent`) data = { consent: null };
  else { unexpected.push(`UNEXPECTED_API:${pathname}`); return route.abort(); }
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data, requestId: userId }) });
});
await page.exposeFunction('syntheticVisibleRead', async (conversationId, messageIds) => {
  assert.equal(conversationId, requestId);
  const boxes = [];
  for (const id of messageIds) {
    const selected = messages.find(message => message.messageId === id);
    assert.ok(selected, 'confirmed ID belongs to this conversation');
    const content = selected.content;
    const locator = longMessage ? page.getByText('합성 긴 메시지', { exact: false }).first() : page.getByText(content, { exact: true });
    const box = await locator.boundingBox();
    boxes.push({ id, box, inViewport: Boolean(box && box.y < 844 && box.y + box.height > 0) });
  }
  readCalls.push({ conversationId, messageIds, boxes });
  return { confirmedMessageIds: messageIds, unreadCount: 0 };
});
const install = async (target, read = true) => {
  await page.goto(`${base}/test-session?read=${read ? '1' : '0'}&target=${encodeURIComponent(target)}`);
  await page.getByRole('button', { name: 'Install synthetic session', exact: true }).click();
};
try {
  await install('/me');
  await page.getByText('신청 없는 본인 공고', { exact: true }).waitFor();
  await page.getByRole('button', { name: '공고 수정', exact: true }).waitFor();
  check('no-application owned post exposes management without conversations', calls.some(call => call.pathname === '/me/posts') && !calls.some(call => call.pathname === '/conversations'));
  await page.screenshot({ path: path.join(output, 'own-post.png'), fullPage: true });
  await install(`/chat?id=request:${requestId}`, false);
  await page.getByText('개별 메시지 읽음 연결 준비 중이에요.', { exact: true }).waitFor();
  await page.getByText(messages[0].content, { exact: true }).waitFor();
  await page.waitForTimeout(350);
  check('missing per-message port dispatches zero and does not fallback to watermark HTTP', readCalls.length === 0 && !calls.some(call => call.pathname.endsWith('/read')));
  await install(`/chat?id=request:${requestId}`);
  await page.getByText(messages[0].content, { exact: true }).waitFor();
  await page.waitForTimeout(450);
  const beforeScroll = readCalls.slice();
  check('visible bodies cause per-message port call', beforeScroll.length > 0);
  check('offscreen newest message excluded on entry', !beforeScroll.some(call => call.messageIds.includes(messages.at(-1).messageId)));
  check('per-message calls follow actual text visibility', beforeScroll.every(call => call.boxes.every(box => box.inViewport)));
  const firstIds = beforeScroll.flatMap(call => call.messageIds);
  check('visible IDs individually deduplicated', new Set(firstIds).size === firstIds.length);
  await page.screenshot({ path: path.join(output, 'chat-initial.png') });
  await page.mouse.move(195, 410); await page.mouse.wheel(0, 650); await page.waitForTimeout(450);
  check('scroll only adds newly exposed bodies', readCalls.length > beforeScroll.length && readCalls.slice(beforeScroll.length).every(call => call.boxes.every(box => box.inViewport)));
  const count = readCalls.length;
  await page.waitForTimeout(350);
  check('unchanged visible bodies create no repeated read', readCalls.length === count);
  const allIds = readCalls.flatMap(call => call.messageIds);
  check('seen IDs stay deduplicated after scroll', new Set(allIds).size === allIds.length);
  await page.screenshot({ path: path.join(output, 'chat-scrolled.png') });
  check('synthetic authenticated HTTP only', calls.every(call => call.syntheticAuth));
  longMessage = true;
  const beforeLong = readCalls.length;
  await install(`/chat?id=request:${requestId}`);
  await page.waitForFunction(() => document.body.innerText.includes('합성 긴 메시지'));
  await page.waitForTimeout(450);
  check('long body partially visible is individually marked read', readCalls.length > beforeLong && readCalls.slice(beforeLong).every(call => call.messageIds.length === 1 && call.messageIds[0] === messages[0].messageId && call.boxes.every(box => box.inViewport && box.box.height > 844)));
  await page.screenshot({ path: path.join(output, 'chat-long-message.png') });
  check('no watermark HTTP fallback used', !calls.some(call => call.pathname.endsWith('/read')));
  check('no page errors or unexpected requests', errors.length === 0 && unexpected.length === 0);
} finally {
  await writeFile(path.join(output, 'receipt.json'), JSON.stringify({ checks, observations, calls, readCalls, errors, unexpected, hashes, evidence: 'localhost Expo web; synthetic session + mocked HTTP; no Auth/DB/provider/native-device claims' }, null, 2));
  if (errors.length || unexpected.length) process.stderr.write(JSON.stringify({ errors, unexpected }));
  await browser.close();
}
process.stdout.write(JSON.stringify({ status: 'PASS', checks: checks.length, receipt: path.join(output, 'receipt.json') }) + '\n');
