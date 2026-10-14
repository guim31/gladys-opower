// -----------------------------------------------------------------------------
// The utilities the integration signs in to.
//
// Each one is a port of its module in tronikos/opower (Apache-2.0). The `key`
// is the value stored in the configuration: never rename one. A utility of
// the Python library that is not ported yet is listed in NOT_YET: the
// documentation names them, and a configuration naming one is refused with a
// clear message instead of a failed sign-in.
// -----------------------------------------------------------------------------

import {
  aepOhio,
  aepTexas,
  appalachianPower,
  indianaMichiganPower,
  kentuckyPower,
  pso,
  swepco,
} from './aep.js';
import { coned, oru } from './coned.js';
import { duquesne } from './duquesne.js';
import { atlanticCityElectric, bge, comed, delmarva, pepco, peco } from './exelon.js';
import { pge } from './pge.js';
import { pse } from './pse.js';

/** Supported, in the order of the configuration list (alphabetical by name). */
export const UTILITIES = [
  aepOhio,
  aepTexas,
  appalachianPower,
  atlanticCityElectric,
  bge,
  comed,
  coned,
  delmarva,
  duquesne,
  indianaMichiganPower,
  kentuckyPower,
  oru,
  pge,
  peco,
  pepco,
  pso,
  pse,
  swepco,
];

const BY_KEY = new Map(UTILITIES.map((utility) => [utility.key, utility]));

/** Opower utilities of the Python library, not ported yet (key → name). */
export const NOT_YET = {
  aesindiana: 'AES Indiana',
  burbankwaterandpower: 'Burbank Water and Power (BWP)',
  clarkpublicutilities: 'Clark Public Utilities',
  coautilities: 'City of Austin Utilities',
  evergy: 'Evergy',
  eversource: 'Eversource',
  glendalewaterandpower: 'Glendale Water and Power (GWP)',
  nipsco: 'Northern Indiana Public Service Company (NIPSCO)',
  rienergy: 'Rhode Island Energy',
  scl: 'Seattle City Light (SCL)',
  smeco: 'Southern Maryland Electric Cooperative (SMECO)',
  smud: 'Sacramento Municipal Utility District (SMUD)',
  swgas: 'Southwest Gas',
};

/** The supported utility for a configuration key, or null. */
export function findUtility(key) {
  return BY_KEY.get(key) ?? null;
}
