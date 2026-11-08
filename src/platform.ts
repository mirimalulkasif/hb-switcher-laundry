import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { LaundryAccessory, type LaundryDeviceConfig } from './accessory';
import {
  DEFAULT_START_SECONDS,
  DEFAULT_START_WATTS,
  DEFAULT_STOP_SECONDS,
  DEFAULT_STOP_WATTS,
  PLATFORM_NAME,
  PLUGIN_NAME,
} from './settings';
import { SwitcherPowerSource, type PowerSource } from './switcher-power';

export class SwitcherLaundryPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  private readonly cachedAccessories: PlatformAccessory[] = [];
  private readonly handlers: LaundryAccessory[] = [];
  public ready: Promise<void> = Promise.resolve();

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
    private readonly powerFactory: (device: LaundryDeviceConfig) => PowerSource = (device) =>
      new SwitcherPowerSource({
        identifier: device.identifier,
        deviceId: device.deviceId,
        deviceIp: device.deviceIp,
        deviceKey: device.deviceKey,
        token: typeof this.config.token === 'string' ? this.config.token : undefined,
        pollSeconds: Number(this.config.pollSeconds) || 10,
        // Operational power-source lines must be visible (debug hides "TCP mode" / errors).
        log: (message) => this.log.info(message),
        debugLog: (message) => this.log.debug(message),
      }),
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.api.on('didFinishLaunching', () => {
      this.ready = Promise.resolve().then(() => this.start());
    });
    this.api.on('shutdown', () => {
      for (const handler of this.handlers) {
        handler.stop();
      }
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.push(accessory);
    this.log.debug(`Restoring cached accessory ${accessory.displayName}`);
  }

  private start(): void {
    const devices = this.readDevices();
    if (devices.length === 0) {
      this.log.error('Add at least one Switcher plug under devices in the plugin config');
      return;
    }

    const activeIds = new Set<string>();
    for (const device of devices) {
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${device.identifier}`);
      activeIds.add(uuid);
      const existing = this.cachedAccessories.find((item) => item.UUID === uuid);
      const category = this.api.hap.Categories.SENSOR;
      const accessory = existing ?? new this.api.platformAccessory(device.name, uuid, category);
      accessory.category = category;
      accessory.context.identifier = device.identifier;

      const handler = new LaundryAccessory(this, accessory, device, this.powerFactory(device));
      this.handlers.push(handler);

      if (!existing) {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
      const tcpReady = Boolean(device.deviceId && device.deviceIp);
      this.log.info(
        `Watching ${device.name} (${device.identifier}) start≥${device.startWatts}W/${device.startSeconds}s stop≤${device.stopWatts}W/${device.stopSeconds}s`
          + (tcpReady
            ? ` TCP id=${device.deviceId} ip=${device.deviceIp}`
            : ' WARNING: deviceId/deviceIp missing — TCP disabled'),
      );
      if (!tcpReady) {
        this.log.error(
          `[${device.name}] Set Device ID and Device IP from Switcher Platform logs (Found New Switcher … | ID:… | IP:…). Name alone is not enough while Platform owns UDP.`,
        );
      }
    }

    const stale = this.cachedAccessories.filter((item) => !activeIds.has(item.UUID));
    if (stale.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }

  private readDevices(): LaundryDeviceConfig[] {
    const raw = Array.isArray(this.config.devices) ? this.config.devices : [];
    return raw
      .map((entry) => this.normalizeDevice(entry))
      .filter((entry): entry is LaundryDeviceConfig => entry != null);
  }

  private normalizeDevice(entry: unknown): LaundryDeviceConfig | null {
    if (!entry || typeof entry !== 'object') {
      return null;
    }
    const item = entry as Record<string, unknown>;
    const identifier = String(item.identifier ?? '').trim();
    if (!identifier) {
      this.log.error('Each laundry device needs an identifier (Switcher id, IP, or name)');
      return null;
    }
    const name = String(item.name ?? identifier).trim() || identifier;
    // Accept common aliases in case config was edited by hand.
    const deviceId = String(item.deviceId ?? item.device_id ?? item.id ?? '').trim() || undefined;
    const deviceIp = String(item.deviceIp ?? item.device_ip ?? item.ip ?? '').trim() || undefined;
    const deviceKey = String(item.deviceKey ?? item.device_key ?? item.key ?? '00').trim() || '00';
    return {
      name,
      identifier,
      deviceId,
      deviceIp,
      deviceKey,
      startWatts: positiveNumber(item.startWatts, DEFAULT_START_WATTS),
      stopWatts: positiveNumber(item.stopWatts, DEFAULT_STOP_WATTS),
      startSeconds: positiveNumber(item.startSeconds, DEFAULT_START_SECONDS),
      stopSeconds: positiveNumber(item.stopSeconds, DEFAULT_STOP_SECONDS),
    };
  }
}

function positiveNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}
