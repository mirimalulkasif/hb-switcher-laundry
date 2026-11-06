import { EventEmitter } from 'node:events';

// switcher-js2 ships as CommonJS without TypeScript types.
const Switcher = require('switcher-js2') as {
  listen: (log: (message: string) => void, identifier?: string) => SwitcherListener;
};

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

interface SwitcherListener {
  on(event: 'message', listener: (message: SwitcherMessage) => void): void;
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
 * Listens for Switcher UDP status broadcasts and emits watt samples.
 * Power Plug devices advertise consumption without a TCP poll.
 */
export class SwitcherBroadcastPowerSource extends EventEmitter implements PowerSource {
  private listener?: SwitcherListener;
  private started = false;

  constructor(
    private readonly identifier: string,
    private readonly log: (message: string) => void = () => undefined,
  ) {
    super();
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.listener = Switcher.listen((message) => this.log(message), this.identifier);
    this.listener.on('message', (message) => this.handleMessage(message));
  }

  stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    const closing = this.listener?.close();
    this.listener = undefined;
    if (closing && typeof (closing as Promise<void>).then === 'function') {
      void (closing as Promise<void>).catch((error: unknown) => {
        this.emit('error', error instanceof Error ? error : new Error(String(error)));
      });
    }
  }

  private handleMessage(message: SwitcherMessage): void {
    const watts = Number(message.state?.power_consumption);
    if (!Number.isFinite(watts)) {
      return;
    }
    this.emit('power', {
      deviceId: message.device_id,
      deviceIp: message.device_ip,
      name: message.name,
      watts,
      on: Number(message.state?.power) === 1,
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
