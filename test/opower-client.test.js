// The Opower API client, on the response shapes of tronikos/opower's tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpSession } from '../src/http.js';
import { createOpowerClient, normalizeUnit, supportsAggregate } from '../src/opower/client.js';
import { createFakeWeb } from './helpers/fake-web.js';
import { CUSTOMER_UUID, ELEC_UUID, fixture, GAS_UUID } from './helpers/opower-server.js';

const ROOT = 'https://pge.opower.com/ei/edge/apis';
const LA = 'America/Los_Angeles';

function client(web) {
  return createOpowerClient({
    session: createHttpSession({ fetch: web.fetch }),
    utility: { subdomain: () => 'pge', utilityCode: () => 'pge' },
    token: 'test-token',
    timezone: LA,
  });
}

const elec = {
  customerUuid: CUSTOMER_UUID,
  uuid: ELEC_UUID,
  utilityAccountId: '1000000003',
  meterType: 'ELEC',
  readResolution: 'QUARTER_HOUR',
};

test('accounts: one per meter, the account number unless electricity and gas share it', async () => {
  const web = createFakeWeb().on('GET', `${ROOT}/multi-account-v1/cws/pge/customers`, {
    json: fixture('customers-pge.json'),
  });
  const accounts = await client(web).getAccounts();
  assert.deepEqual(accounts, [
    {
      customerUuid: CUSTOMER_UUID,
      uuid: ELEC_UUID,
      utilityAccountId: '1000000003',
      id: '1000000003',
      meterType: 'ELEC',
      readResolution: 'QUARTER_HOUR',
    },
    {
      customerUuid: CUSTOMER_UUID,
      uuid: GAS_UUID,
      utilityAccountId: '1000000004',
      id: '1000000004',
      meterType: 'GAS',
      readResolution: 'DAY',
    },
  ]);
  const [request] = web.requests;
  assert.equal(request.headers.authorization, 'Bearer test-token');
  assert.equal(request.query.batchSize, '100');
  // The customer is not known yet: no customer claim on this request.
  assert.equal(request.headers['opower-selected-entities'], undefined);

  const shared = structuredClone(fixture('customers-pge.json'));
  shared.customers[0].utilityAccounts[1].preferredUtilityAccountId = '1000000003';
  const sharedWeb = createFakeWeb().on('GET', `${ROOT}/multi-account-v1/cws/pge/customers`, {
    json: shared,
  });
  assert.deepEqual(
    (await client(sharedWeb).getAccounts()).map((account) => account.id),
    [ELEC_UUID, GAS_UUID],
  );
});

test('accounts: an empty customer list is not a usable sign-in', async () => {
  const web = createFakeWeb().on('GET', `${ROOT}/multi-account-v1/cws/pge/customers`, {
    json: { customers: [] },
  });
  await assert.rejects(client(web).getAccounts(), /no customer account/);
});

test('forecast: the bill forecast of each meter, "TH" read as therms', async () => {
  const web = createFakeWeb()
    .on('GET', `${ROOT}/multi-account-v1/cws/pge/customers`, {
      json: fixture('customers-pge.json'),
    })
    .on('POST', `${ROOT}/dsm-graphql-v1/cws/graphql`, { json: fixture('forecast-pge.json') });
  const [electricity, gas] = await client(web).getForecasts();
  assert.deepEqual(electricity, {
    accountUuid: ELEC_UUID,
    startDate: '2026-07-30',
    endDate: '2026-08-31',
    currentDate: '2026-08-15',
    unit: 'KWH',
    usageToDate: 240,
    costToDate: 72,
    forecastedUsage: 500,
    forecastedCost: 150,
    typicalUsage: 480,
    typicalCost: 140,
  });
  assert.equal(gas.unit, 'THERM');
  assert.equal(gas.forecastedUsage, 12);
  const graphql = web.calls('POST', `${ROOT}/dsm-graphql-v1/cws/graphql`)[0];
  assert.match(graphql.json.query, /billForecast/);
  assert.deepEqual(JSON.parse(graphql.headers['opower-selected-entities']), [
    `urn:opower:customer:uuid:${CUSTOMER_UUID}`,
  ]);
});

test('forecast: a GraphQL error or a null estimate gives no figure, never a failure', async () => {
  const web = createFakeWeb()
    .on('GET', `${ROOT}/multi-account-v1/cws/pge/customers`, {
      json: fixture('customers-pge.json'),
    })
    .on('POST', `${ROOT}/dsm-graphql-v1/cws/graphql`, {
      json: { errors: [{ message: 'Not authorized' }] },
    });
  assert.deepEqual(await client(web).getForecasts(), []);

  const early = structuredClone(fixture('forecast-pge.json'));
  const segment = early.data.billingAccountsConnection.edges[0].node.billForecast.segments[0];
  segment.estimatedUsage = null;
  segment.estimatedUsageCharges = null;
  web.on('POST', `${ROOT}/dsm-graphql-v1/cws/graphql`, { json: early });
  const [electricity] = await client(web).getForecasts();
  assert.equal(electricity.forecastedCost, null);
  assert.equal(electricity.forecastedUsage, null);
  assert.equal(electricity.typicalCost, 140);
});

