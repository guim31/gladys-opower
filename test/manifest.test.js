// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers — these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ACTION, createApp, registerHandlers, SCENE_ACTION, TRIGGER, WIDGET } from '../src/app.js';
import { DEFAULT_CONFIG, HISTORY_DAYS, LANGUAGES } from '../src/config.js';
import { createMemoryStore } from '../src/store.js';
import { UTILITIES } from '../src/utilities/index.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

// Every list of form fields the manifest can declare (same field grammar).
const allFields = [
  ...(manifest.config_schema ?? []),
  ...[
    ...(manifest.actions ?? []),
    ...(manifest.scene_triggers ?? []),
    ...(manifest.scene_actions ?? []),
  ].flatMap((item) => item.fields ?? []),
  ...(manifest.widgets ?? []).flatMap((widget) => widget.settings ?? []),
];

const keysOf = (list) => (list ?? []).map((entry) => entry.key);
const field = (key) => manifest.config_schema.find((entry) => entry.key === key);

function minGladysVersion() {
  const match = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.(\d+)/);
  assert.ok(match, 'gladys_version must declare a minimum version');
  return match.slice(1).map(Number);
}

function isAtLeast(version, required) {
  for (let i = 0; i < required.length; i += 1) {
    if (version[i] !== required[i]) {
      return version[i] > required[i];
    }
  }
  return true;
}

/** The handlers the app registers, by kind. */
function registered() {
  const gladys = createFakeGladys();
  const seen = { action: [], sceneAction: [], widgetGet: [] };
  for (const kind of Object.keys(seen)) {
    const method = `on${kind[0].toUpperCase()}${kind.slice(1)}`;
    const original = gladys[method].bind(gladys);
    gladys[method] = (key, handler) => {
      seen[kind].push(key);
      return original(key, handler);
    };
  }
  registerHandlers(gladys, createApp({ gladys, store: createMemoryStore(), timers: false }));
  return seen;
}

test('every manifest action has a registered handler, and vice versa', () => {
  assert.deepEqual(keysOf(manifest.actions).sort(), registered().action.sort());
  assert.deepEqual(keysOf(manifest.actions).sort(), Object.values(ACTION).sort());
});

test('every scene action and widget has its handler, and vice versa', () => {
  const seen = registered();
  assert.deepEqual(keysOf(manifest.scene_actions), seen.sceneAction);
  assert.deepEqual(keysOf(manifest.scene_actions), Object.values(SCENE_ACTION));
  assert.deepEqual(keysOf(manifest.widgets), seen.widgetGet);
  assert.deepEqual(keysOf(manifest.widgets), Object.values(WIDGET));
});

test('every scene trigger the code fires is declared, and every declared one is fired', () => {
  // An undeclared key is a 404 on publishSceneEvent; a declared key nobody
  // fires is a dead card in the scene editor.
  assert.deepEqual(keysOf(manifest.scene_triggers).sort(), Object.values(TRIGGER).sort());
});

test('the manifest needs Gladys 5.2.0: dated consumption, widgets, scene declarations', () => {
  // POST /energy/consumption shipped in 5.2.0 (GladysAssistant/Gladys, v5.2.0);
  // widgets, scene triggers and actions need 5.1.0, categories 4.86.0.
  assert.ok(isAtLeast(minGladysVersion(), [5, 2, 0]), manifest.gladys_version);
  assert.deepEqual(manifest.categories, ['energy']);
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.equal(manifest.type, 'device');
});

test('the name is short and the same in every language', () => {
  assert.equal(typeof manifest.name, 'string');
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30, manifest.name);
});

test('config_schema defaults stay consistent with DEFAULT_CONFIG', () => {
  for (const entry of manifest.config_schema) {
    if (entry.default !== undefined) {
      assert.equal(DEFAULT_CONFIG[entry.key], entry.default, `DEFAULT_CONFIG.${entry.key}`);
    }
  }
  assert.equal(DEFAULT_CONFIG.language, 'fr', 'French by default (Guilhem, 12/10/2026)');
});

