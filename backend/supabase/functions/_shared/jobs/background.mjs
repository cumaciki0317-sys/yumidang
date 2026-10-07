/** 별도 큐 실행기: DB 기한 기반으로 양보/재시도/예산 연기 작업을 이어 실행한다. 전수 cron이 아니다. */
export const QUEUE_KINDS = Object.freeze(["review_summary", "event_sync", "member_cleanup", "cancellation_safety", "report_retention"]);

export function createBackgroundQueueScheduler(
  {
    repository,
    invoke,
    onError = () => {},
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    elapsed = () => performance.now(),
  },
) {
  let stopped = false, running = false, requested = false, timer = null;
  let completion = null;
  let lastKind = null;
  const kinds = ["review_summary", "event_sync", "member_cleanup"];
  const record = (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const validSchedule = (value, excluded) => {
    if (
      !record(value) || typeof value.serverNow !== "string" ||
      !Number.isFinite(Date.parse(value.serverNow)) ||
      (value.nextDueAt !== null &&
        (typeof value.nextDueAt !== "string" ||
          !Number.isFinite(Date.parse(value.nextDueAt))))
    ) {
      throw new Error("INVALID_QUEUE_SCHEDULE");
    }
    if (
      (value.nextKind !== null && !kinds.includes(value.nextKind)) ||
      (value.nextDueAt !== null &&
        (!kinds.includes(value.nextKind) || excluded.has(value.nextKind)))
    ) {
      throw new Error("INVALID_QUEUE_KIND");
    }
    return value;
  };
  const validInvocation = (value) => {
    if (!record(value)) return false;
    if (value.status === "not_enabled") {
      return value.reason === undefined || typeof value.reason === "string";
    }
    return value.status === "ran" && record(value.counts) &&
      Number.isSafeInteger(value.counts.claimed) &&
      value.counts.claimed >= 0 &&
      Object.values(value.counts).every((n) =>
        Number.isSafeInteger(n) && n >= 0
      );
  };
  const clear = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };
  async function drain() {
    if (stopped) return;
    if (running) {
      requested = true;
      return;
    }
    running = true;
    clear();
    let finish;
    completion = new Promise((resolve) => {
      finish = resolve;
    });
    const excludedKinds = new Set();
    const scheduleQueue = () =>
      repository.schedule({
        excludeKinds: [...excludedKinds],
        afterKind: lastKind,
      });
    try {
      do {
        requested = false;
        const started = elapsed();
        const schedule = await scheduleQueue();
        if (stopped) return;
        validSchedule(schedule, excludedKinds);
        if (schedule.nextDueAt === null) break;
        const delay = Date.parse(schedule.nextDueAt) -
          Date.parse(schedule.serverNow) - Math.max(0, elapsed() - started);
        if (delay > 0) {
          timer = setTimer(() => {
            timer = null;
            void drain();
          }, Math.min(delay, 2_147_483_647));
          break;
        }
        // 모든 runner 인스턴스와 일일 즉시 실행이 공유해야 하는 DB 전역 점유. 자동 연장 없음.
        const lease = await repository.acquire();
        if (!lease) {
          // DB schedule은 현재 실행 점유 만료까지 nextDueAt을 뒤로 보내야 한다.
          // 충돌 직후 같은 due를 무한 재조회하지 않는다. DB 변경 알림 또는 명시 wake를 기다린다.
          const nextStarted = elapsed();
          const next = validSchedule(await scheduleQueue(), excludedKinds);
          if (stopped) return;
          const nextDelay = next.nextDueAt === null
            ? 0
            : Date.parse(next.nextDueAt) -
              Date.parse(next.serverNow) - Math.max(0, elapsed() - nextStarted);
          if (nextDelay > 0) {
            timer = setTimer(() => {
              timer = null;
              void drain();
            }, Math.min(nextDelay, 2_147_483_647));
          }
          break;
        }
        if (
          !record(lease) || typeof lease.token !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
            .test(lease.token) ||
          typeof lease.expiresAt !== "string" ||
          !Number.isFinite(Date.parse(lease.expiresAt))
        ) throw new Error("INVALID_QUEUE_LEASE");
        let releasePermitted = false;
        try {
          const result = await invoke(lease.token, schedule.nextKind);
          if (!validInvocation(result)) {
            throw new Error("INVALID_QUEUE_INVOCATION");
          }
          releasePermitted = true;
          // 준비 미완료·빈 점유는 이 drain에서 해당 종류만 제외한다. 다음 명시 wake는 다시 확인한다.
          if (result.status === "not_enabled" || result.counts?.claimed === 0) {
            excludedKinds.add(schedule.nextKind);
            requested = excludedKinds.size < kinds.length;
          } else {
            lastKind = schedule.nextKind;
            // 한 종류가 끝나도 다른 due 종류가 있는지 확인한다. DB가 afterKind와 전역 마지막 처리 종류를 사용해 교대한다.
            requested = true;
          }
        } catch (error) {
          // fetch 시작 뒤 오류/응답 유실은 원격 종료 증거가 아니다. 조기 해제·연장은 하지 않는다.
          releasePermitted = error?.releasePermitted === true;
          if (!releasePermitted && !stopped) {
            // 재실행 시각은 DB 점유 만료를 반영한 schedule과 DB 시계로만 판단한다.
            const retryStarted = elapsed();
            const next = validSchedule(await scheduleQueue(), excludedKinds);
            const retryDelay = next.nextDueAt === null
              ? 0
              : Date.parse(next.nextDueAt) -
                Date.parse(next.serverNow) -
                Math.max(0, elapsed() - retryStarted);
            if (!stopped && retryDelay > 0) {
              timer = setTimer(() => {
                timer = null;
                void drain();
              }, Math.min(retryDelay, 2_147_483_647));
            }
          }
          throw error;
        } finally {
          if (releasePermitted) {
            const result = await repository.release(lease.token);
            if (!["applied", "lease_lost"].includes(result)) {
              throw new Error("INVALID_QUEUE_LEASE_RELEASE");
            }
          }
        }
      } while (requested && !stopped);
    } catch {
      onError("WORKER_QUEUE_UNAVAILABLE");
    } finally {
      running = false;
      finish();
      completion = null;
    }
  }
  return {
    wake: drain,
    async stop() {
      stopped = true;
      requested = false;
      clear();
      if (completion) await completion;
    },
  };
}

