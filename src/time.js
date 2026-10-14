// -----------------------------------------------------------------------------
// Dates in a given time zone, without a library.
//
// Opower counts days in the utility's time zone (a PG&E day starts at midnight
// in Los Angeles, whatever the container's zone), and Gladys stamps a daily
// consumption at the local midnight of its own zone. Node's Intl knows the
// IANA zones: these helpers read a wall clock from it and find the instant of
// a local time, DST changes included.
// -----------------------------------------------------------------------------

export const HOUR_MS = 3600 * 1000;
export const DAY_MS = 24 * HOUR_MS;

const formatters = new Map();

function formatter(timeZone) {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, found);
  }
  return found;
}

/** True when Intl knows the zone. */
export function isValidTimeZone(timeZone) {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/**
 * The wall clock of an instant in a zone.
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number }}
 */
export function wallClock(ms, timeZone) {
  const parts = {};
  for (const { type, value } of formatter(timeZone).formatToParts(new Date(ms))) {
    if (type !== 'literal') {
      parts[type] = Number(value);
    }
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/** Offset of the zone from UTC at an instant, in ms (e.g. -7 h for Los Angeles in summer). */
export function offsetMs(ms, timeZone) {
  const w = wallClock(ms, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

const pad = (n, width = 2) => String(n).padStart(width, '0');

/** The local date (YYYY-MM-DD) of an instant in a zone. */
export function localDate(ms, timeZone) {
  const w = wallClock(ms, timeZone);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
}

/** The local month (YYYY-MM) of an instant in a zone. */
export function localMonth(ms, timeZone) {
  return localDate(ms, timeZone).slice(0, 7);
}

/** A date shifted by whole days (calendar arithmetic, no zone). */
export function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return shifted.toISOString().slice(0, 10);
}

/** The first day of the month of a date. */
export function monthStart(date) {
  return `${date.slice(0, 7)}-01`;
}

/**
 * The instant of a local wall time in a zone. Used for midnights, which exist
 * every day in the US zones (their DST changes happen at 2 a.m.); a time
 * inside a spring-forward gap would come out an hour off.
 */
export function zonedTimeToMs(date, timeZone, hour = 0, minute = 0) {
  const [y, m, d] = date.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, hour, minute);
  // Two passes settle the offset around a DST change.
  let guess = wall - offsetMs(wall, timeZone);
  guess = wall - offsetMs(guess, timeZone);
  return guess;
}

/** The instant a local day starts. */
export function startOfLocalDay(date, timeZone) {
  return zonedTimeToMs(date, timeZone, 0, 0);
}

/** An instant as ISO 8601 with the zone's offset, e.g. 2026-07-01T00:00:00-07:00. */
export function isoWithOffset(ms, timeZone) {
  const w = wallClock(ms, timeZone);
  const offset = Math.round(offsetMs(ms, timeZone) / 60000);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return (
    `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/**
 * Parse an Opower timestamp. Most carry an offset; a naive one is read in the
 * utility's zone (some utilities send local times without it).
 * @returns {number} ms, NaN when unreadable
 */
export function parseTimestamp(value, timeZone) {
  if (typeof value !== 'string') {
    return NaN;
  }
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    return Date.parse(value);
  }
  const match = value.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/);
  if (!match) {
    return NaN;
  }
  const [, date, hour = '0', minute = '0', second = '0'] = match;
  return zonedTimeToMs(date, timeZone, Number(hour), Number(minute)) + Number(second) * 1000;
}
