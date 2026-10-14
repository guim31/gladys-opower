// -----------------------------------------------------------------------------
// The integration end to end, against the SDK's fake Gladys and a fake web
// serving the PG&E sign-in and the Opower API.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { MESSAGES } from '../src/i18n.js';
import { createMemoryStore } from '../src/store.js';
import { ELEC_UUID, GAS_UUID } from './helpers/opower-server.js';
import { createWorld, NOON, PGE_CONFIG } from './helpers/world.js';

const H = 3600 * 1000;
const elecDevice = (gladys) => `ext:${gladys.selector}:meter:${ELEC_UUID}`;
const feature = (gladys, key, uuid = ELEC_UUID) => `ext:${gladys.selector}:meter:${uuid}:${key}`;
const settle = async (until, tries = 200) => {
  for (let i = 0; i < tries && !until(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

test('first connection: the meters are discovered, nothing is sent before they are added', async () => {
  const world = createWorld();
  try {
    await world.connect();
    const { fake } = world.gladys;
    assert.deepEqual(fake.connectionStatus, { connected: true });
    assert.deepEqual(
      fake.discoveredDevices.map((device) => device.name),
      ['PG&E Electricity …0003', 'PG&E Gas …0004'],
    );
    assert.equal(fake.publishedEnergyConsumption.length, 0);
    assert.equal(fake.states.length, 0);
    assert.equal(fake.sceneEvents.length, 0, 'the first reading only sets the baseline');
  } finally {
    await world.stop();
  }
});

test('an added meter receives its dated consumption and its summaries at once', async () => {
  const world = createWorld();
  try {
    await world.connect();
    await world.addAllMeters();
    const { fake } = world.gladys;

    // 7 days of history, every elapsed hour as two half hours.
    const [batch] = fake.publishedEnergyConsumption;
    assert.equal(batch.device_feature_external_id, feature(world.gladys, 'consumption'));
    assert.equal(batch.intervals[0].starts_at, '2026-08-08T07:00:00.000Z');
    assert.equal(batch.intervals.length, 300);
    const stored = fake.energyConsumption[feature(world.gladys, 'consumption')];
    assert.equal(stored.length, 300);
    // A night hour (0.4 kWh) split in two equal halves, stamped at their end.
    assert.deepEqual(stored[0], { created_at: '2026-08-08T07:30:00.000Z', kwh: 0.2 });

    assert.equal(fake.lastState(feature(world.gladys, 'last_day_usage')), 17.5);
    assert.equal(fake.lastState(feature(world.gladys, 'last_day_cost')), 5.25);
    assert.equal(fake.lastState(feature(world.gladys, 'month_usage')), 227.5);
    assert.equal(fake.lastState(feature(world.gladys, 'month_cost')), 68.25);
    assert.equal(fake.lastState(feature(world.gladys, 'forecast_cost')), 150);
    assert.equal(fake.lastState(feature(world.gladys, 'forecast_usage')), 500);
    // Gas: in m³ (therms through the heat content), never in the energy tracking.
    assert.equal(fake.lastState(feature(world.gladys, 'last_day_usage', GAS_UUID)), 4.096);
    assert.equal(fake.lastState(feature(world.gladys, 'forecast_usage', GAS_UUID)), 32.768);
    assert.equal(fake.publishedEnergyConsumption.length, 1);
    assert.ok(fake.widgetRefreshes.includes('energy_summary'));

    // The cursor is saved: the next start resumes from it.
    assert.equal(world.store.saved.meters[ELEC_UUID].fedUntil, Date.parse('2026-08-14T13:00:00Z'));
  } finally {
    await world.stop();
  }
});

test('the states refresh on the container timer, without any onPoll from Gladys', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const world = createWorld({ timers: true });
  try {
    await world.connect();
    await world.addAllMeters();
    const { fake } = world.gladys;
    const monthBefore = fake.lastState(feature(world.gladys, 'month_usage'));
    const batches = fake.publishedEnergyConsumption.length;

    // A day later, the utility published one more day.
    world.clock.ms += 24 * H;
    t.mock.timers.tick(12 * H);
    await settle(() => fake.publishedEnergyConsumption.length > batches);

    assert.equal(fake.publishedEnergyConsumption.length, batches + 1);
    const latest = fake.publishedEnergyConsumption.at(-1).intervals;
    // From 3 days before the cursor, up to the new data.
    assert.equal(latest[0].starts_at, '2026-08-11T07:00:00.000Z');
    assert.equal(latest.at(-1).starts_at, '2026-08-15T12:30:00.000Z');
    assert.equal(fake.lastState(feature(world.gladys, 'month_usage')), monthBefore + 17.5);
    assert.equal(
      fake.requests.filter((request) => request.path === '/state' && request.method === 'POST')
        .length > 0,
      true,
    );
    assert.equal(
      fake.wsMessages.filter((message) => message.type?.includes('poll')).length,
      0,
      'no onPoll was ever involved',
    );
  } finally {
    await world.stop();
  }
});

test('the core poll is a fallback: skipped after a cycle, a cycle once the timer missed one', async () => {
  const world = createWorld();
  try {
    await world.connect();
    await world.addAllMeters();
    const { fake } = world.gladys;
    const device = fake.devices.find(
      (candidate) => candidate.external_id === elecDevice(world.gladys),
    );
    const before = world.web.requests.length;
    assert.deepEqual(await fake.poll(device), { success: true });
    assert.equal(world.web.requests.length, before, 'no request to the utility');

    world.clock.ms += 10 * H;
    await fake.poll(device);
    assert.equal(world.web.requests.length, before, 'still within the period');

    world.clock.ms += 3 * H;
    // Acked at once, the cycle runs on.
    assert.deepEqual(await fake.poll(device), { success: true });
    await settle(() => world.web.requests.length > before);
    assert.ok(world.web.requests.length > before, 'the timer missed its cycle: the poll runs one');
    await world.app.sync();
  } finally {
    await world.stop();
  }
});

test('a normal cycle writes nothing at info, and no secret ever reaches the logs', async () => {
  const config = { ...PGE_CONFIG, totp_secret: 'JBSWY3DPEHPK3PXP' };
  const world = createWorld({ config });
  try {
    await world.connect();
    await world.addAllMeters();
    const infoBefore = world.logger.at('info').length;
    world.clock.ms += 13 * H;
    await world.app.sync();
    assert.deepEqual(world.logger.at('info').slice(infoBefore), []);
    assert.deepEqual(world.logger.at('warn'), []);
    assert.deepEqual(world.logger.at('error'), []);
    assert.ok(world.logger.at('debug').length > 0, 'the details stay in debug');

    // A refused password, then an outage: one line each, without the secrets.
    await world.gladys.fake.configUpdated({ ...config, password: 'wrong secret' });
    world.web.on(
      'POST',
      'https://myaccount.pge.com/myaccount/s/sfsites/aura',
      new TypeError('fetch failed'),
    );
    await world.gladys.fake.configUpdated(config);
    world.clock.ms += 2 * H;
    await world.app.sync();
    assert.equal(
      world.logger.at('warn').filter((line) => /refused the sign-in/.test(line)).length,
      1,
    );
    assert.equal(world.logger.at('warn').filter((line) => /sign-in failed/.test(line)).length, 1);
    world.clock.ms += 2 * H;
    await world.app.sync();
    assert.equal(
      world.logger.at('warn').filter((line) => /sign-in failed/.test(line)).length,
      1,
      'once',
    );
    for (const { text } of world.logger.lines) {
      for (const secret of [
        'correct horse',
        'wrong secret',
        'JBSWY3DPEHPK3PXP',
        'opower-token',
        'aura-token',
      ]) {
        assert.ok(!text.includes(secret), `"${text}" leaks a secret`);
      }
    }
  } finally {
    await world.stop();
  }
});

test('a refused password blocks the readings: a status, one scene event, then recovery', async () => {
  const world = createWorld({ config: { ...PGE_CONFIG, password: 'wrong' } });
  try {
    await world.connect();
    const { fake } = world.gladys;
    assert.deepEqual(fake.connectionStatus, { connected: false, message: MESSAGES.invalidAuth });
    world.clock.ms += 13 * H;
    await world.app.sync();
    assert.deepEqual(
      fake.sceneEvents.map((event) => [event.key, event.data]),
      [['sign_in_required', { utility: 'PG&E', reason: 'password' }]],
    );
    await fake.configUpdated(PGE_CONFIG);
    assert.deepEqual(fake.connectionStatus, { connected: true });
    assert.ok(world.logger.at('info').includes('Signed in to PG&E again'));
  } finally {
    await world.stop();
  }
});

test('PG&E asks for a code: sent by text, a wrong one refused, the right one remembered', async () => {
  const world = createWorld({ pge: { mfa: true } });
  try {
    await world.connect();
    const { fake } = world.gladys;
    assert.equal(fake.connectionStatus.connected, false);
    assert.match(
      fake.connectionStatus.message.en,
      /Verification code required.*t\*\*\*@example\.com, \*\*\*-\*\*\*-1234/,
    );
    assert.deepEqual(
      fake.sceneEvents.map((event) => event.data.reason),
      ['code'],
    );
    assert.equal(fake.discoveredDevices.length, 0);

    // The 12-hour cycle does not ask for another code while one is expected.
    const logins = world.site.logins;
    await world.app.sync();
    assert.equal(world.site.logins, logins);

    const sent = await fake.action('send_code', { method: 'sms' });
    assert.equal(sent.success, true);
    assert.match(sent.data.message.en, /Code sent to \*\*\*-\*\*\*-1234/);
    assert.equal(world.site.sentTo, 'Phone');

    assert.deepEqual(
      (await fake.action('submit_code', { code: '000000' })).data.message,
      MESSAGES.codeRefused,
    );
    assert.deepEqual(
      (await fake.action('submit_code', { code: ' 123 456 ' })).data.message,
      MESSAGES.codeAccepted,
    );
    await world.app.sync();
    assert.deepEqual(fake.connectionStatus, { connected: true });
    assert.equal(fake.discoveredDevices.length, 2);
    const [saved] = Object.values(world.store.saved.loginData);
    assert.equal(saved.browsercookie, 'device-browsercookie');

    // Remembered: the next cycle signs in without a code.
    world.clock.ms += 13 * H;
    await world.app.sync();
    assert.deepEqual(fake.connectionStatus, { connected: true });
    assert.equal(fake.sceneEvents.length, 1, 'one event for the whole episode');
    assert.deepEqual(
      (await fake.action('submit_code', { code: '123456' })).data.message,
      MESSAGES.noPendingCode,
    );
  } finally {
    await world.stop();
  }
});

test('a code request expires after 10 minutes, and the code actions only serve code utilities', async () => {
  const world = createWorld({ pge: { mfa: true } });
  try {
    await world.connect();
    const { fake } = world.gladys;
    world.clock.ms += 11 * 60 * 1000;
    assert.deepEqual(
      (await fake.action('submit_code', { code: '123456' })).data.message,
      MESSAGES.codeExpired,
    );
    // Sending a code signs in again and gets a fresh request.
    const sent = await fake.action('send_code', { method: 'email' });
    assert.match(sent.data.message.fr, /Code envoyé à t\*\*\*@example\.com/);
    assert.equal(world.site.sentTo, 'Email');

    await fake.configUpdated({ ...PGE_CONFIG, utility: 'pse' });
    assert.deepEqual(
      (await fake.action('send_code', { method: 'email' })).data.message,
      MESSAGES.codeNotNeeded,
    );
    await fake.configUpdated({ ...PGE_CONFIG, utility: 'evergy' });
    assert.deepEqual(fake.connectionStatus, {
      connected: false,
      message: MESSAGES.unsupportedUtility,
    });
    await fake.configUpdated({ language: 'fr' });
    assert.deepEqual(fake.connectionStatus, { connected: false, message: MESSAGES.notConfigured });
  } finally {
    await world.stop();
  }
});

test('one scene event per new complete day, with its figures', async () => {
  const world = createWorld();
  try {
    await world.connect();
    await world.addAllMeters();
    const { fake } = world.gladys;
    assert.equal(fake.sceneEvents.length, 0);
    world.clock.ms += 24 * H;
    await world.app.sync();
    const events = fake.sceneEvents.filter((event) => event.key === 'daily_usage_available');
    assert.deepEqual(
      events.map((event) => event.data),
      [
        {
          meter: elecDevice(world.gladys),
          date: '2026-08-14',
          usage: 17.5,
          unit: 'kWh',
          cost: 5.25,
          month_usage: 245,
          month_cost: 73.5,
          forecast_cost: 150,
        },
        {
          meter: `ext:${world.gladys.selector}:meter:${GAS_UUID}`,
          date: '2026-08-14',
          usage: 4.096,
          unit: 'm³',
          cost: 0.45,
          month_usage: 57.344,
          month_cost: 6.3,
          forecast_cost: 30,
        },
      ],
    );
    world.clock.ms += 2 * H;
    await world.app.sync();
    assert.equal(fake.sceneEvents.length, 2, 'the same day is not announced twice');
  } finally {
    await world.stop();
  }
});

test('a restart resumes from the saved cursor, not from the configured history', async () => {
  const store = createMemoryStore();
  const first = createWorld({ store });
  await first.connect();
  await first.addAllMeters();
  const devices = first.gladys.fake.devices;
  await first.stop();

  const second = createWorld({
    store,
    now: NOON + 24 * H,
    devices,
    config: { ...PGE_CONFIG, history_days: '365' },
  });
  try {
    await second.connect();
    const [batch] = second.gladys.fake.publishedEnergyConsumption;
    assert.equal(batch.intervals[0].starts_at, '2026-08-11T07:00:00.000Z');
    assert.equal(
      second.gladys.fake.sceneEvents.filter((event) => event.key === 'daily_usage_available')
        .length,
      2,
      'the baseline survived the restart',
    );
  } finally {
    await second.stop();
  }
});

test('raising the history imports the longer one at the next reading', async () => {
  const world = createWorld();
  try {
    await world.connect();
    await world.addAllMeters();
    world.clock.ms += 20 * 60 * 1000;
    await world.gladys.fake.configUpdated({ ...PGE_CONFIG, history_days: '30' });
    const batch = world.gladys.fake.publishedEnergyConsumption.at(-1);
    assert.equal(batch.intervals[0].starts_at, '2026-07-16T07:00:00.000Z');
  } finally {
    await world.stop();
  }
});

test('a long history goes in batches of 2,000 intervals', async () => {
  const world = createWorld({ config: { ...PGE_CONFIG, history_days: '90' } });
  try {
    await world.connect();
    await world.addAllMeters();
    const batches = world.gladys.fake.publishedEnergyConsumption.map(
      (batch) => batch.intervals.length,
    );
    assert.deepEqual(batches, [2000, 2000, batches[2]]);
    assert.ok(batches[2] > 0 && batches[2] <= 2000);
    // 26-day windows of hourly reads: 4 requests for 90 days.
    const hourly = world.web.requests.filter((request) => request.query.aggregateType === 'hour');
    assert.equal(hourly.length, 4);
  } finally {
    await world.stop();
  }
});

test('the refresh action: a cycle now, but not twice within 15 minutes', async () => {
  const world = createWorld();
  try {
    await world.connect();
    const { fake } = world.gladys;
    const soon = await fake.action('refresh_now', {});
    assert.match(soon.data.message.en, /Already refreshed recently: try again in 15 min/);
    world.clock.ms += 20 * 60 * 1000;
    const done = await fake.action('refresh_now', {});
    assert.deepEqual(done.data.message, MESSAGES.signedIn('PG&E', 2));
    await world.addAllMeters();
    world.clock.ms += 20 * 60 * 1000;
    assert.deepEqual((await fake.action('refresh_now', {})).data.message, MESSAGES.refreshed(2));
  } finally {
    await world.stop();
  }
});

test('the scene action gives a meter summary, an unknown meter fails the action only', async () => {
  const world = createWorld();
  try {
    await world.connect();
    await world.addAllMeters();
    const { fake } = world.gladys;
    const ack = await fake.sceneAction('get_meter_summary', { meter: elecDevice(world.gladys) });
    assert.deepEqual(ack.data.outputs, {
      unit: 'kWh',
      date: '2026-08-13',
      usage: 17.5,
      cost: 5.25,
      month_usage: 227.5,
      month_cost: 68.25,
      forecast_cost: 150,
    });
    const unknown = await fake.sceneAction('get_meter_summary', { meter: 'ext:other:meter:x' });
    assert.equal(unknown.success, false);
  } finally {
    await world.stop();
  }
});

test('the widget fits the core vocabulary in every language and says why it is empty', async () => {
  const world = createWorld({ pge: { mfa: true } });
  try {
    await world.connect();
    const { fake } = world.gladys;
    const blocked = await fake.widgetGet('energy_summary', {
      settings: {},
      language: 'de',
      units: 'metric',
    });
    assert.match(blocked.data.content.components[0].text, /Bestätigungscode/);

    await fake.action('send_code', { method: 'email' });
    await fake.action('submit_code', { code: '123456' });
    await world.app.sync();
    for (const language of ['en', 'fr', 'de', 'es']) {
      for (const meter of [undefined, `ext:${world.gladys.selector}:meter:${GAS_UUID}`]) {
        const ack = await fake.widgetGet('energy_summary', {
          settings: { meter },
          language,
          units: 'metric',
        });
        assert.equal(ack.success, true);
        assert.deepEqual(validateWidgetContent(ack.data.content), [], `${language} ${meter}`);
        assert.ok(ack.data.content.components.some((component) => component.type === 'chart'));
      }
    }
    const gas = await fake.widgetGet('energy_summary', {
      settings: { meter: `ext:${world.gladys.selector}:meter:${GAS_UUID}` },
      language: 'en',
      units: 'us',
    });
    assert.ok(gas.data.content.components.some((component) => component.unit === 'm³'));
  } finally {
    await world.stop();
  }
});

test('a scan request publishes the meters again, reading them first if needed', async () => {
  const world = createWorld();
  try {
    await world.connect();
    const { fake } = world.gladys;
    const before = world.web.requests.length;
    await fake.scanRequest();
    assert.equal(world.web.requests.length, before, 'served from what the last cycle read');
    assert.equal(fake.discoveredDevices.length, 2);
  } finally {
    await world.stop();
  }
});
