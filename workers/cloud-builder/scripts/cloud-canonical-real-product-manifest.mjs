#!/usr/bin/env node

/**
 * Creates a fresh manifest and directory layout for the reviewed real-product
 * cloud-canonical acceptance driver. This command only writes local harness
 * scaffolding. It never launches Stella, contacts a cloud target, or loads
 * credentials.
 *
 * Usage:
 *   node cloud-canonical-real-product-manifest.mjs \
 *     --root /absolute/existing/disposable/root \
 *     [--manifest /absolute/path/inside/root.json]
 */

import { realpathSync, statSync } from "node:fs";
import { lstat, mkdir, open, rmdir, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CloudProofError,
  FORBIDDEN_TARGET_PATTERN,
  REQUIRED_CLOUD_BUILDER_ORIGIN,
  REQUIRED_CONVEX,
  assert,
} from "./cloud-proof-lib.mjs";
import { ACCEPTANCE_DRIVER_CONTRACT } from "./cloud-canonical-acceptance-driver-contract.mjs";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = realpathSync(
  path.resolve(path.dirname(SCRIPT_FILE), "../../.."),
);
const USER_HOME = realpathSync(homedir());
const DECLARED_LIVE_STELLA_ROOT = path.join(USER_HOME, ".stella");
let LIVE_STELLA_ROOT;
try {
  LIVE_STELLA_ROOT = realpathSync(DECLARED_LIVE_STELLA_ROOT);
} catch {
  LIVE_STELLA_ROOT = DECLARED_LIVE_STELLA_ROOT;
}
const DRIVER_DECLARED_PATH = path.join(
  REPO_ROOT,
  "workers/cloud-builder/scripts/cloud-canonical-real-product-driver.mjs",
);

export const REAL_PRODUCT_STEP_IDS = Object.freeze([
  "primary_auth_handoff",
  "deployment_identity",
  "local_runtime_lifecycle",
  "electron_real_stream",
  "consecutive_durable_turns",
  "duplicate_delivery_idempotency",
  "electron_restart_reconnect",
  "clean_client_hydration",
  "cache_loss_recovery",
  "projection_and_r2",
  "cancellation",
  "cloud_failure_no_local_fallback",
  "desktop_local_routing",
  "mobile_reachable_computer_routing",
  "mobile_unreachable_cloud_routing",
  "mobile_signed_in_canonical_sync",
  "browser_cloud_routing",
  "child_completion",
  "memory_restart_recall",
  "cloud_skill_discovery_use",
  "code_mode_real_mcp",
  "general_agent_real_sandbox",
  "owner_reset_memory_reimport",
  "apps_host_workerd_runtime",
  "cleanup",
]);

export const REAL_PRODUCT_TARGET = Object.freeze({
  convexDeployment: REQUIRED_CONVEX.deployment,
  convexUrl: REQUIRED_CONVEX.cloudUrl,
  convexSiteUrl: REQUIRED_CONVEX.siteUrl,
  cloudBuilderUrl: REQUIRED_CLOUD_BUILDER_ORIGIN,
});

export const HARNESS_SUBDIRECTORIES = Object.freeze([
  "evidence",
  "raw",
  "state",
  "profile",
]);

export const REAL_PRODUCT_HUMAN_ACTION = Object.freeze({
  primary_auth_handoff: "external-inbox-primary-login",
  browser_cloud_routing: "external-inbox-storage-recovery-login",
});

const STEP_TIMEOUT_MS = Object.freeze({
  primary_auth_handoff: 300_000,
  deployment_identity: 300_000,
  local_runtime_lifecycle: 1_200_000,
  electron_real_stream: 1_200_000,
  consecutive_durable_turns: 900_000,
  duplicate_delivery_idempotency: 300_000,
  electron_restart_reconnect: 600_000,
  clean_client_hydration: 600_000,
  cache_loss_recovery: 600_000,
  projection_and_r2: 900_000,
  cancellation: 600_000,
  cloud_failure_no_local_fallback: 600_000,
  desktop_local_routing: 600_000,
  mobile_reachable_computer_routing: 600_000,
  mobile_unreachable_cloud_routing: 600_000,
  mobile_signed_in_canonical_sync: 3_600_000,
  browser_cloud_routing: 1_800_000,
  child_completion: 900_000,
  memory_restart_recall: 1_200_000,
  cloud_skill_discovery_use: 1_200_000,
  code_mode_real_mcp: 1_200_000,
  general_agent_real_sandbox: 1_200_000,
  owner_reset_memory_reimport: 1_800_000,
  apps_host_workerd_runtime: 600_000,
  cleanup: 600_000,
});