test('cost reads: tiered components summed by Opower, the trailing zero read dropped', async () => {
  const web = createFakeWeb().on(
    'GET',
    `${ROOT}/DataBrowser-v1/cws/cost/utilityAccount/${ELEC_UUID}`,
    {
      json: fixture('daily-cost-pge.json'),
    },
  );
  const result = await client(web).getCostReads(elec, 'day', '2026-07-01', '2026-07-02');
  assert.deepEqual(result, {
    reads: [
      {
        start: Date.parse('2026-07-01T07:00:00Z'),
        end: Date.parse('2026-07-02T07:00:00Z'),
        value: 29.4584,
        cost: 9.632872208,
      },
    ],
    unit: 'KWH',
    withCost: true,
  });
  // The cost endpoint takes full timestamps, until the next midnight.
  assert.deepEqual(web.requests[0].query, {
    aggregateType: 'day',
    startDate: '2026-07-01T00:00:00-07:00',
    endDate: '2026-07-03T00:00:00-07:00',
  });
  assert.deepEqual(JSON.parse(web.requests[0].headers['opower-selected-entities']), [
    `urn:opower:customer:uuid:${CUSTOMER_UUID}`,
  ]);
});

test('cost reads: an empty cost answer falls back to the usage endpoint, without cost', async () => {
  const { cost, usage } = fixture('usage-fallback-pge.json');
  const web = createFakeWeb()
    .on('GET', `${ROOT}/DataBrowser-v1/cws/cost/utilityAccount/${ELEC_UUID}`, { json: cost })
    .on('GET', `${ROOT}/DataBrowser-v1/cws/utilities/pge/utilityAccounts/${ELEC_UUID}/reads`, {
      json: usage,
    });
  const result = await client(web).getCostReads(elec, 'day', '2026-08-25', '2026-08-26');
  assert.equal(result.withCost, false);
  assert.deepEqual(
    result.reads.map((read) => [read.value, read.cost]),
    [
      [15.0677, null],
      [11.4372, null],
    ],
  );
  // The usage endpoint takes plain dates.
  assert.deepEqual(web.requests[1].query, {
    aggregateType: 'day',
    startDate: '2026-08-25',
    endDate: '2026-08-27',
  });
});

test('cost reads: an HTTP error of the cost endpoint falls back too (ConEd answers 500)', async () => {
  const { usage } = fixture('usage-fallback-pge.json');
  const web = createFakeWeb()
    .on('GET', `${ROOT}/DataBrowser-v1/cws/cost/utilityAccount/${ELEC_UUID}`, {
      status: 500,
      text: 'error',
    })
    .on('GET', `${ROOT}/DataBrowser-v1/cws/utilities/pge/utilityAccounts/${ELEC_UUID}/reads`, {
      json: usage,
    });
  const result = await client(web).getCostReads(elec, 'day', '2026-08-25', '2026-08-26');
  assert.equal(result.reads.length, 2);
});

test('hourly reads: 26-day windows, newest first, reassembled oldest first', async () => {
  const windows = [];
  const web = createFakeWeb().on(
    'GET',
    `${ROOT}/DataBrowser-v1/cws/utilities/pge/utilityAccounts/${ELEC_UUID}/reads`,
    (request) => {
      windows.push([request.query.startDate, request.query.endDate]);
      const start = request.query.startDate;
      return {
        json: {
          reads: [
            {
              startTime: `${start}T00:00:00.000-07:00`,
              endTime: `${start}T01:00:00.000-07:00`,
              consumption: { value: 1, type: 'ACTUAL' },
            },
          ],
        },
      };
    },
  );
  const result = await client(web).getUsageReads(elec, 'hour', '2026-06-01', '2026-07-31');
  assert.deepEqual(windows, [
    ['2026-07-06', '2026-08-01'],
    ['2026-06-09', '2026-07-05'],
    ['2026-06-01', '2026-06-08'],
  ]);
  assert.deepEqual(
    result.reads.map((read) => new Date(read.start).toISOString().slice(0, 10)),
    ['2026-06-01', '2026-06-09', '2026-07-06'],
  );
});

test('reads: an empty window stops the walk back, naive times are local, bad reads skipped', async () => {
  let calls = 0;
  const web = createFakeWeb().on(
    'GET',
    `${ROOT}/DataBrowser-v1/cws/utilities/pge/utilityAccounts/${ELEC_UUID}/reads`,
    () => {
      calls += 1;
      return calls > 1
        ? { json: { reads: [] } }
        : {
            json: {
              reads: [
                {
                  startTime: '2026-06-01T00:00:00',
                  endTime: '2026-06-02T00:00:00',
                  consumption: { value: 10 },
                },
                { startTime: 'garbage', endTime: '2026-06-03T00:00:00', consumption: { value: 3 } },
                {
                  startTime: '2026-06-02T00:00:00',
                  endTime: '2026-06-03T00:00:00',
                  consumption: null,
                },
              ],
            },
          };
    },
  );
  const result = await client(web).getUsageReads(elec, 'day', '2025-01-01', '2026-06-02');
  assert.equal(calls, 2);
  assert.deepEqual(result.reads, [
    {
      start: Date.parse('2026-06-01T07:00:00Z'),
      end: Date.parse('2026-06-02T07:00:00Z'),
      value: 10,
      cost: null,
    },
  ]);
});

test('units and resolutions', () => {
  assert.equal(normalizeUnit('TH'), 'THERM');
  assert.equal(normalizeUnit('hcf'), 'CCF');
  assert.equal(normalizeUnit(undefined), null);
  assert.equal(supportsAggregate({ readResolution: 'DAY' }, 'hour'), false);
  assert.equal(supportsAggregate({ readResolution: 'QUARTER_HOUR' }, 'hour'), true);
  assert.equal(supportsAggregate({ readResolution: 'BILLING' }, 'day'), false);
});
