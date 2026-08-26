import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../scripts/cloud-canonical-acceptance.mjs", import.meta.url),
);

const stepIds = [
  "electron_real_stream",
  "electron_restart_reconnect",
  "clean_client_hydration",
  "cache_loss_recovery",
  "projection_and_r2",
  "cancellation",
  "cloud_failure_no_local_fallback",
  "desktop_local_routing",
  "mobile_reachable_computer_routing",
  "mobile_unreachable_cloud_routing",
  "browser_cloud_routing",
  "child_completion",
  "cleanup",
];

const makeManifest = (root) => ({
  version: 1,
  target: {
    convexDeployment: "dev:impartial-crab-34",
    convexUrl: "https://impartial-crab-34.convex.cloud",
    convexSiteUrl: "https://impartial-crab-34.convex.site",
    cloudBuilderUrl: "https://stella-v2-cloud-builder-dev.lolruuxi.workers.dev",
  },
  isolatedRoots: [root],
  output: path.join(root, "report.json"),
  steps: stepIds.map((id) => ({
    id,
    driverFile: path.join(root, "real-driver.mjs"),
    command: ["node", path.join(root, "real-driver.mjs"), id],
    cwd: root,
    evidenceFile: path.join(root, `${id}.json`),
    timeoutMs: 5_000,
  })),
});

const checkManifest = async (manifest) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "stella-cloud-acceptance-"),
  );
  const manifestPath = path.join(directory, "manifest.json");
  await writeFile(
    path.join(directory, "real-driver.mjs"),
    "// Structural-check fixture; --check never executes this file.\n",
    "utf8",
  );
  await writeFile(manifestPath, JSON.stringify(manifest(directory)), "utf8");
  return Bun.spawnSync([process.execPath, script, "--check", manifestPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
};

describe("cloud canonical acceptance manifest", () => {
  test("accepts a complete isolated manifest for the pinned dev target", async () => {
    const result = await checkManifest(makeManifest);
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(
      "structurally valid for dev:impartial-crab-34",
    );
  });

  test("rejects a manifest without a disposable root", async () => {
    const result = await checkManifest((root) => ({
      ...makeManifest(root),
      isolatedRoots: [],
    }));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "manifest.isolatedRoots must name at least one disposable harness root",
    );
  });

  test("rejects the historical staging deployment before execution", async () => {
    const result = await checkManifest((root) => ({
      ...makeManifest(root),
      target: {
        ...makeManifest(root).target,
        convexDeployment: "dev:flexible-panther-999",
      },
    }));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "forbidden historical or production target",
    );
  });

  test("rejects an arbitrary shell command in place of an audited driver", async () => {
    const result = await checkManifest((root) => {
      const manifest = makeManifest(root);
      manifest.steps[0].command[0] = "sh";
      return manifest;
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "must invoke an explicit node or bun acceptance driver",
    );
  });
});
