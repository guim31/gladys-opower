// -----------------------------------------------------------------------------
// Exelon companies (ComEd, PECO, BGE, Pepco, Delmarva, Atlantic City
// Electric): the sign-in of their mobile app, an Azure AD B2C flow with a
// verification code, then refresh tokens.
//
// Ported from opower's utilities/exelon.py and its subclasses
// (tronikos/opower, Apache-2.0):
//   - first sign-in: the web login page redirects to the B2C "authorize"
//     page; its SETTINGS give the tenant, the policy is swapped for the mobile
//     one, the credentials are posted (SelfAsserted), and the "confirmed" page
//     always asks for a code (SA_FIELDS): sent by email or text, then checked;
//     the last "confirmed" redirect carries an authorization code for the
//     mobile redirect URI, exchanged (PKCE) for a refresh token;
//   - next sign-ins: the refresh token gives a new one and an access token,
//     which lists the customer accounts; a second refresh, scoped to Opower,
//     gives the Opower token.
// The refresh token, the account number and the B2C address are saved in
// /data. Azure rotates the refresh token at every use: the new one replaces
// the old one each time (the Python library keeps the first one).
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { CannotConnectError, InvalidAuthError, MfaRequiredError } from '../errors.js';

const MOBILE_POLICY = 'B2C_1A_SignIn_Mobile';

