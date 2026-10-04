/** 별도 큐 실행기: DB 기한 기반으로 양보/재시도/예산 연기 작업을 이어 실행한다. 전수 cron이 아니다. */
export function createBackgroundQueueScheduler(
  {
    repository,
    invoke,
    onError = () => {},
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    elapsed = () => Date.now(),
  },
) {
  let stopped = false, running = false, requested = false, timer = null;
  let completion = null;
  let lastKind = null;
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
        if (
          !schedule || typeof schedule.serverNow !== "string" ||
          !Number.isFinite(Date.parse(schedule.serverNow)) ||
          (schedule.nextDueAt !== null &&
            (typeof schedule.nextDueAt !== "string" ||
              !Number.isFinite(Date.parse(schedule.nextDueAt))))
        ) {
          throw new Error("INVALID_QUEUE_SCHEDULE");
        }
        if (schedule.nextDueAt === null) break;
        if (
          !["review_summary", "event_sync"].includes(schedule.nextKind) ||
          excludedKinds.has(schedule.nextKind)
        ) {
          throw new Error("INVALID_QUEUE_KIND");
        }
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
          const next = await scheduleQueue();
          if (
            next?.nextDueAt &&
            Date.parse(next.nextDueAt) > Date.parse(next.serverNow)
          ) {
            timer = setTimer(
              () => {
                timer = null;
                void drain();
              },
              Math.min(
                Date.parse(next.nextDueAt) - Date.parse(next.serverNow),
                2_147_483_647,
              ),
            );
          }
          break;
        }
        if (
          typeof lease.token !== "string" || !lease.token ||
          !Number.isFinite(Date.parse(lease.expiresAt))
        ) throw new Error("INVALID_QUEUE_LEASE");
        try {
          const result = await invoke(lease.token, schedule.nextKind);
          if (!result || !["ran", "not_enabled"].includes(result.status)) {
            throw new Error("INVALID_QUEUE_INVOCATION");
          }
          // 준비 미완료·빈 점유는 이 drain에서 해당 종류만 제외한다. 다음 명시 wake는 다시 확인한다.
          if (result.status === "not_enabled" || result.counts?.claimed === 0) {
            excludedKinds.add(schedule.nextKind);
            requested = excludedKinds.size < 2;
          } else {
            lastKind = schedule.nextKind;
            // 한 종류가 끝나도 다른 due 종류가 있는지 확인한다. DB가 afterKind와 전역 마지막 처리 종류를 사용해 교대한다.
            requested = true;
          }
        } finally {
          const result = await repository.release(lease.token);
          if (!["applied", "lease_lost"].includes(result)) {
            throw new Error("INVALID_QUEUE_LEASE_RELEASE");
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
