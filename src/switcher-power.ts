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
  debugLog?: (message: string) => void;
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

type HubSubscriber = {
  match: (message: SwitcherMessage) => boolean;
  onMessage: (message: SwitcherMessage) => void;
  onUdpFailed: (error: Error) => void;
};

/**
 * One UDP bind for the whole plugin. Two laundry plugs cannot each call
 * Switcher.listen() — the second hits EADDRINUSE and never sees watts.
 */
class SwitcherUdpHub {
  private static shared?: SwitcherUdpHub;
  private listener?: SwitcherListener;
  private readonly subscribers = new Set<HubSubscriber>();
  private started = false;
  private failed = false;
  private failError?: Error;

  static get(): SwitcherUdpHub {
    if (!SwitcherUdpHub.shared) {
      SwitcherUdpHub.shared = new SwitcherUdpHub();
    }
    return SwitcherUdpHub.shared;
  }

  /** Test helper — reset between unit tests. */
  static resetForTests(): void {
    const hub = SwitcherUdpHub.shared;
    if (hub) {
      void hub.closeListener();
      hub.subscribers.clear();
      hub.started = false;
      hub.failed = false;
      hub.failError = undefined;
    }
    SwitcherUdpHub.shared = undefined;
  }

  subscribe(subscriber: HubSubscriber): void {
    this.subscribers.add(subscriber);
    if (this.failed && this.failError) {
      subscriber.onUdpFailed(this.failError);
      return;
    }
    this.ensureListening();
  }

  unsubscribe(subscriber: HubSubscriber): void {
    this.subscribers.delete(subscriber);
    if (this.subscribers.size === 0) {
      void this.closeListener();
      this.started = false;
    }
  }

  private ensureListening(): void {
    if (this.started || this.failed) {
      return;
    }
    this.started = true;
    try {
      this.listener = Switcher.listen(() => undefined);
      this.listener.on('error', (error) => {
        this.failed = true;
        this.failError = error;
        void this.closeListener().then(() => {
          for (const subscriber of [...this.subscribers]) {
            subscriber.onUdpFailed(error);
          }
        });
      });
      this.listener.on('message', (message) => {
        for (const subscriber of this.subscribers) {
          if (subscriber.match(message)) {
            subscriber.onMessage(message);
          }
        }
      });
    } catch (error) {
      this.failed = true;
      this.failError = error instanceof Error ? error : new Error(String(error));
      for (const subscriber of [...this.subscribers]) {
        subscriber.onUdpFailed(this.failError);
      }
    }
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
}

/**
 * Reads watts from the Switcher plug over the LAN.
 * With deviceId + IP: TCP-only (recommended next to homebridge-switcher-platform).
 * Without: shared UDP listen only.
 */
export class SwitcherPowerSource extends EventEmitter implements PowerSource {
  private pollTimer?: ReturnType<typeof setInterval>;
  private device?: SwitcherDevice;
  private started = false;
  private readonly log: (message: string) => void;
  private readonly debugLog: (message: string) => void;
  private readonly pollSeconds: number;
  private resolvedId?: string;
  private resolvedIp?: string;
  private hubSubscriber?: HubSubscriber;
  private usingTcp = false;
  private loggedBadStatus = false;

  constructor(private readonly options: SwitcherPowerOptions) {
    super();
    this.log = options.log || (() => undefined);
    this.debugLog = options.debugLog || this.log;
    this.pollSeconds = Math.max(5, options.pollSeconds || 10);
    this.resolvedId = options.deviceId || (isDeviceId(options.identifier) ? options.identifier : undefined);
    this.resolvedIp = options.deviceIp || (isIpAddress(options.identifier) ? options.identifier : undefined);
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    if (this.resolvedId && this.resolvedIp) {
      this.log(
        `TCP mode for "${this.options.identifier}" → id=${this.resolvedId} ip=${this.resolvedIp} every ${this.pollSeconds}s`,
      );
      this.startTcpPoll();
      return;
    }

    this.log(
      `UDP mode for "${this.options.identifier}" (deviceId/deviceIp missing — set both for reliable TCP next to Switcher Platform)`,
    );

    this.hubSubscriber = {
      match: (message) => this.matchesMessage(message),
      onMessage: (message) => {
        this.resolvedId = message.device_id;
        this.resolvedIp = message.device_ip;
        this.handleWatts(
          Number(message.state?.power_consumption),
          message.device_id,
          message.device_ip,
          message.name,
          Number(message.state?.power) === 1,
        );
      },
      onUdpFailed: (error) => {
        this.log(`UDP listen failed (${error.message}); cannot poll TCP without deviceId+deviceIp`);
        this.emit(
          'error',
          new Error(
            `UDP busy and deviceId/deviceIp not set for "${this.options.identifier}". Add both from Switcher Platform logs.`,
          ),
        );
      },
    };
    SwitcherUdpHub.get().subscribe(this.hubSubscriber);
  }

  private matchesMessage(message: SwitcherMessage): boolean {
    if (matchesIdentifier(this.options.identifier, message)) {
      return true;
    }
    const id = this.options.deviceId?.trim().toLowerCase();
    if (id && message.device_id.toLowerCase() === id) {
      return true;
    }
    const ip = this.options.deviceIp?.trim();
    if (ip && message.device_ip === ip) {
      return true;
    }
    return false;
  }

  stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    if (this.hubSubscriber) {
      SwitcherUdpHub.get().unsubscribe(this.hubSubscriber);
      this.hubSubscriber = undefined;
    }
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
  }

  private startTcpPoll(): void {
    if (this.pollTimer || this.usingTcp || !this.started) {
      return;
    }
    if (!this.resolvedId || !this.resolvedIp) {
      this.emit(
        'error',
        new Error(
          `Cannot TCP-poll "${this.options.identifier}" — need deviceId and deviceIp`,
        ),
      );
      return;
    }

    this.usingTcp = true;
    this.device = new Switcher(
      this.resolvedId,
      this.resolvedIp,
      (message) => this.debugLog(message),
      false,
      'power_plug',
      undefined,
      this.options.token,
    );

    const tick = () => {
      void this.device?.status()
        .then((status) => {
          const watts = Number(status.power_consumption);
          if (!Number.isFinite(watts)) {
            if (!this.loggedBadStatus) {
              this.loggedBadStatus = true;
              this.log(`TCP status missing watts: ${JSON.stringify(status)}`);
            }
            return;
          }
          this.handleWatts(
            watts,
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

export function matchesIdentifier(identifier: string, message: SwitcherMessage): boolean {
  const needle = identifier.trim().toLowerCase();
  if (!needle) {
    return false;
  }
  return (
    message.device_id.toLowerCase() === needle
    || message.name.toLowerCase() === needle
    || message.device_ip === identifier.trim()
  );
}

export { SwitcherUdpHub };

function isIpAddress(value: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value);
}

function isDeviceId(value: string): boolean {
  return /^[a-f0-9]{6,}$/i.test(value);
}
