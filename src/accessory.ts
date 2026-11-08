import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import { LaundryCycleDetector, type CycleSnapshot } from './cycle';
import type { SwitcherLaundryPlatform } from './platform';
import type { PowerSample, PowerSource } from './switcher-power';

export interface LaundryDeviceConfig {
  name: string;
  identifier: string;
  deviceId?: string;
  deviceIp?: string;
  startWatts: number;
  stopWatts: number;
  startSeconds: number;
  stopSeconds: number;
}

export class LaundryAccessory {
  private readonly doneService: Service;
  private readonly runningService: Service;
  private readonly clearService: Service;
  private readonly detector: LaundryCycleDetector;
  private lastWatts = 0;
  private lastLoggedWattsAt = 0;
  private snapshot: CycleSnapshot = {
    phase: 'idle',
    watts: 0,
    running: false,
    done: false,
    changed: false,
  };

  constructor(
    private readonly platform: SwitcherLaundryPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly device: LaundryDeviceConfig,
    private readonly power: PowerSource,
  ) {
    const { Characteristic, Service } = this.platform;

    this.detector = new LaundryCycleDetector({
      startWatts: device.startWatts,
      stopWatts: device.stopWatts,
      startSeconds: device.startSeconds,
      stopSeconds: device.stopSeconds,
    });

    this.accessory.getService(Service.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, 'Switcher')
      .setCharacteristic(Characteristic.Model, 'Power Plug Laundry')
      .setCharacteristic(Characteristic.SerialNumber, device.deviceId || device.identifier);

    // One HomeKit device (like Home Connect): Running is the primary tile;
    // Done + Clear Done are linked sensors inside that device.
    this.runningService = this.accessory.getServiceById(Service.OccupancySensor, 'washer-running')
      || this.accessory.addService(Service.OccupancySensor, device.name, 'washer-running');
    this.runningService.setCharacteristic(Characteristic.Name, device.name);
    this.runningService.getCharacteristic(Characteristic.OccupancyDetected)
      .onGet(() => this.runningOccupancy());

    this.doneService = this.accessory.getServiceById(Service.ContactSensor, 'washer-done')
      || this.accessory.addService(Service.ContactSensor, `${device.name} Done`, 'washer-done');
    this.doneService.setCharacteristic(Characteristic.Name, `${device.name} Done`);
    this.doneService.getCharacteristic(Characteristic.ContactSensorState)
      .onGet(() => this.doneContactState());

    this.clearService = this.accessory.getServiceById(Service.Switch, 'clear-done')
      || this.accessory.addService(Service.Switch, `${device.name} Clear Done`, 'clear-done');
    this.clearService.setCharacteristic(Characteristic.Name, `${device.name} Clear Done`);
    this.clearService.getCharacteristic(Characteristic.On)
      .onGet(() => false)
      .onSet((value) => this.clearDone(value));

    this.runningService.setPrimaryService(true);
    this.runningService.addLinkedService(this.doneService);
    this.runningService.addLinkedService(this.clearService);

    this.applySnapshot(this.snapshot, true);

    this.power.on('power', (sample) => this.onPower(sample));
    this.power.on('error', (error) => {
      this.platform.log.error(`[${device.name}] ${error.message}`);
    });
    this.power.start();

    // If no watt samples arrive, HomeKit sensors stay idle forever — surface that clearly.
    setTimeout(() => {
      if (this.lastWatts === 0 && this.snapshot.phase === 'idle') {
        this.platform.log.warn(
          `[${device.name}] no power readings yet — check identifier/deviceId/deviceIp, or look for UDP/TCP errors above`,
        );
      }
    }, 60_000);
  }

  stop(): void {
    this.power.stop();
  }

  getSnapshot(): CycleSnapshot {
    return this.snapshot;
  }

  /** Used by tests to inject watt samples without UDP traffic. */
  ingestWatts(watts: number, now = Date.now()): CycleSnapshot {
    return this.onPower({
      deviceId: this.device.identifier,
      deviceIp: '127.0.0.1',
      name: this.device.name,
      watts,
      on: true,
    }, now);
  }

  private onPower(sample: PowerSample, now = Date.now()): CycleSnapshot {
    const previousWatts = this.lastWatts;
    this.lastWatts = sample.watts;
    const next = this.detector.update(sample.watts, now);
    if (next.changed) {
      this.platform.log.info(
        `[${this.device.name}] ${next.phase} at ${sample.watts} W`,
      );
      this.lastLoggedWattsAt = now;
    } else if (Math.abs(sample.watts - previousWatts) >= 5 || now - this.lastLoggedWattsAt >= 60_000) {
      // Heartbeat so logs prove TCP/UDP samples keep arriving (Eve can be stale).
      this.platform.log.info(`[${this.device.name}] ${sample.watts} W (${next.phase})`);
      this.lastLoggedWattsAt = now;
    } else {
      this.platform.log.debug(`[${this.device.name}] ${sample.watts} W (${next.phase})`);
    }
    this.applySnapshot(next);
    return next;
  }

  private clearDone(value: CharacteristicValue): void {
    if (!value) {
      return;
    }
    const next = this.detector.acknowledge();
    this.platform.log.info(`[${this.device.name}] cleared done state`);
    this.applySnapshot(next);
    setTimeout(() => {
      this.clearService.updateCharacteristic(this.platform.Characteristic.On, false);
    }, 250);
  }

  private applySnapshot(snapshot: CycleSnapshot, force = false): void {
    if (!force && !snapshot.changed && snapshot.watts === this.lastWatts && this.snapshot.phase === snapshot.phase) {
      this.snapshot = snapshot;
      return;
    }
    this.snapshot = snapshot;
    const { Characteristic } = this.platform;
    this.doneService.updateCharacteristic(Characteristic.ContactSensorState, this.doneContactState());
    this.runningService.updateCharacteristic(Characteristic.OccupancyDetected, this.runningOccupancy());
  }

  private doneContactState(): number {
    const { Characteristic } = this.platform;
    // Open contact while laundry is waiting to be emptied.
    return this.snapshot.done
      ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
      : Characteristic.ContactSensorState.CONTACT_DETECTED;
  }

  private runningOccupancy(): number {
    const { Characteristic } = this.platform;
    return this.snapshot.running
      ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
      : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;
  }
}
