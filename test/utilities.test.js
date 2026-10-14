// -----------------------------------------------------------------------------
// The utility sign-ins, against fake sites that follow the flows the tests of
// tronikos/opower describe (Apache-2.0). Nothing reaches the network: these
// tests prove the port follows the Python flows, not that the live sites
// still answer that way (scripts/probe.mjs checks that, from a real network).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CannotConnectError, InvalidAuthError, MfaRequiredError } from '../src/errors.js';
import { createHttpSession } from '../src/http.js';
import { isValidTimeZone } from '../src/time.js';
import { totp } from '../src/totp.js';
import { aepOhio, swepco } from '../src/utilities/aep.js';
import { coned, oru } from '../src/utilities/coned.js';
import { duquesne } from '../src/utilities/duquesne.js';
import { bge, comed, loadJavascriptVariable, pepco } from '../src/utilities/exelon.js';
import { findUtility, NOT_YET, UTILITIES } from '../src/utilities/index.js';
import { pge } from '../src/utilities/pge.js';
import { pse } from '../src/utilities/pse.js';
import { cookiesOf, createFakeWeb } from './helpers/fake-web.js';
import { servePge } from './helpers/pge-site.js';

const login = (utility, web, credentials) => {
  const instance = utility.create();
  const session = createHttpSession({ fetch: web.fetch });
  return { instance, session, run: () => instance.login(session, credentials) };
};

// --- The registry --------------------------------------------------------------

test('every supported utility has a stable key, a name, a zone and a sign-in kind', () => {
  const keys = UTILITIES.map((utility) => utility.key);
  assert.equal(new Set(keys).size, keys.length, 'duplicate key');
  for (const utility of UTILITIES) {
    assert.match(utility.key, /^[a-z]+$/);
    assert.ok(utility.name && utility.shortName, utility.key);
    assert.ok(isValidTimeZone(utility.timezone), `${utility.key}: ${utility.timezone}`);
    assert.ok(['password', 'code', 'totp'].includes(utility.signIn), utility.key);
    assert.equal(findUtility(utility.key), utility);
    assert.ok(!(utility.key in NOT_YET), `${utility.key} is both supported and not yet`);
  }
  assert.equal(findUtility('evergy'), null);
  assert.equal(UTILITIES.length, 18);
});

test('the supported list is sorted by name, as the configuration shows it', () => {
  const names = UTILITIES.map((utility) => utility.name);
  assert.deepEqual(
    names,
    [...names].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })),
  );
});

// --- PG&E ------------------------------------------------------------------------

test('PG&E: the sign-in follows the front door and reads the Opower token', async () => {
  const web = createFakeWeb();
  const site = servePge(web);
  const { run } = login(pge, web, { username: 'user@example.com', password: 'correct horse' });
  assert.deepEqual(await run(), { token: 'opower-token' });
  assert.deepEqual(
    site.apex.map((call) => call.method),
    ['login', 'generateToken', 'copyToSessionCacheForUser'],
  );
  const first = site.apex[0];
  assert.deepEqual(first.params, {
    username: 'user@example.com',
    password: 'correct horse',
    browsercookie: 'null',
    validationCookie: 'null',
  });
  assert.equal(first.form['aura.token'], 'null');
  assert.equal(first.form['aura.pageURI'], '/myaccount/s/login/');
  assert.equal(first.form['aura.context'], '{"app":"siteforce:loginApp2"}');
  // The actions after the sign-in carry the Aura token of the session cookie.
  assert.equal(site.apex[1].form['aura.token'], 'aura-token');
});

test('PG&E: a wrong password is refused with PG&E words, never the password', async () => {
  const web = createFakeWeb();
  servePge(web);
  const { run } = login(pge, web, { username: 'user@example.com', password: 'wrong' });
  await assert.rejects(run(), (err) => {
    assert.ok(err instanceof InvalidAuthError);
    assert.match(err.message, /invalid username/);
    assert.doesNotMatch(err.message, /wrong/);
    return true;
  });
});

