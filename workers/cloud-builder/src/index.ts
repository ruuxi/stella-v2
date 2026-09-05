import { DurableObject } from "cloudflare:workers";
import { worker } from "./build-session/worker-router.js";
import type { Env } from "./build-session/shared/env.js";
import { OrchestratorSession } from "./orchestrator-session.js";
import { OwnerGate } from "./owner-gate.js";
import { OwnerTransferCoordinator } from "./owner-transfer-coordinator-do.js";
import {
  AppBuildSandbox as AppBuildSandboxBase,
  ContainerProxy,
  GeneralAgentSandbox,
} from "./sandbox-egress-classes.js";
import { appBuildEgress, generalAgentEgress } from "./sandbox-egress-policy.js";
import { inSubshell } from "./shell-subshell.js";
export type { ObservedBrowserSuspension } from "./build-session/shared/types.js";
export const purgeNativeStateForWorkspace = async (
  ...args: Parameters<
    typeof import("./build-session/owner-purge-transfer.js").purgeNativeStateForWorkspace
  >
): Promise<
  Awaited<
    ReturnType<
      typeof import("./build-session/owner-purge-transfer.js").purgeNativeStateForWorkspace
    >
  >
> =>
  await (
    await import("./build-session/owner-purge-transfer.js")
  ).purgeNativeStateForWorkspace(...args);

export const bindObservedBrowserSuspensionToCanonicalCodeCall = async (
  ...args: Parameters<
    typeof import("./build-session/shared/keys.js").bindObservedBrowserSuspensionToCanonicalCodeCall
  >
): Promise<
  Awaited<
    ReturnType<
      typeof import("./build-session/shared/keys.js").bindObservedBrowserSuspensionToCanonicalCodeCall
    >
  >
> =>
  await (
    await import("./build-session/shared/keys.js")
  ).bindObservedBrowserSuspensionToCanonicalCodeCall(...args);
export { parseAgentExecutorResult } from "./build-session/public-helpers.js";
export const waitForCloudAgentTurnResultText = async (
  ...args: Parameters<
    typeof import("./build-session/container-turn.js").waitForCloudAgentTurnResultText
  >
): Promise<
  Awaited<
    ReturnType<
      typeof import("./build-session/container-turn.js").waitForCloudAgentTurnResultText
    >
  >
> =>
  await (
    await import("./build-session/container-turn.js")
  ).waitForCloudAgentTurnResultText(...args);
export const normalizeToolWorkspaceRoot = async (
  ...args: Parameters<
    typeof import("./build-session/shared/keys.js").normalizeToolWorkspaceRoot
  >
): Promise<
  Awaited<
    ReturnType<
      typeof import("./build-session/shared/keys.js").normalizeToolWorkspaceRoot
    >
  >
> =>
  await (
    await import("./build-session/shared/keys.js")
  ).normalizeToolWorkspaceRoot(...args);

export { ContainerProxy };
export { OrchestratorSession };
export { OwnerTransferCoordinator };
export { OwnerGate };
export { WorldStore } from "./world-store.js";

/** Existing large general-agent namespace, retained migration-compatibly. */
export class Sandbox extends GeneralAgentSandbox<Env> {}
Sandbox.outbound = generalAgentEgress;

/**
 * The small rung of the instance ladder. Container size is declared per class
 * in wrangler.jsonc and cannot be chosen per request, so a second class over
 * the same image is the only way to run a cheap turn cheaply. Behaviorally
 * identical to `Sandbox`.
 */
export class SandboxSmall extends GeneralAgentSandbox<Env> {}
SandboxSmall.outbound = generalAgentEgress;

/** Permanently offline app-build namespace with baked dependencies. */
export class AppBuildSandbox extends AppBuildSandboxBase<Env> {}
AppBuildSandbox.outbound = appBuildEgress;

/**
 * Run a strict (`set -eu`) script without leaving those options behind in
 * the session's persistent shell. The subshell's exit status is the script's.
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
