/** Durable reservations live in PostgreSQL. Timers are disposable wakeups, never authority. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TIMER_MS = 2_147_483_647;

function snapshot(value) {
  const serverNow = Date.parse(value?.serverNow);
  if (!Number.isFinite(serverNow) || !Array.isArray(value?.reservations)) throw new Error("INVALID_RESERVATIONS");
  const seen = new Set();
  const rows = value.reservations.map((row) => {
    const due = Date.parse(row?.dueAt);
    if (!UUID.test(row?.appointmentId) || !UUID.test(row?.generation) || !Number.isFinite(due) || seen.has(row.appointmentId)) {
      throw new Error("INVALID_RESERVATIONS");
    }
    seen.add(row.appointmentId);
    return { appointmentId: row.appointmentId, generation: row.generation, due };
  });
  return { serverNow, rows: rows.sort((a, b) => a.due - b.due || a.appointmentId.localeCompare(b.appointmentId)) };
}

/**
 * Call wake only on startup/reconnect, committed DB notification, or the next due timer.
 * Subscribe before the initial snapshot to avoid losing a commit between load and LISTEN.
 * DB rechecks its own clock, current state and generation; a stale timer cannot complete a trip.
 */
export function createCompletionScheduler({ repository, setTimer = setTimeout, clearTimer = clearTimeout,
  monotonicNow = () => performance.now(), onError = () => {} }) {
  let stopped = false, dirty = false, running = null, timer = null;
  const clear = () => { if (timer !== null) clearTimer(timer); timer = null; };
  async function drain() {
    try {
      while (dirty && !stopped) {
        dirty = false;
        clear();
        const started = monotonicNow();
        const { serverNow, rows } = snapshot(await repository.list());
        if (stopped) return;
        // Subtract only monotonic request time. An early wake is harmless: execution uses DB time.
        const elapsed = Math.max(0, monotonicNow() - started);
        const due = rows.filter((row) => row.due <= serverNow);
        if (due.length) {
          for (const row of due) {
            if (stopped) return;
            const result = await repository.execute(row.appointmentId, row.generation);
            if (!["completed", "not_due", "stale"].includes(result?.status)) throw new Error("INVALID_COMPLETION_RESULT");
          }
          // Refresh after writes to observe removal, rescheduling and concurrent changes.
          // PG retains microseconds while JS timers have milliseconds: avoid a same-tick spin.
          timer = setTimer(() => { timer = null; void wake(); }, 1);
        } else if (rows.length) {
          timer = setTimer(() => { timer = null; void wake(); }, Math.min(MAX_TIMER_MS, Math.max(1, rows[0].due - serverNow - elapsed)));
        }
        // No reservations: no recurring scan timer at all.
      }
    } catch {
      stopped = true;
      clear();
      onError("COMPLETION_SCHEDULER_UNAVAILABLE");
    }
  }
  function wake() {
    if (stopped) return Promise.resolve();
    dirty = true;
    if (!running) {
      running = drain().finally(() => {
        running = null;
        if (dirty && !stopped) void wake();
      });
    }
    return running;
  }
  return {
    wake,
    async stop() { stopped = true; clear(); await running; },
  };
}