const inside = (candidate, root) =>
  candidate === root || candidate.startsWith(`${root}${path.sep}`);

const overlaps = (left, right) => inside(left, right) || inside(right, left);

const pathDepth = (value) =>
  value.slice(path.parse(value).root.length).split(path.sep).filter(Boolean)
    .length;

const existingDirectory = (value, label) => {
  let resolved;
  try {
    resolved = realpathSync(value);
    assert(statSync(resolved).isDirectory(), `${label} must be a directory.`);
  } catch (error) {
    if (error instanceof CloudProofError) throw error;
    throw new CloudProofError(
      `${label} must be an existing directory: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return resolved;
};

const broadRoots = () => {
  const values = [
    path.parse(REPO_ROOT).root,
    path.dirname(USER_HOME),
    tmpdir(),
    "/tmp",
    "/private/tmp",
    "/var/tmp",
    "/Users",
    "/Volumes",
    "/Applications",
    "/Library",
    "/System",
    "/usr",
    "/var",
    "/opt",
    "/etc",
  ];
  return new Set(
    values.map((value) => {
      try {
        return realpathSync(value);
      } catch {
        return path.resolve(value);
      }
    }),
  );
};

const tempRoots = () => {
  const values = [tmpdir(), "/tmp", "/private/tmp", "/var/tmp"];
  return new Set(
    values.map((value) => {
      try {
        return realpathSync(value);
      } catch {
        return path.resolve(value);
      }
    }),
  );
};

export const resolveDisposableHarnessRoot = (rawRoot) => {
  assert(
    typeof rawRoot === "string" && rawRoot.trim() !== "",
    "--root is required.",
  );
  assert(path.isAbsolute(rawRoot), "--root must be an absolute path.");
  assert(
    !FORBIDDEN_TARGET_PATTERN.test(rawRoot),
    "--root contains a forbidden historical or production target.",
  );

  const root = existingDirectory(path.resolve(rawRoot), "--root");
  assert(
    !FORBIDDEN_TARGET_PATTERN.test(root),
    "--root resolves through a forbidden historical or production target.",
  );
  const broad = broadRoots();
  const nestedUnderTemp = [...tempRoots()].some(
    (tempRoot) => root !== tempRoot && inside(root, tempRoot),
  );

  assert(
    (pathDepth(root) >= 4 || nestedUnderTemp) && !broad.has(root),
    "--root must be a narrow disposable directory, not a broad filesystem path.",
  );
  assert(root !== USER_HOME, "--root must not be the user's home directory.");
  assert(
    !overlaps(root, REPO_ROOT),
    "--root must not be the integration worktree, contain it, or be inside it.",
  );
  assert(
    !overlaps(root, LIVE_STELLA_ROOT),
    "--root must not be live ~/.stella, contain it, or be inside it.",
  );
  return root;
};

const resolveFreshManifestPath = (rawManifest, root) => {
  const declared = rawManifest ?? path.join(root, "manifest.json");
  assert(
    typeof declared === "string" && declared.trim() !== "",
    "--manifest must name a file.",
  );
  assert(
    path.isAbsolute(declared),
    "--manifest must be an absolute path when provided.",
  );
  assert(declared.endsWith(".json"), "--manifest must name a .json file.");
  assert(
    !FORBIDDEN_TARGET_PATTERN.test(declared),
    "--manifest contains a forbidden historical or production target.",
  );

  const absolute = path.resolve(declared);
  const parent = existingDirectory(path.dirname(absolute), "--manifest parent");
  const manifest = path.join(parent, path.basename(absolute));
  assert(
    !FORBIDDEN_TARGET_PATTERN.test(manifest),
    "--manifest resolves through a forbidden historical or production target.",
  );
  assert(
    manifest !== root && inside(manifest, root),
    "--manifest must remain inside the disposable --root.",
  );
  return manifest;
};

const resolveReviewedDriver = () => {
  let driver;
  try {
    driver = realpathSync(DRIVER_DECLARED_PATH);
    assert(
      statSync(driver).isFile(),
      "The reviewed real-product driver must be a regular file.",
    );
  } catch (error) {
    if (error instanceof CloudProofError) throw error;
    throw new CloudProofError(
      `The reviewed real-product driver is missing: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  assert(
    driver === DRIVER_DECLARED_PATH && inside(driver, REPO_ROOT),
    "The real-product driver must be the reviewed in-tree file, not a symlink.",
  );
  return driver;
};

const pathExists = async (value) => {
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

const assertFreshPlannedPaths = async (paths) => {
  for (const [label, value] of paths) {
    assert(
      !(await pathExists(value)),
      `${label} already exists; refusing to overwrite it.`,
    );
  }
};

export const buildRealProductManifest = ({ root, driverFile }) => {
  const evidenceRoot = path.join(root, "evidence");
  return {
    version: 3,
    stepCount: REAL_PRODUCT_STEP_IDS.length,
    target: { ...REAL_PRODUCT_TARGET },
    isolatedRoots: [root],
    output: path.join(evidenceRoot, "report.json"),
    steps: REAL_PRODUCT_STEP_IDS.map((id) => ({
      id,
      humanAction: REAL_PRODUCT_HUMAN_ACTION[id] ?? "none",
      driverContract: ACCEPTANCE_DRIVER_CONTRACT,
      driverFile,
      command: ["node", driverFile, id],
      cwd: root,
      evidenceFile: path.join(evidenceRoot, `${id}.json`),
      timeoutMs: STEP_TIMEOUT_MS[id],
    })),
  };
};

export const parseManifestGeneratorArguments = (argv) => {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    assert(
      flag === "--root" || flag === "--manifest",
      "Use --root /absolute/existing/disposable/root [--manifest /absolute/path/inside/root.json].",
    );
    assert(value && !value.startsWith("--"), `${flag} requires a value.`);
    assert(!values.has(flag), `${flag} may be provided only once.`);
    values.set(flag, value);
  }
  assert(values.has("--root"), "--root is required.");
  return {
    root: values.get("--root"),
    manifest: values.get("--manifest"),
  };
};

export const generateRealProductManifest = async ({
  root: rawRoot,
  manifest: rawManifest,
}) => {
  const root = resolveDisposableHarnessRoot(rawRoot);
  const manifestPath = resolveFreshManifestPath(rawManifest, root);
  const driverFile = resolveReviewedDriver();
  const directories = HARNESS_SUBDIRECTORIES.map((name) =>
    path.join(root, name),
  );
  await assertFreshPlannedPaths([
    ["Manifest", manifestPath],
    ...directories.map((directory) => ["Harness directory", directory]),
  ]);

  const createdDirectories = [];
  let handle;
  let manifestCreated = false;
  try {
    for (const directory of directories) {
      await mkdir(directory, { mode: 0o700 });
      createdDirectories.push(directory);
    }
    handle = await open(manifestPath, "wx", 0o600);
    manifestCreated = true;
    const manifest = buildRealProductManifest({ root, driverFile });
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    return Object.freeze({ manifestPath, manifest });
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (manifestCreated) await unlink(manifestPath).catch(() => {});
    for (const directory of createdDirectories.reverse()) {
      await rmdir(directory).catch(() => {});
    }
    throw error;
  }
};

export const runManifestGeneratorCli = async (argv = process.argv.slice(2)) => {
  const options = parseManifestGeneratorArguments(argv);
  const generated = await generateRealProductManifest(options);
  console.log(`Created fresh acceptance manifest: ${generated.manifestPath}`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) {
  runManifestGeneratorCli().catch((error) => {
    console.error(
      `Cloud canonical manifest generation failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  });
}