test('the configuration lists exactly the supported utilities, the languages and the histories', () => {
  assert.deepEqual(
    field('utility').options.map((option) => option.value),
    UTILITIES.map((utility) => utility.key),
  );
  for (const option of field('utility').options) {
    // Brand names are not translated.
    assert.equal(new Set(Object.values(option.label)).size, 1, option.value);
  }
  assert.deepEqual(
    field('language').options.map((option) => option.value),
    LANGUAGES,
  );
  assert.deepEqual(
    field('history_days').options.map((option) => option.value),
    HISTORY_DAYS,
  );
  assert.equal(field('password').type, 'secret');
  assert.equal(field('totp_secret').type, 'secret');
});

test('no action field is a secret, none relies on a default', () => {
  // GladysAssistant/Gladys#3154 and #3155: a secret action field cannot be
  // filled in, and an action applies no default.
  for (const action of manifest.actions) {
    for (const entry of action.fields ?? []) {
      assert.notEqual(entry.type, 'secret', `${action.key}.${entry.key}`);
      assert.equal(entry.default, undefined, `${action.key}.${entry.key}`);
    }
    assert.ok(action.timeout_seconds >= 5 && action.timeout_seconds <= 120, action.key);
  }
});

test('section fields are purely presentational', () => {
  const sections = manifest.config_schema.filter((entry) => entry.type === 'section');
  assert.ok(sections.length > 0);
  for (const section of sections) {
    assert.equal(section.required, undefined, `section "${section.key}" must not be required`);
    assert.equal(section.default, undefined, `section "${section.key}" must not have a default`);
    assert.equal(
      section.placeholder,
      undefined,
      `section "${section.key}" must not have a placeholder`,
    );
    assert.ok(!(section.key in DEFAULT_CONFIG), `section "${section.key}" stores no value`);
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('dynamic selects declare a source and no static options', () => {
  const dynamic = allFields.filter((entry) => entry.source !== undefined);
  assert.ok(dynamic.length > 0);
  for (const entry of dynamic) {
    assert.equal(entry.source, 'devices');
    assert.equal(entry.options, undefined, `field "${entry.key}": source and options together`);
  }
});

test('the scene trigger filters match the keys of the events', () => {
  // The core builds the filters from the fields and matches them on the
  // event keys of the same name.
  const daily = manifest.scene_triggers.find((entry) => entry.key === TRIGGER.DAILY_USAGE);
  assert.deepEqual(keysOf(daily.fields), ['meter']);
  assert.deepEqual(keysOf(daily.variables), [
    'date',
    'usage',
    'unit',
    'cost',
    'month_usage',
    'month_cost',
    'forecast_cost',
  ]);
  const signIn = manifest.scene_triggers.find((entry) => entry.key === TRIGGER.SIGN_IN_REQUIRED);
  assert.deepEqual(
    signIn.fields[0].options.map((option) => option.value),
    ['code', 'password'],
  );
});

test('the manifest version is the package version, and the image is tagged with it', () => {
  assert.equal(manifest.version, pkg.version, 'manifest version must match package.json');
  assert.equal(manifest.docker_image, `ghcr.io/guim31/gladys-opower:${manifest.version}`);
  assert.equal(
    manifest.cover_image,
    'https://raw.githubusercontent.com/guim31/gladys-opower/main/cover.png',
  );
});

test('the catalog description holds 10 to 100 characters per language', () => {
  for (const [lang, text] of Object.entries(manifest.description)) {
    assert.ok(
      text.length >= 10 && text.length <= 100,
      `description.${lang} has ${text.length} characters`,
    );
  }
});

test('field placeholders are multi-language objects', () => {
  const withPlaceholder = allFields.filter((entry) => entry.placeholder !== undefined);
  assert.ok(withPlaceholder.length > 0);
  for (const entry of withPlaceholder) {
    assert.equal(typeof entry.placeholder, 'object', `field "${entry.key}": placeholder`);
  }
});
