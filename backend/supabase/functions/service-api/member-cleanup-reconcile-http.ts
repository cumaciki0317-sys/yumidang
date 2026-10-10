/** 민규: SQL115의 원 ACK 복구만 연결하는 내부 HTTP 포트. 기본 factory 미설치. */
import type { RuntimeConfig } from '../_shared/config/env.ts';
import { requireInternalConfig } from '../_shared/config/env.ts';
import type { RequestContext } from '../_shared/contracts/common.ts';
import { requireInternalCaller } from '../_shared/auth/internal-caller.ts';
import { createMemberCleanupAdapter, processMemberCleanupReconciliation } from '../_shared/auth/member-cleanup.ts';
import { createMemberCleanupBudgetReader, createMemberCleanupReconcilePorts } from '../_shared/db/repositories/member-cleanup.ts';
import type { FetchLike } from '../_shared/db/transport.ts';
import { HttpError } from '../_shared/http/errors.ts';
import { createRequestContext, readJson } from '../_shared/http/request.ts';
import { jsonSuccess, jsonFailure } from '../_shared/http/response.ts';

export interface MemberCleanupReconcileReadiness {
  approved: true;
  decisionId: string;
  maxExecutionMs: number;
}
const canonicalId = (v: unknown): v is string => typeof v === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v) &&
  v !== '00000000-0000-0000-0000-000000000000';

/** 승인값은 서버 조립에서만 받는다. 새 global 점유·원 부모 완료·DELETE/ACK를 생성하지 않는다. */
export function createMemberCleanupReconcileExecutor(config: RuntimeConfig,
  readiness: MemberCleanupReconcileReadiness | undefined, fetchImpl: FetchLike = fetch) {
  requireInternalConfig(config);
  const approved = readiness ? Object.freeze({ approved: readiness.approved,
    decisionId: readiness.decisionId, maxExecutionMs: readiness.maxExecutionMs }) : null;
  if (!approved || approved.approved !== true || !/^[A-Za-z0-9_.:-]{1,80}$/.test(approved.decisionId) ||
      !Number.isSafeInteger(approved.maxExecutionMs) || approved.maxExecutionMs < 1 || approved.maxExecutionMs > 60000) {
    throw new HttpError('EXTERNAL_UNAVAILABLE');
  }
  const readBudget = createMemberCleanupBudgetReader(config, fetchImpl);
  const adapter = createMemberCleanupAdapter(config, fetchImpl);
  return async (request: Request, context: RequestContext = createRequestContext()): Promise<Response> => {
    try {
      await requireInternalCaller(request, config);
      if (request.method !== 'POST') throw new HttpError('METHOD_NOT_ALLOWED');
      if (new URL(request.url).search || request.signal.aborted) throw new HttpError('INVALID_REQUEST');
      const token = request.headers.get('x-worker-run-token');
      if (!canonicalId(token)) throw new HttpError('INVALID_REQUEST');
      const body = await readJson(request, { maxBytes: config.maxRequestBytes });
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).sort().join(',') !== 'invocationRequestId,recoveryRequestId,taskId' ||
          !canonicalId(body.recoveryRequestId) || !canonicalId(body.invocationRequestId) || !canonicalId(body.taskId)) {
        throw new HttpError('INVALID_REQUEST');
      }
      const binding = Object.freeze({ recoveryRequestId: body.recoveryRequestId,
        invocationRequestId: body.invocationRequestId, taskId: body.taskId, recoveryGlobalToken: token });
      // 실제 현재 DB global 예산을 읽는다. 회복 키·원 lease·기한은 SQL115가 다시 확인한다.
      const startedAt = Date.now();
      const abort = new AbortController(), signal = AbortSignal.any([abort.signal, request.signal]);
      const timer = setTimeout(() => abort.abort(), approved.maxExecutionMs);
      const stop = () => { throw new HttpError('STATE_CONFLICT'); };
      try {
        // 취소를 무시한 transport도 예산 조회 단계부터 서버 마감을 늘리지 못한다.
        const budget = await new Promise<Awaited<ReturnType<typeof readBudget>>>((resolve, reject) => {
          const expired = () => reject(new HttpError('STATE_CONFLICT'));
          signal.addEventListener('abort', expired, { once: true });
          Promise.resolve().then(() => signal.aborted ? stop() : readBudget(token, signal))
            .then(value => signal.aborted ? expired() : resolve(value), reject)
            .finally(() => signal.removeEventListener('abort', expired));
        });
        const deadlineAt = Math.min(startedAt + approved.maxExecutionMs, budget.deadlineAt!);
        if (signal.aborted || deadlineAt <= Date.now()) stop();
        const ports = createMemberCleanupReconcilePorts(config, binding, fetchImpl);
        const result = await processMemberCleanupReconciliation(ports, adapter, { deadlineAt, signal });
        if (signal.aborted) stop();
        return jsonSuccess({ ...result }, context);
      } finally { clearTimeout(timer); }
    } catch (error) { return jsonFailure(error, context); }
  };
}

