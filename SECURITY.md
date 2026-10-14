# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

What the integration handles:

- **Secrets**: the utility password and the optional authenticator secret key
  (ConEd, O&R) are `secret` fields of the Gladys configuration. The
  integration reads them from Gladys at startup, keeps them in memory, sends
  them only to the sign-in pages of the chosen utility, and never writes them
  to `/data` nor to the logs. The utility and Opower session tokens live in
  memory only, for one reading. The verification codes typed in the
  Configuration screen are sent to the utility and not kept.
- **Stored in `/data`**: `opower-state.json`, readable by the owner only
  (0600): what the utility gives to skip the verification code next time
  (PG&E device cookies, the ConEd/O&R device cookie, the Exelon refresh
  token, account number and sign-in address), keyed by a hash of the utility
  and username; and per meter, how far the energy tracking was fed and the
  last day announced to the scenes. Deleting the file only means a new
  verification code.
- **Network**: requests go only to the sign-in pages of the chosen utility,
  its identity provider (Okta, Azure AD B2C, Salesforce), and
  `<utility>.opower.com`, in HTTPS, certificates verified; the integration
  opens no port. It reads data, it never changes anything on the account.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
the utilities' websites and Opower (Oracle), and the other devices and
services of your network.
