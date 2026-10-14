// The HTTP session of the sign-ins: cookies across hosts and redirects.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CannotConnectError, HttpError } from '../src/errors.js';
import { CookieJar, createHttpSession, safeUrl } from '../src/http.js';
import { cookiesOf, createFakeWeb } from './helpers/fake-web.js';

test('a cookie goes back to its host and path only, unquoted', () => {
  const jar = new CookieJar();
  jar.setFromHeaders('https://www.coned.com/en/login', [
    'CE_DEVICE_ID=dev+ice/id==; Path=/',
    'scoped=1; Path=/en',
    'parent=1; Domain=.coned.com; Path=/',
  ]);
  assert.equal(
    jar.header('https://www.coned.com/en/login'),
    'scoped=1; CE_DEVICE_ID=dev+ice/id==; parent=1',
  );
  assert.equal(
    jar.header('https://www.coned.com/sitecore/api'),
    'CE_DEVICE_ID=dev+ice/id==; parent=1',
  );
  assert.equal(jar.header('https://login.coned.com/'), 'parent=1');
  assert.equal(jar.header('https://www.oru.com/'), null);
});

test('a host cannot set a cookie for another domain', () => {
  const jar = new CookieJar();
  jar.setFromHeaders('https://evil.example.com/', ['stolen=1; Domain=pge.com']);
  assert.equal(jar.header('https://myaccount.pge.com/'), null);
});

test('expired, Max-Age=0 and Secure cookies follow the rules', () => {
  let now = Date.parse('2026-08-15T00:00:00Z');
  const jar = new CookieJar({ now: () => now });
  jar.setFromHeaders('https://www.pse.com/', [
    'short=1; Max-Age=60',
    'gone=1; Expires=Thu, 01 Jan 2026 00:00:00 GMT',
    'secure=1; Secure',
  ]);
  assert.equal(jar.header('https://www.pse.com/'), 'short=1; secure=1');
  assert.equal(jar.header('http://www.pse.com/'), 'short=1');
  jar.setFromHeaders('https://www.pse.com/', ['secure=; Max-Age=0']);
  now += 120 * 1000;
  assert.equal(jar.header('https://www.pse.com/'), null);
});

test('redirects are followed by hand, with the cookies of every hop', async () => {
  const web = createFakeWeb()
    .on('POST', 'https://a.example.com/login', () => ({
      status: 302,
      headers: { location: 'https://b.example.com/next?code=secret' },
      cookies: ['a=1; Path=/; Domain=example.com'],
    }))
    .on('GET', 'https://b.example.com/next', () => ({
      status: 303,
      headers: { location: '/done' },
      cookies: ['b=2; Path=/'],
    }))
    .on('GET', 'https://b.example.com/done', { text: 'ok' });
  const session = createHttpSession({ fetch: web.fetch });
  const response = await session.request('https://a.example.com/login', {
    method: 'POST',
    form: { user: 'u' },
  });
  assert.equal(response.text(), 'ok');
  assert.equal(response.url, 'https://b.example.com/done');
  // The POST became a GET at the first redirect, without its body.
  assert.deepEqual(
    web.requests.map((request) => [request.method, request.body]),
    [
      ['POST', 'user=u'],
      ['GET', null],
      ['GET', null],
    ],
  );
  assert.deepEqual(cookiesOf(web.requests[2]), { a: '1', b: '2' });
});

test('a redirect can be read instead of followed', async () => {
  const web = createFakeWeb().on('GET', 'https://login.example.com/confirmed', {
    status: 302,
    headers: { location: 'msauth.com.comed.mobile://auth/?code=abc' },
  });
  const session = createHttpSession({ fetch: web.fetch });
  const response = await session.request('https://login.example.com/confirmed', {
    followRedirects: false,
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'msauth.com.comed.mobile://auth/?code=abc');
});

test('errors never show a query string, and a network failure is retryable', async () => {
  assert.equal(safeUrl('https://x.example.com/path?token=abc#f'), 'https://x.example.com/path');
  const web = createFakeWeb().on('GET', 'https://x.example.com/fail', {
    status: 500,
    text: 'boom',
  });
  const session = createHttpSession({ fetch: web.fetch });
  await assert.rejects(
    session.request('https://x.example.com/fail?token=abc', { okOnly: true }),
    (err) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 500);
      assert.doesNotMatch(err.message, /token/);
      return true;
    },
  );
  await assert.rejects(session.request('https://unknown.example.com/?password=x'), (err) => {
    assert.ok(err instanceof CannotConnectError);
    assert.doesNotMatch(err.message, /password/);
    return true;
  });
});

