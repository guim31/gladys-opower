// -----------------------------------------------------------------------------
// Time-based one-time passwords (RFC 6238: HMAC-SHA1, 6 digits, 30 s), for the
// utilities whose two-step sign-in accepts an authenticator app (ConEd, O&R).
// The user pastes the secret key their utility showed when they set the app
// up; the integration computes the code itself at every sign-in.
// -----------------------------------------------------------------------------

import { createHmac } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Decode a base32 secret (spaces, dashes, case and padding ignored).
 * @returns {Buffer|null} null when the text is not base32
 */
export function decodeBase32(secret) {
  const clean = String(secret ?? '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/=+$/, '');
  if (clean === '' || /[^A-Z2-7]/.test(clean)) {
    return null;
  }
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** True when the secret can produce codes. */
export function isValidTotpSecret(secret) {
  const key = decodeBase32(secret);
  return key !== null && key.length >= 10;
}

/**
 * The code for an instant.
 * @param {string} secret base32
 * @param {number} [now] ms
 * @param {{ digits?: number, period?: number }} [options]
 */
export function totp(secret, now = Date.now(), { digits = 6, period = 30 } = {}) {
  const key = decodeBase32(secret);
  if (key === null) {
    throw new Error('The authenticator secret key is not valid base32');
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / period)));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}
