/**
 * Stella's own code in a sandbox container.
 *
 * The sandbox image holds only the OS, tools and third-party packages, so it
 * changes only with the Dockerfile or `sandbox-image.bun.lock`, and a deploy of
 * Stella source keeps every owner's container snapshot (a snapshot restores
 * only onto the image it was taken from). The executor's sources ship as a
 * content-addressed bundle instead: `scripts/sandbox-code.mjs` packs it at
 * build time into this Worker version's static assets and compiles its
 * SHA-256 in here.
 *
 * When an agent container starts, fresh or from a snapshot, the Sandbox object
 * runs the image's `stella-code-install` with that hash and an intercepted
 * plain-HTTP URL served from this version's assets (`SandboxCode`). The
 * container refuses bytes that hash to anything else, extracts them root-owned
 * under `/run/stella-code/<sha256>`, and points `current` at them. Every
 * executor process then starts through `stella-executor`, which runs
 * `current`.
 *
 * Version rule: a container runs the bundle it installed when it started. A
 * deploy reaches a running container at its next start (agent containers stop
 * when their turn releases them), so a turn in progress finishes on the code it
 * began with.
 */

declare const __STELLA_SANDBOX_CODE__:
  | Readonly<{ sha256: string; bytes: number }>
  | undefined;

export type SandboxCodeBundle = Readonly<{ sha256: string; bytes: number }>;

/** Plain-HTTP host the container fetches the bundle from; the DO intercepts it. */
export const SANDBOX_CODE_HOST = "code.stella.internal";

/** The bundle's path inside this Worker's static assets. */
export const sandboxCodeAssetPath = (sha256: string): string =>
  `/sandbox-code/${sha256}.tar.gz`;

/** Image scripts (`workers/cloud-builder/sandbox-bin`). */
export const SANDBOX_CODE_INSTALL = "/opt/stella/bin/stella-code-install";
export const SANDBOX_EXECUTOR = "/opt/stella/bin/stella-executor";

/** Where installed bundles live in the container. */
export const SANDBOX_CODE_ROOT = "/run/stella-code";

const SHA256 = /^[0-9a-f]{64}$/u;

/** The bundle this Worker version was built with. */
export const sandboxCode = (): SandboxCodeBundle => {
  const bundle =
    typeof __STELLA_SANDBOX_CODE__ === "undefined"
      ? undefined
      : __STELLA_SANDBOX_CODE__;
  if (!bundle || !SHA256.test(bundle.sha256)) {
    throw new Error(
      "This Worker was built without a sandbox code bundle (scripts/build-worker.mjs).",
    );
  }
  return bundle;
};

export const sandboxCodeUrl = (sha256: string): string =>
  `http://${SANDBOX_CODE_HOST}/${sha256}.tar.gz`;

export type SandboxCodeInstall = Readonly<{
  sha256: string;
  /** "fetched" over the intercept, or "cached": a verified tarball already on disk. */
  source: "fetched" | "cached";
  bytes: number;
  fetchMs: number;
  installMs: number;
}>;

/** The one JSON line `stella-code-install` prints on success. */
export const parseSandboxCodeInstall = (
  stdout: string,
  sha256: string,
): SandboxCodeInstall | null => {
  const line = stdout.trim().split("\n").at(-1);
  if (!line) return null;
  try {
    const value = JSON.parse(line) as Partial<SandboxCodeInstall>;
    if (
      value.sha256 !== sha256 ||
      (value.source !== "fetched" && value.source !== "cached") ||
      typeof value.bytes !== "number" ||
      typeof value.fetchMs !== "number" ||
      typeof value.installMs !== "number"
    ) {
      return null;
    }
    return value as SandboxCodeInstall;
  } catch {
    return null;
  }
};
