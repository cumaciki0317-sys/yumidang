/** 민규: SQL118에서 발견한 회원 UNKNOWN 부모의 저장 증거만 종결한다.
 * 조회 상한은 전송의 기술 한도이며 업무 배정·lease·외부 효과 허가를 만들지 않는다.
 * 자기 UNKNOWN으로 park된 scheduler는 풀지 않는다. 재시작/정상 실행기의 wake에서 사용한다.
 */
import type { RpcClient } from './transport.ts';
import { createWorkerInvocationRuntime, type WorkerInvocationOutcome } from './worker-runtime-client.ts';

export interface ApprovedMemberParentFinalization {
  approved: true;
  decisionId: string;
  maxExecutionMs: number;
}
const names = new Set(['read_member_cleanup_unknown_invocations', 'get_queue_invocation', 'complete_queue_invocation']);
// 아래20은 scan의 RPC 전송 상한이다. global20 job slot·업무 배정과 별개다.
const PAGE_LIMIT = 20, MAX_PAGES = 2, MAX_REQUESTS = 20;
const nil = '00000000-0000-0000-0000-000000000000';
const id = (value: unknown): value is string => typeof value === 'string' && value !== nil &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const stopped = () => new Error('MEMBER_PARENT_FINALIZATION_UNAVAILABLE');
function page(value: unknown, after: string | null): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw stopped();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'items,nextAfterRequestId' || !Array.isArray(row.items) || row.items.length > PAGE_LIMIT) throw stopped();
  let previous = after;
  const result = row.items.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).join(',') !== 'invocationRequestId') throw stopped();
    const key = (item as Record<string, unknown>).invocationRequestId;
    if (!id(key) || previous !== null && key <= previous) throw stopped();
    previous = key; return key;
  });
  if (row.nextAfterRequestId !== (result.at(-1) ?? null)) throw stopped();
  return result;
}
function sameOriginal(before: WorkerInvocationOutcome, after: WorkerInvocationOutcome) {
  return ['requestId', 'globalToken', 'kind', 'limit', 'remainingMs'].every(key =>
    before[key as keyof WorkerInvocationOutcome] === after[key as keyof WorkerInvocationOutcome]);
}

export function createMemberParentFinalizationScanner(db: RpcClient, readiness: ApprovedMemberParentFinalization,
  contractId: string, createScopedDb?: (signal: AbortSignal) => RpcClient) {
  if (!readiness || readiness.approved !== true || readiness.decisionId !== contractId || !contractId.trim() ||
      !Number.isSafeInteger(readiness.maxExecutionMs) || readiness.maxExecutionMs < 1 || readiness.maxExecutionMs > 60000 ||
      !db || typeof db.rpc !== 'function' || typeof db.supportsRpc === 'function' && [...names].some(name => !db.supportsRpc!(name))) {
    throw new Error('SHARED_QUEUE_CONTRACT_NOT_READY');
  }
  const maxExecutionMs = readiness.maxExecutionMs;
  let cursor: string | null = null;
  let running: Promise<void> | null = null;
  async function scan(parentSignal?: AbortSignal) {
    const controller = new AbortController();
    const signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
    const deadline = performance.now() + maxExecutionMs;
    const timer = setTimeout(() => controller.abort(), maxExecutionMs);
    const source = createScopedDb?.(signal) ?? db;
    let requests = 0;
    const live = () => { if (signal.aborted || performance.now() >= deadline) throw stopped(); };
    const scoped: RpcClient = Object.freeze({
      async rpc(...[name, args]: Parameters<RpcClient['rpc']>) {
        live();
        if (!names.has(name) || requests >= MAX_REQUESTS) throw stopped();
        requests++;
        // transport가 취소를 무시하더라도 대기와 다음 RPC는 서버 기한/stop에서 종료한다.
        return await new Promise<Awaited<ReturnType<RpcClient['rpc']>>>((resolve, reject) => {
          const abort = () => reject(stopped());
          signal.addEventListener('abort', abort, { once: true });
          Promise.resolve().then(() => { live(); return source.rpc(name, args); }).then(value => {
            live(); resolve(value);
          }).catch(() => reject(stopped())).finally(() => signal.removeEventListener('abort', abort));
        });
      },
    });
    const runtime = createWorkerInvocationRuntime(scoped);
    try {
      for (let pages = 0; pages < MAX_PAGES && requests + 4 <= MAX_REQUESTS; pages++) {
        live();
        const keys = page(await scoped.rpc('read_member_cleanup_unknown_invocations', {
          p_after_request_id: cursor, p_limit: PAGE_LIMIT,
        }), cursor);
        if (!keys.length) {
          const wrapped = cursor !== null;
          cursor = null;
          // 이전 scan cursor 뒤가 비었으면 남은 한 페이지 안에서 새로 생긴 낮은 ID도 발견한다.
          // 이번 scan에서 이미 처리한 페이지 뒤의 empty에는 같은 ID complete를 반복하지 않는다.
          if (wrapped && pages === 0) continue;
          return;
        }
        for (const requestId of keys) {
          live();
          // GET→complete→GET 세 요청을 모두 확보한다. 읽은 페이지 끝으로 미처리 ID를 건너뛰지 않는다.
          if (requests + 3 > MAX_REQUESTS) return;
          const before = await runtime.getQueueInvocation(requestId);
          if (before.kind !== 'member_cleanup' || !['unknown', 'completed'].includes(before.state)) throw stopped();
          if (before.state !== 'completed') {
            live();
            let response: WorkerInvocationOutcome | undefined;
            try { response = await runtime.completeQueueInvocation(requestId); } catch { /* 유실/실패는 원 ID의 GET만 확인한다. */ }
            live();
            // 성공 응답은 완료 증거가 아니지만 원 binding이 바뀐 응답도 무시하지 않는다.
            if (response && !sameOriginal(before, response)) throw stopped();
            const after = await runtime.getQueueInvocation(requestId);
            if (!sameOriginal(before, after) || !['unknown', 'completed'].includes(after.state)) throw stopped();
            // unknown은 완료/재전송 허가가 아니다. 최종 pending 조회가 새 실행을 계속 막는다.
          }
          live(); cursor = requestId;
        }
      }
    } finally { clearTimeout(timer); }
  }
  return Object.freeze({
    scan(signal?: AbortSignal): Promise<void> {
      if (signal?.aborted) return Promise.reject(stopped());
      if (!running) running = scan(signal).finally(() => { running = null; });
      return running;
    },
  });
}