test('a JSON answer that is not JSON is a retryable error', async () => {
  const web = createFakeWeb().on('GET', 'https://x.example.com/json', {
    text: '<html>maintenance</html>',
  });
  const session = createHttpSession({ fetch: web.fetch });
  const response = await session.request('https://x.example.com/json');
  assert.throws(() => response.json(), CannotConnectError);
});

test('a slow site: the wait for the headers and the reading of the body have their own delays', async () => {
  // A fetch that answers after `headersMs`, then streams the body after `bodyMs`.
  const slow =
    ({ headersMs, bodyMs }) =>
    (_url, init) =>
      new Promise((resolve, reject) => {
        const abort = () => reject(init.signal.reason);
        init.signal.addEventListener('abort', abort, { once: true });
        setTimeout(() => {
          const stream = new ReadableStream({
            start(controller) {
              const timer = setTimeout(() => {
                controller.enqueue(new TextEncoder().encode('<html>usage</html>'));
                controller.close();
              }, bodyMs);
              init.signal.addEventListener('abort', () => {
                clearTimeout(timer);
                controller.error(init.signal.reason);
              });
            },
          });
          resolve(new Response(stream, { status: 200 }));
        }, headersMs);
      });

  // AEP Ohio: headers after ~7 s, the whole page after ~22 s: within the delays.
  const fine = createHttpSession({
    fetch: slow({ headersMs: 70, bodyMs: 150 }),
    headersTimeoutMs: 100,
    bodyTimeoutMs: 200,
  });
  assert.equal(
    (await fine.request('https://www.aepohio.com/account/usage/')).text(),
    '<html>usage</html>',
  );

  const noHeaders = createHttpSession({
    fetch: slow({ headersMs: 300, bodyMs: 0 }),
    headersTimeoutMs: 50,
  });
  await assert.rejects(
    noHeaders.request('https://www.aepohio.com/'),
    /timed out waiting for the answer/,
  );

  const slowBody = createHttpSession({
    fetch: slow({ headersMs: 0, bodyMs: 300 }),
    bodyTimeoutMs: 50,
  });
  await assert.rejects(
    slowBody.request('https://www.aepohio.com/'),
    /timed out while reading the answer/,
  );
});

test('the trace lists every request with its answer, the session headers masked', async () => {
  const web = createFakeWeb()
    .on('POST', 'https://www.pse.com/api/pseauthentication/AsyncSignIn', {
      status: 302,
      headers: { location: '/servererrorpage?aspxerrorpath=/x' },
      cookies: ['session=secret-value; Path=/'],
    })
    .on('GET', 'https://www.pse.com/servererrorpage', { status: 500, text: 'error' });
  const entries = [];
  const session = createHttpSession({ fetch: web.fetch, trace: (entry) => entries.push(entry) });
  await session.request('https://www.pse.com/api/pseauthentication/AsyncSignIn', {
    method: 'POST',
    form: { Password: 'hunter2' },
    headers: { Authorization: 'Bearer abc' },
  });
  assert.deepEqual(
    entries.map(({ method, url, status, location }) => [method, url, status, location]),
    [
      [
        'POST',
        'https://www.pse.com/api/pseauthentication/AsyncSignIn',
        302,
        'https://www.pse.com/servererrorpage',
      ],
      ['GET', 'https://www.pse.com/servererrorpage', 500, undefined],
    ],
  );
  assert.equal(entries[0].headers.Authorization, '(set)');
  assert.equal(entries[1].headers.Cookie, '(set)');
  assert.doesNotMatch(JSON.stringify(entries), /hunter2|secret-value|abc/);
});
