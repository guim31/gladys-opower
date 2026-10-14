// -----------------------------------------------------------------------------
// A small HTTP session for the utility sign-ins: a cookie jar and redirects
// followed by hand.
//
// The sign-in pages are browser flows (Salesforce, Okta, Azure B2C, ASP.NET
// forms): every hop sets cookies the next one needs, across several hosts.
// Node's fetch keeps no cookies, so each hop goes through `fetch` with
// `redirect: 'manual'` and the jar reads and replays the Set-Cookie headers.
// Cookie values are replayed byte for byte, never quoted (coned.com refuses a
// quoted device cookie).
//
// `fetch` is injected: the tests serve every hop from fixtures, nothing
// reaches the network.
// -----------------------------------------------------------------------------

import { CannotConnectError, HttpError } from './errors.js';

// What a desktop browser sends: some sign-in pages refuse unknown clients.
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

export const DEFAULT_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 15;

/** The URL without its query and fragment: what an error message may show. */
export function safeUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '(invalid URL)';
  }
}

function defaultPath(url) {
  const path = url.pathname;
  if (!path.startsWith('/') || path === '/') {
    return '/';
  }
  const last = path.lastIndexOf('/');
  return last === 0 ? '/' : path.slice(0, last);
}

function domainMatches(host, cookie) {
  if (cookie.hostOnly) {
    return host === cookie.domain;
  }
  return host === cookie.domain || host.endsWith(`.${cookie.domain}`);
}

function pathMatches(path, cookiePath) {
  if (path === cookiePath) {
    return true;
  }
  if (!path.startsWith(cookiePath)) {
    return false;
  }
  return cookiePath.endsWith('/') || path[cookiePath.length] === '/';
}

/**
 * The cookie jar of one session (RFC 6265, the subset the sign-in pages use).
 */
export class CookieJar {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    /** @type {Map<string, object>} by domain|path|name */
    this.cookies = new Map();
  }

  /**
   * Store the Set-Cookie headers of a response.
   * @param {string} url the URL that answered
   * @param {string[]} headers one Set-Cookie header per entry
   */
  setFromHeaders(url, headers) {
    const target = new URL(url);
    for (const header of headers) {
      this.#parse(target, header);
    }
  }

  #parse(target, header) {
    const [pair, ...attributes] = header.split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      return;
    }
    const cookie = {
      name: pair.slice(0, eq).trim(),
      value: pair.slice(eq + 1).trim(),
      domain: target.hostname,
      hostOnly: true,
      path: defaultPath(target),
      expires: null,
      secure: false,
    };
    for (const attribute of attributes) {
      const sep = attribute.indexOf('=');
      const key = (sep === -1 ? attribute : attribute.slice(0, sep)).trim().toLowerCase();
      const value = sep === -1 ? '' : attribute.slice(sep + 1).trim();
      if (key === 'domain' && value) {
        const domain = value.replace(/^\./, '').toLowerCase();
        // A host may only set a cookie for itself or a parent domain.
        if (target.hostname !== domain && !target.hostname.endsWith(`.${domain}`)) {
          return;
        }
        cookie.domain = domain;
        cookie.hostOnly = false;
      } else if (key === 'path' && value.startsWith('/')) {
        cookie.path = value;
      } else if (key === 'max-age' && /^-?\d+$/.test(value)) {
        cookie.expires = this.now() + Number(value) * 1000;
      } else if (key === 'expires' && cookie.expires === null) {
        const date = Date.parse(value);
        if (!Number.isNaN(date)) {
          cookie.expires = date;
        }
      } else if (key === 'secure') {
        cookie.secure = true;
      }
    }
    const id = `${cookie.domain}|${cookie.path}|${cookie.name}`;
    if (cookie.expires !== null && cookie.expires <= this.now()) {
      this.cookies.delete(id);
      return;
    }
    this.cookies.set(id, cookie);
  }

  /** The cookies to send to a URL. */
  matching(url) {
    const target = new URL(url);
    const now = this.now();
    const found = [];
    for (const [id, cookie] of this.cookies) {
      if (cookie.expires !== null && cookie.expires <= now) {
        this.cookies.delete(id);
        continue;
      }
      if (
        domainMatches(target.hostname, cookie) &&
        pathMatches(target.pathname, cookie.path) &&
        (!cookie.secure || target.protocol === 'https:')
      ) {
        found.push(cookie);
      }
    }
    // Longer paths first, as browsers do.
    return found.sort((a, b) => b.path.length - a.path.length);
  }

  /** The Cookie header for a URL, or null. */
  header(url) {
    const cookies = this.matching(url);
    return cookies.length ? cookies.map((c) => `${c.name}=${c.value}`).join('; ') : null;
  }

  /** The value of a cookie sent to a URL, or of the first one by that name. */
  get(name, url) {
    const pool = url ? this.matching(url) : [...this.cookies.values()];
    return pool.find((cookie) => cookie.name === name)?.value;
  }

  /** Every cookie whose name starts with a prefix. */
  findByPrefix(prefix) {
    return [...this.cookies.values()].filter((cookie) => cookie.name.startsWith(prefix));
  }

  /** Set a cookie for a host and its subdomains (a value saved in /data). */
  set(name, value, domain, { path = '/', expires = null, secure = true } = {}) {
    this.cookies.set(`${domain}|${path}|${name}`, {
      name,
      value,
      domain,
      hostOnly: false,
      path,
      expires,
      secure,
    });
  }

  /** Remove the cookies a predicate selects. */
  clear(predicate = () => true) {
    for (const [id, cookie] of this.cookies) {
      if (predicate(cookie)) {
        this.cookies.delete(id);
      }
    }
  }
}