test('PG&E: a verification code is asked, sent, checked, and remembered', async () => {
  const web = createFakeWeb();
  const site = servePge(web, { mfa: true });
  const credentials = { username: 'user@example.com', password: 'correct horse' };
  const first = login(pge, web, credentials);
  let challenge;
  await assert.rejects(first.run(), (err) => {
    assert.ok(err instanceof MfaRequiredError);
    challenge = err.challenge;
    return true;
  });
  assert.deepEqual(challenge.options(), [
    { id: 'Email', kind: 'email', label: 't***@example.com' },
    { id: 'Phone', kind: 'sms', label: '***-***-1234' },
  ]);
  await challenge.send('Phone');
  assert.equal(site.sentTo, 'Phone');
  await assert.rejects(challenge.submit('000000'), InvalidAuthError);
  const loginData = await challenge.submit('123456');
  assert.deepEqual(loginData, {
    browsercookie: 'device-browsercookie',
    validationCookie: 'device-validation',
    expiryDateTime: '2027-03-01 12:00:00',
  });
  const verify = site.apex.findLast((call) => call.method === 'verifySignInCode');
  assert.equal(verify.params.input.otpType, 'Phone');
  assert.equal(verify.params.input.encToken, 'encrypted-tft');

  // The next sign-in sends the remembered cookies and needs no code.
  const next = login(pge, web, { ...credentials, loginData });
  assert.deepEqual(await next.run(), { token: 'opower-token' });
});

test('PG&E: an empty Opower token is transient, a missing one is a failed sign-in', async () => {
  const web = createFakeWeb();
  servePge(web, { token: '' });
  await assert.rejects(
    login(pge, web, { username: 'u', password: 'correct horse' }).run(),
    CannotConnectError,
  );
  const expired = createFakeWeb();
  servePge(expired);
  expired.on(
    'GET',
    'https://myaccount.pge.com/myaccount/apex/MyAcct_VF_BillInsights_OpowerDataBrowser',
    {
      text: '<html><body>Session expired</body></html>',
    },
  );
  await assert.rejects(
    login(pge, expired, { username: 'u', password: 'correct horse' }).run(),
    InvalidAuthError,
  );
});

// --- ConEd and O&R -----------------------------------------------------------

const DEVICE_ID = 'dev+ice/id==';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

/** coned.com / oru.com and their Okta rounds, as test_coned.py serves them. */
function serveConEd(web, { host = 'www.coned.com', mfa = true, now = () => Date.now() } = {}) {
  const base = `https://${host}`;
  const api = `${base}/sitecore/api/ssc/ConEdWeb-Foundation-Login-Areas-LoginAPI/User/0`;
  const seen = { codes: [], logins: [] };
  web
    .on('GET', `${base}/en/login`, (request) => ({
      text: '<html>login</html>',
      cookies: cookiesOf(request).CE_DEVICE_ID ? [] : [`CE_DEVICE_ID=${DEVICE_ID}; Path=/`],
    }))
    .on('POST', `${api}/Login`, (request) => {
      seen.logins.push(request.json);
      if (request.json.LoginPassword !== 'pw') {
        return { json: { login: false } };
      }
      if (!mfa || cookiesOf(request).CE_DEVICE_ID === 'remembered-device') {
        return {
          json: { login: true, authRedirectUrl: `${base}/oauth2/authorize?state=no_redirect` },
        };
      }
      return { json: { login: true, newDevice: true, noMfa: false } };
    })
    .on('POST', `${api}/VerifyFactor`, (request) => {
      seen.codes.push(request.json.MFACode);
      const ok = request.json.MFACode === totp(TOTP_SECRET, now());
      return {
        json: ok
          ? { code: true, authRedirectUrl: `${base}/oauth2/authorize?state=no_redirect` }
          : { code: false },
      };
    })
    .on('GET', `${base}/oauth2/authorize`, (request) => ({
      status: 302,
      headers: { location: `/?code=abc&state=${encodeURIComponent(request.query.state)}` },
    }))
    .on('GET', `${base}/`, (request) => {
      if (!request.query.code) {
        return { text: 'home' };
      }
      // The code exchange only works with the device cookie, unquoted.
      if (cookiesOf(request).CE_DEVICE_ID === undefined) {
        return { text: 'home', cookies: ['CE_AUTH=; Expires=Sat, 27-Sep-2025 13:13:03 GMT'] };
      }
      const state = request.query.state;
      const cookies = ['CE_AUTH=session; Path=/'];
      if (state.startsWith('opower|')) {
        cookies.push('OPOWER_AUTH_TOKEN=minted; Path=/');
      }
      return {
        status: 302,
        headers: {
          location:
            state === 'no_redirect'
              ? '/en/accounts-billing/my-account'
              : '/en/accounts-billing/my-account/energy-use',
        },
        cookies,
      };
    })
    .on('GET', `${base}/en/accounts-billing/my-account`, { text: 'my account' })
    .on('GET', `${base}/en/accounts-billing/my-account/energy-use`, (request) => {
      const cookies = cookiesOf(request);
      if (cookies.CE_AUTH !== 'session') {
        return {
          status: 302,
          headers: { location: '/login?url=/en/accounts-billing/my-account/energy-use' },
        };
      }
      if (!cookies.OPOWER_AUTH_TOKEN) {
        return {
          status: 302,
          headers: { location: '/oauth2/authorize?state=opower%7C%2Fenergy-use' },
        };
      }
      return { text: 'energy use' };
    })
    .on('GET', `${base}/login`, { text: 'please log in' })
    .on(
      'GET',
      `${base}/sitecore/api/ssc/ConEd-Cms-Services-Controllers-Opower/OpowerService/0/GetOPowerToken`,
      (request) => ({
        json: cookiesOf(request).OPOWER_AUTH_TOKEN ? 'coned-opower-token' : null,
      }),
    );
  return seen;
}