function base64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The JSON assigned to `var <name> = {...};` on one line of a page. */
export function loadJavascriptVariable(text, name) {
  const match = text.match(new RegExp(`var ${name} = ({.*});`));
  if (!match) {
    return null;
  }
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function encodeQuery(params) {
  // RFC 3986 encoding (%20 for a space), as the mobile app sends it.
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

/** The account fields the sign-in needs later; the rest (address...) is not kept. */
function slimAccount(account) {
  return {
    accountNumber: String(account.accountNumber ?? ''),
    isResidential: account.isResidential === true,
    state:
      account.PremiseInfo?.[0]?.mainAddress?.townDetail?.stateOrProvince ?? account.state ?? null,
  };
}

/** The web of requests of one sign-in: B2C settings, PKCE, tokens. */
class ExelonFlow {
  constructor(session, { baseUrl, euDomain, refreshToken, clientId, mobileId, shortName }) {
    this.session = session;
    this.baseUrl = baseUrl;
    this.euDomain = euDomain;
    this.refreshToken = refreshToken;
    this.clientId = clientId;
    this.mobileId = mobileId;
    this.shortName = shortName;
    this.codeVerifier = base64Url(randomBytes(32));
    this.codeChallenge = base64Url(createHash('sha256').update(this.codeVerifier).digest());
    this.settings = null;
  }

  async loadMobile(authorizePath) {
    const query = encodeQuery({
      p: MOBILE_POLICY,
      client_id: this.clientId,
      nonce: 'defaultNonce',
      redirect_uri: `${this.mobileId}://auth`,
      scope: 'openid offline_access',
      response_type: 'code',
      code_challenge: this.codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'login',
    });
    const page = await this.session.request(`https://${authorizePath}?${query}`, { okOnly: true });
    const settings = loadJavascriptVariable(page.text(), 'SETTINGS');
    if (settings === null) {
      throw new InvalidAuthError(`${this.shortName}: the mobile sign-in page changed`);
    }
    // The mobile app moves to SelfAsserted on its own.
    settings.api = 'SelfAsserted';
    this.settings = settings;
  }

  /**
   * GET a B2C page. Without settings, a plain page of the base URL; with
   * them, `api/<api>/<path>` with the CSRF and transaction parameters.
   * @returns {Promise<{ text: string, path: string, host: string, location: string|null }>}
   */
  async getApi(path, { followRedirects = true } = {}) {
    let url = `https://${this.baseUrl}/${path}`;
    if (this.settings) {
      const params = new URLSearchParams({
        csrf_token: this.settings.csrf ?? '',
        tx: this.settings.transId ?? '',
        p: this.settings.hosts?.policy ?? '',
        diags: JSON.stringify({
          pageViewId: this.settings.pageViewId ?? '',
          pageId: this.settings.api ?? '',
          trace: [],
        }),
      });
      url = `https://${this.baseUrl}/api/${this.settings.api ?? ''}/${path}?${params}`;
    }
    const response = await this.session.request(url, { followRedirects, okOnly: followRedirects });
    if (!followRedirects) {
      if (response.status < 300 || response.status >= 400) {
        throw new CannotConnectError(`${this.shortName}: the sign-in did not hand over its code`);
      }
      return {
        text: response.text(),
        path: '',
        host: '',
        location: response.headers.get('location'),
      };
    }
    const settings = loadJavascriptVariable(response.text(), 'SETTINGS');
    if (settings === null) {
      throw new InvalidAuthError(`${this.shortName}: the sign-in page changed (no settings)`);
    }
    this.settings = settings;
    const final = new URL(response.url);
    return { text: response.text(), path: final.pathname, host: final.host, location: null };
  }

  /** POST to the B2C API; anything but status "200" is a refusal or an outage. */
  async postApi(path, data, step) {
    const api = this.settings?.api ?? '';
    const params = new URLSearchParams({
      tx: this.settings?.transId ?? '',
      p: this.settings?.hosts?.policy ?? '',
    });
    const response = await this.session.request(
      `https://${this.baseUrl}/${path ? `${api}/${path}` : api}?${params}`,
      {
        method: 'POST',
        headers: {
          'X-CSRF-TOKEN': this.settings?.csrf ?? '',
          'X-Requested-With': 'XMLHttpRequest',
        },
        form: data,
        okOnly: true,
      },
    );
    const result = response.json();
    const status = String(result?.status ?? '');
    if (status !== '200') {
      // Only an explicit rejection means wrong credentials or code; a 5xx or a
      // 404 is an outage, retried.
      if (['400', '401', '403'].includes(status)) {
        throw new InvalidAuthError(`${this.shortName} refused the ${step}`);
      }
      throw new CannotConnectError(
        `${this.shortName}: the ${step} failed (status ${status || '?'})`,
      );
    }
    return result;
  }

  /** POST the token endpoint; a refused refresh token resolves {} (code needed again). */
  async tokenRequest(form) {
    const response = await this.session.request(`https://${this.baseUrl}/oauth2/v2.0/token`, {
      method: 'POST',
      form,
    });
    if ([400, 401, 403].includes(response.status)) {
      return {};
    }
    if (!response.ok) {
      throw new CannotConnectError(
        `${this.shortName}: token refresh failed (HTTP ${response.status})`,
      );
    }
    return response.json();
  }

  async refreshRefresh() {
    const result = await this.tokenRequest({
      grant_type: 'refresh_token',
      response_type: 'token',
      scope: `openid offline_access ${this.clientId}`,
      client_id: this.clientId,
      refresh_token: this.refreshToken,
    });
    this.refreshToken = result.refresh_token ?? '';
    return String(result.access_token ?? '');
  }

  async refreshOpower(accountNumber) {
    const tenant = this.baseUrl.match(/\/(.*)\.onmicrosoft\.com\//);
    const scope = tenant ? tenant[1] : this.euDomain.replace('eudapi.', 'euazure');
    const result = await this.tokenRequest({
      grant_type: 'refresh_token',
      response_type: 'token',
      scope: `https://${scope}.onmicrosoft.com/opower/opower_connect`,
      client_id: this.clientId,
      refresh_token: this.refreshToken,
      nonce: accountNumber,
    });
    return String(result.access_token ?? '');
  }

  async firstActiveAccount(bearer) {
    const response = await this.session.request(
      `https://${this.euDomain}/mobile/custom/auth/accounts`,
      { headers: { Authorization: `Bearer ${bearer}` } },
    );
    if (!response.ok) {
      throw new CannotConnectError(
        `${this.shortName}: cannot list the accounts (HTTP ${response.status})`,
      );
    }
    const result = response.json();
    if (result?.success !== true) {
      throw new InvalidAuthError(`${this.shortName}: unable to list the accounts`);
    }
    // After a move, the old account stays listed as "Inactive".
    const active = (Array.isArray(result.data) ? result.data : []).filter(
      (account) => account?.status === 'Active',
    );
    if (active.length === 0) {
      throw new InvalidAuthError(`${this.shortName}: no active account`);
    }
    return active.find((account) => account.isDefaultProfile === true) ?? active[0];
  }

  /** Tokens from an authorization code (after the code) or from the refresh token. */
  async getToken(account, redirect) {
    let bearer;
    if (redirect) {
      const prefix = `${this.mobileId}://auth/?code=`;
      const code = redirect.startsWith(prefix)
        ? redirect.slice(prefix.length)
        : (redirect.match(/[?&]code=([^&]+)/)?.[1] ?? '');
      const response = await this.session.request(`https://${this.baseUrl}/oauth2/v2.0/token`, {
        method: 'POST',
        form: {
          grant_type: 'authorization_code',
          scope: `openid offline_access ${this.clientId}`,
          client_id: this.clientId,
          code,
          code_verifier: this.codeVerifier,
          redirect_uri: this.mobileId,
        },
      });
      let result = {};
      try {
        result = response.json();
      } catch {
        // An error page: no token, handled below.
      }
      bearer = String(result.access_token ?? '');
      this.refreshToken = result.refresh_token ?? '';
    } else {
      bearer = await this.refreshRefresh();
    }
    if (!account) {
      if (!bearer) {
        throw new InvalidAuthError(`${this.shortName} did not hand over a session after the code`);
      }
      account = slimAccount(await this.firstActiveAccount(bearer));
    }
    const opowerToken = await this.refreshOpower(account.accountNumber);
    return { opowerToken, refreshToken: this.refreshToken, account };
  }
}

function mfaOptions(fields) {
  const options = {};
  let phoneMfaOff = false;
  let bypassSelection = false;
  for (const field of fields?.AttributeFields ?? []) {
    // Forced MFA: email only, no choice to make.
    if (field.ID === 'extension_isMFAEnabled' && field.PRE === 'False') {
      phoneMfaOff = true;
    }
    if (field.ID === 'emailVerificationControl') {
      for (const display of field.DISPLAY_FIELDS ?? []) {
        if (display.ID === 'displayEmailAddress') {
          options.Email = display.PRE;
          bypassSelection = true;
        }
      }
    }
    // MFA the customer opted into, with a phone.
    if (field.ID === 'displayEmailAddress') {
      options.Email = field.PRE;
    }
    if (field.ID === 'displayPhoneNumber') {
      options.Text = field.PRE;
    }
  }
  return { options, bypass: phoneMfaOff && bypassSelection };
}

function createChallenge(flow, fields) {
  const { options, bypass } = mfaOptions(fields);
  let optionId = bypass ? 'Bypass' : null;
  const listed = [];
  if (options.Email) {
    listed.push({ id: 'Email', kind: 'email', label: String(options.Email) });
  }
  if (options.Text) {
    listed.push({ id: 'Text', kind: 'sms', label: String(options.Text) });
  }
  const target = () =>
    optionId === 'Text'
      ? { control: 'textVerificationControl', data: { displayPhoneNumber: options.Text ?? '' } }
      : { control: 'emailVerificationControl', data: { displayEmailAddress: options.Email ?? '' } };

  return {
    options: () => listed,

    async send(id) {
      if (optionId !== 'Bypass') {
        optionId = id;
        await flow.postApi(
          '',
          {
            displayEmailAddress: options.Email ?? '',
            displayPhoneNumber: options.Text ?? '',
            mfaEnabledRadio: optionId,
            request_type: 'RESPONSE',
          },
          'code method',
        );
        await flow.getApi('confirmed');
      }
      const { control, data } = target();
      await flow.postApi(`DisplayControlAction/vbeta/${control}/SendCode`, data, 'code request');
    },

    async submit(code) {
      const { control, data } = target();
      const verify = { ...data, verificationCode: code };
      await flow.postApi(
        `DisplayControlAction/vbeta/${control}/VerifyCode`,
        verify,
        'verification code',
      );
      await flow.postApi('', { ...verify, request_type: 'RESPONSE' }, 'verification code');
      const { location } = await flow.getApi('confirmed', { followRedirects: false });
      const { refreshToken, account } = await flow.getToken(null, location ?? '');
      if (!refreshToken || !account) {
        throw new InvalidAuthError(`${flow.shortName}: the sign-in did not complete`);
      }
      return { token: refreshToken, account, base_url: flow.baseUrl };
    },
  };
}

function createExelonCompany({
  key,
  name,
  shortName,
  loginDomain,
  euDomain,
  clientId,
  mobileId,
  subdomain,
  subdomains,
  timezone = 'America/New_York',
}) {
  return {
    key,
    name,
    shortName,
    timezone,
    signIn: 'code',

    create() {
      let chosenSubdomain = subdomain ?? null;
      return {
        subdomain() {
          if (!chosenSubdomain) {
            throw new CannotConnectError(`${shortName}: sign in before reading the data`);
          }
          return chosenSubdomain;
        },
        utilityCode() {
          return this.subdomain();
        },

        async login(session, { username, password, loginData = {} }) {
          let account = loginData.account ?? null;
          const flow = new ExelonFlow(session, {
            baseUrl: String(loginData.base_url ?? loginDomain),
            euDomain,
            refreshToken: String(loginData.token ?? ''),
            clientId,
            mobileId,
            shortName,
          });

          let opowerToken = '';
          if (account) {
            ({ opowerToken, account } = await flow.getToken(account, ''));
          }

          if (!account || !opowerToken) {
            // First sign-in, or a refresh token Azure no longer takes: the
            // whole flow again, up to the code.
            flow.baseUrl = loginDomain;
            const { text, path, host } = await flow.getApi('Pages/Login.aspx?/login');
            if (!path.endsWith('/authorize')) {
              throw new CannotConnectError(`${shortName}: the sign-in page changed`);
            }
            if (!host) {
              throw new CannotConnectError(`${shortName}: no sign-in host`);
            }
            const settings = loadJavascriptVariable(text, 'SETTINGS');
            if (!settings?.hosts?.tenant || !settings.hosts.policy) {
              throw new CannotConnectError(`${shortName}: the sign-in page changed (no tenant)`);
            }
            // The mobile app knows its tenant; the web page tells it, then
            // the policy is swapped for the mobile one.
            flow.baseUrl = `${host}${settings.hosts.tenant}`.replace(
              settings.hosts.policy,
              MOBILE_POLICY,
            );
            await flow.loadMobile(`${host}${path}`);
            await flow.postApi(
              '',
              { request_type: 'RESPONSE', signInName: username, password },
              'username or the password',
            );
            const confirmed = await flow.getApi('confirmed');
            const fields = loadJavascriptVariable(confirmed.text, 'SA_FIELDS');
            if (fields !== null) {
              throw new MfaRequiredError(
                loginData.token
                  ? `${shortName} asks for a new verification code`
                  : `${shortName} asks for a verification code`,
                createChallenge(flow, fields),
              );
            }
            throw new InvalidAuthError(
              `${shortName}: unexpected sign-in without a verification code`,
            );
          }

          // Pepco and Delmarva serve Maryland homes from one Opower service
          // and everyone else from another (the logic of their own web app).
          if (subdomains) {
            chosenSubdomain =
              account.isResidential && account.state === 'MD'
                ? subdomains.primary
                : subdomains.secondary;
          }
          return {
            token: opowerToken,
            loginData: { token: flow.refreshToken, account, base_url: flow.baseUrl },
          };
        },
      };
    },
  };
}

export const comed = createExelonCompany({
  key: 'comed',
  name: 'Commonwealth Edison (ComEd)',
  shortName: 'ComEd',
  loginDomain: 'secure.comed.com',
  euDomain: 'eudapi.comed.com',
  clientId: 'b587ed2d-28a5-462c-8c1f-835f9d73f7c3',
  mobileId: 'msauth.com.comed.mobile',
  subdomain: 'cec',
  timezone: 'America/Chicago',
});

export const peco = createExelonCompany({
  key: 'peco',
  name: 'PECO Energy Company (PECO)',
  shortName: 'PECO',
  loginDomain: 'secure.peco.com',
  euDomain: 'eudapi.peco.com',
  clientId: 'e555f5eb-b9ec-48b8-9452-fa0ed2ddeeda',
  mobileId: 'msauth.com.exelon.mobile.peco',
  subdomain: 'peco',
});

export const bge = createExelonCompany({
  key: 'bge',
  name: 'Baltimore Gas and Electric (BGE)',
  shortName: 'BGE',
  loginDomain: 'secure.bge.com',
  euDomain: 'eudapi.bge.com',
  clientId: '202e1b60-9ba3-4e49-ab43-a1ebd438aa97',
  mobileId: 'msauth.com.exelon.mobile.bge',
  subdomain: 'bgec',
});

export const pepco = createExelonCompany({
  key: 'pepco',
  name: 'Potomac Electric Power Company (Pepco)',
  shortName: 'Pepco',
  loginDomain: 'secure.pepco.com',
  euDomain: 'eudapi.pepco.com',
  clientId: 'bb13a5b0-c61c-4194-960b-c44cebe992c2',
  mobileId: 'msauth.com.ifactorconsulting.pepco',
  subdomains: { primary: 'pep', secondary: 'pepd' },
});

export const delmarva = createExelonCompany({
  key: 'delmarva',
  name: 'Delmarva Power',
  shortName: 'Delmarva',
  loginDomain: 'secure.delmarva.com',
  euDomain: 'eudapi.delmarva.com',
  clientId: '571ee0e4-c2cc-4d39-b784-6395571cb077',
  mobileId: 'msauth.com.ifactorconsulting.delmarva',
  subdomains: { primary: 'dpl', secondary: 'dpld' },
});

export const atlanticCityElectric = createExelonCompany({
  key: 'atlanticcityelectric',
  name: 'Atlantic City Electric',
  shortName: 'ACE',
  loginDomain: 'secure.atlanticcityelectric.com',
  euDomain: 'eudapi.atlanticcityelectric.com',
  clientId: '64930d53-e888-45f9-9b02-aeed39ba48ca',
  mobileId: 'msauth.com.ifactorconsulting.acelectric',
  subdomain: 'ace',
});
