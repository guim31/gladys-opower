// -----------------------------------------------------------------------------
// The PG&E sign-in on the fake web, as the tests of tronikos/opower describe
// it (tests/opower/utilities/test_pge.py, Apache-2.0): Aura Apex actions
// routed by method, a session "front door", the __Host-ERIC_PROD Aura token
// cookie, and the Opower data browser page carrying `tokenFromApex`.
// -----------------------------------------------------------------------------

const BASE = 'https://myaccount.pge.com';
export const AURA_URL = `${BASE}/myaccount/s/sfsites/aura`;
const FRONTDOOR = `${BASE}/myaccount/secur/frontdoor.jsp`;

/** An Apex return value, wrapped the way the Aura endpoint answers. */
export function auraResponse(returnValue) {
  return {
    actions: [
      { state: 'SUCCESS', returnValue: { returnValue, cacheable: false }, error: [] },
      // Aura appends this warning to most responses.
      { id: 'COOSE', state: 'warning', coos: 'This page has changes since the last refresh.' },
    ],
    context: { mode: 'PROD', app: 'siteforce:loginApp2' },
  };
}

/**
 * @param {object} web
 * @param {object} [options]
 * @param {string} [options.password] the password PG&E accepts
 * @param {boolean} [options.mfa] ask for a code unless the device cookies come along
 * @param {string} [options.code] the code PG&E accepts
 * @param {string} [options.token] the Opower token handed over
 */
export function servePge(
  web,
  { password = 'correct horse', mfa = false, code = '123456', token = 'opower-token' } = {},
) {
  const site = { sentTo: null, logins: 0, apex: [] };

  web.on('POST', AURA_URL, (request) => {
    const message = JSON.parse(request.form.message);
    const params = message.actions[0].params;
    site.apex.push({ method: params.method, params: params.params, form: request.form });
    switch (params.method) {
      case 'login': {
        site.logins += 1;
        if (params.params.password !== password) {
          return { json: auraResponse({ retMessage: 'invalid username.' }) };
        }
        const remembered =
          params.params.browsercookie === 'device-browsercookie' &&
          params.params.validationCookie === 'device-validation';
        if (mfa && !remembered) {
          return {
            json: auraResponse({
              retMessage: 'verifymfa :',
              retencrUsrname: 'encrypted-username',
              encryptedTFT: 'encrypted-tft',
              EmailVal: 't***@example.com',
              PhoneVal: '***-***-1234',
            }),
          };
        }
        return {
          json: auraResponse({
            cookieExpiryDays: '180.0',
            retencrUsrname: 'encrypted-username',
            retMessage: `${FRONTDOOR}?sid=00Dtest%21TESTSESSIONID&retURL=%2Fmyaccount`,
          }),
        };
      }
      case 'handleChoiceofMFA':
        site.sentTo = params.params.selectedChoice;
        return { json: auraResponse({ retMessage: 'Success' }) };
      case 'verifySignInCode':
        if (params.params.input.authCode !== code) {
          return { json: auraResponse({ returnResponse: 'Invalid Code' }) };
        }
        return {
          json: auraResponse({
            returnResponse: 'Success',
            wrapperObj: {
              retencrUsrname: 'device-browsercookie',
              encryptedKey: 'device-validation',
              expiryDateTime: '2027-03-01 12:00:00',
            },
          }),
        };
      case 'generateToken':
      case 'copyToSessionCacheForUser':
        if (request.form['aura.token'] !== 'aura-token') {
          return { status: 401, text: 'no session' };
        }
        return { json: auraResponse({ retMessage: 'success' }) };
      default:
        return { status: 404, text: 'unknown action' };
    }
  });

  web.on('GET', FRONTDOOR, () => ({
    status: 302,
    headers: { location: '/myaccount/s/' },
    cookies: ['sid=session; Path=/; Secure; HttpOnly'],
  }));
  web.on('GET', `${BASE}/myaccount/s/`, () => ({
    text: '<html>my account</html>',
    cookies: ['__Host-ERIC_PROD_0000000000=aura-token; Path=/; Secure'],
  }));
  web.on('GET', `${BASE}/myaccount/apex/MyAcct_VF_BillInsights_OpowerDataBrowser`, (request) => {
    if (!(request.headers.cookie ?? '').includes('sid=session')) {
      return { text: '<html><body>Session expired</body></html>' };
    }
    return {
      text: `<html><body><script>
    let userId = '005000000000000000';
    let tokenFromApex = '${token}';
    let opowerUrl = 'https://pge.opower.com/ei/x/e/';
</script></body></html>`,
    };
  });
  return site;
}
