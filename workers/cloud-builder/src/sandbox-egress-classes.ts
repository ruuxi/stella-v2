import { ContainerProxy, Sandbox as SandboxBase } from "@cloudflare/sandbox";
import { appBuildEgress, generalAgentEgress } from "./sandbox-egress-policy.js";

export { ContainerProxy };

/**
 * General-agent sandboxes intentionally retain broad Internet access. HTTP(S)
 * is intercepted only to emit destination-level telemetry.
 */
export class GeneralAgentSandbox<Env = unknown> extends SandboxBase<Env> {
  enableInternet = true;
}

GeneralAgentSandbox.outbound = generalAgentEgress;

/**
 * App builds are permanently fail-closed at runtime. Their dependencies are
 * baked into the immutable container image, so the runtime never needs an
 * Internet-enabled installation phase. `allowedHosts = ["*"]` lets HTTP(S)
 * attempts reach the trusted deny handler for destination-only telemetry;
 * `enableInternet = false` still blocks all non-HTTP Internet traffic.
 *
 * A separate class is required because the stable Sandbox SDK fixes
 * `enableInternet` when the container starts; its runtime host-list
 * APIs cannot safely implement a broad-to-sealed transition.
 */
export class AppBuildSandbox<Env = unknown> extends SandboxBase<Env> {
  enableInternet = false;
  allowedHosts = ["*"];
}

AppBuildSandbox.outbound = appBuildEgress;
