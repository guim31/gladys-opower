// -----------------------------------------------------------------------------
// A whole world for the end-to-end tests: the SDK's fake Gladys, the app wired
// to it, a fake web serving the PG&E sign-in and the Opower API, an in-memory
// store, a clock the test moves, and the log lines the app wrote.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { createApp, registerHandlers } from '../../src/app.js';
import { createMemoryStore } from '../../src/store.js';
import { createFakeWeb } from './fake-web.js';
import { serveOpower } from './opower-server.js';
import { servePge } from './pge-site.js';

// Noon in Los Angeles, mid-August 2026: before the real "now" of the test run,
// so the fake Gladys takes the intervals as elapsed.
export const NOON = Date.parse('2026-08-15T19:00:00Z');

export const PGE_CONFIG = {
  utility: 'pge',
  username: 'user@example.com',
  password: 'correct horse',
  language: 'en',
  history_days: '7',
};

/** A logger recording every line, by level. */
export function recordingLogger() {
  const lines = [];
  const record =
    (level) =>
    (...args) =>
      lines.push({
        level,
        text: args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '),
      });
  return {
    lines,
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    at: (level) => lines.filter((line) => line.level === level).map((line) => line.text),
  };
}

/**
 * @param {object} [options]
 * @param {object} [options.config]
 * @param {number} [options.now] the clock (ms), moved through `world.clock`
 * @param {number} [options.lagHours] how late the meter data is (hours)
 * @param {object} [options.pge] options of the PG&E site
 * @param {object} [options.opower] options of the Opower service
 * @param {object} [options.store] the persisted state to start from
 * @param {Array} [options.devices] devices already created in Gladys
 * @param {boolean} [options.timers] arm the refresh timer
 */
export function createWorld({
  config = PGE_CONFIG,
  now = NOON,
  lagHours = 30,
  pge = {},
  opower = {},
  store = createMemoryStore(),
  devices = [],
  timers = false,
} = {}) {
  const clock = { ms: now };
  const web = createFakeWeb();
  const site = servePge(web, pge);
  const service = serveOpower(web, {
    dataUntil: () => clock.ms - lagHours * 3600 * 1000,
    ...opower,
  });
  const gladys = createFakeGladys({ config, devices });
  const logger = recordingLogger();
  const app = createApp({
    gladys,
    store,
    fetch: web.fetch,
    now: () => clock.ms,
    timers,
    logger,
    gladysTimeZone: 'UTC',
  });
  registerHandlers(gladys, app);
  return {
    clock,
    web,
    site,
    service,
    gladys,
    app,
    store,
    logger,
    async connect() {
      await gladys.connect();
    },
    /** Add every discovered meter to Gladys, as the user would. */
    async addAllMeters() {
      for (const device of gladys.fake.discoveredDevices) {
        await gladys.fake.deviceCreated(device);
      }
    },
    async stop() {
      app.stop();
      await gladys.disconnect();
    },
  };
}
