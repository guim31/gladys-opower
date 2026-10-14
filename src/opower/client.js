// -----------------------------------------------------------------------------
// The Opower API (<subdomain>.opower.com), once the utility handed over a
// token.
//
// Ported from opower's opower.py (tronikos/opower, Apache-2.0), the part this
// integration uses:
//   - multi-account-v1: the customers and their utility accounts (one per
//     meter: electricity, gas);
//   - dsm-graphql-v1: the bill forecast of the current billing period;
//   - DataBrowser-v1: the reads, with their cost (`cost/utilityAccount`) or
//     without (`.../reads`), by bill, day, hour, half or quarter hour.
// Opower caps the span of one request (363 days of days, 26 days of hours, 6
// days of half or quarter hours): longer ranges are asked newest first, in
// windows, like the Python library.
// -----------------------------------------------------------------------------

import { CannotConnectError, HttpError } from '../errors.js';
import { safeUrl } from '../http.js';
import { addDays, isoWithOffset, parseTimestamp, startOfLocalDay } from '../time.js';

export const METER_TYPES = { ELEC: 'ELEC', GAS: 'GAS', WATER: 'WATER' };

export const AGGREGATES = {
  BILL: 'bill',
  DAY: 'day',
  HOUR: 'hour',
  HALF_HOUR: 'half_hour',
  QUARTER_HOUR: 'quarter_hour',
};

// The finest resolution of an account, and the aggregations it supports.
const SUPPORTED_AGGREGATES = {
  BILLING: ['bill'],
  DAY: ['bill', 'day'],
  HOUR: ['bill', 'day', 'hour'],
  HALF_HOUR: ['bill', 'day', 'hour', 'half_hour'],
  QUARTER_HOUR: ['bill', 'day', 'hour', 'half_hour', 'quarter_hour'],
  FIVE_MINUTE: ['bill', 'day', 'hour', 'half_hour', 'quarter_hour'],
};

const MAX_REQUEST_DAYS = { day: 363, hour: 26, half_hour: 6, quarter_hour: 6 };

/** True when an account can be read at that aggregation. */
export function supportsAggregate(account, aggregate) {
  const supported = SUPPORTED_AGGREGATES[account.readResolution];
  return supported ? supported.includes(aggregate) : aggregate === 'bill';
}

const FORECAST_QUERY = `
query GetBillForecast {
  billingAccountsConnection(first: 100) {
    edges {
      node {
        billForecast {
          timeInterval
          currentDateTime
          segments {
            serviceAgreement { uuid }
            estimatedUsage { value, unit }
            estimatedUsageCharges { value }
            soFarUsage { value }
            soFarUsageCharges { value }
            priorYearUsage { value }
            priorYearUsageCharges { value }
          }
        }
      }
    }
  }
}`;

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** `{ value }` → number, or null when absent. */
function valueOf(object) {
  return object && typeof object === 'object' ? numberOrNull(object.value) : null;
}

/** "TH", "THERMS" → "THERM"; "HCF" → "CCF". */
export function normalizeUnit(unit) {
  const upper = String(unit ?? '').toUpperCase();
  return { TH: 'THERM', THERMS: 'THERM', THM: 'THERM', HCF: 'CCF' }[upper] ?? (upper || null);
}

/**
 * @param {object} options
 * @param {object} options.session the HTTP session of the sign-in (its cookies go along)
 * @param {object} options.utility the signed-in utility instance (subdomain, utilityCode)
 * @param {string} options.token the Opower access token
 * @param {string} options.timezone the utility's zone
 */
