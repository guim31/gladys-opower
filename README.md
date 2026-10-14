# Opower (US utilities) for Gladys Assistant

An external integration for [Gladys Assistant](https://gladysassistant.com)
that brings the electricity and gas usage of US utilities served by **Opower**
(Oracle) into Gladys: PG&E, ConEd, the Exelon companies (ComEd, PECO, BGE,
Pepco, Delmarva, Atlantic City Electric), the AEP companies, PSE, Duquesne
Light… It is the US counterpart of the Linky / Enedis integrations for the
**energy tracking of Gladys 5.2**.

> **Developed without the hardware: feedback welcome.** No utility account
> was available: the sign-ins are ports of the open-source
> [opower](https://github.com/tronikos/opower) library used by Home Assistant,
> tested against the flows and answers its tests describe, not against the
> live websites. Please report what works and what does not in the
> [issues](https://github.com/guim31/gladys-opower/issues).

## Features

- **One device per meter** (electricity, gas) of the utility account.
- **Electricity in the energy tracking**: the consumption is published dated
  at its real time, 30-minute slots split from the hourly reads (or days for a
  meter read daily), through the dated-consumption endpoint of Gladys 5.2. The
  data of a utility arrives a day or two late; Gladys still charts and prices
  it at the right hours. The history of your choice (7 days to a year) is
  imported at the first reading.
- **Summaries** for every meter: the last complete day, the current month
  (usage and cost) and the **bill forecast** of the billing period, in kWh
  and dollars; gas in m³ (Gladys has no therm nor CCF unit: converted, see the
  documentation).
- **Sign-in** by password, by an authenticator key (ConEd, O&R), or by a
  **verification code** sent by email or text (PG&E, Exelon companies) with
  the _Send the verification code_ and _Enter the code_ actions; the sign-in
  is then remembered.
- **Dashboard widget** "Utility energy summary": last day, month, month cost,
  bill forecast (orange above last year's), the last 14 days as bars.
- **Scene triggers**: _New day of usage available_ (once per new day, with its
  figures) and _Utility sign-in needs you_ (a code is asked, or the password
  is refused). **Scene action**: _Read a meter summary_ (for a message).
- A reading every 12 hours by the integration itself, and a _Sign in and
  refresh now_ action.
- Every text in English, French, German and Spanish.

Supported utilities: AEP Ohio, AEP Texas, Appalachian Power, Atlantic City
Electric, Baltimore Gas and Electric (BGE), Commonwealth Edison (ComEd),
Consolidated Edison (ConEd), Delmarva Power, Duquesne Light Company (DQE),
Indiana Michigan Power, Kentucky Power, Orange & Rockland Utilities (O&R),
Pacific Gas and Electric Company (PG&E), PECO Energy Company (PECO), Potomac
Electric Power Company (Pepco), Public Service Company of Oklahoma (PSO),
Puget Sound Energy (PSE), Southwestern Electric Power Company (SWEPCO).
Not ported yet: AES Indiana, Burbank Water and Power, Clark Public Utilities,
City of Austin Utilities, Evergy, Eversource, Glendale Water and Power,
NIPSCO, Rhode Island Energy, Seattle City Light, SMECO, SMUD, Southwest Gas.

## Requirements

- Gladys Assistant **5.2.0** or later (dated consumption for the energy
  tracking, widgets, scene triggers and actions).
- An online account at a supported utility; a smart meter for hourly
  electricity.
- Internet access from Gladys.

## Installation

1. In Gladys, open **Integrations** → **Install from GitHub** and enter the
   address of this repository: `https://github.com/guim31/gladys-opower`
   (or install **Opower (US utilities)** from the catalog once it is listed).
2. In **Configuration**, choose the utility, enter the username and password
   of its website (and the authenticator key for a ConEd/O&R account with
   two-step sign-in). Save. If a verification code is asked, use the two code
   actions.
3. Open the **Discover** tab and add the meters. To get the costs computed by
   Gladys, set the electricity meter's _Consumption_ as the main meter in the
   energy settings and create your contract there.

The user guide is in [`docs/en.md`](docs/en.md) (also in
[French](docs/fr.md), [German](docs/de.md) and [Spanish](docs/es.md)); Gladys
links it from the Configuration screen.

## How it works

- Every 12 hours (`src/poller.js`, the container's own timer: Gladys 5.2 does
  not poll external devices reliably, GladysAssistant/Gladys#3198), the
  integration signs in to the utility (`src/utilities/`), which hands over an
  Opower token, then calls the Opower API (`src/opower/client.js`): the
  customer accounts, the bill forecast (GraphQL), the hourly usage and the
  daily costs.
- The hourly reads become dated half hours (`src/summary.js`) sent with
  `publishEnergyConsumption`; the last three days are sent again every time,
  the core writes only what changed. No cumulative index is published: the
  core's index pipeline would collapse a late day into one half hour.
- The summaries go through `publishChangedStates` (changes only, a heartbeat
  every 6 hours). A device added later receives everything at once.
- The sign-in data that skips the verification code is kept in
  `/data/opower-state.json` (0600), never the password.
- `scripts/probe.mjs` checks the live websites read-only, from a machine with
  Internet: a made-up account must be refused cleanly by PG&E, ConEd, ComEd,
  AEP Ohio and PSE; with a real account (environment variables), it lists the
  meters and counts the reads without printing anything personal.

## Limitations

- **Developed without the hardware or an account**: the first real sign-ins
  may find differences with the flows of the reference library.
- The data is a day or two late: no live power.
- Hourly reads are split into two equal half hours; net metering counts an
  exporting hour as 0 in the energy tracking.
- Gas is in m³ (therms converted with the US average heat content) and not in
  the energy tracking (Gladys 5.2 prices electricity only).
- One account per installation; the Exelon companies read the default
  account of the sign-in. Water meters are not supported.

## Development

```bash
npm ci
npm run format:check
npm run lint
npm test
npx -y github:GladysAssistant/integration-store --skip-image-check .
```

The tests use the fake Gladys of the SDK (`@gladysassistant/integration-sdk/testing`)
and a fake web (`test/helpers/fake-web.js`) serving the sign-in flows and the
Opower API in the shapes of the opower library's tests
(`test/fixtures/opower/`). Nothing reaches the network. See
[`CLAUDE.md`](CLAUDE.md) for the project rules.

## Credits

- [tronikos/opower](https://github.com/tronikos/opower) by tronikos and
  contributors (Apache-2.0): every sign-in flow and the Opower API calls are
  ports of its utility modules, and its tests provided the response shapes of
  the fixtures.
- Home Assistant's
  [`opower`](https://github.com/home-assistant/core/tree/dev/homeassistant/components/opower)
  integration (Apache-2.0): the 12-hour pace, the choice of sensors and the
  handling of late data.
- The architecture and the conformity tests follow
  [gladys-wled](https://github.com/guim31/gladys-wled) and
  [gladys-subsonic](https://github.com/guim31/gladys-subsonic).

## Disclaimer

This project is not affiliated with, endorsed or sponsored by Oracle Opower
or the utilities. "Opower" is a trademark of Oracle; the utility names are
trademarks of their owners.

## License

Apache-2.0
