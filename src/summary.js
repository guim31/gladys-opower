// -----------------------------------------------------------------------------
// From Opower reads to what Gladys shows. Pure functions, no I/O.
//
//   - `toHalfHours`: hourly (or half-hourly) reads → the dated 30-minute
//     consumption of Gladys' energy tracking (POST /energy/consumption). An
//     hour is split into two equal halves, the practice the core recommends.
//   - `toDailyConsumption`: daily reads → the dated daily consumption.
//   - `computeSummary`: the last complete day, the current month and the
//     bill forecast of a meter, in Gladys units.
//
// Net metering: Opower reports the net of each interval, negative when the
// home exported more than it took. The consumption sent to the energy
// tracking cannot be negative (the core refuses it): an exporting interval
// counts 0 there. The summaries keep the net figures the utility bills.
// -----------------------------------------------------------------------------

import { addDays, DAY_MS, localDate, localMonth, startOfLocalDay } from './time.js';

const HALF_HOUR_MS = 30 * 60 * 1000;

// Gas: Gladys has no therm nor CCF unit, so gas volumes are shown in cubic
// meters. A CCF is 100 cubic feet (exact). A therm is energy (100,000 Btu):
// it becomes a volume through the average heat content of the natural gas
// delivered to US consumers, 1,037 Btu per cubic foot (EIA).
const CUBIC_FOOT_M3 = 0.028316846592;
const BTU_PER_CUBIC_FOOT = 1037;
export const GAS_TO_M3 = {
  CCF: 100 * CUBIC_FOOT_M3,
  THERM: (100000 / BTU_PER_CUBIC_FOOT) * CUBIC_FOOT_M3,
};

const round = (value, digits) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** The factor turning a gas reading into m³ (THERM when the utility does not say). */
export function gasFactor(unit) {
  return GAS_TO_M3[unit] ?? GAS_TO_M3.THERM;
}

/**
 * Interval reads → 30-minute slots `{ starts_at, kwh }`, elapsed ones only.
 * A read of 30 minutes or more is split evenly (and skipped when it does not
 * start on a slot boundary); a shorter one is summed into its slot.
 */
export function toHalfHours(reads, now) {
  const slots = new Map();
  for (const read of reads) {
    const duration = read.end - read.start;
    if (read.end > now || duration <= 0) {
      continue;
    }
    const kwh = Math.max(0, read.value);
    if (duration >= HALF_HOUR_MS) {
      const count = Math.round(duration / HALF_HOUR_MS);
      if (read.start % HALF_HOUR_MS !== 0 || count * HALF_HOUR_MS !== duration) {
        continue;
      }
      for (let i = 0; i < count; i += 1) {
        const start = read.start + i * HALF_HOUR_MS;
        slots.set(start, (slots.get(start) ?? 0) + kwh / count);
      }
    } else {
      const start = read.start - (read.start % HALF_HOUR_MS);
      slots.set(start, (slots.get(start) ?? 0) + kwh);
    }
  }
  return [...slots.entries()]
    .sort(([a], [b]) => a - b)
    .map(([start, kwh]) => ({ starts_at: new Date(start).toISOString(), kwh: round(kwh, 6) }));
}

/**
 * Daily reads → `{ date, kwh }` for the days elapsed in the Gladys zone.
 * @param {string} utilityZone the zone the utility counts days in
 * @param {string} gladysZone the zone Gladys stamps daily states in
 */
export function toDailyConsumption(reads, now, utilityZone, gladysZone) {
  const today = localDate(now, gladysZone);
  const days = new Map();
  for (const read of reads) {
    const date = localDate(read.start, utilityZone);
    if (read.end > now || date >= today) {
      continue;
    }
    days.set(date, (days.get(date) ?? 0) + Math.max(0, read.value));
  }
  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, kwh]) => ({ date, kwh: round(kwh, 6) }));
}

/**
 * Usage per local day, with whether the day is complete.
 * Interval reads: a day is complete once the reads reach its last instant.
 * Daily reads: a day is complete once its read has ended.
 */
