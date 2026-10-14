// -----------------------------------------------------------------------------
// Duquesne Light Company (DQE): an OAuth "password" form, then the Opower
// token written in a script of the electric-use page.
//
// Ported from opower's utilities/duquesnelight.py (tronikos/opower,
// Apache-2.0). The site sits behind a bot filter (Incapsula): the requests
// carry the headers of a browser navigation.
// -----------------------------------------------------------------------------

import { HttpError, InvalidAuthError } from '../errors.js';
import { safeUrl } from '../http.js';

const NAVIGATION_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Cache-Control': 'max-age=0',
};

export const duquesne = {
  key: 'duquesnelight',
  name: 'Duquesne Light Company (DQE)',
  shortName: 'Duquesne Light',
  timezone: 'America/New_York',
  signIn: 'password',

  create() {
    return {
      subdomain: () => 'duq',
      utilityCode: () => 'duq',

      async login(session, { username, password }) {
        session.jar.clear((cookie) => cookie.domain.includes('duquesnelight.com'));
        const url = 'https://auth.duquesnelight.com/oauth/authorize/login';
        const answer = await session.request(url, {
          method: 'POST',
          headers: NAVIGATION_HEADERS,
          form: { grant_type: 'password', remember_username: 'True', username, password },
        });
        if (answer.status === 400) {
          throw new InvalidAuthError('Duquesne Light refused the username or the password');
        }
        if (answer.status !== 200) {
          throw new HttpError(answer.status, safeUrl(url));
        }

        const page = (
          await session.request(
            'https://www.duquesnelight.com/energy-money-savings/my-electric-use',
            { headers: NAVIGATION_HEADERS, okOnly: true },
          )
        ).text();
        const token = [...page.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
          .map((script) => script[1].match(/"OPowerToken": "([^"]+)"/)?.[1])
          .find(Boolean);
        if (!token) {
          throw new InvalidAuthError('Duquesne Light did not hand over the Opower token');
        }
        return { token };
      },
    };
  },
};
