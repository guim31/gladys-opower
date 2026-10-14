// -----------------------------------------------------------------------------
// The errors of the sign-in and of the Opower API.
//
// The sync loop decides what to do from the class alone: a bad password is
// not retried (the user must fix the configuration), a verification code is
// asked through the Configuration screen, anything else is a transient
// failure retried at the next cycle. Messages never carry a credential, a
// token or a URL query: they end up in the logs and in the Gladys interface.
// -----------------------------------------------------------------------------

/** The utility refused the username, the password or the verification code. */
export class InvalidAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidAuthError';
  }
}

/** A network error, a server error or a page that changed: retried later. */
export class CannotConnectError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CannotConnectError';
  }
}

/**
 * The utility asks for a one-time code. `challenge` drives the rest of the
 * sign-in: `options()` lists where the code can be sent, `send(option)` sends
 * it, `submit(code)` checks it and resolves the data that skips the code on
 * the next sign-in (saved in /data).
 */
export class MfaRequiredError extends Error {
  constructor(message, challenge) {
    super(message);
    this.name = 'MfaRequiredError';
    this.challenge = challenge;
  }
}

/** An HTTP answer outside 2xx. `url` carries no query string (it may hold a token). */
export class HttpError extends Error {
  constructor(status, url, body = '') {
    super(`HTTP ${status} from ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    // Kept for the parsers (an error page explains a refusal), never logged.
    this.body = body;
  }
}
