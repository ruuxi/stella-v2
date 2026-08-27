/**
 * Reviewed contract shared by real-product acceptance drivers.
 *
 * This module deliberately does not drive Stella, infer observations, or
 * provide a passing fixture. A reviewed driver must obtain its context from
 * the runner-injected environment, perform the real product work itself, and
 * explicitly attest to every non-mock property before this helper will write
 * its fresh evidence document.
 */

import { realpathSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  CloudProofError,
  assert,
  loadNonMutatingTarget,
  sha256,
  writeEvidence,
} from "./cloud-proof-lib.mjs";

export const ACCEPTANCE_DRIVER_CONTRACT = "stella-cloud-real-product-driver-v3";

const CONTEXT_BRAND = Symbol("stella-cloud-acceptance-driver-context");

export const REQUIRED_RAW_SURFACES = Object.freeze({
  primary_auth_handoff: [
    "electron-cdp",
    "browser-cdp",
    "git",
    "cloudflare",
    "convex",
    "worker",
  ],
  deployment_identity: ["git", "cloudflare", "convex", "worker"],
  local_runtime_lifecycle: ["local-runtime"],
  electron_real_stream: ["electron-cdp", "worker"],
  consecutive_durable_turns: ["electron-cdp", "worker"],
  duplicate_delivery_idempotency: ["convex", "worker"],
  electron_restart_reconnect: [
    "electron-process",
    "electron-cdp",
    "browser-cdp",
    "worker",
  ],
  clean_client_hydration: ["electron-cdp", "convex", "worker"],
  cache_loss_recovery: ["electron-cdp", "worker"],
  projection_and_r2: ["worker", "convex", "r2"],
  cancellation: ["electron-cdp", "worker"],
  cloud_failure_no_local_fallback: ["electron-cdp", "worker"],
  desktop_local_routing: ["local-runtime", "convex"],
  mobile_reachable_computer_routing: ["mobile-http", "local-runtime", "convex"],
  mobile_unreachable_cloud_routing: ["mobile-http", "convex", "sandbox"],
  mobile_signed_in_canonical_sync: [
    "electron-cdp",
    "mobile-client",
    "convex",
    "mobile-http",
    "worker",
  ],
  browser_cloud_routing: ["browser-cdp", "convex", "sandbox"],
  child_completion: ["worker", "sandbox"],
  memory_restart_recall: ["worker", "r2"],
  dream_rotation_memory_map: ["worker", "r2"],
  cloud_skill_discovery_use: ["worker", "r2"],
  code_mode_real_mcp: ["worker", "mcp"],
  general_agent_real_sandbox: ["worker", "sandbox"],
  owner_reset_memory_reimport: [
    "electron-cdp",
    "browser-cdp",
    "convex",
    "worker",
    "r2",
    "mcp",
  ],
  apps_host_workerd_runtime: ["apps-host-workerd"],
  cleanup: ["worker", "convex", "r2", "electron-process", "apps-host-workerd"],
});

const RAW_LOG_KEYS = new Set([
  "at",
  "runId",
  "step",
  "surface",
  "operation",
  "mocked",
  "synthetic",
  "status",
  "outcome",
  "requestIdSha256",
  "resourceIdSha256",
  "responseSha256",
  "stateSha256",
  "processOutputSha256",
  "objectKeySha256",
  "bytes",
  "count",
  "durationMs",
  "seq",
]);
const RAW_SURFACES = new Set(Object.values(REQUIRED_RAW_SURFACES).flat());
const RAW_OPERATION_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,159}$/u;
const RAW_OUTCOME_PATTERN = /^[a-z][a-z0-9._:-]{0,63}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const required = (env, key) => {
  const value = env[key]?.trim();
  if (!value) throw new CloudProofError(`${key} is required.`);
  return value;
};

