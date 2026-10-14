// -----------------------------------------------------------------------------
// Puget Sound Energy (PSE): an ASP.NET sign-in, then the Opower token written
// in a script of the usage page.
//
// Ported from opower's utilities/pse.py (tronikos/opower, Apache-2.0):
//   1. the login page carries the anti-forgery __RequestVerificationToken;
//   2. AsyncSignIn takes it with the credentials;
//   3. an empty account selector means the sign-in failed;
//   4. the usage page assigns `var accessToken = "..."` in an inline script.
// Every error names its step. The live check of 14/10/2026 saw a made-up
// account end on /servererrorpage (HTTP 500): when the sign-in or the account
// selector lands there, it is read as refused credentials. Not verified with
// a real account yet.
// -----------------------------------------------------------------------------

import { CannotConnectError, HttpError, InvalidAuthError } from '../errors.js';
import { findTags } from './forms.js';

const BASE = 'https://www.pse.com';
const ERROR_PAGE = `${BASE}/servererrorpage`;

/** Run one step; an HTTP error names it, the error page after the credentials is a refusal. */
async function step(name, run, { refusalOnErrorPage = false } = {}) {
  try {
    return await run();
  } catch (err) {
    if (err instanceof HttpError) {
      if (refusalOnErrorPage && err.url.toLowerCase() === ERROR_PAGE) {
        throw new InvalidAuthError(`PSE refused the sign-in (${name}: server error page)`);
      }
      throw new CannotConnectError(`PSE: ${name} failed (${err.message})`);
    }
    throw err;
  }
}

export const pse = {
  key: 'pse',
  name: 'Puget Sound Energy (PSE)',
  shortName: 'PSE',
  timezone: 'America/Los_Angeles',
  signIn: 'password',

  create() {
    return {
      subdomain: () => 'pse',
      utilityCode: () => 'pse',

      async login(session, { username, password }) {
        // A second sign-in fails while the previous cookies are around.
        session.jar.clear((cookie) => cookie.domain === 'www.pse.com');
        const page = (
          await step('login page', () => session.request(`${BASE}/en/login`, { okOnly: true }))
        ).text();
        const verification = findTags(page, 'input').find(
          ({ attributes }) => attributes.name === '__RequestVerificationToken',
        )?.attributes.value;
        if (!verification) {
          throw new CannotConnectError('PSE: the login page changed (no verification token)');
        }

        await step(
          'sign-in',
          () =>
            session.request(`${BASE}/api/pseauthentication/AsyncSignIn`, {
              method: 'POST',
              form: {
                __RequestVerificationToken: verification,
                GenericMessage: 'Incorrect username or password',
                LockedMessage: 'Account is locked',
                ReturnUrl: '',
                OtherPageUrl: 'False',
                Username: username,
                Password: password,
                RememberMe: 'true',
              },
              okOnly: true,
            }),
          { refusalOnErrorPage: true },
        );

        const accounts = await step(
          'account selector',
          () =>
            session.request(`${BASE}/api/AccountSelector/GetContractAccountJson`, { okOnly: true }),
          { refusalOnErrorPage: true },
        );
        if (accounts.text().length === 0) {
          throw new InvalidAuthError('PSE refused the username or the password');
        }

        const usage = (
          await step('usage page', () =>
            session.request(`${BASE}/en/account-and-billing/my-usage/view-my-usage`, {
              okOnly: true,
            }),
          )
        ).text();
        const token = [...usage.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
          .map((script) => script[1].match(/var accessToken\s+=\s+["']([^"']+)["']/)?.[1])
          .find(Boolean);
        if (!token) {
          throw new CannotConnectError('PSE: the usage page carries no Opower token');
        }
        return { token };
      },
    };
  },
};
