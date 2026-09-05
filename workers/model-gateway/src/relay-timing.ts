/** Monotonic, request-local durations. No prompt, token, URL or credential fields. */
export class RelayTiming {
  private readonly started: number;
  private readonly startedAt = Date.now();
  private readonly milestones: Record<string, number> = {};
  private readonly durations: Record<string, number> = {};

  constructor(private readonly now: () => number = () => performance.now()) {
    this.started = now();
  }

  mark(
    name:
      | "authenticated"
      | "providerDispatch"
      | "providerDispatchReady"
      | "upstreamHeaders"
      | "firstUpstreamByte"
      | "upstreamBodyComplete"
      | "assemblyComplete"
      | "resultPersisted",
  ): void {
    this.milestones[name] ??= this.now() - this.started;
  }

  async measure<T>(name: string, work: () => T): Promise<Awaited<T>> {
    const start = this.now();
    try {
      return await work();
    } finally {
      this.durations[name] = (this.durations[name] ?? 0) + this.now() - start;
    }
  }

  snapshot() {
    return {
      startedAt: this.startedAt,
      elapsedMs: this.now() - this.started,
      milestonesMs: { ...this.milestones },
      durationsMs: { ...this.durations },
    };
  }
}
