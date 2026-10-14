// -----------------------------------------------------------------------------
// Repeated failures, logged once.
//
// A utility down for a day fails every cycle, a widget asked every few
// minutes fails as often: each would write the same warning again and again.
// An issue log keeps, per key, whether the problem is ongoing: the first
// failure is a warning, the next ones go to debug, and the recovery is one
// info line.
// -----------------------------------------------------------------------------

/**
 * @param {{ debug: Function, info: Function, warn: Function }} logger
 */
export function createIssueLog(logger) {
  const ongoing = new Set();
  return {
    /**
     * Report a failure: a warning the first time, debug while it lasts.
     * @param {string} key what failed (one key per independent problem)
     * @param {string} message
     */
    fail(key, message) {
      if (ongoing.has(key)) {
        logger.debug(`${message} (still failing)`);
        return;
      }
      ongoing.add(key);
      logger.warn(message);
    },

    /**
     * Report a success: one info line when it ends an ongoing failure.
     * @param {string} key
     * @param {string} message
     */
    ok(key, message) {
      if (ongoing.delete(key)) {
        logger.info(message);
      }
    },

    /** @param {string} key */
    isFailing(key) {
      return ongoing.has(key);
    },
  };
}