test('ConEd: the two Okta rounds end with the Opower token, the TOTP computed from the key', async () => {
  const web = createFakeWeb();
  const seen = serveConEd(web);
  const { run } = login(coned, web, {
    username: 'user@example.com',
    password: 'pw',
    totpSecret: TOTP_SECRET,
  });
  const result = await run();
  assert.equal(result.token, 'coned-opower-token');
  // The device cookie is kept, unquoted, for the next sign-in.
  assert.deepEqual(result.loginData, { deviceCookie: DEVICE_ID });
  assert.equal(seen.codes.length, 1);
  assert.deepEqual(Object.keys(seen.logins[0]), [
    'LoginEmail',
    'LoginPassword',
    'LoginRememberMe',
    'ReturnUrl',
    'FromURI',
    'OpenIdRelayState',
  ]);
});

test('ConEd: a remembered device skips the code', async () => {
  const web = createFakeWeb();
  const seen = serveConEd(web);
  const { run } = login(coned, web, {
    username: 'u',
    password: 'pw',
    loginData: { deviceCookie: 'remembered-device' },
  });
  assert.equal((await run()).token, 'coned-opower-token');
  assert.equal(seen.codes.length, 0);
});

test('ConEd: two-step sign-in without a key, a bad key or a bad password is refused', async () => {
  const web = createFakeWeb();
  serveConEd(web);
  await assert.rejects(login(coned, web, { username: 'u', password: 'pw' }).run(), /authenticator/);
  await assert.rejects(
    login(coned, web, { username: 'u', password: 'pw', totpSecret: 'not!base32' }).run(),
    /not valid/,
  );
  await assert.rejects(
    login(coned, web, {
      username: 'u',
      password: 'pw',
      totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    }).run(),
    /refused the authenticator code/,
  );
  await assert.rejects(
    login(coned, web, { username: 'u', password: 'nope' }).run(),
    InvalidAuthError,
  );
});

test('O&R signs in on oru.com with the ConEd flow and its own Opower service', async () => {
  const web = createFakeWeb();
  serveConEd(web, { host: 'www.oru.com', mfa: false });
  const { instance, run } = login(oru, web, { username: 'u', password: 'pw' });
  assert.equal((await run()).token, 'coned-opower-token');
  assert.equal(instance.subdomain(), 'oru');
});

// --- AEP ----------------------------------------------------------------------

