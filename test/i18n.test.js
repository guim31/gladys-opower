// -----------------------------------------------------------------------------
// Every text Gladys shows exists in the four languages of its interface
// (English, French, German, Spanish): the manifest, the message tables of the
// code and the documentation. German says "du", never the polite "Sie".
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LANGUAGES } from '../src/config.js';
import { CODE_METHODS, FEATURE_NAMES, MESSAGES, METER_NAMES } from '../src/i18n.js';
import { NOT_YET, UTILITIES } from '../src/utilities/index.js';
import { WIDGET_TEXT } from '../src/widgets.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const docs = Object.fromEntries(
  await Promise.all(
    ['en', 'fr', 'de', 'es'].map(async (lang) => [
      lang,
      await readFile(new URL(`../docs/${lang}.md`, import.meta.url), 'utf8'),
    ]),
  ),
);

const LANGS = ['en', 'fr', 'de', 'es'];
const POLITE_GERMAN = /(?<!\p{L})(Sie|Ihr|Ihre|Ihren|Ihrem|Ihrer|Ihres)(?!\p{L})/u;

// Upper bounds, in characters: what the Gladys interface shows without cutting.
const MAX = {
  catalog: 100,
  widgetLabel: 30,
  label: 60,
  placeholder: 60,
  description: 300,
  message: 200,
  short: 24,
  featureName: 40,
};

const sorted = (keys) => [...keys].sort();

/** Checks one multi-language object; returns its problems. */
function problems(value, path, max) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [`${path} must be a multi-language object`];
  }
  const found = [];
  if (JSON.stringify(sorted(Object.keys(value))) !== JSON.stringify(sorted(LANGS))) {
    found.push(`${path} has [${Object.keys(value)}], expected exactly [${LANGS}]`);
  }
  for (const [lang, text] of Object.entries(value)) {
    found.push(...textProblems(text, `${path}.${lang}`, lang, max));
  }
  return found;
}

function textProblems(text, path, lang, max) {
  if (typeof text !== 'string' || text.trim() === '') {
    return [`${path} is empty`];
  }
  const found = [];
  if (text.length > max) {
    found.push(`${path} has ${text.length} characters (${max} at most)`);
  }
  if (lang === 'de' && POLITE_GERMAN.test(text)) {
    found.push(`${path} uses the polite form: "${text}"`);
  }
  return found;
}

