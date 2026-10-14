// -----------------------------------------------------------------------------
// The integration: one cycle reads the utility and feeds Gladys.
//
// A cycle (every 12 hours, src/poller.js):
//   1. signs in to the utility (a fresh session each time: the utilities'
//      sessions last minutes), with the saved data that skips the code;
//   2. lists the meters and their bill forecast;
//   3. reads each meter: hourly usage (electricity on a smart meter) and the
//      daily usage with its cost, from the last day Gladys has (3 days of
//      overlap: utilities correct their recent readings) or, the first time,
//      from the history the user chose;
//   4. publishes the devices, the dated consumption of the energy tracking,
//      the summaries, and the "new day" scene events.
// What the utility answered is kept in memory: a device added later, the
// widget and the scene action are served from it without a new sign-in.
//
// The sign-in may stop on a verification code (PG&E, Exelon): the challenge is
// kept, and the "Send the verification code" / "Enter the code" actions of the
// Configuration screen finish it. The data that skips the code next time is
// saved in /data.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { DEFAULT_CONFIG, isConfigured, normalizeConfig, secretsOf } from './config.js';
import { InvalidAuthError, MfaRequiredError } from './errors.js';
import { createHttpSession } from './http.js';
import { CODE_METHODS, MESSAGES } from './i18n.js';
import { createIssueLog } from './issues.js';
import { buildDevice, consumptionKey, meterIds, readingMode, summaryStates } from './meters.js';
import { createOpowerClient } from './opower/client.js';
import { createPoller } from './poller.js';
import { emptyState, identityOf } from './store.js';
import { computeSummary, toDailyConsumption, toHalfHours } from './summary.js';
import { addDays, DAY_MS, localDate, monthStart, startOfLocalDay } from './time.js';
import { findUtility } from './utilities/index.js';
import { buildWidgetContent } from './widgets.js';

export const ACTION = {
  REFRESH: 'refresh_now',
  SEND_CODE: 'send_code',
  SUBMIT_CODE: 'submit_code',
};

export const TRIGGER = {
  DAILY_USAGE: 'daily_usage_available',
  SIGN_IN_REQUIRED: 'sign_in_required',
};

export const SCENE_ACTION = {
  SUMMARY: 'get_meter_summary',
};

export const WIDGET = {
  SUMMARY: 'energy_summary',
};

// Utilities correct their last readings (estimated → actual): every cycle
// sends the last 3 days again; the core writes only what changed.
const OVERLAP_DAYS = 3;
// A code request older than this is dropped: the utilities' codes expire.
const CODE_TTL_MS = 10 * 60 * 1000;
// A manual refresh within this delay of a successful one is refused.
const MANUAL_REFRESH_MIN_MS = 15 * 60 * 1000;
// An action answers within its timeout; a longer refresh goes on alone.
const ACTION_WAIT_MS = 100 * 1000;
// Re-send unchanged summaries at least this often ("no recent value" otherwise).
const HEARTBEAT_MS = 6 * 3600 * 1000;
const MAX_INTERVALS_PER_CALL = 2000;

const earliest = (...dates) => [...dates].sort()[0];

/** A logger that blanks the configured secrets, whatever a message carries. */
function redacting(base, secrets) {
  const clean = (args) =>
    args.map((arg) => {
      let text = arg instanceof Error ? arg.message : arg;
      if (typeof text !== 'string') {
        return arg;
      }
      for (const secret of secrets()) {
        text = text.split(secret).join('***');
      }
      return text;
    });
  return {
    debug: (...args) => base.debug(...clean(args)),
    info: (...args) => base.info(...clean(args)),
    warn: (...args) => base.warn(...clean(args)),
    error: (...args) => base.error(...clean(args)),
  };
}

/** Several multi-language messages joined, language by language. */
function mergeMessages(...messages) {
  const merged = {};
  for (const language of Object.keys(messages[0])) {
    merged[language] = messages.map((message) => message[language]).join(' ');
  }
  return merged;
}

/** A reason short enough for a status line. */
function reasonOf(err) {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 120 ? `${message.slice(0, 117)}...` : message;
}