/**
 * 5종 공유 cycle의 준비 포트. 공통 count/journal/terminal 계약을 주입한 경우만 사용한다.
 * 이 함수의 내부 객체는 제안 포트이며 새로운 DB RPC/HTTP wire 계약이 아니다.
 * readSchedule은 소유한 globalToken을 고려해 조회해야 한다. 자신의 lease를 기다리는 조회를 재사용하지 않는다.
 * unitsFor의 정책 단위·journal 영속 저장·terminal 조회는 민규 계약 확인 전 모형으로만 제공한다.
 */
export function createSharedBackgroundQueueScheduler({
  repository, invoke, contracts, supportedKinds = QUEUE_KINDS,
  queryTimeoutMs,
  onError = () => {}, setTimer = setTimeout, clearTimer = clearTimeout,
  elapsed = () => performance.now(),
}) {
  const record = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const id = v => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  if (!contracts?.decisionId?.trim() || typeof contracts.readBudget !== "function" ||
    typeof contracts.unitsFor !== "function" ||
    ["hasPending", "begin", "confirm", "unknown"].some(k => typeof contracts.journal?.[k] !== "function") ||
    ["readSchedule", "run"].some(k => typeof contracts.maintenance?.[k] !== "function") ||
    ["schedule", "acquire", "release"].some(k => typeof repository?.[k] !== "function") ||
    typeof invoke !== "function" || !Array.isArray(supportedKinds) || !supportedKinds.length ||
    new Set(supportedKinds).size !== supportedKinds.length || supportedKinds.some(k => !QUEUE_KINDS.includes(k)) ||
    !Number.isSafeInteger(queryTimeoutMs) || queryTimeoutMs < 1 || queryTimeoutMs > 10000) {
    throw new Error("SHARED_QUEUE_CONTRACT_NOT_READY");
  }
  let stopped = false, unknown = false, running = null, dirty = false;
  let timer = null, terminalTimer = null, lastKind = null;
  const pendingReads = new Set();
  // 공통 DB query timeout을 사용한다. 새 폴링 주기나 자체 lease 기한을 만들지 않는다.
  const read = operation => new Promise((resolve, reject) => {
    const controller = new AbortController();
    pendingReads.add(controller);
    const deadline = setTimer(() => controller.abort(), queryTimeoutMs);
    const cleanup = () => {
      clearTimer(deadline); pendingReads.delete(controller);
      controller.signal.removeEventListener("abort", abort);
    };
    const abort = () => { cleanup(); reject(new Error("QUEUE_PORT_UNAVAILABLE")); };
    controller.signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error("QUEUE_PORT_UNAVAILABLE");
      return operation();
    }).then(resolve, reject).finally(cleanup);
  });
  const clear = () => {
    if (timer !== null) clearTimer(timer);
    if (terminalTimer !== null) clearTimer(terminalTimer);
    timer = terminalTimer = null;
  };
  function schedule(value, excluded, terminal = false) {
    const keys = terminal ? ["serverNow", "nextDueAt"] : ["serverNow", "nextDueAt", "nextKind"];
    if (!record(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k)) ||
      typeof value.serverNow !== "string" || !Number.isFinite(Date.parse(value.serverNow)) ||
      (value.nextDueAt !== null && (typeof value.nextDueAt !== "string" || !Number.isFinite(Date.parse(value.nextDueAt)))) ||
      (!terminal && (value.nextDueAt === null ? value.nextKind !== null :
        !supportedKinds.includes(value.nextKind) || excluded.has(value.nextKind)))) throw new Error("INVALID_QUEUE_SCHEDULE");
    return value;
  }
  function arm(value, started, terminal, continueDue = false) {
    if (value.nextDueAt === null || stopped || unknown) return;
    const delay = Date.parse(value.nextDueAt) - Date.parse(value.serverNow) - Math.max(0, elapsed() - started);
    if (delay <= 0 && !continueDue) return;
    const handle = setTimer(() => {
      if (terminal) terminalTimer = null; else timer = null;
      void wake();
    }, Math.min(Math.max(1, delay), 2_147_483_647));
    if (terminal) terminalTimer = handle; else timer = handle;
  }
  async function drain() {
    let lease = null, releasePermitted = true, progressed = false;
    const excluded = new Set(QUEUE_KINDS.filter(k => !supportedKinds.includes(k)));
    const getQueue = token => read(() => repository.schedule({ excludeKinds: [...excluded], afterKind: lastKind, globalToken: token }));
    try {
      clear(); dirty = false;
      // 재시작/새 인스턴스도 미확인 기록이 있으면 dispatch를 만들지 않는다.
      const pending = await read(() => contracts.journal.hasPending());
      if (typeof pending !== "boolean") throw new Error("INVALID_QUEUE_JOURNAL");
      if (pending) { unknown = true; onError("WORKER_QUEUE_RECONCILIATION_REQUIRED"); return; }
      let started = elapsed();
      let next = schedule(await getQueue(null), excluded);
      arm(next, started, false);
      started = elapsed();
      const terminal = schedule(await read(() => contracts.maintenance.readSchedule()), excluded, true);
      arm(terminal, started, true);
      let maintenanceDue = terminal.nextDueAt !== null && Date.parse(terminal.nextDueAt) <= Date.parse(terminal.serverNow);
      const due = next.nextDueAt !== null && Date.parse(next.nextDueAt) <= Date.parse(next.serverNow);
      if (stopped || (!due && !maintenanceDue)) return;
      lease = await read(() => repository.acquire());
      if (lease === null) {
        // 경쟁자의 점유 만료를 반영한 DB 기한을 다시 읽는다. 새 알림이 없어도 재개하되
        // 같은 due를 즉시 반복하거나 자연 만료를 원격 종결 증거로 사용하지 않는다.
        if (stopped) return;
        started = elapsed();
        arm(schedule(await getQueue(null), excluded), started, false);
        started = elapsed();
        arm(schedule(await read(() => contracts.maintenance.readSchedule()), excluded, true), started, true);
        return;
      }
      if (!record(lease) || !id(lease.token) || typeof lease.expiresAt !== "string" || !Number.isFinite(Date.parse(lease.expiresAt))) {
        releasePermitted = false; throw new Error("INVALID_QUEUE_LEASE");
      }
      let remainingUnits = 20;
      while (!stopped && remainingUnits > 0) {
        const budgetStarted = elapsed();
        const budget = await read(() => contracts.readBudget(lease.token));
        if (!record(budget) || Object.keys(budget).length !== 1 || !Number.isSafeInteger(budget.remainingMs) ||
          budget.remainingMs < 0 || budget.remainingMs > 180000) throw new Error("INVALID_QUEUE_BUDGET");
        let remainingMs = budget.remainingMs - Math.max(0, elapsed() - budgetStarted);
        if (remainingMs <= 0 || stopped) break;
        if (!maintenanceDue) {
          started = elapsed();
          next = schedule(await getQueue(lease.token), excluded);
          arm(next, started, false);
          if (stopped || next.nextDueAt === null || Date.parse(next.nextDueAt) > Date.parse(next.serverNow)) break;
        }
        // 예약 조회 시간도 같은 DB budget에서 차감한다.
        remainingMs = budget.remainingMs - Math.max(0, elapsed() - budgetStarted);
        if (remainingMs <= 0 || stopped) break;
        const kind = maintenanceDue ? null : next.nextKind;
        const controller = new AbortController();
        const deadline = setTimer(() => controller.abort(), Math.max(1, Math.floor(remainingMs)));
        const bounded = operation => new Promise((resolve, reject) => {
          const abort = () => reject(new Error("QUEUE_DEADLINE_UNKNOWN"));
          if (controller.signal.aborted) return abort();
          controller.signal.addEventListener("abort", abort, { once: true });
          Promise.resolve().then(() => {
            if (controller.signal.aborted) throw new Error("QUEUE_DEADLINE_UNKNOWN");
            return operation();
          }).then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", abort));
        });
        let ticket = null;
        // journal.begin 자체 응답 유실도 새 intent 여부가 미확인이다.
        releasePermitted = false;
        try {
          ticket = await bounded(() => contracts.journal.begin({ globalToken: lease.token, kind }));
          if (!id(ticket) || controller.signal.aborted || stopped) throw new Error("INVALID_QUEUE_JOURNAL");
          const options = Object.freeze({ limit: remainingUnits, remainingMs, signal: controller.signal });
          const result = await bounded(() => kind === null ? contracts.maintenance.run(lease.token, options) : invoke(lease.token, kind, options));
          if (controller.signal.aborted) throw new Error("QUEUE_DEADLINE_UNKNOWN");
          const disabled = kind !== null && record(result) && result.status === "not_enabled" && typeof result.reason === "string";
          const valid = kind === null ? record(result) && Object.keys(result).length === 1 && Number.isSafeInteger(result.purged) && result.purged >= 0 && result.purged <= remainingUnits :
            disabled || record(result) && result.status === "ran" && record(result.counts) &&
            Number.isSafeInteger(result.counts.claimed) && result.counts.claimed >= 0 &&
            Object.values(result.counts).every(n => Number.isSafeInteger(n) && n >= 0);
          if (!valid) throw new Error("INVALID_QUEUE_INVOCATION");
          const units = contracts.unitsFor(kind, result);
          if (!Number.isSafeInteger(units) || units < 0 || units > remainingUnits ||
            (!disabled && (kind === null ? result.purged > 0 : result.counts.claimed > 0) && units === 0)) throw new Error("INVALID_QUEUE_UNITS");
          if (await bounded(() => contracts.journal.confirm(ticket)) !== true) throw new Error("QUEUE_ACK_UNKNOWN");
          releasePermitted = true;
          remainingUnits -= units;
          progressed ||= units > 0;
          if (kind === null) maintenanceDue = false;
          else {
            lastKind = kind;
            if (disabled || result.counts.claimed === 0 || units === 0) excluded.add(kind);
          }
        } catch (error) {
          unknown = true; dirty = false; clear();
          // 최소 ID만 보존한다. 원문·Storage 경로·공급사 응답은 journal 인자가 아니다.
          try { await read(() => contracts.journal.unknown(ticket)); } catch { /* 미확인 상태 유지 */ }
          throw error;
        } finally { clearTimer(deadline); }
      }
    } catch {
      onError(unknown ? "WORKER_QUEUE_RECONCILIATION_REQUIRED" : "WORKER_QUEUE_UNAVAILABLE");
    } finally {
      if (lease && releasePermitted) {
        try {
          if (!["applied", "lease_lost"].includes(await read(() => repository.release(lease.token)))) throw new Error();
          if (progressed && !stopped && !unknown) {
            // 실제 진전이 있는 cycle만 후속 due를 예약한다. 빈 큐/미준비/예산0 hot loop를 만들지 않는다.
            let started = elapsed();
            arm(schedule(await getQueue(null), excluded), started, false, true);
            started = elapsed();
            arm(schedule(await read(() => contracts.maintenance.readSchedule()), excluded, true), started, true, true);
          }
        } catch { unknown = true; dirty = false; clear(); onError("WORKER_QUEUE_RECONCILIATION_REQUIRED"); }
      }
    }
  }
  function wake() {
    if (stopped || unknown) return Promise.resolve();
    dirty = true;
    if (!running) running = drain().finally(() => {
      running = null;
      if (dirty && !stopped && !unknown) void wake();
    });
    return running;
  }
  return { wake, async stop() { stopped = true; dirty = false; clear(); for (const controller of pendingReads) controller.abort(); await running; } };
}
