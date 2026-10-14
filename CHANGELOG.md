# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Electricity and gas meters of US utilities on Opower: AEP Ohio, AEP Texas,
  Appalachian Power, Atlantic City Electric, BGE, ComEd, ConEd, Delmarva,
  Duquesne Light, Indiana Michigan Power, Kentucky Power, O&R, PG&E, PECO,
  Pepco, PSO, PSE and SWEPCO. One device per meter.
- Electricity feeds the Gladys 5.2 energy tracking with a consumption dated
  at its real time (30-minute slots from hourly reads, or days), the history
  of your choice imported at the first reading.
- Per meter: the last complete day, the current month and the bill forecast,
  in kWh (gas in m³) and dollars.
- Sign-in by password, by an authenticator key (ConEd, O&R), or by a
  verification code sent by email or text (PG&E, Exelon companies), with the
  "Send the verification code" and "Enter the code" actions; the sign-in is
  then remembered.
- A reading every 12 hours by the integration itself, and a "Sign in and
  refresh now" action.
- The "Utility energy summary" dashboard widget, the "New day of usage
  available" and "Utility sign-in needs you" scene triggers, and the "Read a
  meter summary" scene action.
- PSE is marked experimental: the live check of a made-up account ended on
  PSE's error page, read as refused credentials.
- Texts in English, French, German and Spanish; documentation in the four
  languages.

[Unreleased]: https://github.com/guim31/gladys-opower/commits/main
