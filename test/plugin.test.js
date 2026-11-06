const assert = require('node:assert/strict');
const test = require('node:test');

const hap = require('hap-nodejs');
const { PlatformAccessory } = require('homebridge/lib/platformAccessory');

const plugin = require('../dist/index');
const { SwitcherLaundryPlatform } = require('../dist/platform');
const { FakePowerSource } = require('../dist/switcher-power');

test('the plugin registers the Switcher Laundry platform', () => {
  let registered = null;
  plugin({
    registerPlatform(pluginName, platformName, constructor) {
      registered = { pluginName, platformName, constructor };
    },
  });
  assert.deepEqual(registered, {
    pluginName: 'homebridge-switcher-laundry',
    platformName: 'SwitcherLaundry',
    constructor: SwitcherLaundryPlatform,
  });
});

test('HomeKit sensors follow running and done wattage thresholds', async () => {
  const power = new FakePowerSource();
  const accessories = [];
  let launch = () => {};
  let shutdown = () => {};

  const api = {
    hap,
    platformAccessory: PlatformAccessory,
    registerPlatformAccessories(_pluginName, _platformName, list) {
      accessories.push(...list);
    },
    unregisterPlatformAccessories() {},
    on(event, callback) {
      if (event === 'didFinishLaunching') {
        launch = callback;
      }
      if (event === 'shutdown') {
        shutdown = callback;
      }
    },
  };

  const platform = new SwitcherLaundryPlatform({
    info() {},
    warn() {},
    error() {},
    debug() {},
  }, {
    name: 'Laundry',
    devices: [{
      name: 'Washer',
      identifier: 'abc123',
      startWatts: 5,
      stopWatts: 2,
      startSeconds: 2,
      stopSeconds: 3,
    }],
  }, api, () => power);

  try {
    launch();
    await platform.ready;
    assert.equal(accessories.length, 1);

    const accessory = accessories[0];
    const done = accessory.getService('Washer Done');
    const running = accessory.getService('Washer Running');
    assert.ok(done);
    assert.ok(running);

    const contact = done.getCharacteristic(hap.Characteristic.ContactSensorState);
    const occupancy = running.getCharacteristic(hap.Characteristic.OccupancyDetected);

    assert.equal(contact.value, hap.Characteristic.ContactSensorState.CONTACT_DETECTED);
    assert.equal(occupancy.value, hap.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED);

    const t0 = Date.now();
    power.push(20);
    // FakePowerSource does not accept timestamps; drive through the handler clock by
    // replaying samples spaced with the detector's wall clock. Advance by feeding
    // samples after real waits would be slow, so call the private path via a short
    // delay simulation: emit many times after mutating Date is brittle. Instead,
    // use the accessory ingest helper exposed for tests.
    const handler = platform.handlers[0];
    handler.ingestWatts(20, t0);
    handler.ingestWatts(20, t0 + 2_000);
    assert.equal(occupancy.value, hap.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED);
    assert.equal(contact.value, hap.Characteristic.ContactSensorState.CONTACT_DETECTED);

    handler.ingestWatts(1, t0 + 3_000);
    handler.ingestWatts(1, t0 + 6_000);
    assert.equal(occupancy.value, hap.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    assert.equal(contact.value, hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
  } finally {
    shutdown();
  }
});
