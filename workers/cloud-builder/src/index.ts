// @peculiar/x509 2.x (App Attest) runs tsyringe, which needs a Reflect polyfill
// loaded before its lazily imported chunk evaluates.
import "reflect-metadata";
import { DurableObject } from "cloudflare:workers";
import { worker } from "./build-session/worker-router.js";
import type { Env } from "./build-session/shared/env.js";
import { OrchestratorSession } from "./orchestrator-session.js";
import { OwnerGate } from "./owner-gate.js";
import { inSubshell } from "./shell-subshell.js";
export { OrchestratorSession };
export { OwnerGate };
export { BillingControl } from "./billing/control.js";
export { WorldStore } from "./world-store.js";
export { WorldShellFs } from "./world-shell-fs.js";

/**
 * Every sandbox, of either size and either workload, is one object in this
 * namespace; it starts its container through `ctx.container`.
 */
export { Sandbox, SandboxEgress } from "./sandbox-container.js";

/**
 * Run a strict (`set -eu`) script scoped to a subshell. The subshell's exit
 * status is the script's.
 * Defined in `shell-subshell.ts` so the checkpoint archive scripts share it
 * without importing this module.
 */
export { inSubshell };
export class BuildSession extends DurableObject<Env> {
  private implementation?: Promise<
    import("./build-session/object.js").BuildSessionObject
  >;

  private loadImplementation(): Promise<
    import("./build-session/object.js").BuildSessionObject
  > {
    if (!this.implementation) {
      this.implementation = import("./build-session/object.js")
        .then(
          ({ BuildSessionObject }) =>
            new BuildSessionObject(this.ctx, this.env),
        )
        .catch((error: unknown) => {
          this.implementation = undefined;
          throw error;
        });
    }
    return this.implementation;
  }

  async fetch(request: Request): Promise<Response> {
    return (await this.loadImplementation()).fetch(request);
  }

  async alarm(): Promise<void> {
    await (await this.loadImplementation()).alarm();
  }
}

export default worker;
