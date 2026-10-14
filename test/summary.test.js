// From reads to Gladys: half hours, days, the summaries and the gas units.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSummary,
  GAS_TO_M3,
  gasFactor,
  toDailyConsumption,
  toHalfHours,
} from '../src/summary.js';
import { startOfLocalDay } from '../src/time.js';

const LA = 'America/Los_Angeles';
const H = 3600 * 1000;
const at = (iso) => Date.parse(iso);

test('an hourly read becomes two equal half hours, quarter hours are summed', () => {
  const start = at('2026-08-14T07:00:00Z');
  const reads = [
    { start, end: start + H, value: 1.2 },
    { start: start + H, end: start + H + 15 * 60000, value: 0.1 },
    { start: start + H + 15 * 60000, end: start + H + 30 * 60000, value: 0.2 },
  ];
  assert.deepEqual(toHalfHours(reads, start + 3 * H), [
    { starts_at: '2026-08-14T07:00:00.000Z', kwh: 0.6 },
    { starts_at: '2026-08-14T07:30:00.000Z', kwh: 0.6 },
    { starts_at: '2026-08-14T08:00:00.000Z', kwh: 0.3 },
  ]);
});

test('net metering: an exporting hour counts 0 in the energy tracking', () => {
  const start = at('2026-08-14T19:00:00Z');
  assert.deepEqual(toHalfHours([{ start, end: start + H, value: -0.8 }], start + H), [
    { starts_at: '2026-08-14T19:00:00.000Z', kwh: 0 },
    { starts_at: '2026-08-14T19:30:00.000Z', kwh: 0 },
  ]);
});

test('an hour not elapsed or off the half-hour grid is not sent', () => {
  const start = at('2026-08-14T07:00:00Z');
  assert.deepEqual(toHalfHours([{ start, end: start + H, value: 1 }], start + H - 1), []);
  assert.deepEqual(
    toHalfHours([{ start: start + 60000, end: start + H + 60000, value: 1 }], start + 2 * H),
    [],
  );
});

test('daily reads become dated days, the current one left out', () => {
  const day = (date, value) => ({
    start: startOfLocalDay(date, LA),
    end: startOfLocalDay(date, LA) + 24 * H,
    value,
  });
  const now = at('2026-08-15T19:00:00Z');
  assert.deepEqual(
    toDailyConsumption(
      [day('2026-08-13', 12.5), day('2026-08-14', -1), day('2026-08-15', 3)],
      now,
      LA,
      LA,
    ),
    [
      { date: '2026-08-13', kwh: 12.5 },
      { date: '2026-08-14', kwh: 0 },
    ],
  );
});

/** Hourly reads of 1 kWh from a local date to an instant. */
function hourly(fromDate, untilMs) {
  const reads = [];
  for (let ms = startOfLocalDay(fromDate, LA); ms + H <= untilMs; ms += H) {
    reads.push({ start: ms, end: ms + H, value: 1 });
  }
  return reads;
}

function daily(fromDate, toDate, { value = 24, cost = 7.2 } = {}) {
  const reads = [];
  for (let ms = startOfLocalDay(fromDate, LA); ms < startOfLocalDay(toDate, LA); ms += 24 * H) {
    reads.push({ start: ms, end: ms + 24 * H, value, cost });
  }
  return reads;
}

test('the last day is the last complete one, the month counts complete days only', () => {
  const now = at('2026-08-15T19:00:00Z');
  // Metered until 2026-08-14 18:00 local: the 14th is not complete.
  const summary = computeSummary({
    meterType: 'ELEC',
    intervalReads: hourly('2026-08-01', at('2026-08-15T01:00:00Z')),
    dailyReads: daily('2026-08-01', '2026-08-14'),
    withCost: true,
    unit: 'KWH',
    forecast: null,
    now,
    timezone: LA,
  });
  assert.deepEqual(summary.lastDay, { date: '2026-08-13', usage: 24, cost: 7.2 });
  assert.deepEqual(summary.month, { month: '2026-08', days: 13, usage: 312, cost: 93.6 });
  assert.equal(summary.forecast, null);
  assert.equal(summary.recent.length, 13);
});

test('a month cost is only given when every day of it has its cost', () => {
  const now = at('2026-08-15T19:00:00Z');
  const reads = daily('2026-08-01', '2026-08-14');
  reads[5].cost = null;
  const summary = computeSummary({
    meterType: 'ELEC',
    dailyReads: reads,
    withCost: true,
    unit: 'KWH',
    forecast: null,
    now,
    timezone: LA,
  });
  assert.equal(summary.month.cost, null);
  assert.equal(summary.month.usage, 312);
  assert.equal(summary.lastDay.cost, 7.2);
  const usageOnly = computeSummary({
    meterType: 'ELEC',
    dailyReads: daily('2026-08-01', '2026-08-14', { cost: null }),
    withCost: false,
    unit: 'KWH',
    forecast: null,
    now,
    timezone: LA,
  });
  assert.equal(usageOnly.lastDay.cost, null);
  assert.equal(usageOnly.month.cost, null);
});

test('on the 1st of a month the month is empty, the last day still the previous one', () => {
  const now = at('2026-09-01T19:00:00Z');
  const summary = computeSummary({
    meterType: 'ELEC',
    dailyReads: daily('2026-08-25', '2026-08-31'),
    withCost: true,
    unit: 'KWH',
    forecast: null,
    now,
    timezone: LA,
  });
  assert.equal(summary.lastDay.date, '2026-08-30');
  assert.deepEqual(summary.month, { month: '2026-09', days: 0, usage: 0, cost: 0 });
});

test('gas is shown in cubic meters: CCF exactly, therms through the US heat content', () => {
  assert.equal(GAS_TO_M3.CCF.toFixed(6), '2.831685');
  assert.equal(GAS_TO_M3.THERM.toFixed(4), '2.7307');
  assert.equal(gasFactor(null), GAS_TO_M3.THERM);
  const summary = computeSummary({
    meterType: 'GAS',
    dailyReads: daily('2026-08-10', '2026-08-15', { value: 2, cost: 3 }),
    withCost: true,
    unit: 'CCF',
    forecast: {
      startDate: '2026-07-30',
      endDate: '2026-08-31',
      unit: 'THERM',
      usageToDate: 6,
      costToDate: 15,
      forecastedUsage: 12,
      forecastedCost: 30,
      typicalUsage: 11,
      typicalCost: 28,
    },
    now: at('2026-08-15T19:00:00Z'),
    timezone: LA,
  });
  assert.deepEqual(summary.lastDay, { date: '2026-08-14', usage: 5.663, cost: 3 });
  assert.equal(summary.forecast.usage, 32.768);
  assert.equal(summary.forecast.cost, 30);
  assert.equal(summary.forecast.typicalCost, 28);
});