import { createRpcTransport, type RpcClient } from '../_shared/db/transport.ts';
import { createWorkerInvocationRuntime, type WorkerInvocationOutcome } from '../_shared/db/worker-runtime-client.ts';

/** 원 UNKNOWN 부모의 저장 증거만 종결한다. 기본 factory에는 설치하지 않는다. */
export function createMemberCleanupFinalizationExecutor(config: RuntimeConfig,
  readiness: MemberCleanupReconcileReadiness | undefined, fetchImpl: FetchLike = fetch) {
  const { serviceKey } = requireInternalConfig(config);
  const approved = readiness ? Object.freeze({ approved: readiness.approved,
    decisionId: readiness.decisionId, maxExecutionMs: readiness.maxExecutionMs }) : null;
  if (!approved || approved.approved !== true || !/^[A-Za-z0-9_.:-]{1,80}$/.test(approved.decisionId) ||
      !Number.isSafeInteger(approved.maxExecutionMs) || approved.maxExecutionMs < 1 || approved.maxExecutionMs > 60000) {
    throw new HttpError('EXTERNAL_UNAVAILABLE');
  }
  return async (request: Request, context: RequestContext = createRequestContext()): Promise<Response> => {
    try {
      await requireInternalCaller(request, config);
      if (request.method !== 'POST') throw new HttpError('METHOD_NOT_ALLOWED');
      if (new URL(request.url).search || request.signal.aborted) throw new HttpError('INVALID_REQUEST');
      const body = await readJson(request, { maxBytes: config.maxRequestBytes });
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).join(',') !== 'invocationRequestId' || !canonicalId(body.invocationRequestId)) {
        throw new HttpError('INVALID_REQUEST');
      }
      const originalId = body.invocationRequestId;
      const abort = new AbortController(), signal = AbortSignal.any([abort.signal, request.signal]);
      const deadlineAt = Date.now() + approved.maxExecutionMs;
      const timer = setTimeout(() => abort.abort(), approved.maxExecutionMs);
      const assertLive = () => { if (signal.aborted || Date.now() >= deadlineAt) throw new HttpError('STATE_CONFLICT'); };
      try {
        // RPC transport 자체가 취소를 무시해도 이 요청은 서버 마감에 종료한다.
        const bounded = <T>(operation: () => Promise<T>) => new Promise<T>((resolve, reject) => {
          const expired = () => reject(new HttpError('STATE_CONFLICT'));
          signal.addEventListener('abort', expired, { once: true });
          Promise.resolve().then(() => { assertLive(); return operation(); }).then(value => {
            assertLive(); resolve(value);
          }).catch(reject).finally(() => signal.removeEventListener('abort', expired));
        });
        const scopedFetch: FetchLike = (url, init) => {
          assertLive();
          return fetchImpl(url, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal });
        };
        // 이 포트에는 prepare/claim/lease/task 복구/외부 삭제 능력이 없다.
        const transport = createRpcTransport(config, serviceKey, serviceKey,
          new Set(['get_queue_invocation', 'complete_queue_invocation']), scopedFetch);
        const db = Object.freeze<RpcClient>({ rpc: (name, args) => bounded(() => transport.rpc(name, args)) });
        const runtime = createWorkerInvocationRuntime(db);
        const before = await runtime.getQueueInvocation(originalId);
        if (before.kind !== 'member_cleanup' || !['unknown', 'completed'].includes(before.state)) throw new HttpError('STATE_CONFLICT');
        const sameOriginal = (row: WorkerInvocationOutcome) => row.requestId === before.requestId &&
          row.globalToken === before.globalToken && row.kind === before.kind && row.limit === before.limit && row.remainingMs === before.remainingMs;
        const completed = (row: WorkerInvocationOutcome) => {
          if (!sameOriginal(row) || row.state !== 'completed' || !row.result || !('counts' in row.result)) throw new HttpError('EXTERNAL_UNAVAILABLE');
          return { status: 'completed', counts: row.result.counts };
        };
        if (before.state === 'completed') { assertLive(); return jsonSuccess(completed(before), context); }
        let response: WorkerInvocationOutcome | undefined;
        try { response = await runtime.completeQueueInvocation(originalId); } catch { /* 같은 ID의 저장 증거만 조회한다. */ }
        assertLive();
        if (response && !sameOriginal(response)) throw new HttpError('EXTERNAL_UNAVAILABLE');
        // 완료 응답은 최종 증거로 쓰지 않는다. 원 global 만료는 새 실행 허가가 아니다.
        const after = await runtime.getQueueInvocation(originalId);
        assertLive();
        if (!sameOriginal(after)) throw new HttpError('EXTERNAL_UNAVAILABLE');
        if (after.state === 'unknown') return jsonSuccess({ status: 'pending' }, context);
        return jsonSuccess(completed(after), context);
      } finally { clearTimeout(timer); }
    } catch (error) { return jsonFailure(error, context); }
  };
}