test('AEP: the generated form fields are sent back, the Opower subdomain read from the page', async () => {
  const web = createFakeWeb();
  const usage = 'https://www.aepohio.com/account/usage/';
  let posted;
  web
    .on('GET', usage, {
      text: `<form method="post"><input type="hidden" name="__VIEWSTATE" value="state&amp;1">
        <input name="ctl00$Main$UserID" value=""><input type="password" name="ctl00$Main$Password">
        <input type="submit" name="ctl00$Main$Login" value="Sign In"></form>`,
    })
    .on('POST', usage, (request) => {
      posted = request.form;
      return request.form['ctl00$Main$Password'] === 'pw'
        ? { text: '<script src="https://aepohio.opower.com/ei/x/e/widget.js"></script>' }
        : { text: '<div class="error"><p>Invalid login</p></div>' };
    })
    .on('GET', 'https://www.aepohio.com/account/oauth/ValidToken', {
      json: [{ data: { AccessToken: 'aep-token' } }],
    });
  const { instance, run } = login(aepOhio, web, { username: 'u', password: 'pw' });
  assert.equal((await run()).token, 'aep-token');
  assert.equal(instance.subdomain(), 'aepohio');
  assert.deepEqual(posted, {
    __VIEWSTATE: 'state&1',
    ctl00$Main$UserID: 'u',
    ctl00$Main$Password: 'pw',
    ctl00$Main$Login: 'Sign In',
  });
  await assert.rejects(
    login(aepOhio, web, { username: 'u', password: 'bad' }).run(),
    InvalidAuthError,
  );
  assert.throws(() => aepOhio.create().subdomain(), CannotConnectError);
  assert.equal(swepco.timezone, 'America/Chicago');
});

// --- PSE and Duquesne -------------------------------------------------------------

test('PSE: anti-forgery token, sign-in, then the token of the usage page', async () => {
  const web = createFakeWeb();
  let signedIn = false;
  web
    .on('GET', 'https://www.pse.com/en/login', {
      text: '<input name="__RequestVerificationToken" type="hidden" value="anti-forgery">',
    })
    .on('POST', 'https://www.pse.com/api/pseauthentication/AsyncSignIn', (request) => {
      signedIn =
        request.form.__RequestVerificationToken === 'anti-forgery' &&
        request.form.Password === 'pw';
      return { json: {} };
    })
    .on('GET', 'https://www.pse.com/api/AccountSelector/GetContractAccountJson', () => ({
      text: signedIn ? '[{"ContractAccount":"1"}]' : '',
    }))
    .on('GET', 'https://www.pse.com/en/account-and-billing/my-usage/view-my-usage', {
      text: '<script src="x.js"></script><script>\n var accessToken = "pse-token";\n</script>',
    });
  assert.deepEqual(await login(pse, web, { username: 'u', password: 'pw' }).run(), {
    token: 'pse-token',
  });
  await assert.rejects(login(pse, web, { username: 'u', password: 'bad' }).run(), InvalidAuthError);
});

test('Duquesne Light: a 400 is a refused password, the token comes from the page', async () => {
  const web = createFakeWeb();
  web
    .on('POST', 'https://auth.duquesnelight.com/oauth/authorize/login', (request) =>
      request.form.password === 'pw' ? { text: 'ok' } : { status: 400, text: 'bad credentials' },
    )
    .on('GET', 'https://www.duquesnelight.com/energy-money-savings/my-electric-use', {
      text: '<script>window.cfg = { "OPowerToken": "dqe-token", "Other": "x" };</script>',
    });
  assert.deepEqual(await login(duquesne, web, { username: 'u', password: 'pw' }).run(), {
    token: 'dqe-token',
  });
  await assert.rejects(
    login(duquesne, web, { username: 'u', password: 'bad' }).run(),
    InvalidAuthError,
  );
});

// --- Exelon --------------------------------------------------------------------

/**
 * The Azure B2C flow of an Exelon company, as exelon.py walks it: a login page
 * redirecting to the authorize page, SETTINGS on each page, SelfAsserted
 * posts, SA_FIELDS asking for the code, a "confirmed" redirect to the mobile
 * URI, and the token endpoint (authorization code, then refresh tokens).
 */
