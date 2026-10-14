// -----------------------------------------------------------------------------
// American Electric Power (AEP) companies: an ASP.NET form on the usage page.
//
// Ported from opower's utilities/aepbase.py and its subclasses (tronikos/opower,
// Apache-2.0):
//   1. the usage page serves the sign-in form, whose field names are generated:
//      every input is sent back, the "UserID" and "Password" ones filled in;
//   2. an error block on the answer means refused credentials, otherwise the
//      page names its opower.com subdomain;
//   3. ValidToken answers the Opower access token.
// -----------------------------------------------------------------------------

import { CannotConnectError, InvalidAuthError } from '../errors.js';
import { parseAllInputs } from './forms.js';

function createAepCompany({ key, name, shortName, hostname, timezone = 'America/New_York' }) {
  return {
    key,
    name,
    shortName,
    timezone,
    signIn: 'password',

    create() {
      let subdomain = null;
      return {
        subdomain() {
          if (!subdomain) {
            throw new CannotConnectError(`${shortName}: sign in before reading the data`);
          }
          return subdomain;
        },
        utilityCode() {
          return this.subdomain();
        },

        async login(session, { username, password }) {
          // Old Opower cookies break a second sign-in.
          session.jar.clear((cookie) => cookie.domain.endsWith('opower.com'));
          const usageUrl = `https://www.${hostname}/account/usage/`;
          const page = await session.request(usageUrl, { okOnly: true });

          // Every input of the page, like the Python parser: the form fields
          // carry generated names and hidden ASP.NET state.
          const inputs = parseAllInputs(page.text());
          for (const field of Object.keys(inputs)) {
            if (field.includes('UserID')) {
              inputs[field] = username;
            }
            if (field.includes('Password')) {
              inputs[field] = password;
            }
          }

          const answer = (
            await session.request(usageUrl, {
              method: 'POST',
              headers: { Referer: usageUrl },
              form: inputs,
              okOnly: true,
            })
          ).text();
          if (/<[^>]*?class="error"[^>]*?>[\s\S]*?<p>([\s\S]*?)<\/p>/.test(answer)) {
            throw new InvalidAuthError(`${shortName} refused the username or the password`);
          }
          const found = answer.match(/https:\/\/([^.]*)\.opower\.com/);
          if (!found) {
            throw new CannotConnectError(
              `${shortName}: the usage page does not name its Opower service`,
            );
          }
          subdomain = found[1];

          const tokens = (
            await session.request(`https://www.${hostname}/account/oauth/ValidToken`, {
              headers: {
                Accept: 'application/json, text/javascript, */*; q=0.01',
                'X-Requested-With': 'XMLHttpRequest',
                Referer: usageUrl,
              },
              okOnly: true,
            })
          ).json();
          const token = Array.isArray(tokens) ? tokens[0]?.data?.AccessToken : undefined;
          if (!token) {
            throw new InvalidAuthError(`${shortName} did not hand over the Opower token`);
          }
          return { token: String(token) };
        },
      };
    },
  };
}

export const aepOhio = createAepCompany({
  key: 'aepohio',
  name: 'AEP Ohio',
  shortName: 'AEP Ohio',
  hostname: 'aepohio.com',
});

export const aepTexas = createAepCompany({
  key: 'aeptexas',
  name: 'AEP Texas',
  shortName: 'AEP Texas',
  hostname: 'aeptexas.com',
  timezone: 'America/Chicago',
});

export const appalachianPower = createAepCompany({
  key: 'appalachianpower',
  name: 'Appalachian Power',
  shortName: 'Appalachian Power',
  hostname: 'appalachianpower.com',
});

export const indianaMichiganPower = createAepCompany({
  key: 'indianamichiganpower',
  name: 'Indiana Michigan Power',
  shortName: 'I&M',
  hostname: 'indianamichiganpower.com',
});

export const kentuckyPower = createAepCompany({
  key: 'kentuckypower',
  name: 'Kentucky Power',
  shortName: 'Kentucky Power',
  hostname: 'kentuckypower.com',
});

export const pso = createAepCompany({
  key: 'psoklahoma',
  name: 'Public Service Company of Oklahoma (PSO)',
  shortName: 'PSO',
  hostname: 'psoklahoma.com',
  timezone: 'America/Chicago',
});

export const swepco = createAepCompany({
  key: 'swepco',
  name: 'Southwestern Electric Power Company (SWEPCO)',
  shortName: 'SWEPCO',
  hostname: 'swepco.com',
  timezone: 'America/Chicago',
});
