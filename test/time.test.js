// Dates in the utilities' zones, DST changes included, and the TOTP codes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  isoWithOffset,
  localDate,
  parseTimestamp,
  startOfLocalDay,
  wallClock,
} from '../src/time.js';
import { decodeBase32, isValidTotpSecret, totp } from '../src/totp.js';

const LA = 'America/Los_Angeles';

test('a local day starts at the zone midnight, 23 or 25 hours long around DST', () => {
  assert.equal(
    new Date(startOfLocalDay('2026-07-01', LA)).toISOString(),
    '2026-07-01T07:00:00.000Z',
  );
  assert.equal(
    new Date(startOfLocalDay('2026-01-15', LA)).toISOString(),
    '2026-01-15T08:00:00.000Z',
  );
  // 2026-03-08: spring forward; 2026-11-01: fall back.
  const spring = startOfLocalDay('2026-03-09', LA) - startOfLocalDay('2026-03-08', LA);
  const fall = startOfLocalDay('2026-11-02', LA) - startOfLocalDay('2026-11-01', LA);
  assert.equal(spring / 3600000, 23);
  assert.equal(fall / 3600000, 25);
  assert.equal(
    new Date(startOfLocalDay('2026-11-01', 'America/New_York')).toISOString(),
    '2026-11-01T04:00:00.000Z',
  );
});

test('an instant prints with the offset of its zone, as the cost endpoint wants it', () => {
  assert.equal(isoWithOffset(Date.parse('2026-07-01T07:00:00Z'), LA), '2026-07-01T00:00:00-07:00');
  assert.equal(
    isoWithOffset(Date.parse('2026-01-01T06:00:00Z'), 'America/Chicago'),
    '2026-01-01T00:00:00-06:00',
  );
  assert.equal(localDate(Date.parse('2026-07-01T06:59:59Z'), LA), '2026-06-30');
  assert.deepEqual(wallClock(Date.parse('2026-07-01T07:30:00Z'), LA), {
    year: 2026,
    month: 7,
    day: 1,
    hour: 0,
    minute: 30,
    second: 0,
  });
});

test('Opower timestamps parse with their offset, naive ones in the utility zone', () => {
  assert.equal(
    parseTimestamp('2026-07-01T00:00:00.000-07:00', LA),
    Date.parse('2026-07-01T07:00:00Z'),
  );
  assert.equal(
    parseTimestamp('2026-06-01T00:00:00', 'America/Chicago'),
    Date.parse('2026-06-01T05:00:00Z'),
  );
  assert.equal(parseTimestamp('2026-06-01', 'America/Chicago'), Date.parse('2026-06-01T05:00:00Z'));
  assert.ok(Number.isNaN(parseTimestamp('yesterday', LA)));
  assert.ok(Number.isNaN(parseTimestamp(null, LA)));
});

test('calendar arithmetic crosses months and years', () => {
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
});

test('TOTP codes match the RFC 6238 test vectors', () => {
  // The SHA-1 secret of the RFC, "12345678901234567890", in base32.
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(totp(secret, 59 * 1000, { digits: 8 }), '94287082');
  assert.equal(totp(secret, 1111111109 * 1000, { digits: 8 }), '07081804');
  assert.equal(totp(secret, 2000000000 * 1000, { digits: 8 }), '69279037');
  assert.equal(totp(secret, 59 * 1000), '287082');
  // Spaces, dashes and lower case as an app shows them are accepted.
  assert.equal(totp('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq', 59 * 1000), '287082');
});

test('a secret that is not base32 is refused before any sign-in', () => {
  assert.equal(decodeBase32('not base32!'), null);
  assert.equal(isValidTotpSecret('JBSWY3DPEHPK3PXP'), true);
  assert.equal(isValidTotpSecret('ABC'), false);
  assert.throws(() => totp('0189', 0), /not valid base32/);
});
