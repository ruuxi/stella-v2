/**
 * Run-owned resource registration seam (M5 surface 3, phase 2).
 *
 * A `RunResource` is any unit of work whose lifetime must be bounded by its
 * owning run: provider streams, tool calls, external engine processes.
 * Registrars are wired from the runner (`orchestrator-launch.ts`,
 * `agent-orchestration.ts`) to the kernel run supervisor, whose per-run
 * `SupervisedScope` forks one Effect fiber per resource: interrupting the
 * run's scope fires each resource's cooperative `abort` and joins its
 * `settled` teardown before cancellation resolves.
 *
 * Only promise/data shapes cross this seam; Effect stays inside
 * `shared/supervised-scope.ts`.
 */

export type RunResource = {
  /** Verbatim child-fiber label (`provider-stream:<runId>:<n>`, `tool:<...>`). */
  label: string;
  /** Cooperative cancel. Idempotent; fired on fiber interruption. */
  abort: (reason?: unknown) => void;
  /** Settles only once the resource's own teardown has completed. */
  settled: Promise<unknown>;
};

export type RunResourceRegistrar = (resource: RunResource) => void;
