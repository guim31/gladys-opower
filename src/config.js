// -----------------------------------------------------------------------------
// The configuration filled in by the user (manifest `config_schema`).
//
// DEFAULT_CONFIG mirrors the manifest defaults (test/manifest.test.js checks
// it); normalizeConfig trims and types what the form sends, so the rest of the
// code never deals with an absent or malformed value.
// -----------------------------------------------------------------------------

import { LANGUAGES } from './i18n.js';

export { LANGUAGES };

/** Days of consumption imported into the energy tracking on the first sync. */
export const HISTORY_DAYS = ['7', '30', '90', '365'];

export const DEFAULT_CONFIG = {
  utility: '',
  username: '',
  password: '',
  totp_secret: '',
  history_days: '30',
  language: 'fr',
};

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * @param {Record<string, unknown>} [raw] the config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const historyDays = HISTORY_DAYS.includes(String(raw.history_days))
    ? String(raw.history_days)
    : DEFAULT_CONFIG.history_days;
  return {
    utility: text(raw.utility).toLowerCase(),
    username: text(raw.username),
    // A password may legitimately start or end with a space: kept as typed.
    password: typeof raw.password === 'string' ? raw.password : '',
    totp_secret: text(raw.totp_secret),
    history_days: historyDays,
    historyDays: Number(historyDays),
    language: LANGUAGES.includes(raw.language) ? raw.language : DEFAULT_CONFIG.language,
  };
}

/** True when a sign-in can be tried. */
export function isConfigured(config) {
  return Boolean(config.utility && config.username && config.password);
}

/** The values that must never reach a log line. */
export function secretsOf(config) {
  return [config.password, config.totp_secret].filter((value) => value && value.length >= 3);
}
