/** 별도 큐 실행기: DB 기한 기반으로 양보/재시도/예산 연기 작업을 이어 실행한다. 전수 cron이 아니다. */
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
