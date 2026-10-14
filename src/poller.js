// -----------------------------------------------------------------------------
// The container's own refresh timer.
//
// Opower publishes a day of readings once a day, a day or two late: one read
// every 12 hours keeps Gladys at most 12 hours behind, the pace of the Home
// Assistant integration, and spares the utilities' sites. A cycle that could
// not reach the utility is retried after an hour.
//
// The core cannot be trusted to poll an external device: Gladys 5.2 skips the
// devices created without `should_poll`, and keeps that forever
// (GladysAssistant/Gladys#3198). So this timer does the work, and the core's
// onPoll (once a minute) is a fallback that only runs a cycle when the timer
// missed one: never two reads of the utility in a period.
// -----------------------------------------------------------------------------

export const REFRESH_PERIOD_MS = 12 * 3600 * 1000;
export const RETRY_DELAY_MS = 3600 * 1000;

/**
 * @param {object} options
 * @param {() => Promise<{ retry?: boolean } | void>} options.run one cycle (never throws)
 * @param {() => number} [options.now]
 * @param {boolean} [options.timers] arm the timer (the tests drive the cycles by hand)
 * @param {number} [options.periodMs]
 */
export function createPoller({
  run,
  now = () => Date.now(),
  timers = true,
  periodMs = REFRESH_PERIOD_MS,
  retryMs = RETRY_DELAY_MS,
}) {
  let timer = null;
  let stopped = true;
  let lastRunAt = null;
  let nextDelay = periodMs;

  function schedule(delay) {
    clearTimeout(timer);
    timer = null;
    if (!timers || stopped) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      api.runNow().finally(() => schedule(nextDelay));
    }, delay);
    // The timer must not keep a stopping process alive.
    timer.unref?.();
  }

  const api = {
    /** Run a cycle now and note when. */
    async runNow() {
      lastRunAt = now();
      const outcome = await run();
      nextDelay = outcome?.retry ? retryMs : periodMs;
      return outcome;
    },

    /** (Re)start: a cycle now, then one every period. */
    async start() {
      stopped = false;
      const outcome = await api.runNow();
      schedule(nextDelay);
      return outcome;
    },

    /**
     * The core's poll: a cycle only when the timer has not run one for 90 %
     * of a period (it stalled, or the container just started without it).
     * @returns {Promise<boolean>} true when a cycle ran
     */
    async fromCore() {
      if (lastRunAt !== null && now() - lastRunAt < nextDelay * 0.9) {
        return false;
      }
      await api.runNow();
      schedule(nextDelay);
      return true;
    },

    /** When the last cycle started (ms), or null. */
    get lastRunAt() {
      return lastRunAt;
    },

    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
    },
  };
  return api;
}