/**
 * One answer, its body already read (the sign-in pages are small).
 */
class HttpResponse {
  constructor({ status, url, headers, body }) {
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this.url = url;
    this.headers = headers;
    this.body = body;
  }

  text() {
    return this.body;
  }

  json() {
    try {
      return JSON.parse(this.body);
    } catch {
      throw new CannotConnectError(`Unexpected answer from ${safeUrl(this.url)} (not JSON)`);
    }
  }

  /** The absolute target of a redirect, or null. */
  location() {
    const value = this.headers.get('location');
    return value ? new URL(value, this.url).toString() : null;
  }
}

function encodeForm(form) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) {
    params.append(key, value === undefined || value === null ? '' : String(value));
  }
  return params.toString();
}

// Header values never written to a trace: they carry the session.
const SECRET_HEADERS = new Set(['cookie', 'authorization', 'x-csrf-token']);

/** A timer that aborts a controller with a TimeoutError, cleared once the step is done. */
function abortAfter(controller, ms) {
  const timer = setTimeout(
    () => controller.abort(new DOMException('The operation timed out', 'TimeoutError')),
    ms,
  );
  timer.unref?.();
  return timer;
}

/**
 * @param {object} [options]
 * @param {typeof fetch} [options.fetch] the fetch implementation (injected by the tests)
 * @param {number} [options.headersTimeoutMs] wait for the answer's headers
 * @param {number} [options.bodyTimeoutMs] then for its body: some sites send 200 KB slowly
 *   (AEP Ohio: headers in ~7 s, the whole page in ~22 s)
 * @param {CookieJar} [options.jar]
 * @param {(entry: object) => void} [options.trace] called per request with what was
 *   sent and answered, secrets left out (scripts/probe.mjs prints it)
 */
export function createHttpSession({
  fetch: fetchImpl = globalThis.fetch,
  headersTimeoutMs = 60000,
  bodyTimeoutMs = 90000,
  jar = new CookieJar(),
  trace,
} = {}) {
  async function once(url, { method, headers, body }) {
    // What a browser sends: PSE's ASP.NET server answers its error page to a
    // request without Accept-Language. A caller's header replaces a default.
    const sent = { 'User-Agent': USER_AGENT, ...DEFAULT_HEADERS, ...headers };
    const cookie = jar.header(url);
    if (cookie) {
      sent.Cookie = cookie;
    }
    const entry = {
      method,
      url: safeUrl(url),
      headers: Object.fromEntries(
        Object.entries(sent).map(([key, value]) => [
          key,
          SECRET_HEADERS.has(key.toLowerCase()) ? '(set)' : value,
        ]),
      ),
    };
    const controller = new AbortController();
    let timer = abortAfter(controller, headersTimeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: sent,
        body,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err) {
      const timedOut =
        err?.name === 'TimeoutError' || controller.signal.reason?.name === 'TimeoutError';
      const reason = timedOut ? 'timed out waiting for the answer' : 'network error';
      trace?.({ ...entry, error: reason });
      throw new CannotConnectError(`${safeUrl(url)}: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
    const setCookies =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : (response.headers.get('set-cookie') ?? '').split(/,(?=\s*[^;,=\s]+=)/).filter(Boolean);
    jar.setFromHeaders(url, setCookies);
    const location = response.headers.get('location');
    trace?.({
      ...entry,
      status: response.status,
      ...(location ? { location: safeUrl(new URL(location, url).toString()) } : {}),
    });
    let text;
    timer = abortAfter(controller, bodyTimeoutMs);
    try {
      text = await response.text();
    } catch (err) {
      const timedOut =
        err?.name === 'TimeoutError' || controller.signal.reason?.name === 'TimeoutError';
      throw new CannotConnectError(
        `${safeUrl(url)}: ${timedOut ? 'timed out while reading the answer' : 'the answer was cut'}`,
      );
    } finally {
      clearTimeout(timer);
    }
    return new HttpResponse({
      status: response.status,
      url,
      headers: response.headers,
      body: text,
    });
  }

  return {
    jar,

    /**
     * @param {string} url
     * @param {object} [options]
     * @param {string} [options.method]
     * @param {Record<string, string>} [options.headers]
     * @param {Record<string, unknown>} [options.form] sent urlencoded
     * @param {unknown} [options.json] sent as JSON
     * @param {string} [options.body] sent as is
     * @param {boolean} [options.followRedirects] default true
     * @param {boolean} [options.okOnly] throw an HttpError outside 2xx (after the redirects)
     * @returns {Promise<HttpResponse>}
     */
    async request(url, options = {}) {
      let method = options.method ?? 'GET';
      const headers = { ...options.headers };
      let body = options.body;
      if (options.form !== undefined) {
        body = encodeForm(options.form);
        headers['Content-Type'] ??= 'application/x-www-form-urlencoded';
      } else if (options.json !== undefined) {
        body = JSON.stringify(options.json);
        headers['Content-Type'] ??= 'application/json';
      }
      let current = url;
      let response;
      for (let hop = 0; ; hop += 1) {
        response = await once(current, { method, headers, body });
        const next = response.location();
        if (options.followRedirects === false || !REDIRECT_STATUSES.has(response.status) || !next) {
          break;
        }
        if (hop >= MAX_REDIRECTS) {
          throw new CannotConnectError(`${safeUrl(url)}: too many redirects`);
        }
        if (
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) && method === 'POST')
        ) {
          method = 'GET';
          body = undefined;
          delete headers['Content-Type'];
        }
        current = next;
      }
      if (options.okOnly && !response.ok) {
        throw new HttpError(response.status, safeUrl(response.url), response.body);
      }
      return response;
    },
  };
}
