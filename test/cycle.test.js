const assert = require('node:assert/strict');
const test = require('node:test');

const { LaundryCycleDetector } = require('../dist/cycle');

test('marks running after sustained high power, then done after sustained low power', () => {
  const detector = new LaundryCycleDetector({
    startWatts: 5,
    stopWatts: 2,
    startSeconds: 60,
    stopSeconds: 180,
  });

  let now = 1_000_000;
  assert.equal(detector.update(1, now).phase, 'idle');

  now += 1_000;
  assert.equal(detector.update(20, now).phase, 'idle');

  now += 60_000;
  assert.equal(detector.update(20, now).phase, 'running');

  // Short rinse pause should not finish the cycle.
  now += 1_000;
  assert.equal(detector.update(1, now).phase, 'running');
  now += 60_000;
  assert.equal(detector.update(1, now).phase, 'running');

  now += 1_000;
  assert.equal(detector.update(25, now).phase, 'running');

  now += 1_000;
  assert.equal(detector.update(1, now).phase, 'running');
  now += 180_000;
  const done = detector.update(1, now);
  assert.equal(done.phase, 'done');
  assert.equal(done.changed, true);
});

test('a new sustained high-power stretch leaves done and starts running again', () => {
  const detector = new LaundryCycleDetector({
    startWatts: 5,
    stopWatts: 2,
    startSeconds: 30,
    stopSeconds: 30,
  });

  let now = 0;
  detector.update(20, now);
  now += 30_000;
  assert.equal(detector.update(20, now).phase, 'running');
  now += 1_000;
  detector.update(1, now);
  now += 30_000;
  assert.equal(detector.update(1, now).phase, 'done');

  now += 1_000;
  detector.update(20, now);
  now += 30_000;
  assert.equal(detector.update(20, now).phase, 'running');
});

test('acknowledge clears a finished cycle', () => {
  const detector = new LaundryCycleDetector({
    startWatts: 5,
    stopWatts: 2,
    startSeconds: 1,
    stopSeconds: 1,
  });

  let now = 0;
  detector.update(10, now);
  now += 1_000;
  detector.update(10, now);
  now += 1_000;
  detector.update(1, now);
  now += 1_000;
  assert.equal(detector.update(1, now).phase, 'done');
  assert.equal(detector.acknowledge().phase, 'idle');
});
