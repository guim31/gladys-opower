// -----------------------------------------------------------------------------
// A fake Opower service on the fake web: the customers, the bill forecast and
// reads generated for any window, in the shapes of test/fixtures/opower.
//
// The meter "reports" until `dataUntil`: later reads are zeros, like the real
// service serves the hours not metered yet. Hourly usage follows a daily
// curve (0.4 kWh at night, 1.2 kWh in the evening); a day costs 0.30 $/kWh.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { addDays, HOUR_MS, isoWithOffset, startOfLocalDay, wallClock } from '../../src/time.js';

export const CUSTOMER_UUID = '11111111-1111-11e5-bf2b-000000000001';
export const ELEC_UUID = '22222222-2222-11e5-bf2b-000000000002';
export const GAS_UUID = '33333333-3333-11e5-bf2b-000000000003';

export const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/opower/${name}`, import.meta.url), 'utf8'));

/** kWh of the hour starting at `ms` (local hour of the zone). */
export function hourlyKwh(ms, timezone) {
  const { hour } = wallClock(ms, timezone);
  return hour >= 17 && hour < 22 ? 1.2 : hour < 6 ? 0.4 : 0.7;
}

const PRICE = 0.3;
// Gas: therms per day.
const GAS_DAILY = 1.5;

const stamp = (ms, timezone) => isoWithOffset(ms, timezone).replace(/([+-]\d\d:\d\d)$/, '.000$1');

/**
 * @param {object} web the fake web
 * @param {object} options
 * @param {string} [options.subdomain]
 * @param {string} [options.utilityCode]
 * @param {string} [options.timezone]
 * @param {() => number} options.dataUntil the last metered instant
 * @param {object} [options.customers] the multi-account-v1 answer
 * @param {object|Error} [options.forecast] the GraphQL answer
 * @param {boolean} [options.costs] the cost endpoint answers (else empty)
 * @param {string} [options.token] the bearer token expected
 */
export function serveOpower(
  web,
  {
    subdomain = 'pge',
    utilityCode = subdomain,
    timezone = 'America/Los_Angeles',
    dataUntil,
    customers = fixture('customers-pge.json'),
    forecast = fixture('forecast-pge.json'),
    costs = true,
    token = 'opower-token',
  },
) {
  const root = `https://${subdomain}.opower.com/ei/edge/apis`;
  const state = { refused: false };

  const authorized = (request) =>
    !state.refused && request.headers.authorization === `Bearer ${token}`;
  const unauthorized = { status: 401, json: { error: 'unauthorized' } };

  const meterTypeOf = (uuid) => {
    for (const customer of customers.customers) {
      for (const account of customer.utilityAccounts) {
        if (account.uuid === uuid) {
          return account.meterType;
        }
      }
    }
    return null;
  };

  function reads(uuid, aggregate, startMs, endMs, withCost) {
    const gas = meterTypeOf(uuid) === 'GAS';
    const result = [];
    if (aggregate === 'hour') {
      for (let ms = startMs; ms < endMs; ms += HOUR_MS) {
        const metered = ms + HOUR_MS <= dataUntil();
        const value = metered ? (gas ? GAS_DAILY / 24 : hourlyKwh(ms, timezone)) : 0;
        result.push({ start: ms, end: ms + HOUR_MS, value, cost: withCost ? value * PRICE : null });
      }
    } else if (aggregate === 'day') {
      const first = new Date(startMs);
      let date = isoWithOffset(first.getTime(), timezone).slice(0, 10);
      for (;;) {
        const start = startOfLocalDay(date, timezone);
        const end = startOfLocalDay(addDays(date, 1), timezone);
        if (start >= endMs) {
          break;
        }
        let value = 0;
        if (gas) {
          value = end <= dataUntil() ? GAS_DAILY : 0;
        } else {
          for (let ms = start; ms < end; ms += HOUR_MS) {
            value += ms + HOUR_MS <= dataUntil() ? hourlyKwh(ms, timezone) : 0;
          }
        }
        result.push({
          start,
          end,
          value,
          cost: withCost ? Math.round(value * PRICE * 1e6) / 1e6 : null,
        });
        date = addDays(date, 1);
      }
    }
    return result;
  }

  web.on('GET', `${root}/multi-account-v1/cws/${utilityCode}/customers`, (request) =>
    authorized(request) ? { json: customers } : unauthorized,
  );

  web.on('POST', `${root}/dsm-graphql-v1/cws/graphql`, (request) => {
    if (!authorized(request)) {
      return unauthorized;
    }
    return forecast instanceof Error ? { status: 500, text: 'error' } : { json: forecast };
  });

  web.on(
    'GET',
    (url) =>
      url.pathname.startsWith('/ei/edge/apis/DataBrowser-v1/cws/cost/utilityAccount/') &&
      url.host === `${subdomain}.opower.com`,
    (request) => {
      if (!authorized(request)) {
        return unauthorized;
      }
      const uuid = new URL(request.url).pathname.split('/').at(-1);
      if (!costs) {
        return { json: { unit: 'KWH', reads: [] } };
      }
      const startMs = Date.parse(request.query.startDate);
      const endMs = Date.parse(request.query.endDate);
      const unit = meterTypeOf(uuid) === 'GAS' ? 'THERM' : 'KWH';
      return {
        json: {
          unit,
          siteTimeZoneId: timezone,
          reads: reads(uuid, request.query.aggregateType, startMs, endMs, true).map((read) => ({
            startTime: stamp(read.start, timezone),
            endTime: stamp(read.end, timezone),
            value: read.value,
            readType: 'ACTUAL',
            providedCost: read.cost,
          })),
        },
      };
    },
  );

  web.on(
    'GET',
    (url) =>
      url.host === `${subdomain}.opower.com` &&
      /\/DataBrowser-v1\/cws\/utilities\/[^/]+\/utilityAccounts\/[^/]+\/reads$/.test(url.pathname),
    (request) => {
      if (!authorized(request)) {
        return unauthorized;
      }
      const uuid = new URL(request.url).pathname.split('/').at(-2);
      // Plain dates; the end date is served as a whole day.
      const startMs = startOfLocalDay(request.query.startDate, timezone);
      const endMs = startOfLocalDay(addDays(request.query.endDate, 1), timezone);
      return {
        json: {
          startDate: request.query.startDate,
          endDate: request.query.endDate,
          reads: reads(uuid, request.query.aggregateType, startMs, endMs, false).map((read) => ({
            startTime: stamp(read.start, timezone),
            endTime: stamp(read.end, timezone),
            providedCost: null,
            consumption: { value: read.value, type: 'ACTUAL' },
          })),
        },
      };
    },
  );

  return state;
}
