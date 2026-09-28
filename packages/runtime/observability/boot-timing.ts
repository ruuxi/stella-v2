import { performance } from "node:perf_hooks";
import type { AppPerformanceTelemetry } from "@stella/contracts/telemetry";

/**
 * Worker boot timeline: monotonic (`performance.now()`) marks for the
 * `internal.worker.initialize` → runner-ready journey — the untimed stretch
 * between `worker.listening` and a usable runtime. One timeline per
 * initialize that builds a fresh session; it is finished exactly once and
 * reported as ONE `worker.ready.timing` process-log event plus the
 * `app.performance` `worker-ready` telemetry metric.
 *
 * Steps are recorded by name as they complete and flattened into log fields
 * as `<step>Ms`. Steps recorded from modules that cannot see the timeline
 * (SQLite migration, runner initialization phases) go through the
 * process-wide active timeline via `recordBootStep` / `recordBootField`,
 * which are no-ops outside a boot.
 */

export type BootOutcome = "success" | "failure" | "canceled";

export type BootTimingValue = number | string | boolean;

/** Flat, log-ready fields of one finished boot. */
export type WorkerReadyTiming = {
  readonly outcome: BootOutcome;
  /** initialize received → runner initialized (or failure). */
  readonly totalMs: number;
  /** Worker process uptime when initialize arrived (launch → initialize). */
  readonly uptimeAtInitializeMs: number;
  /** Longest event-loop gap the boot probe observed (sync stalls). */
  readonly maxEventLoopStallMs: number;
} & Readonly<Record<string, BootTimingValue>>;

const round = (ms: number): number => Math.round(ms * 10) / 10;

export class BootTimeline {
  private readonly startedAt: number;
  private readonly uptimeAtStartMs: number;
  private readonly steps = new Map<string, number>();
  private readonly fields = new Map<string, BootTimingValue>();
  private maxStallMs = 0;
  private finished = false;

  constructor(
    private readonly now: () => number = () => performance.now(),
    uptimeMs: () => number = () => process.uptime() * 1000,
  ) {
    this.startedAt = now();
    this.uptimeAtStartMs = uptimeMs();
  }

  /** Milliseconds since initialize was received. */
  elapsed(): number {
    return this.now() - this.startedAt;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  /** Add `ms` to step `name` (repeated steps accumulate). */
  step(name: string, ms: number): void {
    if (this.finished || !Number.isFinite(ms)) return;
    this.steps.set(name, (this.steps.get(name) ?? 0) + Math.max(0, ms));
  }

  /** Record the elapsed time since initialize under `name` (a milestone). */
  mark(name: string): void {
    if (this.finished) return;
    this.fields.set(`${name}AtMs`, round(this.elapsed()));
  }

  set(name: string, value: BootTimingValue): void {
    if (this.finished) return;
    this.fields.set(name, value);
  }

  /** Time a synchronous step; the step is recorded even if `fn` throws. */
  time<T>(name: string, fn: () => T): T {
    const startedAt = this.now();
    try {
      return fn();
    } finally {
      this.step(name, this.now() - startedAt);
    }
  }

  /** Time an async step; the step is recorded on settle either way. */
  async timeAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const startedAt = this.now();
    try {
      return await fn();
    } finally {
      this.step(name, this.now() - startedAt);
    }
  }

  noteEventLoopStall(ms: number): void {
    if (ms > this.maxStallMs) this.maxStallMs = ms;
  }

  /**
   * Freeze the timeline and return its flat event, or null when it was
   * already finished (a boot reports once).
   */
  finish(outcome: BootOutcome): WorkerReadyTiming | null {
    if (this.finished) return null;
    const totalMs = round(this.elapsed());
    this.finished = true;
    const out: Record<string, BootTimingValue> = {
      outcome,
      totalMs,
      uptimeAtInitializeMs: round(this.uptimeAtStartMs),
      maxEventLoopStallMs: round(this.maxStallMs),
    };
    for (const [name, ms] of this.steps) out[`${name}Ms`] = round(ms);
    for (const [name, value] of this.fields) out[name] = value;
    return out as WorkerReadyTiming;
  }
}

/** The `app.performance` `worker-ready` metric for one finished boot. */
export const workerReadyTelemetry = (
  timing: WorkerReadyTiming,
): AppPerformanceTelemetry => ({
  type: "app.performance",
  component: "runtime-worker",
  metric: "worker-ready",
  durationMs: Math.max(0, Math.round(timing.totalMs)),
  outcome: timing.outcome,
});

let activeTimeline: BootTimeline | null = null;

/** Install (or clear) the timeline that module-level recorders write to. */
export const setActiveBootTimeline = (timeline: BootTimeline | null): void => {
  activeTimeline = timeline;
};

export const getActiveBootTimeline = (): BootTimeline | null =>
  activeTimeline && !activeTimeline.isFinished ? activeTimeline : null;

/** Record a step on the active boot, if any. */
export const recordBootStep = (name: string, ms: number): void => {
  getActiveBootTimeline()?.step(name, ms);
};

/** Record a field on the active boot, if any. */
export const recordBootField = (name: string, value: BootTimingValue): void => {
  getActiveBootTimeline()?.set(name, value);
};
