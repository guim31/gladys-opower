// -----------------------------------------------------------------------------
// What the integration keeps between restarts, in /data (the only writable
// volume of the container):
//   - the sign-in data that skips the verification code (PG&E device cookies,
//     ConEd device cookie, Exelon refresh token), per utility and username;
//   - per meter, how far its consumption reached Gladys and the last day a
//     scene was told about.
// The file holds secrets: it is written owner-only (0600), atomically (a
// temporary file renamed over the old one), and never logged.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const VERSION = 1;

export function emptyState() {
  return { version: VERSION, loginData: {}, meters: {} };
}

/** The key of one sign-in: the utility and the username, hashed (no address in the file). */
export function identityOf(utilityKey, username) {
  return createHash('sha256')
    .update(
      `${utilityKey}\n${String(username ?? '')
        .trim()
        .toLowerCase()}`,
    )
    .digest('hex')
    .slice(0, 32);
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== VERSION) {
    return emptyState();
  }
  return {
    version: VERSION,
    loginData: raw.loginData && typeof raw.loginData === 'object' ? raw.loginData : {},
    meters: raw.meters && typeof raw.meters === 'object' ? raw.meters : {},
  };
}

/**
 * @param {string} [directory] default: $DATA_DIR, else /data
 */
export function createFileStore(directory = process.env.DATA_DIR || '/data') {
  const path = join(directory, 'opower-state.json');
  return {
    path,
    async load() {
      try {
        return normalize(JSON.parse(await readFile(path, 'utf8')));
      } catch {
        return emptyState();
      }
    },
    async save(state) {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.tmp`;
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await rename(temporary, path);
    },
  };
}

/** The same contract in memory (tests). */
export function createMemoryStore(initial = emptyState()) {
  let saved = structuredClone(initial);
  return {
    async load() {
      return normalize(structuredClone(saved));
    },
    async save(state) {
      saved = structuredClone(state);
    },
    get saved() {
      return saved;
    },
  };
}