function serveExelon(
  web,
  { company = 'comed', mobileId = 'msauth.com.comed.mobile', accounts } = {},
) {
  const login = `https://secure.${company}.com`;
  const b2c = `https://login.${company}.com`;
  const tenant = `/euazure${company}.onmicrosoft.com/B2C_1A_SignIn`;
  const mobileTenant = `/euazure${company}.onmicrosoft.com/B2C_1A_SignIn_Mobile`;
  const settings = (api) =>
    `<script>var SETTINGS = ${JSON.stringify({
      api,
      csrf: 'csrf-token',
      transId: 'StateProperties=abc',
      pageViewId: 'view-1',
      hosts: { tenant, policy: 'B2C_1A_SignIn' },
    })};</script>`;
  const site = { refreshTokens: [], codeSentTo: null, opowerScopes: [], step: 'start', grants: [] };
  web
    .on('GET', `${login}/Pages/Login.aspx`, {
      status: 302,
      headers: { location: `${b2c}${tenant.toLowerCase()}/oauth2/v2.0/authorize?client_id=web` },
    })
    .on('GET', `${b2c}${tenant.toLowerCase()}/oauth2/v2.0/authorize`, (request) => {
      if (request.query.p === 'B2C_1A_SignIn_Mobile') {
        assert.equal(request.query.code_challenge_method, 'S256');
        site.challenge = request.query.code_challenge;
        return {
          text: settings('CombinedSigninAndSignup'),
          cookies: ['x-ms-cpim-trans=t1; Path=/'],
        };
      }
      return { text: settings('CombinedSigninAndSignup') };
    })
    .on('POST', `${b2c}${mobileTenant}/SelfAsserted`, (request) => {
      assert.equal(request.headers['x-csrf-token'], 'csrf-token');
      if (site.step === 'start') {
        if (request.form.password !== 'pw') {
          return { json: { status: '400', message: 'Invalid username or password.' } };
        }
        site.step = 'credentials';
        return { json: { status: '200' } };
      }
      if (site.step === 'verified' && request.form.request_type === 'RESPONSE') {
        site.step = 'done';
      }
      if (request.form.mfaEnabledRadio) {
        site.method = request.form.mfaEnabledRadio;
      }
      return { json: { status: '200' } };
    })
    .on('GET', `${b2c}${mobileTenant}/api/SelfAsserted/confirmed`, () =>
      site.step === 'done'
        ? { status: 302, headers: { location: `${mobileId}://auth/?code=auth-code` } }
        : {
            text: `${settings('SelfAsserted')}\n<script>var SA_FIELDS = ${JSON.stringify({
              AttributeFields: [
                { ID: 'displayEmailAddress', PRE: 't***@example.com' },
                { ID: 'displayPhoneNumber', PRE: 'XXX-XXX-1234' },
              ],
            })};</script>`,
          },
    )
    .on(
      'POST',
      `${b2c}${mobileTenant}/SelfAsserted/DisplayControlAction/vbeta/textVerificationControl/SendCode`,
      () => {
        site.codeSentTo = 'text';
        return { json: { status: '200' } };
      },
    )
    .on(
      'POST',
      `${b2c}${mobileTenant}/SelfAsserted/DisplayControlAction/vbeta/textVerificationControl/VerifyCode`,
      (request) => {
        if (request.form.verificationCode !== '654321') {
          return { json: { status: '400', message: 'Wrong code' } };
        }
        site.step = 'verified';
        return { json: { status: '200' } };
      },
    )
    .on('POST', `${b2c}${mobileTenant}/oauth2/v2.0/token`, (request) => {
      site.grants.push(request.form.grant_type);
      if (request.form.grant_type === 'authorization_code') {
        assert.equal(request.form.code, 'auth-code');
        assert.ok(request.form.code_verifier);
        site.refreshTokens.push('refresh-1');
        return { json: { access_token: 'bearer-1', refresh_token: 'refresh-1' } };
      }
      if (!site.refreshTokens.includes(request.form.refresh_token)) {
        return { status: 400, json: { error: 'invalid_grant' } };
      }
      if (request.form.scope.includes('opower_connect')) {
        site.opowerScopes.push(request.form.scope);
        return { json: { access_token: `opower-for-${request.form.nonce}` } };
      }
      const next = `refresh-${site.refreshTokens.length + 1}`;
      site.refreshTokens.push(next);
      return { json: { access_token: 'bearer-n', refresh_token: next } };
    })
    .on('GET', `https://eudapi.${company}.com/mobile/custom/auth/accounts`, {
      json: {
        success: true,
        data: accounts ?? [
          { accountNumber: '0000000001', status: 'Inactive' },
          {
            accountNumber: '1234567890',
            status: 'Active',
            isDefaultProfile: true,
            isResidential: true,
            PremiseInfo: [{ mainAddress: { townDetail: { stateOrProvince: 'MD' } } }],
          },
        ],
      },
    });
  return site;
}

