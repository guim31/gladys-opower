// -----------------------------------------------------------------------------
// One Gladys device per Opower meter (utility account): electricity or gas.
//
// External ids are built from the Opower account uuid, which the utility
// never reuses: `ext:<selector>:meter:<uuid>`. Feature keys are forever.
//
// Electricity feeds Gladys' energy tracking with a consumption feature the
// integration dates itself (POST /energy/consumption): 30-minute slots when
// the utility serves hourly (or finer) reads, days otherwise. No cumulative
// index is published: Opower's data arrives a day or two late, and the core's
// index pipeline would collapse it into the half-hour it is received in. The
// core derives the cost feature of that consumption from the user's tariff.
//
// The summaries (last complete day, current month, bill forecast) are plain
// readings: they never enter the energy tracking, so nothing is counted
// twice. Gas has no consumption feature: the energy tracking of Gladys 5.2
// prices electricity only, and a gas consumption would be attached to the
// electric meter.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CAT,
  DEVICE_FEATURE_TYPES as TYPE,
  DEVICE_FEATURE_UNITS as UNIT,
  DEVICE_POLL_FREQUENCIES,
} from '@gladysassistant/integration-sdk';
import { FEATURE_NAMES, METER_NAMES, pick } from './i18n.js';

export const FEATURE = {
  CONSUMPTION: 'consumption',
  DAILY_CONSUMPTION: 'daily_consumption',
  LAST_DAY_USAGE: 'last_day_usage',
  LAST_DAY_COST: 'last_day_cost',
  MONTH_USAGE: 'month_usage',
  MONTH_COST: 'month_cost',
  FORECAST_USAGE: 'forecast_usage',
  FORECAST_COST: 'forecast_cost',
};

// Resolutions served as intervals: read hourly, split into half hours.
const INTERVAL_RESOLUTIONS = ['HOUR', 'HALF_HOUR', 'QUARTER_HOUR', 'FIVE_MINUTE'];

/** How a meter is read: 'interval', 'daily' or 'bill' (bills only, no daily data). */
export function readingMode(account) {
  if (INTERVAL_RESOLUTIONS.includes(account.readResolution)) {
    return 'interval';
  }
  return account.readResolution === 'BILLING' ? 'bill' : 'daily';
}

/** The consumption feature fed to the energy tracking, or null (gas, bills only). */
export function consumptionKey(account) {
  if (account.meterType !== 'ELEC') {
    return null;
  }
  const mode = readingMode(account);
  if (mode === 'interval') {
    return FEATURE.CONSUMPTION;
  }
  return mode === 'daily' ? FEATURE.DAILY_CONSUMPTION : null;
}

/** The ids of a meter's device and features. */
export function meterIds(gladys, account) {
  return gladys.externalIds('meter', account.uuid);
}

/** "…0003": enough to tell two meters apart, not the whole account number. */
function accountSuffix(account) {
  const digits = String(account.utilityAccountId || account.uuid).replace(/[^0-9A-Za-z]/g, '');
  return `…${digits.slice(-4)}`;
}

/**
 * The device Gladys discovers for a meter.
 * @param {object} gladys the SDK client
 * @param {object} account an account of the Opower client
 * @param {{ shortName: string }} utility
 * @param {string} language
 */
export function buildDevice(gladys, account, utility, language) {
  const ids = meterIds(gladys, account);
  const names = pick(FEATURE_NAMES, language);
  const gas = account.meterType === 'GAS';
  const usageFeature = () =>
    gas
      ? {
          category: CAT.VOLUME_SENSOR,
          type: TYPE.VOLUME_SENSOR.DECIMAL,
          unit: UNIT.CUBIC_METER,
        }
      : {
          // A plain energy reading: neither an index nor a consumption type,
          // so the core does not count it in the energy tracking.
          category: CAT.ENERGY_SENSOR,
          type: TYPE.ENERGY_SENSOR.INDEX_YESTERDAY,
          unit: UNIT.KILOWATT_HOUR,
        };
  const reading = (key, kind) => ({
    name: names[key],
    external_id: ids.feature(key),
    ...kind,
    read_only: true,
    has_feedback: false,
    keep_history: true,
    // Net metering makes a usage negative, a credit makes a cost negative.
    min: -1000000,
    max: 1000000,
  });
  const money = { category: CAT.CURRENCY, type: TYPE.CURRENCY.DECIMAL, unit: UNIT.DOLLAR };

  const features = [];
  const consumption = consumptionKey(account);
  if (consumption) {
    features.push({
      name: names[consumption],
      external_id: ids.feature(consumption),
      category: CAT.ENERGY_SENSOR,
      type:
        consumption === FEATURE.CONSUMPTION
          ? TYPE.ENERGY_SENSOR.THIRTY_MINUTES_CONSUMPTION
          : TYPE.ENERGY_SENSOR.DAILY_CONSUMPTION,
      unit: UNIT.KILOWATT_HOUR,
      read_only: true,
      has_feedback: false,
      keep_history: true,
      min: 0,
      max: 1000000,
    });
  }
  features.push(
    reading(FEATURE.LAST_DAY_USAGE, usageFeature()),
    reading(FEATURE.LAST_DAY_COST, money),
    reading(FEATURE.MONTH_USAGE, usageFeature()),
    reading(FEATURE.MONTH_COST, money),
    reading(FEATURE.FORECAST_USAGE, usageFeature()),
    reading(FEATURE.FORECAST_COST, money),
  );

  return {
    name: `${utility.shortName} ${pick(METER_NAMES, language)[account.meterType]} ${accountSuffix(account)}`,
    external_id: ids.device,
    // The container refreshes the meters itself (src/poller.js); the core's
    // poll, once a minute, is only a fallback the poller skips.
    should_poll: true,
    poll_frequency: DEVICE_POLL_FREQUENCIES.EVERY_MINUTES,
    features,
  };
}

/** The summary states of a meter, for publishChangedStates. */
export function summaryStates(gladys, account, summary) {
  const ids = meterIds(gladys, account);
  const states = [];
  const add = (key, value) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      states.push({ device_feature_external_id: ids.feature(key), state: value });
    }
  };
  add(FEATURE.LAST_DAY_USAGE, summary.lastDay?.usage);
  add(FEATURE.LAST_DAY_COST, summary.lastDay?.cost);
  add(FEATURE.MONTH_USAGE, summary.month?.usage);
  add(FEATURE.MONTH_COST, summary.month?.cost);
  add(FEATURE.FORECAST_USAGE, summary.forecast?.usage);
  add(FEATURE.FORECAST_COST, summary.forecast?.cost);
  return states;
}
