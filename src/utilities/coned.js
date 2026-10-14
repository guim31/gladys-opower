// -----------------------------------------------------------------------------
// Consolidated Edison (ConEd) and Orange & Rockland (O&R): coned.com / oru.com
// sign-in API, then two Okta authorization rounds.
//
// Ported from opower's utilities/coned.py and oru.py (tronikos/opower,
// Apache-2.0):
//   1. the login page sets the pre-login cookies, among them CE_DEVICE_ID
//      (a remembered device skips the two-step check);
//   2. the Login API answers an Okta redirect, or `newDevice` + no `noMfa`:
//      a code from an authenticator app is then required (VerifyFactor) — the
//      integration computes it from the secret key the user pasted;
//   3. the Okta redirect sets the site session, the energy-use page runs the
//      second round that mints the Opower token, read from GetOPowerToken.
// The device cookie is saved in /data and replayed at the next sign-in.
// -----------------------------------------------------------------------------

import { CannotConnectError, InvalidAuthError } from '../errors.js';
import { isValidTotpSecret, totp } from '../totp.js';

const RETURN_URL = '/en/accounts-billing/my-account/energy-use';
const LOGIN_API = '/sitecore/api/ssc/ConEdWeb-Foundation-Login-Areas-LoginAPI/User/0';
const TOKEN_API =
  '/sitecore/api/ssc/ConEd-Cms-Services-Controllers-Opower/OpowerService/0/GetOPowerToken';
const DEVICE_COOKIE = 'CE_DEVICE_ID';

function createConEdFamily({ key, name, shortName, hostname, subdomain }) {
  const base = `https://www.${hostname}`;
  return {
    key,
    name,
    shortName,
    timezone: 'America/New_York',
    signIn: 'totp',

    create() {
      return {
        subdomain: () => subdomain,
        utilityCode: () => subdomain,

        async login(session, { username, password, totpSecret, loginData = {} }) {
          if (loginData.deviceCookie) {
            session.jar.set(DEVICE_COOKIE, loginData.deviceCookie, hostname);
          }
          const headers = { Referer: `${base}/en/login` };
          await session.request(`${base}/en/login`, { okOnly: true });

          const result = (
            await session.request(`${base}${LOGIN_API}/Login`, {
              method: 'POST',
              headers,
              json: {
                LoginEmail: username,
                LoginPassword: password,
                LoginRememberMe: false,
                ReturnUrl: '',
                FromURI: '',
                OpenIdRelayState: '',
              },
              okOnly: true,
            })
          ).json();
          if (!result?.login) {
            throw new InvalidAuthError(`${shortName} refused the username or the password`);
          }

          let redirectUrl = null;
          if (result.authRedirectUrl) {
            redirectUrl = result.authRedirectUrl;
          } else if (result.newDevice) {
            if (!result.noMfa) {
              if (!totpSecret) {
                throw new InvalidAuthError(
                  `${shortName} asks for a code from an authenticator app: fill in the authenticator secret key`,
                );
              }
              if (!isValidTotpSecret(totpSecret)) {
                throw new InvalidAuthError('The authenticator secret key is not valid');
              }
              const mfa = (
                await session.request(`${base}${LOGIN_API}/VerifyFactor`, {
                  method: 'POST',
                  headers,
                  json: {
                    MFACode: totp(totpSecret),
                    ReturnUrl: '',
                    FromURI: '',
                    OpenIdRelayState: '',
                  },
                  okOnly: true,
                })
              ).json();
              if (!mfa?.code) {
                throw new InvalidAuthError(
                  `${shortName} refused the authenticator code: check the secret key`,
                );
              }
              redirectUrl = mfa.authRedirectUrl;
            }
          } else {
            throw new InvalidAuthError(`${shortName} refused the sign-in`);
          }
          if (!redirectUrl) {
            throw new CannotConnectError(`${shortName} did not continue the sign-in`);
          }

          await session.request(redirectUrl, { okOnly: true });
          const energyUse = await session.request(`${base}${RETURN_URL}`, { okOnly: true });
          if (new URL(energyUse.url).pathname.includes('/login')) {
            throw new CannotConnectError(`${shortName} did not open a session after the sign-in`);
          }
          const token = (
            await session.request(`${base}${TOKEN_API}`, {
              headers: { Referer: `${base}${RETURN_URL}` },
              okOnly: true,
            })
          ).json();
          if (!token) {
            throw new CannotConnectError(`${shortName} did not hand over the Opower token`);
          }
          const deviceCookie = session.jar.get(DEVICE_COOKIE, base);
          return { token: String(token), loginData: deviceCookie ? { deviceCookie } : undefined };
        },
      };
    },
  };
}

export const coned = createConEdFamily({
  key: 'coned',
  name: 'Consolidated Edison (ConEd)',
  shortName: 'ConEd',
  hostname: 'coned.com',
  subdomain: 'cned',
});

export const oru = createConEdFamily({
  key: 'oru',
  name: 'Orange & Rockland Utilities (O&R)',
  shortName: 'O&R',
  hostname: 'oru.com',
  subdomain: 'oru',
});