test('Exelon: first sign-in asks for a code, then refresh tokens give the Opower token', async () => {
  const web = createFakeWeb();
  const site = serveExelon(web);
  const credentials = { username: 'user@example.com', password: 'pw' };
  let challenge;
  await assert.rejects(login(comed, web, credentials).run(), (err) => {
    assert.ok(err instanceof MfaRequiredError, err.message);
    challenge = err.challenge;
    return true;
  });
  assert.deepEqual(
    challenge.options().map((option) => option.kind),
    ['email', 'sms'],
  );
  await challenge.send('Text');
  assert.equal(site.method, 'Text');
  assert.equal(site.codeSentTo, 'text');
  await assert.rejects(challenge.submit('000000'), InvalidAuthError);
  const loginData = await challenge.submit('654321');
  assert.deepEqual(loginData.account, {
    accountNumber: '1234567890',
    isResidential: true,
    state: 'MD',
  });
  assert.equal(loginData.token, 'refresh-1');
  assert.equal(
    loginData.base_url,
    'login.comed.com/euazurecomed.onmicrosoft.com/B2C_1A_SignIn_Mobile',
  );

  // Next sign-in: no code, the refresh token rotates and is saved again.
  const next = login(comed, web, { ...credentials, loginData });
  const result = await next.run();
  assert.equal(result.token, 'opower-for-1234567890');
  assert.equal(result.loginData.token, 'refresh-2');
  assert.equal(next.instance.subdomain(), 'cec');
  assert.match(
    site.opowerScopes.at(-1),
    /^https:\/\/euazurecomed\.onmicrosoft\.com\/opower\/opower_connect$/,
  );
});

test('Exelon: a refused refresh token starts the code flow again', async () => {
  const web = createFakeWeb();
  serveExelon(web);
  const loginData = {
    token: 'expired',
    account: { accountNumber: '1234567890', isResidential: true, state: 'MD' },
    base_url: 'login.comed.com/euazurecomed.onmicrosoft.com/B2C_1A_SignIn_Mobile',
  };
  await assert.rejects(
    login(comed, web, { username: 'u', password: 'pw', loginData }).run(),
    (err) => {
      assert.ok(err instanceof MfaRequiredError);
      assert.match(err.message, /new verification code/);
      return true;
    },
  );
});

test('Exelon: a wrong password is refused before any code', async () => {
  const web = createFakeWeb();
  serveExelon(web);
  await assert.rejects(
    login(comed, web, { username: 'u', password: 'bad' }).run(),
    InvalidAuthError,
  );
});

test('Pepco serves Maryland homes from "pep", everyone else from "pepd"', async () => {
  for (const [state, residential, expected] of [
    ['MD', true, 'pep'],
    ['DC', true, 'pepd'],
    ['MD', false, 'pepd'],
  ]) {
    const web = createFakeWeb();
    const site = serveExelon(web, {
      company: 'pepco',
      mobileId: 'msauth.com.ifactorconsulting.pepco',
    });
    site.refreshTokens.push('saved');
    const { instance, run } = login(pepco, web, {
      username: 'u',
      password: 'pw',
      loginData: {
        token: 'saved',
        account: { accountNumber: '42', isResidential: residential, state },
        base_url: 'login.pepco.com/euazurepepco.onmicrosoft.com/B2C_1A_SignIn_Mobile',
      },
    });
    await run();
    assert.equal(instance.subdomain(), expected, `${state} ${residential}`);
  }
  assert.equal(bge.create().subdomain(), 'bgec');
});

test('the B2C settings are read from one line of the page', () => {
  assert.deepEqual(
    loadJavascriptVariable('<script>var SETTINGS = {"a":1,"b":{"c":2}};</script>', 'SETTINGS'),
    {
      a: 1,
      b: { c: 2 },
    },
  );
  assert.equal(loadJavascriptVariable('<p>nothing</p>', 'SETTINGS'), null);
  assert.equal(loadJavascriptVariable('var SETTINGS = {broken};', 'SETTINGS'), null);
});