/** Every multi-language object of the manifest, with its length limit. */
function manifestTexts(root) {
  const texts = [];
  const walk = (value, path, key) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`, key));
      return;
    }
    if (!value || typeof value !== 'object') {
      return;
    }
    const isText =
      ['label', 'description', 'placeholder'].includes(key) ||
      Object.keys(value).some((child) => LANGS.includes(child));
    if (isText) {
      const max =
        path === 'manifest.description' || /^manifest\.widgets\[\d+\]\.description$/.test(path)
          ? MAX.catalog
          : /^manifest\.widgets\[\d+\]\.label$/.test(path)
            ? MAX.widgetLabel
            : (MAX[key] ?? MAX.label);
      texts.push({ path, value, max });
      return;
    }
    for (const [child, item] of Object.entries(value)) {
      walk(item, `${path}.${child}`, child);
    }
  };
  walk(root, 'manifest', null);
  return texts;
}

// Tables written one language at a time: same keys everywhere, no empty text.
function tableProblems(table, name, max, render = (value) => value) {
  const found = [];
  if (JSON.stringify(sorted(Object.keys(table))) !== JSON.stringify(sorted(LANGS))) {
    found.push(`${name} has [${Object.keys(table)}], expected exactly [${LANGS}]`);
  }
  for (const lang of LANGS) {
    const entries = table[lang] ?? {};
    if (
      JSON.stringify(sorted(Object.keys(entries))) !== JSON.stringify(sorted(Object.keys(table.en)))
    ) {
      found.push(`${name}.${lang} does not have the keys of ${name}.en`);
    }
    for (const [key, value] of Object.entries(entries)) {
      found.push(...textProblems(render(value), `${name}.${lang}.${key}`, lang, max));
    }
  }
  return found;
}

test('the configuration offers the four languages', () => {
  assert.deepEqual(LANGUAGES, LANGS);
});

test('every text of the manifest is in English, French, German and Spanish', () => {
  const texts = manifestTexts(manifest);
  assert.ok(texts.length >= 80, `only ${texts.length} texts found in the manifest`);
  assert.deepEqual(
    texts.flatMap(({ path, value, max }) => problems(value, path, max)),
    [],
  );
});

test('the catalog description holds 10 characters at least in every language', () => {
  for (const lang of LANGS) {
    assert.ok(manifest.description[lang].length >= 10, `description.${lang} is too short`);
  }
});

test('the status and action messages exist in every language, 200 characters at most', () => {
  const samples = {
    cannotConnect: ['https://pge.opower.com/ei/edge/apis/multi-account-v1: network error'],
    signedIn: ['Atlantic City Electric', 12],
    codeChoice: ['t***@example.com, ***-***-1234'],
    codeSent: ['***-***-1234'],
    refreshed: [12],
    refreshTooSoon: [15],
    failed: ['ComEd: the code request failed (status 503)'],
  };
  const found = Object.entries(MESSAGES).flatMap(([key, value]) =>
    problems(
      typeof value === 'function' ? value(...samples[key]) : value,
      `MESSAGES.${key}`,
      MAX.message,
    ),
  );
  assert.deepEqual(found, []);
});

test('the feature names, meter names and code methods exist in every language', () => {
  assert.deepEqual(tableProblems(FEATURE_NAMES, 'FEATURE_NAMES', MAX.featureName), []);
  assert.deepEqual(tableProblems(METER_NAMES, 'METER_NAMES', MAX.short), []);
  assert.deepEqual(tableProblems(CODE_METHODS, 'CODE_METHODS', MAX.short), []);
  for (const lang of LANGS) {
    assert.equal(
      new Set(Object.values(FEATURE_NAMES[lang])).size,
      Object.keys(FEATURE_NAMES.en).length,
    );
  }
});

test('the widget texts exist in every language, within the core limits', () => {
  // Tile labels ≤ 24 (with the date added), status labels ≤ 40, caption ≤ 80, body ≤ 300.
  const limits = {
    lastDay: 12,
    month: MAX.short,
    monthCost: MAX.short,
    forecast: MAX.short,
    dayCost: 40,
    forecastUsage: 40,
    typical: 40,
    period: 40,
    chart: 40,
    dataUntil: 80,
    notConfigured: 300,
    code: 300,
    password: 300,
    noData: 300,
  };
  const found = [];
  for (const [key, max] of Object.entries(limits)) {
    found.push(
      ...tableProblems(
        Object.fromEntries(LANGS.map((lang) => [lang, { [key]: WIDGET_TEXT[lang][key] }])),
        'WIDGET_TEXT',
        max,
        (value) => (typeof value === 'function' ? value('12 sept.') : value),
      ),
    );
  }
  assert.deepEqual(found, []);
  assert.deepEqual(
    tableProblems(WIDGET_TEXT, 'WIDGET_TEXT', 300, (value) =>
      typeof value === 'function' ? value('x') : value,
    ),
    [],
  );
});

test('the four docs have the same sections, the supported list and the notices', () => {
  const outline = (text) => [...text.matchAll(/^(#{1,4}) /gm)].map((match) => match[1]);
  const reference = outline(docs.en);
  assert.ok(reference.filter((level) => level === '##').length >= 9, 'too few sections');
  for (const lang of LANGS) {
    // Names may wrap across lines.
    const text = docs[lang].replace(/\s+/g, ' ');
    assert.deepEqual(
      outline(docs[lang]),
      reference,
      `docs/${lang}.md does not have the sections of docs/en.md`,
    );
    for (const utility of UTILITIES) {
      assert.ok(text.includes(utility.name), `docs/${lang}.md does not list ${utility.name}`);
    }
    for (const name of Object.values(NOT_YET)) {
      assert.ok(text.includes(name), `docs/${lang}.md does not name ${name} as not supported yet`);
    }
    assert.ok(text.includes('Oracle Opower'), `docs/${lang}.md lacks the "not affiliated" notice`);
    assert.ok(text.includes('Developed without'), `docs/${lang}.md lacks the hardware notice`);
    assert.ok(text.length > 3000, `docs/${lang}.md is too short`);
  }
  assert.doesNotMatch(docs.de, POLITE_GERMAN, 'docs/de.md uses the polite form');
});

test('the guard catches a missing language, an empty text and the polite German form', () => {
  assert.equal(problems({ en: 'Light', fr: 'Éclairage', de: 'Licht' }, 'x', 60).length, 1);
  assert.equal(problems({ en: 'Light', fr: 'Éclairage', de: '', es: 'Luz' }, 'x', 60).length, 1);
  assert.equal(problems({ en: 'a', fr: 'a', de: 'a', es: 'a', it: 'a' }, 'x', 60).length, 1);
  assert.equal(problems({ en: 'a', fr: 'a', de: 'a'.repeat(61), es: 'a' }, 'x', 60).length, 1);
  for (const polite of [
    'Wählen Sie',
    'Ihr Gerät',
    'Ihre IP',
    'mit Ihrem',
    'Ihren',
    'Ihrer',
    'Ihres',
  ]) {
    assert.equal(problems({ en: 'a', fr: 'a', de: polite, es: 'a' }, 'x', 60).length, 1, polite);
  }
  assert.deepEqual(
    problems({ en: 'a', fr: 'a', de: 'Siebenschläfer, ihre', es: 'a' }, 'x', 60),
    [],
  );
  const forgotten = structuredClone(manifest);
  delete forgotten.actions[1].fields[0].placeholder.de;
  assert.deepEqual(
    manifestTexts(forgotten).flatMap(({ path, value, max }) => problems(value, path, max)),
    ['manifest.actions[1].fields[0].placeholder has [en,fr,es], expected exactly [en,fr,de,es]'],
  );
});
