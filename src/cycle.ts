export type CyclePhase = 'idle' | 'running' | 'done';

export interface CycleThresholds {
  startWatts: number;
  stopWatts: number;
  startSeconds: number;
  stopSeconds: number;
}

export interface CycleSnapshot {
  phase: CyclePhase;
  watts: number;
  running: boolean;
  done: boolean;
  changed: boolean;
}

/**
 * Tracks a laundry cycle from Switcher plug wattage.
 * A cycle starts after sustained high power, and finishes only after
 * sustained low power that is longer than normal fill/rinse pauses.
 */
export class LaundryCycleDetector {
  private phase: CyclePhase = 'idle';
  private highSince: number | null = null;
  private lowSince: number | null = null;

  constructor(private readonly thresholds: CycleThresholds) {}

  getPhase(): CyclePhase {
    return this.phase;
  }

  update(watts: number, now = Date.now()): CycleSnapshot {
    const previous = this.phase;
    const startMs = this.thresholds.startSeconds * 1000;
    const stopMs = this.thresholds.stopSeconds * 1000;

    if (watts >= this.thresholds.startWatts) {
      this.lowSince = null;
      if (this.highSince == null) {
        this.highSince = now;
      }
      if (this.phase !== 'running' && now - this.highSince >= startMs) {
        this.phase = 'running';
      }
    } else if (watts <= this.thresholds.stopWatts) {
      this.highSince = null;
      if (this.phase === 'running') {
        if (this.lowSince == null) {
          this.lowSince = now;
        }
        if (now - this.lowSince >= stopMs) {
          this.phase = 'done';
          this.lowSince = null;
        }
      } else if (this.phase === 'idle') {
        this.lowSince = null;
      }
    } else {
      // Between thresholds: treat as inconclusive noise.
      this.highSince = null;
      this.lowSince = null;
    }

    return {
      phase: this.phase,
      watts,
      running: this.phase === 'running',
      done: this.phase === 'done',
      changed: previous !== this.phase,
    };
  }

  /** Clears a finished cycle without waiting for the next start. */
  acknowledge(): CycleSnapshot {
    const previous = this.phase;
    if (this.phase === 'done') {
      this.phase = 'idle';
      this.highSince = null;
      this.lowSince = null;
    }
    return {
      phase: this.phase,
      watts: 0,
      running: false,
      done: false,
      changed: previous !== this.phase,
    };
  }
}