/**
 * @param {object} options
 * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
 * @param {object} options.store persistence (src/store.js)
 * @param {typeof fetch} [options.fetch] for the utility and Opower requests
 * @param {() => number} [options.now]
 * @param {boolean} [options.timers] arm the refresh timer
 * @param {object} [options.logger]
 * @param {string} [options.gladysTimeZone] the zone Gladys stamps daily states in
 */
export function createApp({
  gladys,
  store,
  fetch: fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timers = true,
  logger: baseLogger = createLogger({ name: 'opower' }),
  gladysTimeZone = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
}) {
  let config = normalizeConfig(DEFAULT_CONFIG);
  const logger = redacting(baseLogger, () => secretsOf(config));
  const issues = createIssueLog(logger);
  let persisted = emptyState();

  /** Meters read by the last cycle, by account uuid. */
  let meters = new Map();
  /** The verification code the sign-in waits for. */
  let pending = null;
  /** 'code' | 'password' while the sign-in is blocked, for the status and the trigger. */
  let signInProblem = null;
  let lastSuccessAt = null;
  let running = null;

  const utility = () => findUtility(config.utility);
  const identity = () => identityOf(config.utility, config.username);

  async function setStatus(connected, message) {
    try {
      await gladys.setConnectionStatus(connected, message);
    } catch (err) {
      logger.debug(`Connection status not sent: ${reasonOf(err)}`);
    }
  }

  async function save() {
    try {
      await store.save(persisted);
    } catch (err) {
      issues.fail('store', `Cannot write the state file: ${reasonOf(err)}`);
      return;
    }
    issues.ok('store', 'The state file is writable again');
  }

  function createdDevices() {
    return new Set((gladys.devices ?? []).map((device) => device.external_id));
  }

  function meterByDevice(externalId) {
    for (const meter of meters.values()) {
      if (meterIds(gladys, meter.account).device === externalId) {
        return meter;
      }
    }
    return null;
  }

  async function publishDevices() {
    const target = utility();
    const devices = [...meters.values()].map((meter) =>
      buildDevice(gladys, meter.account, target, config.language),
    );
    await gladys.publishDiscoveredDevices(devices);
  }

  async function blockSignIn(kind, message) {
    await setStatus(false, message);
    if (signInProblem !== kind) {
      signInProblem = kind;
      try {
        await gladys.publishSceneEvent(TRIGGER.SIGN_IN_REQUIRED, {
          utility: utility()?.shortName ?? config.utility,
          reason: kind,
        });
      } catch (err) {
        logger.debug(`Sign-in event not sent: ${reasonOf(err)}`);
      }
    }
  }

  /**
   * Sign in. Resolves the signed-in session and Opower client, or null when
   * the sign-in is blocked (status and logs done).
   */
  async function signIn(target) {
    const session = createHttpSession({ fetch: fetchImpl });
    const instance = target.create();
    const id = identity();
    try {
      const { token, loginData } = await instance.login(session, {
        username: config.username,
        password: config.password,
        totpSecret: config.totp_secret,
        loginData: persisted.loginData[id] ?? {},
      });
      if (loginData) {
        persisted.loginData[id] = loginData;
        await save();
      }
      if (pending?.identity === id) {
        pending = null;
      }
      issues.ok('auth', `Signed in to ${target.shortName} again`);
      issues.ok('reach', `${target.shortName} answers again`);
      return {
        session,
        client: createOpowerClient({
          session,
          utility: instance,
          token,
          timezone: target.timezone,
        }),
      };
    } catch (err) {
      if (err instanceof MfaRequiredError) {
        pending = { identity: id, challenge: err.challenge, createdAt: now(), sentAt: null };
        if (signInProblem !== 'code') {
          logger.info(`${target.shortName} asks for a verification code: waiting for the user`);
        }
        const labels = err.challenge
          .options()
          .map((option) => option.label)
          .join(', ');
        await blockSignIn(
          'code',
          labels
            ? mergeMessages(MESSAGES.codeRequired, MESSAGES.codeChoice(labels))
            : MESSAGES.codeRequired,
        );
        return null;
      }
      if (err instanceof InvalidAuthError) {
        issues.fail('auth', `${target.shortName} refused the sign-in: ${reasonOf(err)}`);
        await blockSignIn('password', MESSAGES.invalidAuth);
        return null;
      }
      issues.fail('reach', `${target.shortName} sign-in failed: ${reasonOf(err)}`);
      await setStatus(false, MESSAGES.cannotConnect(reasonOf(err)));
      throw err;
    }
  }

  /** Read one meter; resolves what the cycle publishes for it. */
  async function readMeter(client, account, forecast, target) {
    const tz = target.timezone;
    const at = now();
    const today = localDate(at, tz);
    const thisMonth = monthStart(today);
    const state = persisted.meters[account.uuid] ?? {};
    const cursor = typeof state.fedUntil === 'number' ? state.fedUntil : null;
    // Never more than a year back, even after a long stop.
    const oldest = addDays(today, -365);
    const historyFrom = earliest(
      cursor === null
        ? addDays(today, -config.historyDays)
        : localDate(cursor - OVERLAP_DAYS * DAY_MS, tz),
      today,
    );
    const feedFrom = [historyFrom, oldest].sort().at(-1);
    const recentFrom = earliest(thisMonth, addDays(today, -7));
    const mode = readingMode(account);
    const feedKey = consumptionKey(account);

    let intervalReads = null;
    let daily = { reads: [], withCost: false, unit: null };
    let unit = null;
    if (mode === 'interval') {
      const hourly = await client.getUsageReads(
        account,
        'hour',
        feedKey ? earliest(feedFrom, recentFrom) : recentFrom,
        today,
      );
      intervalReads = hourly.reads;
      unit = hourly.unit;
      try {
        daily = await client.getCostReads(account, 'day', recentFrom, today);
      } catch (err) {
        // The usage is complete without it: the costs stay unknown this cycle.
        logger.debug(`${target.shortName}: no daily cost (${reasonOf(err)})`);
      }
    } else if (mode === 'daily') {
      daily = await client.getCostReads(
        account,
        'day',
        feedKey ? earliest(feedFrom, recentFrom) : recentFrom,
        today,
      );
    }
    unit = daily.unit ?? unit ?? forecast?.unit ?? null;

    const summary = computeSummary({
      meterType: account.meterType,
      intervalReads,
      dailyReads: daily.reads,
      withCost: daily.withCost,
      unit,
      forecast,
      now: at,
      timezone: tz,
    });

    let feed = [];
    if (feedKey) {
      const feedStart = startOfLocalDay(feedFrom, tz);
      feed =
        mode === 'interval'
          ? toHalfHours(
              intervalReads.filter((read) => read.start >= feedStart),
              at,
            )
          : toDailyConsumption(
              daily.reads.filter((read) => read.start >= feedStart),
              at,
              tz,
              gladysTimeZone,
            );
    }
    return { account, summary, feedKey, feed, updatedAt: at, utility: target.shortName };
  }

  /** The end (ms) of the last interval of a feed. */
  function feedEnd(meter, target) {
    const last = meter.feed.at(-1);
    if (!last) {
      return null;
    }
    if (last.starts_at) {
      return Date.parse(last.starts_at) + 30 * 60 * 1000;
    }
    return startOfLocalDay(addDays(last.date, 1), target.timezone);
  }

  /**
   * Send a meter to Gladys: its dated consumption, its summaries, its new-day
   * event. Only for a device the user added (Gladys drops the rest).
   * @returns {Promise<boolean>} false when the device is not created yet
   */
  async function publishMeter(meter) {
    const ids = meterIds(gladys, meter.account);
    const target = utility();
    const state = (persisted.meters[meter.account.uuid] ??= {});
    const created = createdDevices().has(ids.device);

    // The scene event: once per new complete day. The first reading only
    // sets the baseline, so installing never replays the history.
    const lastDay = meter.summary.lastDay;
    let announce = false;
    if (lastDay && lastDay.date !== state.announced) {
      announce = state.announced !== undefined && lastDay.date > state.announced;
      state.announced = lastDay.date;
    }
    if (!created) {
      await save();
      return false;
    }

    if (meter.feedKey && meter.feed.length > 0) {
      const featureId = ids.feature(meter.feedKey);
      try {
        for (let i = 0; i < meter.feed.length; i += MAX_INTERVALS_PER_CALL) {
          await gladys.publishEnergyConsumption(
            featureId,
            meter.feed.slice(i, i + MAX_INTERVALS_PER_CALL),
          );
        }
        const end = target ? feedEnd(meter, target) : null;
        if (end !== null) {
          state.fedUntil = Math.max(state.fedUntil ?? 0, end);
        }
        issues.ok(
          `feed:${meter.account.uuid}`,
          `${meter.utility}: the energy tracking takes the consumption again`,
        );
      } catch (err) {
        issues.fail(
          `feed:${meter.account.uuid}`,
          `${meter.utility}: the energy tracking refused the consumption (${reasonOf(err)})`,
        );
      }
    }

    try {
      await gladys.publishChangedStates(summaryStates(gladys, meter.account, meter.summary), {
        heartbeat: HEARTBEAT_MS,
      });
      issues.ok(`states:${meter.account.uuid}`, `${meter.utility}: states published again`);
    } catch (err) {
      issues.fail(
        `states:${meter.account.uuid}`,
        `${meter.utility}: states not published (${reasonOf(err)})`,
      );
    }

    if (announce) {
      try {
        await gladys.publishSceneEvent(TRIGGER.DAILY_USAGE, {
          meter: ids.device,
          date: lastDay.date,
          usage: lastDay.usage,
          unit: meter.account.meterType === 'GAS' ? 'm³' : 'kWh',
          cost: lastDay.cost,
          month_usage: meter.summary.month.usage,
          month_cost: meter.summary.month.cost,
          forecast_cost: meter.summary.forecast?.cost ?? null,
        });
      } catch (err) {
        logger.debug(`New-day event not sent: ${reasonOf(err)}`);
      }
    }
    await save();
    return true;
  }

  async function refreshWidget() {
    try {
      await gladys.requestWidgetRefresh(WIDGET.SUMMARY);
    } catch (err) {
      logger.debug(`Widget refresh not sent: ${reasonOf(err)}`);
    }
  }

  /**
   * One cycle. Never throws: resolves its outcome, `retry` when the utility
   * could not be reached (the poller tries again within the hour).
   * @returns {Promise<{ status: string, retry?: boolean, reason?: string }>}
   */
  async function cycle() {
    if (!isConfigured(config)) {
      await setStatus(false, MESSAGES.notConfigured);
      return { status: 'not_configured' };
    }
    const target = utility();
    if (!target) {
      await setStatus(false, MESSAGES.unsupportedUtility);
      return { status: 'unsupported' };
    }
    if (pending && pending.identity === identity() && now() - pending.createdAt < CODE_TTL_MS) {
      // A code is on its way: a new sign-in now would make the utility send
      // another one and void it.
      logger.debug('Sign-in waits for the verification code: cycle skipped');
      return { status: 'code' };
    }

    let signedIn;
    try {
      signedIn = await signIn(target);
    } catch (err) {
      return { status: 'unreachable', retry: true, reason: reasonOf(err) };
    }
    if (!signedIn) {
      return { status: signInProblem ?? 'code' };
    }
    if (signInProblem !== null) {
      signInProblem = null;
    }

    let accounts;
    let forecasts;
    try {
      accounts = (await signedIn.client.getAccounts()).filter((account) =>
        ['ELEC', 'GAS'].includes(account.meterType),
      );
      forecasts = await signedIn.client.getForecasts();
      issues.ok('accounts', `${target.shortName}: the meters are listed again`);
    } catch (err) {
      issues.fail('accounts', `${target.shortName}: cannot list the meters (${reasonOf(err)})`);
      await setStatus(false, MESSAGES.cannotConnect(reasonOf(err)));
      return { status: 'unreachable', retry: true, reason: reasonOf(err) };
    }

    const read = new Map();
    let failed = 0;
    for (const account of accounts) {
      const forecast = forecasts.find((entry) => entry.accountUuid === account.uuid) ?? null;
      try {
        read.set(account.uuid, await readMeter(signedIn.client, account, forecast, target));
        issues.ok(`meter:${account.uuid}`, `${target.shortName}: a meter is read again`);
      } catch (err) {
        failed += 1;
        issues.fail(
          `meter:${account.uuid}`,
          `${target.shortName}: a meter could not be read (${reasonOf(err)})`,
        );
        // Keep what the previous cycle read: still the best known values.
        const previous = meters.get(account.uuid);
        if (previous) {
          read.set(account.uuid, previous);
        } else {
          read.set(account.uuid, {
            account,
            summary: { lastDay: null, month: null, forecast: null, recent: [] },
            feedKey: consumptionKey(account),
            feed: [],
            updatedAt: null,
            utility: target.shortName,
          });
        }
      }
    }
    const previousCount = meters.size;
    meters = read;

    try {
      await publishDevices();
    } catch (err) {
      issues.fail('devices', `Publishing the meters failed: ${reasonOf(err)}`);
      await setStatus(false, MESSAGES.failed(reasonOf(err)));
      return { status: 'unreachable', retry: true, reason: reasonOf(err) };
    }
    issues.ok('devices', 'Meters published again');
    if (meters.size !== previousCount) {
      logger.info(`${target.shortName}: ${meters.size} meter(s) found`);
    }

    for (const meter of meters.values()) {
      await publishMeter(meter);
    }
    await refreshWidget();

    if (meters.size === 0) {
      await setStatus(false, MESSAGES.noMeter);
      return { status: 'no_meter' };
    }
    await setStatus(true);
    lastSuccessAt = now();
    logger.debug(`Cycle done: ${meters.size} meter(s), ${failed} failed`);
    return { status: 'ok', retry: failed > 0 };
  }

  /** One cycle at a time: a second caller waits for the one in progress. */
  function sync() {
    if (!running) {
      running = cycle()
        .catch((err) => {
          logger.error(`Cycle failed: ${reasonOf(err)}`);
          return { status: 'unreachable', retry: true, reason: reasonOf(err) };
        })
        .finally(() => {
          running = null;
        });
    }
    return running;
  }

  const poller = createPoller({ run: sync, now, timers });

  /** Wait for a refresh at most ACTION_WAIT_MS; it goes on alone past that. */
  async function refreshForAction() {
    let timeout;
    const outcome = await Promise.race([
      poller.runNow(),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(null), ACTION_WAIT_MS);
        timeout.unref?.();
      }),
    ]);
    clearTimeout(timeout);
    return outcome;
  }

  /** The message of an action that ran a cycle. */
  function outcomeMessage(outcome) {
    switch (outcome?.status) {
      case undefined:
        // Still running (a long first import): it goes on alone.
        return MESSAGES.refreshed('…');
      case 'ok': {
        const created = createdDevices();
        const missing = [...meters.values()].some(
          (meter) => !created.has(meterIds(gladys, meter.account).device),
        );
        return missing
          ? MESSAGES.signedIn(utility()?.shortName ?? config.utility, meters.size)
          : MESSAGES.refreshed(meters.size);
      }
      case 'code':
        return MESSAGES.codeRequired;
      case 'password':
        return MESSAGES.invalidAuth;
      case 'no_meter':
        return MESSAGES.noMeter;
      case 'not_configured':
        return MESSAGES.notConfigured;
      case 'unsupported':
        return MESSAGES.unsupportedUtility;
      default:
        return MESSAGES.cannotConnect(outcome.reason ?? 'see the logs');
    }
  }

  /** The challenge of a code the user can act on, signing in again if needed. */
  async function currentChallenge(target) {
    if (pending && pending.identity === identity() && now() - pending.createdAt < CODE_TTL_MS) {
      return pending.challenge;
    }
    pending = null;
    const signedIn = await signIn(target);
    if (signedIn) {
      // No code asked: the saved data was enough.
      void poller.runNow();
      return null;
    }
    return pending?.challenge ?? null;
  }

  const api = {
    get config() {
      return config;
    },
    get meters() {
      return meters;
    },
    get pending() {
      return pending;
    },
    poller,
    sync,

    /** (Re)connected to Gladys: read the config and the saved state, then a cycle. */
    async start() {
      config = normalizeConfig(await gladys.getConfig());
      persisted = await store.load();
      const target = utility();
      logger.info(
        isConfigured(config)
          ? `Opower integration started for ${target?.shortName ?? `an unsupported utility (${config.utility})`}`
          : 'Opower integration started: waiting for the configuration',
      );
      await poller.start();
    },

    async configUpdated(raw) {
      const previous = { identity: identity(), historyDays: config.historyDays };
      config = normalizeConfig(raw);
      logger.info('Configuration updated');
      if (identity() !== previous.identity) {
        // Another account: forget its meters, its code and its blockage.
        meters = new Map();
        pending = null;
        signInProblem = null;
      }
      if (config.historyDays > previous.historyDays) {
        // A longer history asked: the next cycle imports it again (the core
        // writes only the values it does not have).
        for (const state of Object.values(persisted.meters)) {
          delete state.fedUntil;
        }
        await save();
      }
      await poller.start();
    },

    async scanRequest() {
      if (meters.size === 0 && isConfigured(config)) {
        await sync();
      }
      await publishDevices();
    },

    async deviceCreated(device) {
      const meter = meterByDevice(device.external_id);
      if (!meter) {
        return;
      }
      logger.info(`${meter.utility}: meter added to Gladys, sending its data`);
      await publishMeter(meter);
      await refreshWidget();
    },

    async deviceUpdated(device) {
      const meter = meterByDevice(device.external_id);
      if (meter) {
        await publishMeter(meter);
      }
    },

    /**
     * The core's poll: acked at once, the cycle (when one is due) runs on.
     * A cycle signs in and reads for many seconds, past the ack delay.
     */
    poll() {
      poller.fromCore().catch((err) => logger.debug(`Poll fallback failed: ${reasonOf(err)}`));
    },

    stop() {
      poller.stop();
    },

    /** Configuration action: sign in and read now. */
    async refreshNow() {
      logger.info('Action: refresh now');
      if (!isConfigured(config)) {
        return MESSAGES.notConfigured;
      }
      if (!utility()) {
        return MESSAGES.unsupportedUtility;
      }
      if (lastSuccessAt !== null && now() - lastSuccessAt < MANUAL_REFRESH_MIN_MS) {
        return MESSAGES.refreshTooSoon(
          Math.ceil((MANUAL_REFRESH_MIN_MS - (now() - lastSuccessAt)) / 60000),
        );
      }
      // A refresh asked by the user goes past a code request in progress.
      pending = null;
      const outcome = await refreshForAction();
      return outcomeMessage(outcome);
    },

    /** Configuration action: have the utility send the code by email or text. */
    async sendCode(fields = {}) {
      const method = fields.method === 'sms' ? 'sms' : 'email';
      logger.info(`Action: send the verification code (${method})`);
      if (!isConfigured(config)) {
        return MESSAGES.notConfigured;
      }
      const target = utility();
      if (!target) {
        return MESSAGES.unsupportedUtility;
      }
      if (target.signIn !== 'code') {
        return MESSAGES.codeNotNeeded;
      }
      let challenge;
      try {
        challenge = await currentChallenge(target);
      } catch (err) {
        return MESSAGES.cannotConnect(reasonOf(err));
      }
      if (!challenge) {
        return signInProblem === 'password' ? MESSAGES.invalidAuth : MESSAGES.noPendingCode;
      }
      const options = challenge.options();
      if (options.length === 0) {
        return MESSAGES.codeAlreadySent;
      }
      const option = options.find((candidate) => candidate.kind === method);
      if (!option) {
        return mergeMessages(
          MESSAGES.noCodeMethod,
          MESSAGES.codeChoice(options.map((candidate) => candidate.label).join(', ')),
        );
      }
      try {
        await challenge.send(option.id);
      } catch (err) {
        logger.warn(`${target.shortName}: the code could not be sent (${reasonOf(err)})`);
        return MESSAGES.failed(reasonOf(err));
      }
      pending.sentAt = now();
      pending.createdAt = now();
      return mergeMessages(MESSAGES.codeSent(option.label), {
        en: `(${CODE_METHODS.en[method]})`,
        fr: `(${CODE_METHODS.fr[method]})`,
        de: `(${CODE_METHODS.de[method]})`,
        es: `(${CODE_METHODS.es[method]})`,
      });
    },

    /** Configuration action: check the code the user received. */
    async submitCode(fields = {}) {
      logger.info('Action: enter the verification code');
      const code = String(fields.code ?? '').replace(/\s/g, '');
      const target = utility();
      if (!target) {
        return isConfigured(config) ? MESSAGES.unsupportedUtility : MESSAGES.notConfigured;
      }
      if (target.signIn !== 'code') {
        return MESSAGES.codeNotNeeded;
      }
      if (!pending || pending.identity !== identity()) {
        return MESSAGES.noPendingCode;
      }
      if (now() - pending.createdAt >= CODE_TTL_MS) {
        pending = null;
        return MESSAGES.codeExpired;
      }
      if (!/^[0-9A-Za-z]{4,12}$/.test(code)) {
        return MESSAGES.codeRefused;
      }
      let loginData;
      try {
        loginData = await pending.challenge.submit(code);
      } catch (err) {
        if (err instanceof InvalidAuthError) {
          logger.info(`${target.shortName} refused the verification code`);
          return MESSAGES.codeRefused;
        }
        logger.warn(`${target.shortName}: the code could not be checked (${reasonOf(err)})`);
        return MESSAGES.failed(reasonOf(err));
      }
      persisted.loginData[pending.identity] = loginData;
      pending = null;
      signInProblem = null;
      await save();
      logger.info(`${target.shortName} accepted the verification code`);
      // The first read may import a long history: it goes on in the background.
      void poller.runNow();
      return MESSAGES.codeAccepted;
    },

    /** Scene action: the figures of a meter, for a message. */
    async meterSummary(fields = {}) {
      const meter = meterByDevice(fields.meter) ?? null;
      if (!meter) {
        throw new Error('Unknown meter: add it to Gladys, then pick it in the action');
      }
      const { lastDay, month, forecast } = meter.summary;
      // An unknown figure is left out (null for the scene), never a false 0.
      const outputs = { unit: meter.account.meterType === 'GAS' ? 'm³' : 'kWh' };
      const add = (key, value) => {
        if (value !== null && value !== undefined) {
          outputs[key] = value;
        }
      };
      add('date', lastDay?.date);
      add('usage', lastDay?.usage);
      add('cost', lastDay?.cost);
      add('month_usage', month?.usage);
      add('month_cost', month?.cost);
      add('forecast_cost', forecast?.cost);
      return outputs;
    },

    /** Dashboard widget content. */
    async widget({ settings = {}, language = 'en' } = {}) {
      const all = [...meters.values()];
      const meter =
        meterByDevice(settings.meter) ??
        all.find((candidate) => candidate.account.meterType === 'ELEC') ??
        all[0] ??
        null;
      return buildWidgetContent({
        meter,
        language,
        configured: isConfigured(config),
        signInProblem,
        utility: utility()?.shortName ?? null,
        timezone: utility()?.timezone ?? 'UTC',
        now: now(),
      });
    },
  };
  return api;
}

/**
 * Register every handler on the SDK client (before connect()).
 * @param {object} gladys
 * @param {ReturnType<typeof createApp>} app
 */
export function registerHandlers(gladys, app) {
  gladys.onScanRequest(() => app.scanRequest());
  gladys.onPoll(() => app.poll());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceUpdated((device) => app.deviceUpdated(device));
  gladys.onConfigUpdated((config) => app.configUpdated(config));
  gladys.onAction(ACTION.REFRESH, () => app.refreshNow());
  gladys.onAction(ACTION.SEND_CODE, (fields) => app.sendCode(fields));
  gladys.onAction(ACTION.SUBMIT_CODE, (fields) => app.submitCode(fields));
  gladys.onSceneAction(SCENE_ACTION.SUMMARY, (fields) => app.meterSummary(fields));
  gladys.onWidgetGet(WIDGET.SUMMARY, (request) => app.widget(request));
  gladys.on('connected', async () => {
    try {
      await app.start();
    } catch (err) {
      await gladys.setConnectionStatus(false, MESSAGES.initFailed).catch(() => {});
      throw err;
    }
  });
}
