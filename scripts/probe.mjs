#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Probe the real utility websites, read-only, from a machine with Internet.
//
// The tests serve every sign-in from fixtures: they prove the port follows
// the Python library, not that the live sites still answer that way. This
// script checks the live side without an account:
//
//   node scripts/probe.mjs
//
// For five large utilities (PG&E, ConEd, ComEd, AEP Ohio, PSE), it signs in
// with a made-up account and expects a clean refusal: "refused cleanly" means
// the site answered through the whole flow the integration expects up to the
// password check; anything else (a page that changed, a network error) is
// printed with its class and a reason free of any secret.
//
// With a real account, it goes further — still read-only:
//
//   OPOWER_UTILITY=pge OPOWER_USERNAME=... OPOWER_PASSWORD=... node scripts/probe.mjs
//   (OPOWER_TOTP_SECRET=... for ConEd/O&R; OPOWER_CODE_METHOD=email|sms to be
//   asked a verification code on the terminal for PG&E and Exelon)
//
// It signs in, lists the meters (kind and resolution only) and counts the
// reads of the last 3 days, the daily costs and the forecast. It never prints
// the username, the password, a token, an account number nor an address.
// -----------------------------------------------------------------------------

import { createInterface } from 'node:readline/promises';
import { CannotConnectError, InvalidAuthError, MfaRequiredError } from '../src/errors.js';
import { createHttpSession } from '../src/http.js';
import { createOpowerClient } from '../src/opower/client.js';
import { readingMode } from '../src/meters.js';
import { addDays, localDate } from '../src/time.js';
import { findUtility } from '../src/utilities/index.js';

const FAKE_ACCOUNT = {
  username: `probe.${Math.random().toString(36).slice(2, 10)}@example.com`,
  password: `Probe-${Math.random().toString(36).slice(2, 12)}!`,
};
const PROBED = ['pge', 'coned', 'comed', 'aepohio', 'pse'];

function describe(err) {
  const kind = err?.name ?? 'Error';
  // The messages are built without secrets (src/errors.js); cut them short anyway.
  return `${kind}: ${String(err?.message ?? err).slice(0, 160)}`;
}

async function probeRefusal(key) {
  const utility = findUtility(key);
  const session = createHttpSession();
  try {
    await utility.create().login(session, { ...FAKE_ACCOUNT, loginData: {} });
    return `${key}: UNEXPECTED — a made-up account was accepted`;
  } catch (err) {
    if (err instanceof InvalidAuthError) {
      return `${key}: refused cleanly (${describe(err)})`;
    }
    if (err instanceof MfaRequiredError) {
      // Exelon checks the password first: a code request means it was accepted.
      return `${key}: UNEXPECTED — a verification code was asked for a made-up account`;
    }
    return `${key}: FAILED before the password check (${describe(err)})`;
  }
}

async function probeAccount() {
  const utility = findUtility(process.env.OPOWER_UTILITY ?? '');
  if (!utility) {
    throw new Error(`Unknown or unsupported OPOWER_UTILITY "${process.env.OPOWER_UTILITY}"`);
  }
  const credentials = {
    username: process.env.OPOWER_USERNAME,
    password: process.env.OPOWER_PASSWORD,
    totpSecret: process.env.OPOWER_TOTP_SECRET,
    loginData: {},
  };
  let session = createHttpSession();
  let instance = utility.create();
  let token;
  try {
    ({ token } = await instance.login(session, credentials));
  } catch (err) {
    if (!(err instanceof MfaRequiredError) || !process.env.OPOWER_CODE_METHOD) {
      throw err;
    }
    const options = err.challenge.options();
    console.log(
      `Code asked; options: ${options.map((option) => option.kind).join(', ') || '(sent already)'}`,
    );
    const option = options.find((candidate) => candidate.kind === process.env.OPOWER_CODE_METHOD);
    if (option) {
      await err.challenge.send(option.id);
    }
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    const code = (await terminal.question('Verification code: ')).trim();
    terminal.close();
    credentials.loginData = await err.challenge.submit(code);
    instance = utility.create();
    session = createHttpSession();
    ({ token } = await instance.login(session, credentials));
  }
  console.log(`${utility.key}: signed in, Opower service "${instance.subdomain()}"`);

  const client = createOpowerClient({
    session,
    utility: instance,
    token,
    timezone: utility.timezone,
  });
  const accounts = await client.getAccounts();
  const forecasts = await client.getForecasts();
  const today = localDate(Date.now(), utility.timezone);
  for (const [index, account] of accounts.entries()) {
    const mode = readingMode(account);
    const line = [
      `meter ${index + 1}: ${account.meterType}, resolution ${account.readResolution} (${mode})`,
    ];
    try {
      if (mode === 'interval') {
        const hourly = await client.getUsageReads(account, 'hour', addDays(today, -3), today);
        line.push(`${hourly.reads.length} hourly reads in 3 days`);
      }
      if (mode !== 'bill') {
        const daily = await client.getCostReads(account, 'day', addDays(today, -7), today);
        line.push(
          `${daily.reads.length} daily reads in 7 days, ${daily.withCost ? 'with' : 'without'} cost, unit ${daily.unit ?? '?'}`,
        );
        const last = daily.reads.at(-1);
        if (last) {
          line.push(`last day ${localDate(last.start, utility.timezone)}`);
        }
      }
    } catch (err) {
      line.push(`reads failed (${describe(err)})`);
    }
    line.push(
      forecasts.some((forecast) => forecast.accountUuid === account.uuid)
        ? 'forecast: yes'
        : 'forecast: no',
    );
    console.log(line.join(' · '));
  }
}

if (process.env.OPOWER_USERNAME && process.env.OPOWER_PASSWORD) {
  try {
    await probeAccount();
  } catch (err) {
    console.log(`Account probe failed: ${describe(err)}`);
    process.exitCode = err instanceof CannotConnectError ? 2 : 1;
  }
} else {
  for (const key of PROBED) {
    console.log(await probeRefusal(key));
  }
}
