// -----------------------------------------------------------------------------
// Conformity with the Gladys core, on every device discovered from realistic
// fixtures: an electricity meter read by the quarter hour, one read by the
// day, one with bills only, a gas meter — in every feature-name language.
//
// The table (test/fixtures/gladys-feature-table.json) is extracted from the
// core code: a category/type couple missing there shows as "undefined" or
// without icon in Gladys, a poll frequency outside its list is a 400 on
// discovery, a feature without min/max is a 422 on "Add to Gladys".
// Do not loosen this test to make it pass: fix the integration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture } from './helpers/opower-server.js';
import { createWorld, PGE_CONFIG } from './helpers/world.js';

const table = JSON.parse(
  await readFile(new URL('./fixtures/gladys-feature-table.json', import.meta.url), 'utf8'),
);

// Every reading mode an Opower account can have, next to the gas meter.
function customers() {
  const answer = structuredClone(fixture('customers-pge.json'));
  const [electricity, gas] = answer.customers[0].utilityAccounts;
  answer.customers[0].utilityAccounts = [
    electricity,
    gas,
    {
      ...electricity,
      uuid: '55555555-5555-11e5-bf2b-000000000005',
      preferredUtilityAccountId: '1000000005',
      readResolution: 'DAY',
    },
    {
      ...electricity,
      uuid: '66666666-6666-11e5-bf2b-000000000006',
      preferredUtilityAccountId: '1000000006',
      readResolution: 'BILLING',
    },
    {
      ...electricity,
      uuid: '77777777-7777-11e5-bf2b-000000000007',
      preferredUtilityAccountId: '1000000007',
      readResolution: 'HOUR',
    },
  ];
  return answer;
}

for (const language of ['en', 'fr', 'de', 'es']) {
  test(`every discovered meter follows the Gladys rules (${language} names)`, async () => {
    const world = createWorld({
      config: { ...PGE_CONFIG, language },
      opower: { customers: customers() },
    });
    try {
      await world.connect();
      const devices = world.gladys.fake.discoveredDevices;
      assert.equal(devices.length, 5, 'one device per meter');
      const deviceIds = new Set();

      for (const device of devices) {
        const where = device.name;
        assert.ok(!deviceIds.has(device.external_id), `${where}: duplicate device external_id`);
        deviceIds.add(device.external_id);

        // should_poll: true if and only if poll_frequency is provided, in ms.
        if (device.poll_frequency === undefined) {
          assert.notEqual(device.should_poll, true, `${where}: should_poll without poll_frequency`);
        } else {
          assert.equal(device.should_poll, true, `${where}: poll_frequency without should_poll`);
          assert.ok(
            table.poll_frequencies_ms.includes(device.poll_frequency),
            `${where}: poll_frequency ${device.poll_frequency} is not one of ${table.poll_frequencies_ms}`,
          );
        }

        assert.ok(device.features.length > 0, `${where}: no feature`);
        const externalIds = new Set();
        const names = new Set();
        for (const feature of device.features) {
          const at = `${where} / ${feature.name}`;
          const pair = table.pairs[`${feature.category}/${feature.type}`];
          assert.ok(
            pair,
            `${at}: ${feature.category}/${feature.type} is not a couple Gladys knows`,
          );
          assert.ok(
            pair.label_en && pair.label_fr && pair.icon,
            `${at}: couple without label or icon`,
          );

          assert.equal(typeof feature.min, 'number', `${at}: min must be a number`);
          assert.equal(typeof feature.max, 'number', `${at}: max must be a number`);
          assert.ok(
            Number.isFinite(feature.min) && Number.isFinite(feature.max),
            `${at}: finite min/max`,
          );
          assert.ok(feature.min <= feature.max, `${at}: min > max`);
          assert.equal(typeof feature.read_only, 'boolean', `${at}: read_only must be a boolean`);
          assert.equal(
            typeof feature.has_feedback,
            'boolean',
            `${at}: has_feedback must be a boolean`,
          );
          if (feature.unit !== undefined) {
            assert.ok(table.units.includes(feature.unit), `${at}: unknown unit ${feature.unit}`);
            const allowed = table.units_by_category[feature.category];
            if (allowed) {
              assert.ok(
                allowed.flat().includes(feature.unit),
                `${at}: ${feature.unit} not a unit of ${feature.category}`,
              );
            }
          }

          assert.ok(!externalIds.has(feature.external_id), `${at}: duplicate external_id`);
          externalIds.add(feature.external_id);
          assert.ok(!names.has(feature.name), `${at}: duplicate feature name on the device`);
          names.add(feature.name);
        }
      }
    } finally {
      await world.stop();
    }
  });
}

test('only electricity feeds the energy tracking, through one consumption feature, never an index', async () => {
  const world = createWorld({ opower: { customers: customers() } });
  try {
    await world.connect();
    const consumptionTypes = ['thirty-minutes-consumption', 'daily-consumption'];
    // The core derives a consumption from these: a late index would collapse a day into a half hour.
    const indexTypes = ['index', 'energy'];
    for (const device of world.gladys.fake.discoveredDevices) {
      const energy = device.features.filter((feature) => feature.category === 'energy-sensor');
      assert.equal(
        energy.filter((feature) => indexTypes.includes(feature.type)).length,
        0,
        `${device.name}: a cumulative index`,
      );
      const consumption = energy.filter((feature) => consumptionTypes.includes(feature.type));
      const gas = device.name.includes('Gas');
      const billsOnly = device.external_id.includes('66666666');
      assert.equal(consumption.length, gas || billsOnly ? 0 : 1, device.name);
      for (const feature of consumption) {
        assert.equal(feature.unit, 'kilowatt-hour');
        assert.equal(feature.min, 0, 'a consumption is never negative');
      }
    }
    const types = Object.fromEntries(
      world.gladys.fake.discoveredDevices.map((device) => [
        device.external_id.split(':').at(-1).slice(0, 8),
        device.features.find((feature) => consumptionTypes.includes(feature.type))?.type ?? null,
      ]),
    );
    assert.deepEqual(types, {
      22222222: 'thirty-minutes-consumption',
      33333333: null,
      55555555: 'daily-consumption',
      66666666: null,
      77777777: 'thirty-minutes-consumption',
    });
  } finally {
    await world.stop();
  }
});