const evidencePath = (raw) => {
  assert(
    path.isAbsolute(raw),
    "STELLA_CLOUD_ACCEPTANCE_EVIDENCE_FILE must be absolute.",
  );
  const declared = path.resolve(raw);
  let resolved;
  try {
    const parent = realpathSync(path.dirname(declared));
    assert(
      statSync(parent).isDirectory(),
      "Acceptance evidence parent must be a directory.",
    );
    resolved = path.join(parent, path.basename(declared));
  } catch (error) {
    if (error instanceof CloudProofError) throw error;
    throw new CloudProofError(
      `Acceptance evidence parent could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const liveRoot = path.join(homedir(), ".stella");
  assert(
    resolved.endsWith(".json") &&
      resolved !== liveRoot &&
      !resolved.startsWith(`${liveRoot}${path.sep}`),
    "Acceptance evidence must be a JSON file outside live ~/.stella.",
  );
  return resolved;
};

const rawLogPath = (raw, step) => {
  assert(
    path.isAbsolute(raw),
    "STELLA_CLOUD_ACCEPTANCE_RAW_LOG_FILE must be absolute.",
  );
  const declared = path.resolve(raw);
  let resolved;
  try {
    const parent = realpathSync(path.dirname(declared));
    assert(
      statSync(parent).isDirectory(),
      "Acceptance raw-log parent must be a directory.",
    );
    resolved = path.join(parent, path.basename(declared));
  } catch (error) {
    if (error instanceof CloudProofError) throw error;
    throw new CloudProofError(
      `Acceptance raw-log parent could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const liveRoot = path.join(homedir(), ".stella");
  assert(
    resolved.endsWith(".jsonl") &&
      path.basename(resolved) === `${step}.jsonl` &&
      resolved !== liveRoot &&
      !resolved.startsWith(`${liveRoot}${path.sep}`),
    "Acceptance raw log must be the runner-selected step JSONL file outside live ~/.stella.",
  );
  return resolved;
};

const canonicalIso = (value, label) => {
  assert(
    typeof value === "string" && value.length > 0,
    `${label} is required.`,
  );
  const parsed = Date.parse(value);
  assert(
    Number.isFinite(parsed) && new Date(parsed).toISOString() === value,
    `${label} must be a canonical ISO timestamp.`,
  );
  return value;
};

export const loadAcceptanceDriverContext = (
  expectedStep,
  env = process.env,
) => {
  assert(
    typeof expectedStep === "string" && expectedStep.trim() !== "",
    "A driver must declare its expected acceptance step.",
  );
  assert(
    required(env, "STELLA_CLOUD_ACCEPTANCE_DRIVER_CONTRACT") ===
      ACCEPTANCE_DRIVER_CONTRACT,
    "The runner injected an unsupported acceptance driver contract.",
  );
  const step = required(env, "STELLA_CLOUD_ACCEPTANCE_STEP");
  assert(
    step === expectedStep,
    `Driver expected ${expectedStep}, received ${step}.`,
  );
  const runId = required(env, "STELLA_CLOUD_ACCEPTANCE_RUN_ID");
  assert(
    RUN_ID_PATTERN.test(runId),
    "STELLA_CLOUD_ACCEPTANCE_RUN_ID must be a UUID.",
  );
  const target = loadNonMutatingTarget({
    deployment: required(env, "CONVEX_DEPLOYMENT"),
    convexUrl: required(env, "CONVEX_URL"),
    convexSiteUrl: required(env, "CONVEX_SITE_URL"),
    cloudBuilderUrl: required(env, "CLOUD_BUILDER_URL"),
  });
  return Object.freeze({
    [CONTEXT_BRAND]: true,
    step,
    runId,
    target,
    evidenceFile: evidencePath(
      required(env, "STELLA_CLOUD_ACCEPTANCE_EVIDENCE_FILE"),
    ),
    rawLogFile: rawLogPath(
      required(env, "STELLA_CLOUD_ACCEPTANCE_RAW_LOG_FILE"),
      step,
    ),
  });
};

const optionalNonNegativeInteger = (value, label) => {
  assert(
    Number.isSafeInteger(value) && value >= 0,
    `${label} must be an integer >= 0.`,
  );
  return value;
};

/**
 * Validate the retained receipt format at both the driver and runner boundary.
 * The deliberately small allowlist prevents prompts, response bodies, headers,
 * credentials, cookies, and raw upstream identifiers from entering evidence.
 */
export const validateAcceptanceRawLogEntries = ({
  step,
  runId,
  startedAt,
  finishedAt,
  entries,
}) => {
  assert(Array.isArray(entries) && entries.length > 0, "rawLog is required.");
  assert(Object.hasOwn(REQUIRED_RAW_SURFACES, step), "Unknown raw-log step.");
  assert(RUN_ID_PATTERN.test(runId), "Raw-log runId must be a UUID.");
  const startedMs = Date.parse(canonicalIso(startedAt, "startedAt"));
  const finishedMs = Date.parse(canonicalIso(finishedAt, "finishedAt"));
  assert(finishedMs >= startedMs, "Raw-log evidence timestamps are inverted.");
  const surfaces = new Set();
  const checked = entries.map((entry, index) => {
    assert(
      entry && typeof entry === "object" && !Array.isArray(entry),
      `rawLog[${index}] must be an object.`,
    );
    for (const key of Object.keys(entry)) {
      assert(
        RAW_LOG_KEYS.has(key),
        `rawLog[${index}] contains forbidden field ${JSON.stringify(key)}.`,
      );
    }
    const at = canonicalIso(entry.at, `rawLog[${index}].at`);
    const atMs = Date.parse(at);
    assert(
      atMs >= startedMs && atMs <= finishedMs,
      `rawLog[${index}].at is outside the evidence interval.`,
    );
    assert(entry.runId === runId, `rawLog[${index}].runId is not this run.`);
    assert(entry.step === step, `rawLog[${index}].step is not this step.`);
    const surface = String(entry.surface ?? "").trim();
    const operation = String(entry.operation ?? "").trim();
    assert(RAW_SURFACES.has(surface), `rawLog[${index}].surface is invalid.`);
    assert(
      RAW_OPERATION_PATTERN.test(operation),
      `rawLog[${index}].operation is invalid.`,
    );
    assert(
      entry.mocked === false && entry.synthetic === false,
      `rawLog[${index}] must attest to a real non-synthetic operation.`,
    );
    const optional = {};
    if (entry.status !== undefined) {
      optional.status = optionalNonNegativeInteger(
        entry.status,
        `rawLog[${index}].status`,
      );
    }
    if (entry.outcome !== undefined) {
      assert(
        typeof entry.outcome === "string" &&
          RAW_OUTCOME_PATTERN.test(entry.outcome),
        `rawLog[${index}].outcome is invalid.`,
      );
      optional.outcome = entry.outcome;
    }
    for (const key of [
      "requestIdSha256",
      "resourceIdSha256",
      "responseSha256",
      "stateSha256",
      "processOutputSha256",
      "objectKeySha256",
    ]) {
      if (entry[key] === undefined) continue;
      assert(
        typeof entry[key] === "string" && SHA256_PATTERN.test(entry[key]),
        `rawLog[${index}].${key} must be a SHA-256 digest.`,
      );
      optional[key] = entry[key];
    }
    for (const key of ["bytes", "count", "durationMs", "seq"]) {
      if (entry[key] === undefined) continue;
      optional[key] = optionalNonNegativeInteger(
        entry[key],
        `rawLog[${index}].${key}`,
      );
    }
    surfaces.add(surface);
    return {
      at,
      runId,
      step,
      surface,
      operation,
      mocked: false,
      synthetic: false,
      ...optional,
    };
  });
  for (const requiredSurface of REQUIRED_RAW_SURFACES[step]) {
    assert(
      surfaces.has(requiredSurface),
      `${step} raw log is missing the ${requiredSurface} product surface.`,
    );
  }
  return checked;
};

export const writeAcceptanceDriverEvidence = async (context, value) => {
  assert(
    context?.[CONTEXT_BRAND] === true,
    "Acceptance evidence requires a context loaded from the runner environment.",
  );
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    "Acceptance evidence payload is required.",
  );
  assert(
    value.attestations?.passed === true &&
      value.attestations?.productPath === true &&
      value.attestations?.syntheticAssistantRecords === false &&
      value.attestations?.mocked === false &&
      value.attestations?.realNetwork === true,
    "A real driver must explicitly attest to passed/productPath/realNetwork and to no synthetic or mocked services.",
  );
  assert(
    value.identity &&
      typeof value.identity === "object" &&
      !Array.isArray(value.identity),
    "Acceptance identity evidence is required.",
  );
  assert(
    value.observations &&
      typeof value.observations === "object" &&
      !Array.isArray(value.observations),
    "Acceptance observations are required.",
  );
  const startedAt = canonicalIso(value.startedAt, "startedAt");
  const finishedAt = canonicalIso(value.finishedAt, "finishedAt");
  assert(
    Date.parse(finishedAt) >= Date.parse(startedAt),
    "Acceptance evidence timestamps are inverted.",
  );
  const rawEntries = validateAcceptanceRawLogEntries({
    step: context.step,
    runId: context.runId,
    startedAt,
    finishedAt,
    entries: Array.isArray(value.rawLog)
      ? value.rawLog.map((entry) => ({
          ...entry,
          runId: context.runId,
          step: context.step,
        }))
      : value.rawLog,
  });
  const rawBytes = Buffer.from(
    `${rawEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
  assert(
    rawBytes.byteLength <= 16 * 1024 * 1024,
    "Acceptance raw log exceeded 16 MiB.",
  );
  await mkdir(path.dirname(context.rawLogFile), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(context.rawLogFile, rawBytes, {
    mode: 0o600,
    flag: "wx",
  });
  await writeEvidence(context.evidenceFile, {
    version: 2,
    driverContract: ACCEPTANCE_DRIVER_CONTRACT,
    step: context.step,
    runId: context.runId,
    passed: true,
    productPath: true,
    syntheticAssistantRecords: false,
    mocked: false,
    realNetwork: true,
    startedAt,
    finishedAt,
    identity: value.identity,
    observations: value.observations,
    artifacts: {
      rawLog: {
        path: context.rawLogFile,
        sha256: sha256(rawBytes),
        bytes: rawBytes.byteLength,
        entries: rawEntries.length,
      },
    },
  });
};
