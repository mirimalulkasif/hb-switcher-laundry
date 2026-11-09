import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import { LaundryCycleDetector, type CycleSnapshot } from './cycle';
import type { SwitcherLaundryPlatform } from './platform';
import type { PowerSample, PowerSource } from './switcher-power';

export interface LaundryDeviceConfig {
  name: string;
  identifier: string;
  deviceId?: string;
  deviceIp?: string;
  deviceKey?: string;
  startWatts: number;
  stopWatts: number;
  startSeconds: number;
  stopSeconds: number;
  /** Optional switch that turns on when laundry needs emptying. */
  showEmptySwitch: boolean;
}

export class LaundryAccessory {
  private readonly doneService: Service;
  private readonly runningService: Service;
  private readonly emptyService?: Service;
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

    // One HomeKit device: Running is the primary tile; Done (+ optional Empty) linked inside.
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

    this.emptyService = this.setupEmptySwitch(device);

    this.runningService.setPrimaryService(true);
    this.runningService.addLinkedService(this.doneService);
    if (this.emptyService) {
      this.runningService.addLinkedService(this.emptyService);
    }

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
      // "idle" at high watts is normal until startSeconds elapses — label that clearly.
      this.platform.log.info(`[${this.device.name}] ${sample.watts} W (${this.phaseLabel(next.phase, sample.watts)})`);
      this.lastLoggedWattsAt = now;
    } else {
      this.platform.log.debug(`[${this.device.name}] ${sample.watts} W (${next.phase})`);
    }
    this.applySnapshot(next);
    return next;
  }

  private setupEmptySwitch(device: LaundryDeviceConfig): Service | undefined {
    const { Characteristic, Service } = this.platform;
    const legacyClear = this.accessory.getServiceById(Service.Switch, 'clear-done');
    const existing = this.accessory.getServiceById(Service.Switch, 'needs-emptying');
    if (legacyClear && legacyClear !== existing) {
      this.accessory.removeService(legacyClear);
    }

    if (!device.showEmptySwitch) {
      if (existing) {
        this.accessory.removeService(existing);
      }
      return undefined;
    }

    const label = `${device.name} Empty Me`;
    const service = existing || this.accessory.addService(Service.Switch, label, 'needs-emptying');
    service.setCharacteristic(Characteristic.Name, label);
    if ('ConfiguredName' in Characteristic) {
      try {
        service.setCharacteristic(Characteristic.ConfiguredName, label);
      } catch {
        // older HAP
      }
    }
    service.getCharacteristic(Characteristic.On)
      .onGet(() => this.snapshot.done)
      .onSet((value) => this.setEmptySwitch(value));
    return service;
  }

  /**
   * Empty Me switch: turns ON automatically when Done fires.
   * Turning it OFF means you emptied the machine → clear Done.
   * Turning it ON manually does nothing unless already done.
   */
  private setEmptySwitch(value: CharacteristicValue): void {
    const requested = Boolean(value);
    if (requested) {
      // Stay on only while laundry still needs emptying.
      if (!this.snapshot.done) {
        setTimeout(() => {
          this.emptyService?.updateCharacteristic(this.platform.Characteristic.On, false);
        }, 100);
      }
      return;
    }
    if (!this.snapshot.done) {
      return;
    }
    const next = this.detector.acknowledge();
    this.platform.log.info(`[${this.device.name}] emptied — Done cleared`);
    this.applySnapshot(next);
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
    this.emptyService?.updateCharacteristic(Characteristic.On, this.snapshot.done);
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

  private phaseLabel(phase: CycleSnapshot['phase'], watts: number): string {
    if (phase === 'idle' && watts >= this.device.startWatts) {
      return `warming ≥${this.device.startWatts}W for ${this.device.startSeconds}s`;
    }
    if (phase === 'running' && watts <= this.device.stopWatts) {
      return `stopping ≤${this.device.stopWatts}W for ${this.device.stopSeconds}s`;
    }
    return phase;
  }
}