function usageByDay(reads, { daily, now, timezone }) {
  const days = new Map();
  let coveredUntil = -Infinity;
  for (const read of reads) {
    const date = localDate(read.start, timezone);
    days.set(date, (days.get(date) ?? 0) + read.value);
    coveredUntil = Math.max(coveredUntil, read.end);
  }
  const result = [];
  for (const [date, usage] of days) {
    const end = daily
      ? Math.min(coveredUntil, startOfLocalDay(addDays(date, 1), timezone))
      : startOfLocalDay(addDays(date, 1), timezone);
    const complete = end <= now && end <= coveredUntil;
    result.push({ date, usage, complete });
  }
  return result.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * @param {object} input
 * @param {'ELEC'|'GAS'} input.meterType
 * @param {Array<{start:number,end:number,value:number}>} [input.intervalReads] hourly reads (interval meters)
 * @param {Array<{start:number,end:number,value:number,cost:number|null}>} input.dailyReads
 * @param {boolean} input.withCost the daily reads came from the cost endpoint
 * @param {string|null} input.unit the reading unit (gas: THERM or CCF)
 * @param {object|null} input.forecast the bill forecast of the meter
 * @param {number} input.now ms
 * @param {string} input.timezone the utility's zone
 */
export function computeSummary({
  meterType,
  intervalReads = null,
  dailyReads,
  withCost,
  unit,
  forecast,
  now,
  timezone,
}) {
  const factor = meterType === 'GAS' ? gasFactor(unit) : 1;
  const usageDigits = meterType === 'GAS' ? 3 : 2;
  const toUnit = (value) => round(value * factor, usageDigits);

  const days = intervalReads
    ? usageByDay(intervalReads, { daily: false, now, timezone })
    : usageByDay(dailyReads, { daily: true, now, timezone });
  const costs = new Map();
  if (withCost) {
    for (const read of dailyReads) {
      if (read.cost !== null && read.end <= now) {
        const date = localDate(read.start, timezone);
        costs.set(date, (costs.get(date) ?? 0) + read.cost);
      }
    }
  }

  const complete = days.filter((day) => day.complete);
  const last = complete.at(-1) ?? null;
  const lastDay = last
    ? {
        date: last.date,
        usage: toUnit(last.usage),
        cost: costs.has(last.date) ? round(costs.get(last.date), 2) : null,
      }
    : null;

  const month = localMonth(now, timezone);
  const inMonth = complete.filter((day) => day.date.startsWith(month));
  const monthCostKnown = withCost && inMonth.every((day) => costs.has(day.date));
  const monthSummary = {
    month,
    days: inMonth.length,
    usage: toUnit(inMonth.reduce((sum, day) => sum + day.usage, 0)),
    cost: monthCostKnown
      ? round(
          inMonth.reduce((sum, day) => sum + costs.get(day.date), 0),
          2,
        )
      : null,
  };

  let forecastSummary = null;
  if (forecast) {
    const forecastFactor = meterType === 'GAS' ? gasFactor(forecast.unit ?? unit) : 1;
    const toForecastUnit = (value) =>
      value === null ? null : round(value * forecastFactor, usageDigits);
    forecastSummary = {
      startDate: forecast.startDate,
      endDate: forecast.endDate,
      usage: toForecastUnit(forecast.forecastedUsage),
      cost: forecast.forecastedCost === null ? null : round(forecast.forecastedCost, 2),
      usageToDate: toForecastUnit(forecast.usageToDate),
      costToDate: forecast.costToDate === null ? null : round(forecast.costToDate, 2),
      typicalCost: forecast.typicalCost === null ? null : round(forecast.typicalCost, 2),
    };
  }

  // The last days for the widget chart (14 at most, complete ones).
  const recent = complete.slice(-14).map((day) => ({ date: day.date, usage: toUnit(day.usage) }));

  return { lastDay, month: monthSummary, forecast: forecastSummary, recent };
}

/** The local date a fresh history starts from. */
export function historyStart(now, timezone, days) {
  return localDate(now - days * DAY_MS, timezone);
}
