import { mock } from "bun:test";

class WorkerEntrypoint<Env = unknown> {
  env!: Env;
}

class DurableObject<Env = unknown> {
  protected readonly ctx: DurableObjectState;
  protected readonly env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

mock.module("cloudflare:workers", () => ({ WorkerEntrypoint, DurableObject }));
