import { EventEmitter } from 'node:events';

// switcher-js2 ships as CommonJS without TypeScript types.
const Switcher = require('switcher-js2') as SwitcherModule;

interface SwitcherModule {
  listen: (log: (message: string) => void, identifier?: string) => SwitcherListener;
  new (
    deviceId: string,
    deviceIp: string,
    log: (message: string) => void,
    listen: boolean,
    deviceType?: string,
    remote?: unknown,
    token?: string,
  ): SwitcherDevice;
}

interface SwitcherDevice {
  status: () => Promise<{
    power?: number | string;
    power_consumption?: number;
  }>;
  close?: () => void;
}

export interface PowerSample {
  deviceId: string;
  deviceIp: string;
  name: string;
  watts: number;
  on: boolean;
}

export interface PowerSource {
  start(): void;
  stop(): void;
  on(event: 'power', listener: (sample: PowerSample) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  off(event: 'power', listener: (sample: PowerSample) => void): this;
  off(event: 'error', listener: (error: Error) => void): this;
}

export interface SwitcherPowerOptions {
  identifier: string;
  deviceId?: string;
  deviceIp?: string;
  token?: string;
  pollSeconds?: number;
  log?: (message: string) => void;
}

interface SwitcherListener {
  on(event: 'message', listener: (message: SwitcherMessage) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  close(): Promise<void> | void;
}

interface SwitcherMessage {
  device_id: string;
  device_ip: string;
  name: string;
  type?: string;
  state?: {
    power?: number;
    power_consumption?: number;
  };
}

/**
 * Prefers UDP broadcasts; if the Switcher UDP port is already taken
 * (e.g. by homebridge-switcher-platform), falls back to TCP status polling.
 */
export class SwitcherPowerSource extends EventEmitter implements PowerSource {
  private listener?: SwitcherListener;
  private pollTimer?: ReturnType<typeof setInterval>;
  private device?: SwitcherDevice;
  private started = false;
  private readonly log: (message: string) => void;
  private readonly pollSeconds: number;
  private resolvedId?: string;
  private resolvedIp?: string;

  constructor(private readonly options: SwitcherPowerOptions) {
    super();
    this.log = options.log || (() => undefined);
    this.pollSeconds = Math.max(5, options.pollSeconds || 10);
    this.resolvedId = options.deviceId || (isDeviceId(options.identifier) ? options.identifier : undefined);
    this.resolvedIp = options.deviceIp || (isIpAddress(options.identifier) ? options.identifier : undefined);
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    try {
      this.listener = Switcher.listen((message) => this.log(message), this.options.identifier);
      this.listener.on('error', (error) => {
        this.log(`UDP listen failed (${error.message}); trying TCP poll fallback`);
        void this.closeListener().then(() => this.startTcpPoll());
      });
      this.listener.on('message', (message) => {
        this.resolvedId = message.device_id;
        this.resolvedIp = message.device_ip;
        this.handleWatts(
          Number(message.state?.power_consumption),
          message.device_id,
          message.device_ip,
          message.name,
          Number(message.state?.power) === 1,
        );
      });
    } catch (error) {
      this.log(`UDP listen threw (${error instanceof Error ? error.message : String(error)}); trying TCP poll`);
      this.startTcpPoll();
    }
  }

  stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    try {
      this.device?.close?.();
    } catch {
      // ignore
    }
    this.device = undefined;
    void this.closeListener();
  }

  private async closeListener(): Promise<void> {
    const closing = this.listener?.close();
    this.listener = undefined;
    if (closing && typeof (closing as Promise<void>).then === 'function') {
      try {
        await closing;
      } catch {
        // ignore
      }
    }
  }

  private startTcpPoll(): void {
    if (this.pollTimer || !this.started) {
      return;
    }
    if (!this.resolvedId || !this.resolvedIp) {
      const error = new Error(
        'UDP port busy (often homebridge-switcher-platform). Set deviceId (and deviceIp if needed) in the laundry device config to poll over TCP.',
      );
      this.emit('error', error);
      return;
    }

    this.log(`Polling Switcher ${this.resolvedId} at ${this.resolvedIp} every ${this.pollSeconds}s over TCP`);
    this.device = new Switcher(
      this.resolvedId,
      this.resolvedIp,
      (message) => this.log(message),
      false,
      'power_plug',
      undefined,
      this.options.token,
    );

    const tick = () => {
      void this.device?.status()
        .then((status) => {
          this.handleWatts(
            Number(status.power_consumption),
            this.resolvedId || this.options.identifier,
            this.resolvedIp || '0.0.0.0',
            this.options.identifier,
            Number(status.power) === 1 || status.power === 'ON',
          );
        })
        .catch((error: unknown) => {
          this.emit('error', error instanceof Error ? error : new Error(String(error)));
        });
    };

    tick();
    this.pollTimer = setInterval(tick, this.pollSeconds * 1000);
  }

  private handleWatts(
    watts: number,
    deviceId: string,
    deviceIp: string,
    name: string,
    on: boolean,
  ): void {
    if (!Number.isFinite(watts)) {
      return;
    }
    this.emit('power', {
      deviceId,
      deviceIp,
      name,
      watts,
      on,
    } satisfies PowerSample);
  }
}

/** Test double that feeds watt samples into the same PowerSource contract. */
export class FakePowerSource extends EventEmitter implements PowerSource {
  start(): void {
    // No network work in tests.
  }

  stop(): void {
    this.removeAllListeners();
  }

  push(watts: number, extras: Partial<PowerSample> = {}): void {
    this.emit('power', {
      deviceId: extras.deviceId ?? 'test',
      deviceIp: extras.deviceIp ?? '127.0.0.1',
      name: extras.name ?? 'Test Plug',
      watts,
      on: extras.on ?? true,
    } satisfies PowerSample);
  }
}

function isIpAddress(value: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value);
}

function isDeviceId(value: string): boolean {
  return /^[a-f0-9]{6,}$/i.test(value);
}
