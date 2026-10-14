// -----------------------------------------------------------------------------
// A fake web for the tests: a `fetch` that serves registered routes and
// records every request. Nothing reaches the network.
//
// A route matches a method and a URL (exact string without the query, a
// RegExp on the whole URL, or a predicate) and answers
// `{ status, headers, body | json | text, cookies }`, or a function of the
// request that returns one. `cookies` are Set-Cookie headers.
// -----------------------------------------------------------------------------

function matches(matcher, url) {
  if (typeof matcher === 'function') {
    return matcher(url);
  }
  if (matcher instanceof RegExp) {
    return matcher.test(url.toString());
  }
  return `${url.origin}${url.pathname}` === matcher;
}

export function createFakeWeb() {
  const routes = [];
  const requests = [];

  function toResponse(answer) {
    const headers = new Headers();
    for (const [key, value] of Object.entries(answer.headers ?? {})) {
      headers.set(key, value);
    }
    for (const cookie of answer.cookies ?? []) {
      headers.append('set-cookie', cookie);
    }
    let body = answer.body ?? null;
    if (answer.json !== undefined) {
      body = JSON.stringify(answer.json);
      if (!headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }
    } else if (answer.text !== undefined) {
      body = answer.text;
    }
    const status = answer.status ?? 200;
    return new Response([204, 301, 302, 303, 304, 307, 308].includes(status) ? null : body, {
      status,
      headers,
    });
  }

  const web = {
    requests,

    /** Register a route; the last registered wins when several match. */
    on(method, matcher, answer) {
      routes.unshift({ method, matcher, answer });
      return web;
    },

    /** The recorded requests to a path (any query). */
    calls(method, path) {
      return requests.filter(
        (request) =>
          request.method === method &&
          (path instanceof RegExp ? path.test(request.url) : request.url.split('?')[0] === path),
      );
    },

    async fetch(input, init = {}) {
      const url = new URL(String(input));
      const method = (init.method ?? 'GET').toUpperCase();
      const headers = Object.fromEntries(
        Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
      );
      const request = {
        method,
        url: url.toString(),
        query: Object.fromEntries(url.searchParams),
        headers,
        body: init.body ?? null,
        form: null,
        json: null,
      };
      if (typeof request.body === 'string') {
        if ((headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) {
          request.form = Object.fromEntries(new URLSearchParams(request.body));
        } else if ((headers['content-type'] ?? '').startsWith('application/json')) {
          request.json = JSON.parse(request.body);
        }
      }
      requests.push(request);
      const route = routes.find(
        (candidate) => candidate.method === method && matches(candidate.matcher, url),
      );
      if (!route) {
        throw new TypeError(`fetch failed: no route for ${method} ${url}`);
      }
      const answer =
        typeof route.answer === 'function' ? await route.answer(request) : route.answer;
      if (answer instanceof Error) {
        throw answer;
      }
      return toResponse(answer);
    },
  };
  web.fetch = web.fetch.bind(web);
  return web;
}

/** The cookies a request carried, name → value. */
export function cookiesOf(request) {
  const cookies = {};
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
  }
  return cookies;
}
