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
  const { accessories, launch, shutdown, platform } = createHarness(power);

  try {
    launch();
    await platform.ready;
    assert.equal(accessories.length, 1);

    const accessory = accessories[0];
    const done = accessory.getServiceById(hap.Service.ContactSensor, 'washer-done');
    const running = accessory.getServiceById(hap.Service.OccupancySensor, 'washer-running');
    assert.ok(done);
    assert.ok(running);

    const contact = done.getCharacteristic(hap.Characteristic.ContactSensorState);
    const occupancy = running.getCharacteristic(hap.Characteristic.OccupancyDetected);

    assert.equal(contact.value, hap.Characteristic.ContactSensorState.CONTACT_DETECTED);
    assert.equal(occupancy.value, hap.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED);

    const handler = platform.handlers[0];
    const t0 = 1_700_000_000_000;
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

test('matchesIdentifier accepts id, name, or ip', () => {
  const { matchesIdentifier } = require('../dist/switcher-power');
  const message = {
    device_id: 'e4eaf6',
    device_ip: '192.168.68.91',
    name: 'Dryer Machine Plug',
  };
  assert.equal(matchesIdentifier('e4eaf6', message), true);
  assert.equal(matchesIdentifier('Dryer Machine Plug', message), true);
  assert.equal(matchesIdentifier('192.168.68.91', message), true);
  assert.equal(matchesIdentifier('washer', message), false);
});

test('two laundry devices each get their own sensors', async () => {
  const washerPower = new FakePowerSource();
  const dryerPower = new FakePowerSource();
  const powers = [washerPower, dryerPower];
  let index = 0;

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
    devices: [
      {
        name: 'Washer',
        identifier: 'washer1',
        startWatts: 5,
        stopWatts: 2,
        startSeconds: 2,
        stopSeconds: 3,
      },
      {
        name: 'Dryer',
        identifier: 'dryer1',
        startWatts: 200,
        stopWatts: 20,
        startSeconds: 2,
        stopSeconds: 3,
      },
    ],
  }, api, () => powers[index++]);

  try {
    launch();
    await platform.ready;
    assert.equal(accessories.length, 2);
    assert.ok(accessories[1].getServiceById(hap.Service.OccupancySensor, 'washer-running'));
    assert.ok(accessories[1].getServiceById(hap.Service.ContactSensor, 'washer-done'));
  } finally {
    shutdown();
  }
});

test('restoring a cached accessory does not duplicate services', async () => {
  const power = new FakePowerSource();
  const first = createHarness(power);
  first.launch();
  await first.platform.ready;
  const cached = first.accessories[0];
  first.shutdown();

  const second = createHarness(power);
  second.platform.configureAccessory(cached);
  await assert.doesNotReject(async () => {
    second.launch();
    await second.platform.ready;
  });
  assert.equal(
    cached.services.filter((service) => service.UUID === hap.Service.ContactSensor.UUID).length,
    1,
  );
  second.shutdown();
});

function createHarness(power) {
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

  return { accessories, launch, shutdown, platform };
}