export function createOpowerClient({ session, utility, token, timezone }) {
  let customers = null;

  const root = () => `https://${utility.subdomain()}.opower.com/ei/edge/apis`;

  function headers(customerUuid) {
    const sent = { authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (customerUuid) {
      sent['Opower-Selected-Entities'] = JSON.stringify([
        `urn:opower:customer:uuid:${customerUuid}`,
      ]);
    }
    return sent;
  }

  async function getJson(url, params, customerUuid) {
    const query = new URLSearchParams(params).toString();
    const response = await session.request(query ? `${url}?${query}` : url, {
      headers: headers(customerUuid),
    });
    if (!response.ok) {
      throw new HttpError(response.status, safeUrl(url), response.text());
    }
    return response.json();
  }

  async function postGraphql(query, customerUuid) {
    const url = `${root()}/dsm-graphql-v1/cws/graphql`;
    const response = await session.request(url, {
      method: 'POST',
      headers: headers(customerUuid),
      json: { query },
    });
    if (!response.ok) {
      throw new HttpError(response.status, safeUrl(url), response.text());
    }
    const result = response.json();
    if (result?.errors) {
      throw new CannotConnectError('Opower GraphQL answered an error');
    }
    return result;
  }

  async function getCustomers() {
    if (customers === null) {
      const result = await getJson(
        `${root()}/multi-account-v1/cws/${utility.utilityCode()}/customers`,
        { offset: '0', batchSize: '100', addressFilter: '' },
      );
      if (!Array.isArray(result?.customers)) {
        throw new CannotConnectError('Opower did not list the customer accounts');
      }
      customers = result.customers;
    }
    if (customers.length === 0) {
      throw new CannotConnectError('Opower lists no customer account for this sign-in');
    }
    return customers;
  }

  /**
   * One window of reads.
   * @returns {Promise<{ reads: object[], unit: string|null }>}
   */
  async function fetchWindow(account, aggregate, startDate, endDate, usageOnly) {
    const startMs = startOfLocalDay(startDate, timezone);
    const endMs = startOfLocalDay(endDate, timezone);
    const params = { aggregateType: aggregate };
    let url;
    if (usageOnly) {
      url = `${root()}/DataBrowser-v1/cws/utilities/${utility.utilityCode()}/utilityAccounts/${account.uuid}/reads`;
      params.startDate = startDate;
      params.endDate = endDate;
    } else {
      url = `${root()}/DataBrowser-v1/cws/cost/utilityAccount/${account.uuid}`;
      params.startDate = isoWithOffset(startMs, timezone);
      params.endDate = isoWithOffset(endMs, timezone);
    }
    const result = await getJson(url, params, account.customerUuid);
    return {
      reads: Array.isArray(result?.reads) ? result.reads : [],
      unit: normalizeUnit(result?.unit),
    };
  }

  /** Every window of a range, newest first, reassembled oldest first. */
  async function fetchRange(account, aggregate, startDate, endDate, usageOnly) {
    const maxDays = MAX_REQUEST_DAYS[aggregate];
    // The server serves the end date as a whole day: ask until the next midnight.
    let requestEnd = addDays(endDate, 1);
    let all = [];
    let unit = null;
    const seen = new Set();
    for (;;) {
      const requestStart =
        maxDays === undefined
          ? startDate
          : [startDate, addDays(requestEnd, -maxDays)].sort().at(-1);
      if (requestStart > requestEnd) {
        break;
      }
      const window = await fetchWindow(account, aggregate, requestStart, requestEnd, usageOnly);
      unit ??= window.unit;
      if (window.reads.length === 0) {
        break;
      }
      // Windows overlap by a read on a spring-forward day: keep the later copy.
      const fresh = window.reads.filter((read) => !seen.has(read.startTime));
      fresh.forEach((read) => seen.add(read.startTime));
      all = [...fresh, ...all];
      if (maxDays === undefined) {
        break;
      }
      requestEnd = addDays(requestStart, -1);
    }
    return { reads: all, unit };
  }

  function parseReads(raw, usageOnly) {
    const reads = [];
    for (const read of raw) {
      const start = parseTimestamp(read?.startTime, timezone);
      const end = parseTimestamp(read?.endTime, timezone);
      const value = usageOnly
        ? valueOf(read?.consumption)
        : (numberOrNull(read?.value) ?? valueOf(read?.consumption));
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || value === null) {
        continue;
      }
      reads.push({ start, end, value, cost: usageOnly ? null : numberOrNull(read?.providedCost) });
    }
    // Trailing zero reads are periods the meter has not reported yet.
    while (reads.length && reads.at(-1).value === 0 && !reads.at(-1).cost) {
      reads.pop();
    }
    return reads;
  }

  return {
    /** The meters of the signed-in customer(s). */
    async getAccounts() {
      const accounts = [];
      for (const customer of await getCustomers()) {
        const utilityAccounts = Array.isArray(customer?.utilityAccounts)
          ? customer.utilityAccounts
          : [];
        const ids = utilityAccounts.map((account) => account?.preferredUtilityAccountId);
        for (const account of utilityAccounts) {
          if (!account?.uuid) {
            continue;
          }
          const utilityAccountId = String(account.preferredUtilityAccountId ?? '');
          accounts.push({
            customerUuid: String(customer.uuid),
            uuid: String(account.uuid),
            utilityAccountId,
            // The account number, unless electricity and gas share it.
            id:
              ids.filter((id) => id === account.preferredUtilityAccountId).length === 1
                ? utilityAccountId
                : String(account.uuid),
            meterType: String(account.meterType ?? '').toUpperCase(),
            readResolution: String(account.readResolution ?? '').toUpperCase() || null,
          });
        }
      }
      return accounts;
    },

    /**
     * The bill forecast of each account (current billing period). An error
     * of the GraphQL endpoint yields no forecast, never a failed cycle.
     */
    async getForecasts() {
      const forecasts = [];
      for (const customer of await getCustomers()) {
        let result;
        try {
          result = await postGraphql(FORECAST_QUERY, String(customer.uuid));
        } catch {
          continue;
        }
        for (const edge of result?.data?.billingAccountsConnection?.edges ?? []) {
          const forecast = edge?.node?.billForecast;
          const interval = String(forecast?.timeInterval ?? '');
          if (!forecast || !interval.includes('/')) {
            continue;
          }
          const [start, end] = interval.split('/');
          for (const segment of forecast.segments ?? []) {
            const accountUuid = segment?.serviceAgreement?.uuid;
            if (!accountUuid) {
              continue;
            }
            forecasts.push({
              accountUuid: String(accountUuid),
              startDate: start.slice(0, 10),
              endDate: end.slice(0, 10),
              currentDate: String(forecast.currentDateTime ?? start).slice(0, 10),
              unit: normalizeUnit(segment.estimatedUsage?.unit),
              usageToDate: valueOf(segment.soFarUsage),
              costToDate: valueOf(segment.soFarUsageCharges),
              forecastedUsage: valueOf(segment.estimatedUsage),
              forecastedCost: valueOf(segment.estimatedUsageCharges),
              typicalUsage: valueOf(segment.priorYearUsage),
              typicalCost: valueOf(segment.priorYearUsageCharges),
            });
          }
        }
      }
      return forecasts;
    },

    /**
     * Reads with their cost between two local dates (inclusive). Some
     * utilities answer the cost endpoint with an error or nothing at a fine
     * aggregation: the usage endpoint is asked instead, the reads then carry
     * no cost (`withCost: false`).
     * @returns {Promise<{ reads: Array<{ start: number, end: number, value: number, cost: number|null }>, unit: string|null, withCost: boolean }>}
     */
    async getCostReads(account, aggregate, startDate, endDate) {
      let range;
      try {
        range = await fetchRange(account, aggregate, startDate, endDate, false);
      } catch (err) {
        if (!(err instanceof HttpError) || aggregate === 'bill') {
          throw err;
        }
        range = null;
      }
      const reads = range ? parseReads(range.reads, false) : [];
      if (reads.length > 0 || aggregate === 'bill') {
        return { reads, unit: range?.unit ?? null, withCost: true };
      }
      return this.getUsageReads(account, aggregate, startDate, endDate);
    },

    /** Reads without cost between two local dates (inclusive). */
    async getUsageReads(account, aggregate, startDate, endDate) {
      const range = await fetchRange(account, aggregate, startDate, endDate, true);
      return { reads: parseReads(range.reads, true), unit: range.unit, withCost: false };
    },
  };
}
