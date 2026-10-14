// -----------------------------------------------------------------------------
// Pacific Gas and Electric (PG&E): a Salesforce "Aura" sign-in.
//
// Ported from opower's utilities/pge.py (tronikos/opower, Apache-2.0):
//   1. the login Apex action answers the URL of a session "front door", or
//      "verifymfa :" when PG&E wants a code (sent by email or text);
//   2. the front door and the account page set the session cookies, among
//      them __Host-ERIC_PROD*, the Aura token of the next actions;
//   3. two Apex actions prepare the session, then the Opower data browser
//      page carries the Opower token in a script (`tokenFromApex`).
// A verified code returns two cookies that skip the code on the next
// sign-ins (`browsercookie`, `validationCookie`): saved in /data.
// -----------------------------------------------------------------------------

import { CannotConnectError, InvalidAuthError, MfaRequiredError } from '../errors.js';

const BASE = 'https://myaccount.pge.com';
const AURA_URL = `${BASE}/myaccount/s/sfsites/aura?aura.ApexAction.execute=1`;
const MY_ACCOUNT_URL = `${BASE}/myaccount/s/`;
const DATA_BROWSER_URL = `${BASE}/myaccount/apex/MyAcct_VF_BillInsights_OpowerDataBrowser`;

/** Run one Apex action; the dict fields travel as compact JSON in a form. */
async function apex(session, { classname, method, params, app, pageURI, token = 'null' }) {
  const action = {
    descriptor: 'aura://ApexActionController/ACTION$execute',
    params: { classname, method },
  };
  if (params !== undefined) {
    action.params.params = params;
  }
  const response = await session.request(AURA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    form: {
      message: JSON.stringify({ actions: [action] }),
      'aura.context': JSON.stringify({ app }),
      'aura.pageURI': pageURI,
      'aura.token': token,
    },
    okOnly: true,
  });
  return response.json();
}

function returnValueOf(result) {
  return result?.actions?.[0]?.returnValue?.returnValue ?? {};
}

function createChallenge(session, password, data) {
  let optionId = null;
  const options = [];
  if (data.EmailVal) {
    options.push({ id: 'Email', kind: 'email', label: String(data.EmailVal) });
  }
  if (data.PhoneVal) {
    options.push({ id: 'Phone', kind: 'sms', label: String(data.PhoneVal) });
  }
  return {
    options: () => options,

    async send(id) {
      optionId = id;
      const result = await apex(session, {
        classname: 'MyAcct_Apex_CustomMFAController',
        method: 'handleChoiceofMFA',
        params: { username: data.retencrUsrname, selectedChoice: id, isforgotpassword: false },
        app: 'siteforce:loginApp2',
        pageURI: '/myaccount/s/login/',
      });
      const value = returnValueOf(result);
      if (String(value.retMessage ?? '').toLowerCase() !== 'success') {
        throw new CannotConnectError(
          `PG&E did not send the code (${value.retMessage ?? 'no answer'})`,
        );
      }
    },

    async submit(code) {
      const result = await apex(session, {
        classname: 'MyAcct_Apex_CustomMFAController',
        method: 'verifySignInCode',
        params: {
          input: {
            authCode: code,
            password,
            encToken: data.encryptedTFT,
            usernameVal: data.retencrUsrname,
            isForgotPasswordFlow: false,
            otpType: optionId,
          },
        },
        app: 'siteforce:loginApp2',
        pageURI: '/myaccount/s/login/',
      });
      const value = returnValueOf(result);
      if (String(value.returnResponse ?? '').toLowerCase() !== 'success') {
        throw new InvalidAuthError('PG&E refused the verification code');
      }
      const wrapper = value.wrapperObj;
      if (!wrapper) {
        throw new InvalidAuthError('PG&E accepted the code but sent no device cookie');
      }
      return {
        browsercookie: wrapper.retencrUsrname ?? null,
        validationCookie: wrapper.encryptedKey ?? null,
        expiryDateTime: wrapper.expiryDateTime ?? null,
      };
    },
  };
}

export const pge = {
  key: 'pge',
  name: 'Pacific Gas and Electric Company (PG&E)',
  shortName: 'PG&E',
  timezone: 'America/Los_Angeles',
  signIn: 'code',

  create() {
    return {
      subdomain: () => 'pge',
      utilityCode: () => 'pge',

      async login(session, { username, password, loginData = {} }) {
        const result = await apex(session, {
          classname: 'MyAcct_customLoginLWCController',
          method: 'login',
          params: {
            username,
            password,
            browsercookie: loginData.browsercookie ?? 'null',
            validationCookie: loginData.validationCookie ?? 'null',
          },
          app: 'siteforce:loginApp2',
          pageURI: '/myaccount/s/login/',
        });
        const action = result?.actions?.[0];
        if (!action) {
          throw new InvalidAuthError('PG&E answered the sign-in without any result');
        }
        if (action.state !== 'SUCCESS') {
          throw new InvalidAuthError('PG&E refused the sign-in');
        }
        const value = returnValueOf(result);
        const message = String(value.retMessage ?? '');
        if (message === 'verifymfa :') {
          throw new MfaRequiredError(
            'PG&E asks for a verification code',
            createChallenge(session, password, value),
          );
        }
        if (!message.startsWith('http')) {
          // e.g. "invalid username." — PG&E's own words, without the credentials.
          throw new InvalidAuthError(
            `PG&E refused the sign-in (${message.slice(0, 80) || 'no reason'})`,
          );
        }

        await session.request(message, { okOnly: true });
        await session.request(MY_ACCOUNT_URL, { okOnly: true });

        const auraToken = session.jar.findByPrefix('__Host-ERIC_PROD')[0]?.value;
        if (!auraToken) {
          throw new InvalidAuthError('PG&E did not open a session after the sign-in');
        }
        for (const [classname, method] of [
          ['MyAcct_OneTrustIntegrationController', 'generateToken'],
          ['MyAcct_AccountCacheHandler', 'copyToSessionCacheForUser'],
        ]) {
          await apex(session, {
            classname,
            method,
            app: 'siteforce:communityApp',
            pageURI: '/myaccount/s/',
            token: auraToken,
          });
        }

        const page = (await session.request(DATA_BROWSER_URL, { okOnly: true })).text();
        const match = page.match(/let tokenFromApex = '([^']*)'/);
        if (!match) {
          throw new InvalidAuthError('PG&E did not hand over the Opower token after the sign-in');
        }
        if (!match[1]) {
          // Seen as a transient failure upstream: retried at the next cycle.
          throw new CannotConnectError('PG&E handed over an empty Opower token');
        }
        return { token: match[1] };
      },
    };
  },
};
