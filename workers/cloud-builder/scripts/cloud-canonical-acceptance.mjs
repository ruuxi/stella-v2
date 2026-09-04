#!/usr/bin/env node

/**
 * Manifest runner for real Stella cloud-canonical product acceptance.
 *
 * Unlike cloud-canonical-protocol-smoke.mjs, every step here must launch or
 * drive a real product surface and write structured evidence. The runner does
 * not manufacture transcript rows, infer success from exit code, or accept a
 * mocked/synthetic assistant response.
 *
 * Hash-only checkpoints permit a runner-process restart only while the
 * prepared isolated product processes remain alive. Machine or app-process
 * death requires a fresh acceptance run; no resumable credential is persisted.
 *
 * Usage:
 *   node cloud-canonical-acceptance.mjs --list
 *   node cloud-canonical-acceptance.mjs --check /abs/manifest.json
 *   node cloud-canonical-acceptance.mjs --prepare-auth /abs/manifest.json
 *   STELLA_CLOUD_ACCEPTANCE_CONFIRM=run-real-preview:basic-nightingale-118 \
 *     node cloud-canonical-acceptance.mjs --run /abs/manifest.json
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CloudProofError,
  FORBIDDEN_TARGET_PATTERN,
  REQUIRED_APPS_HOST_WORKER_NAME,
  REQUIRED_CLOUD_BUILDER_WORKER_NAME,
  REQUIRED_CONVEX,
  assert,
  assertSafeAcceptanceEnvironment,
  loadNonMutatingTarget,
  sanitizeEvidence,
  sha256,
  writeEvidence,
} from "./cloud-proof-lib.mjs";
import {
  ACCEPTANCE_DRIVER_CONTRACT,
  validateAcceptanceRawLogEntries,
} from "./cloud-canonical-acceptance-driver-contract.mjs";

export { ACCEPTANCE_DRIVER_CONTRACT };

const REPO_ROOT = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
);
const USER_HOME = path.resolve(homedir());
const LIVE_STELLA_ROOT = path.join(USER_HOME, ".stella");
const MAX_COMMAND_OUTPUT_BYTES = 2_000_000;
const MAX_JSON_FILE_BYTES = 2_000_000;
const MAX_STEP_TIMEOUT_MS = 60 * 60_000;
const PRIMARY_AUTH_HANDOFF_CHECKPOINT_CONTRACT =
  "stella-cloud-primary-auth-handoff-run-v1";
const PRIMARY_AUTH_HANDOFF_PREPARE_CONTRACT =
  "stella-cloud-primary-auth-handoff-prepare-v1";
const PRIMARY_AUTH_AWAITING_EXIT_CODE = 75;
export const AUTHORITY_RUNWAY_EXHAUSTED_EXIT_CODE = 76;
const AUTHORITY_RUNWAY_EXHAUSTED = "authority_runway_exhausted";
const INHERITED_ACCEPTANCE_AUTHORITY_KEYS = Object.freeze([
  "STELLA_CLOUD_PROOF_JWT",
  "STELLA_CLOUD_PROOF_SESSION_COOKIE",
  "STELLA_CLOUD_ACCEPTANCE_SECONDARY_JWT",
  "STELLA_CLOUD_ACCEPTANCE_SECONDARY_SESSION_COOKIE",
  "STELLA_MOBILE_ACCEPTANCE_JWT",
  "STELLA_MOBILE_ACCEPTANCE_SECONDARY_JWT",
  "STELLA_MOBILE_RN_ACCEPTANCE_JWT",
]);

class ProductHandoffAwaitingError extends CloudProofError {}

const DRIVER_PROCESS_GROUPS = process.platform !== "win32";

const driverProcessGroupAlive = (processGroupId) => {
  if (!DRIVER_PROCESS_GROUPS || !Number.isSafeInteger(processGroupId)) {
    return false;
  }
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

const signalDriverProcessTree = (child, signal) => {
  if (DRIVER_PROCESS_GROUPS && Number.isSafeInteger(child.pid)) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if its process group already disappeared.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // A concurrently exited child is already terminated.
  }
};

export const stripInheritedAcceptanceAuthority = (source) => {
  const environment = { ...source };
  for (const key of INHERITED_ACCEPTANCE_AUTHORITY_KEYS) {
    delete environment[key];
  }
  return environment;
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
};

const canonicalJson = (value) => JSON.stringify(canonicalize(value));

const atomicWritePrivateJson = async (filePath, value) => {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

const requiredStepDescriptions = Object.freeze({
  primary_auth_handoff:
    "A fresh disposable nonanonymous account completes the normal product login flow in isolated profiles; the driver retains no raw cookie or token and resumes from a hash-only checkpoint.",
  deployment_identity:
    "The exact reviewed source tree is bound to the deployed Worker version and Convex function manifest.",
  local_runtime_lifecycle:
    "An isolated real local runtime proves provider streaming, tools, child completion, interruption, continuation, persistence, and process restart.",
  electron_real_stream:
    "A real isolated Electron profile streams a real turn into the conversation DO.",
  consecutive_durable_turns:
    "A second real turn uses the same conversation DO and journal epoch and observes the first turn.",
  duplicate_delivery_idempotency:
    "Replaying one real delivery returns the exact receipt without adding prompt or terminal records.",
  electron_restart_reconnect:
    "The real app process restarts, reconnects, and observes the same journal/history.",
  clean_client_hydration:
    "A second isolated profile with no cache discovers via Convex and hydrates from cloud.",
  cache_loss_recovery:
    "Deleting only the disposable profile cache does not lose or fork the conversation.",
  projection_and_r2:
    "DO SQLite is gapless, projection fencing is monotonic, and hot+cold R2 evidence exists.",
  cancellation:
    "A real user cancellation stops execution and writes exactly one canceled terminal.",
  cloud_failure_no_local_fallback:
    "Cold canonical prompt and malformed active-history failures are explicit before provider dispatch and create no local-authoritative row.",
  desktop_local_routing:
    "Desktop computer work executes in the eligible local runtime, never a sandbox.",
  mobile_reachable_computer_routing:
    "Mobile computer work routes to the reachable paired computer under a fenced claim.",
  mobile_unreachable_cloud_routing:
    "Mobile computer work without an eligible computer runs in a real cloud sandbox.",
  mobile_signed_in_canonical_sync:
    "The signed-in mobile product persists an outbox before network admission, survives a fresh-process restart, executes through the real mobile HTTP path, and hydrates the canonical terminal journal through a clean WebSocket client.",
  browser_cloud_routing:
    "The actual browser shell sends through cloud placement, survives reload, a cold process, and complete storage loss, pauses for the required second external-inbox product login, resumes from the same hash-only target checkpoint, and never serializes credentials or falls back locally.",
  child_completion:
    "A real child completion reaches the parent DO exactly once.",
  memory_restart_recall:
    "Cloud MEMORY.md survives a Worker restart and is recalled and injected into a later real turn.",
  cloud_skill_discovery_use:
    "A versioned cloud-owned skill manifest and asset are discovered, loaded, and used by a real cloud agent without Mac filesystem access.",
  code_mode_real_mcp:
    "Real code mode completes MCP initialization, discovery, description, and a connected read-only tool call.",
  general_agent_real_sandbox:
    "A real general child agent executes in a Cloudflare sandbox and returns one fenced completion without local execution.",
  owner_reset_memory_reimport:
    "The signed-in product performs a memory-only wipe with explicit reimport, then a full owner reset rotates generation, removes reset-owned core data and old-generation objects, preserves the audited connected integration for a second read-only call, and reimports only retained local memory.",
  apps_host_workerd_runtime:
    "The production Apps Host bundle serves real KV/R2-backed app routes inside Workerd and fails closed on unsafe proxy and authority inputs.",
  cleanup:
    "Disposable conversations, R2 objects, and isolated profiles are removed; live state is untouched.",
});

export const REQUIRED_STEP_IDS = Object.freeze(
  Object.keys(requiredStepDescriptions),
);

const nonEmptyString = (value, label) => {
  assert(
    typeof value === "string" && value.trim() !== "",
    `${label} is required.`,
  );
  return value.trim();
};

const finiteInteger = (value, label, minimum = 0) => {
  assert(
    Number.isSafeInteger(value) && value >= minimum,
    `${label} must be an integer >= ${minimum}.`,
  );
  return value;
};

const exactInteger = (value, expected, label) => {
  const checked = finiteInteger(value, label);
  assert(checked === expected, `${label} must be ${expected}.`);
  return expected;
};

const booleanTrue = (value, label) => {
  assert(value === true, `${label} must be true.`);
  return true;
};

const sha256Value = (value, label) => {
  assert(
    /^[a-f0-9]{64}$/.test(value ?? ""),
    `${label} must be a SHA-256 hex digest.`,
  );
  return value;
};

const gitShaValue = (value, label) => {
  assert(
    /^[a-f0-9]{40}$/.test(value ?? ""),
    `${label} must be a full lowercase Git SHA.`,
  );
  return value;
};

const codeToolRevisionValue = (value, label) => {
  assert(
    /^v2:[a-f0-9]{64}$/.test(value ?? ""),
    `${label} must be an exact v2 connected-tool content revision.`,
  );
  return value;
};

const uuidValue = (value, label) => {
  const checked = nonEmptyString(value, label);
  assert(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      checked,
    ),
    `${label} must be a UUID.`,
  );
  return checked;
};

const boundedIdentifier = (value, label, maximum = 256) => {
  const checked = nonEmptyString(value, label);
  assert(
    checked.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(checked),
    `${label} must be at most ${maximum} characters and contain no control characters.`,
  );
  return checked;
};

const exactLiteral = (value, expected, label) => {
  assert(value === expected, `${label} must be ${JSON.stringify(expected)}.`);
  return expected;
};

const falseValue = (value, label) => {
  assert(value === false, `${label} must be false.`);
  return false;
};

const exactRecord = (value, expectedKeys, label) => {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object.`,
  );
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  assert(
    actual.length === expected.length &&
      actual.every((key, index) => key === expected[index]),
    `${label} must contain exactly: ${expected.join(", ")}.`,
  );
  return value;
};

const stableJson = (value) => {
  const encode = (input) => {
    if (Array.isArray(input)) return input.map(encode);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(
      Object.entries(input)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, encode(child)]),
    );
  };
  return JSON.stringify(encode(value));
};

// rendered-client-cdp.mjs deliberately uses the ECMAScript default key sort,
// not localeCompare. Keep this byte-identical so the runner independently
// recomputes both observation and receipt digests.
const renderedCanonicalJson = (value) => {
  const encode = (input) => {
    if (Array.isArray(input)) return input.map(encode);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(
      Object.keys(input)
        .sort()
        .map((key) => [key, encode(input[key])]),
    );
  };
  return JSON.stringify(encode(value));
};

const RENDERED_RECEIPT_KEYS = Object.freeze([
  "applicationIdentitySha256",
  "browserBuildSha256",
  "contract",
  "observationSha256",
  "operation",
  "outcome",
  "processIdSha256",
  "processInstanceSha256",
  "profileSha256",
  "receiptSha256",
  "surface",
]);
const RENDERED_OBSERVATION_LITERALS = new Set([
  "browser-generation-rotated",
  "browser-storage-recovered",
  "browser-storage-recovered-after-product-login",
  "cold-process-hydrated",
  "completed",
  "cross-process-identity-round-trip",
  "electron-generation-rotated",
  "failed",
  "resumed",
  "same-target-page-reloaded",
]);

const assertHashOnlyRenderedObservation = (value, label) => {
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isSafeInteger(value))
  ) {
    return;
  }
  if (typeof value === "string") {
    assert(
      /^[a-f0-9]{64}$/u.test(value) || RENDERED_OBSERVATION_LITERALS.has(value),
      `${label} retained a non-hash rendered string.`,
    );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertHashOnlyRenderedObservation(entry, `${label}[${index}]`),
    );
    return;
  }
  assert(
    value && typeof value === "object",
    `${label} contains an unsupported rendered value.`,
  );
  for (const [key, child] of Object.entries(value)) {
    assert(
      !/(?:cookie|jwt|token|prompt|conversationId|ownerGeneration|subject|sessionId)$/u.test(
        key,
      ) || key.endsWith("Sha256"),
      `${label}.${key} is a forbidden raw rendered field.`,
    );
    assertHashOnlyRenderedObservation(child, `${label}.${key}`);
  }
};

const validateRenderedProofs = (
  value,
  { surface, requiredOperations, expectedSetSha256, label },
) => {
  assert(Array.isArray(value), `${label} must be an array.`);
  const operations = [];
  const normalized = value.map((entry, index) => {
    const pair = exactRecord(
      entry,
      ["observation", "receipt"],
      `${label}[${index}]`,
    );
    assertHashOnlyRenderedObservation(
      pair.observation,
      `${label}[${index}].observation`,
    );
    const receipt = exactRecord(
      pair.receipt,
      RENDERED_RECEIPT_KEYS,
      `${label}[${index}].receipt`,
    );
    exactLiteral(
      receipt.contract,
      "stella-rendered-client-cdp-v1",
      `${label}[${index}].receipt.contract`,
    );
    exactLiteral(
      receipt.surface,
      surface,
      `${label}[${index}].receipt.surface`,
    );
    exactLiteral(
      receipt.outcome,
      "passed",
      `${label}[${index}].receipt.outcome`,
    );
    const operation = boundedIdentifier(
      receipt.operation,
      `${label}[${index}].receipt.operation`,
      80,
    );
    assert(
      /^rendered\.[a-z0-9-]+$/u.test(operation),
      `${label}[${index}] has an invalid rendered operation.`,
    );
    for (const field of [
      "processIdSha256",
      "processInstanceSha256",
      "profileSha256",
      "browserBuildSha256",
      "applicationIdentitySha256",
      "observationSha256",
      "receiptSha256",
    ]) {
      sha256Value(receipt[field], `${label}[${index}].receipt.${field}`);
    }
    assert(
      receipt.observationSha256 ===
        sha256(renderedCanonicalJson(pair.observation)),
      `${label}[${index}] observation digest is invalid.`,
    );
    const { receiptSha256, ...receiptBody } = receipt;
    assert(
      receiptSha256 === sha256(renderedCanonicalJson(receiptBody)),
      `${label}[${index}] receipt digest is invalid.`,
    );
    operations.push(operation);
    return { observation: pair.observation, receipt };
  });
  assert(
    new Set(operations).size === operations.length,
    `${label} contains a duplicate rendered operation.`,
  );
  const required = [...requiredOperations].sort();
  assert(
    operations.length === required.length &&
      [...operations]
        .sort()
        .every((operation, index) => operation === required[index]),
    `${label} must contain exactly the reviewed rendered operation roster.`,
  );
  const proofSetSha256 = sha256(
    renderedCanonicalJson(
      normalized.map(({ receipt }) => ({
        receiptSha256: receipt.receiptSha256,
        observationSha256: receipt.observationSha256,
      })),
    ),
  );
  assert(
    proofSetSha256 === expectedSetSha256,
    `${label} proof-set digest is invalid.`,
  );
  const byOperation = new Map(
    normalized.map((entry) => [entry.receipt.operation, entry]),
  );
  const failClosed = byOperation.get("rendered.fail-closed")?.observation;
  if (failClosed) {
    assert(
      failClosed.terminalKind === "failed" &&
        failClosed.visibleAlertDelta >= 1 &&
        failClosed.newAssistantRowCount === 0 &&
        failClosed.providerDispatchCountBefore ===
          failClosed.providerDispatchCountAfter &&
        failClosed.localFallbackCount === 0,
      `${label} did not prove a visible zero-fallback failure.`,
    );
  }
  const resume = byOperation.get("rendered.mounted-resume")?.observation;
  if (resume) {
    assert(
      resume.outcome === "resumed" &&
        resume.gapless === true &&
        resume.noDuplicateRows === true &&
        resume.sameMountedClient === true &&
        resume.replayRecordCount > 0 &&
        Number.isSafeInteger(resume.since) &&
        Number.isSafeInteger(resume.epoch),
      `${label} did not prove same-mounted cursor replay.`,
    );
  }
  const send = byOperation.get("rendered.send-terminal")?.observation;
  if (send) {
    assert(
      send.terminalKind === "completed" && send.localFallbackCount === 0,
      `${label} rendered send did not reach a canonical terminal.`,
    );
  }
  const reload = byOperation.get("rendered.same-target-reload")?.observation;
  if (reload) {
    assert(
      reload.outcome === "same-target-page-reloaded" &&
        reload.sameTarget === true &&
        reload.newRendererMount === true &&
        reload.noDuplicateRows === true,
      `${label} did not prove same-target reload hydration.`,
    );
  }
  const cold = byOperation.get("rendered.cold-process")?.observation;
  if (cold) {
    assert(
      cold.outcome === "cold-process-hydrated" &&
        cold.identityObservedBeforeAuth === true &&
        cold.profileReused === true &&
        cold.newProcess === true &&
        cold.newTarget === true &&
        cold.noDuplicateRows === true,
      `${label} did not prove cold-process hydration before auth setup.`,
    );
  }
  const identity = byOperation.get("rendered.identity-round-trip")?.observation;
  if (identity) {
    assert(
      identity.outcome === "cross-process-identity-round-trip" &&
        identity.secondaryExistingProfilePreserved === true &&
        identity.secondaryRelaunched === true &&
        identity.primaryRemainedMounted === true &&
        identity.staleContentRejected === true &&
        identity.credentialMaterialReturned === false,
      `${label} did not prove hash-only A/B/A profile isolation.`,
    );
  }
  const storageRecovery = byOperation.get(
    "rendered.storage-recovery",
  )?.observation;
  if (storageRecovery) {
    assert(
      storageRecovery.outcome ===
        "browser-storage-recovered-after-product-login" &&
        storageRecovery.localRowsAbsentBeforeReauth === true &&
        storageRecovery.priorAuthoritySignedOutOrAnonymous === true &&
        storageRecovery.outboxEmptyBeforeReauth === true &&
        storageRecovery.accountAuthorityPreserved === true &&
        storageRecovery.productLoginRequired === true &&
        storageRecovery.credentialMaterialReturned === false &&
        storageRecovery.noDuplicateRows === true,
      `${label} did not prove product-login recovery after complete browser storage loss.`,
    );
  }
  const generation = byOperation.get(
    "rendered.generation-rotation",
  )?.observation;
  if (generation && surface === "browser-cdp") {
    assert(
      generation.outcome === "browser-generation-rotated" &&
        generation.oldSocketClosedBeforeStaleRelease === true &&
        generation.postRotationOldSocketCount === 0 &&
        generation.oldGenerationOutboxPurged === true &&
        generation.staleCallbackDropped === true &&
        generation.oldGenerationAckCouldNotRecreate === true &&
        generation.staleMutationServerRejected === true &&
        generation.staleRowsRejected === true &&
        generation.localFallbackCount === 0,
      `${label} did not prove browser outbox/socket generation fencing.`,
    );
  }
  if (generation && surface === "electron-cdp") {
    assert(
      generation.outcome === "electron-generation-rotated" &&
        generation.sameMountedRenderer === true &&
        generation.oldSocketClosed === true &&
        generation.staleRowsRejected === true &&
        generation.localFallbackCount === 0 &&
        generation.outboxApplicable === false,
      `${label} did not prove same-mounted Electron generation fencing.`,
    );
  }
  return { entries: normalized, proofSetSha256, byOperation };
};

export const REQUIRED_JOINED_PROVIDER_LIFECYCLE_PHASES = Object.freeze([
  "request-admitted",
  "request-dispatched",
  "stream-open",
  "transport-closed",
  "transport-joined",
]);

const joinedProviderLifecycle = ({
  phases,
  requestIdSha256,
  physicalAttempt,
  streamOrdinal,
  outcome,
  rawRequestIdExposed,
  label,
  expectedOutcome,
}) => {
  assert(Array.isArray(phases), `${label}.phases must be an array.`);
  assert(
    phases.length === REQUIRED_JOINED_PROVIDER_LIFECYCLE_PHASES.length &&
      phases.every(
        (phase, index) =>
          phase === REQUIRED_JOINED_PROVIDER_LIFECYCLE_PHASES[index],
      ),
    `${label} must prove admitted, dispatched, stream-open, transport-closed, and transport-joined in order.`,
  );
  return {
    phases: [...REQUIRED_JOINED_PROVIDER_LIFECYCLE_PHASES],
    requestIdSha256: sha256Value(requestIdSha256, `${label}.requestIdSha256`),
    physicalAttempt: finiteInteger(
      physicalAttempt,
      `${label}.physicalAttempt`,
      1,
    ),
    streamOrdinal: finiteInteger(streamOrdinal, `${label}.streamOrdinal`, 1),
    outcome: exactLiteral(outcome, expectedOutcome, `${label}.outcome`),
    rawRequestIdExposed: falseValue(
      rawRequestIdExposed,
      `${label}.rawRequestIdExposed`,
    ),
  };
};

const acceptanceIdentity = (value, label) => {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} is required.`,
  );
  return {
    deploymentFingerprintSha256: sha256Value(
      value.deploymentFingerprintSha256,
      `${label}.deploymentFingerprintSha256`,
    ),
    sourceTreeSha256: sha256Value(
      value.sourceTreeSha256,
      `${label}.sourceTreeSha256`,
    ),
    ownerIdSha256: sha256Value(value.ownerIdSha256, `${label}.ownerIdSha256`),
    ownerGeneration: boundedIdentifier(
      value.ownerGeneration,
      `${label}.ownerGeneration`,
    ),
  };
};

const identityEquals = (left, right) =>
  left.deploymentFingerprintSha256 === right.deploymentFingerprintSha256 &&
  left.sourceTreeSha256 === right.sourceTreeSha256 &&
  left.ownerIdSha256 === right.ownerIdSha256 &&
  left.ownerGeneration === right.ownerGeneration;

const agentHomeGenerationPrefix = (identity) =>
  `agent-home/${identity.ownerIdSha256}/generations/${sha256(identity.ownerGeneration)}/`;

const deploymentFingerprint = (observation) =>
  sha256(
    JSON.stringify({
      version: 2,
      repoCommitSha: observation.repoCommitSha,
      repoTreeSha: observation.repoTreeSha,
      sourceTreeSha256: observation.sourceTreeSha256,
      cloudBuilderUrl: observation.cloudBuilderUrl,
      workerName: observation.workerName,
      workerVersionId: observation.workerVersionId,
      workerScriptSha256: observation.workerScriptSha256,
      convexDeployment: observation.convexDeployment,
      convexUrl: observation.convexUrl,
      convexSiteUrl: observation.convexSiteUrl,
      convexFunctionManifestSha256: observation.convexFunctionManifestSha256,
      canonicalPromptSchemaVersion: observation.canonicalPromptSchemaVersion,
      canonicalPromptRevision: observation.canonicalPromptRevision,
      canonicalPromptPublishedAt: observation.canonicalPromptPublishedAt,
      canonicalPromptManifestSha256: observation.canonicalPromptManifestSha256,
      canonicalPromptIdsSha256: observation.canonicalPromptIdsSha256,
      canonicalPromptCount: observation.canonicalPromptCount,
    }),
  );

const safeIsolatedPath = (value, label) => {
  const raw = nonEmptyString(value, label);
  const resolved = path.resolve(raw);
  assert(path.isAbsolute(raw), `${label} must be absolute.`);
  assert(
    resolved !== path.parse(resolved).root &&
      resolved !== USER_HOME &&
      !LIVE_STELLA_ROOT.startsWith(`${resolved}${path.sep}`) &&
      resolved !== LIVE_STELLA_ROOT &&
      !resolved.startsWith(`${LIVE_STELLA_ROOT}${path.sep}`),
    `${label} must be narrow and must not point at or contain the live ~/.stella tree.`,
  );
  return resolved;
};

const isoTimestamp = (value, label) => {
  const timestamp = nonEmptyString(value, label);
  const parsed = Date.parse(timestamp);
  assert(
    Number.isFinite(parsed) && new Date(parsed).toISOString() === timestamp,
    `${label} must be a canonical ISO timestamp.`,
  );
  return parsed;
};

const rawLogArtifact = (
  value,
  label,
  { stepId, runId, startedAt, finishedAt },
) => {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} is required.`,
  );
  const declared = safeIsolatedPath(value.path, `${label}.path`);
  let resolved;
  let metadata;
  let bytes;
  try {
    resolved = realpathSync(declared);
    metadata = statSync(resolved);
    bytes = readFileSync(resolved);
  } catch (error) {
    throw new CloudProofError(`${label} could not be read.`, {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  assert(
    resolved.endsWith(".jsonl") && metadata.isFile(),
    `${label} must be a JSONL regular file.`,
  );
  assert(
    bytes.byteLength > 0 && bytes.byteLength <= 16 * 1024 * 1024,
    `${label} must contain 1 byte through 16 MiB.`,
  );
  assert(
    value.bytes === bytes.byteLength,
    `${label}.bytes does not match the retained file.`,
  );
  const digest = sha256(bytes);
  assert(
    value.sha256 === digest,
    `${label}.sha256 does not match the retained file.`,
  );
  const text = bytes.toString("utf8");
  assert(
    !/Bearer\s+[A-Za-z0-9._~+/=-]+/iu.test(text) &&
      !/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u.test(text) &&
      !FORBIDDEN_TARGET_PATTERN.test(text),
    `${label} contains a credential or forbidden deployment target.`,
  );
  const lines = text.trimEnd().split("\n");
  finiteInteger(value.entries, `${label}.entries`, 1);
  assert(
    lines.length === value.entries,
    `${label}.entries does not match the retained file.`,
  );
  const entries = [];
  for (const [index, line] of lines.entries()) {
    try {
      entries.push(JSON.parse(line));
    } catch (error) {
      if (error instanceof CloudProofError) throw error;
      throw new CloudProofError(`${label} line ${index + 1} is invalid JSON.`);
    }
  }
  validateAcceptanceRawLogEntries({
    step: stepId,
    runId,
    startedAt,
    finishedAt,
    entries,
  });
  return {
    path: resolved,
    sha256: digest,
    bytes: bytes.byteLength,
    entries: lines.length,
  };
};

const commonEvidence = (stepId, payload, runId) => {
  assert(payload?.version === 2, `${stepId} evidence version must be 2.`);
  assert(
    payload?.driverContract === ACCEPTANCE_DRIVER_CONTRACT,
    `${stepId} evidence uses the wrong driver contract.`,
  );
  assert(payload?.step === stepId, `${stepId} evidence names the wrong step.`);
  assert(
    payload?.runId === runId,
    `${stepId} evidence belongs to another run.`,
  );
  booleanTrue(payload?.passed, `${stepId}.passed`);
  booleanTrue(payload?.productPath, `${stepId}.productPath`);
  assert(
    payload?.syntheticAssistantRecords === false,
    `${stepId} may not use synthetic assistant records.`,
  );
  assert(payload?.mocked === false, `${stepId} may not use mocked services.`);
  booleanTrue(payload?.realNetwork, `${stepId}.realNetwork`);
  const startedAt = isoTimestamp(payload?.startedAt, `${stepId}.startedAt`);
  const finishedAt = isoTimestamp(payload?.finishedAt, `${stepId}.finishedAt`);
  assert(
    finishedAt >= startedAt,
    `${stepId} evidence timestamps are inverted.`,
  );
  assert(
    payload?.observations && typeof payload.observations === "object",
    `${stepId}.observations is required.`,
  );
  const artifact = rawLogArtifact(
    payload?.artifacts?.rawLog,
    `${stepId}.artifacts.rawLog`,
    {
      stepId,
      runId,
      startedAt: payload.startedAt,
      finishedAt: payload.finishedAt,
    },
  );
  return {
    identity: acceptanceIdentity(payload.identity, `${stepId}.identity`),
    observations: payload.observations,
    artifact,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
  };
};

const MOBILE_RN_PRODUCT_MODULES = Object.freeze([
  "use-cloud-canonical-chat-thread.ts",
  "use-chat-thread.ts",
  "desktop-chat-outbox.ts",
  "cloud-conversation-store.ts",
  "cloud-conversation-socket.ts",
  "http.ts",
]);

const MOBILE_RN_AUTHORITY_KEYS = Object.freeze([
  "identityKeySha256",
  "accountScopeSha256",
  "ownerGenerationSha256",
  "conversationIdSha256",
  "socketOriginSha256",
]);

const mobileRnAuthority = (value, label) => {
  const authority = exactRecord(value, MOBILE_RN_AUTHORITY_KEYS, label);
  return Object.fromEntries(
    MOBILE_RN_AUTHORITY_KEYS.map((key) => [
      key,
      sha256Value(authority[key], `${label}.${key}`),
    ]),
  );
};

const assertSameMobileRnAuthority = (left, right, message) => {
  assert(
    MOBILE_RN_AUTHORITY_KEYS.every((key) => left[key] === right[key]),
    message,
  );
};

const successfulHttpStatus = (value, label) => {
  const checked = finiteInteger(value, label, 200);
  assert(checked <= 299, `${label} must be a successful HTTP status.`);
  return checked;
};

const mobileRnReceipt = ({ value, label, expected }) => {
  const receipt = exactRecord(
    value,
    ["surface", "operation", "outcome", ...expected.fields],
    label,
  );
  exactLiteral(receipt.surface, expected.surface, `${label}.surface`);
  exactLiteral(receipt.operation, expected.operation, `${label}.operation`);
  exactLiteral(receipt.outcome, expected.outcome, `${label}.outcome`);
  for (const field of expected.sha256Fields ?? []) {
    sha256Value(receipt[field], `${label}.${field}`);
  }
  if (expected.status === true) {
    successfulHttpStatus(receipt.status, `${label}.status`);
  }
  if (expected.countMinimum !== undefined) {
    finiteInteger(receipt.count, `${label}.count`, expected.countMinimum);
  }
  return receipt;
};

const validators = {
  primary_auth_handoff(observation, context) {
    const checked = exactRecord(
      observation,
      [
        "authDialogClosed",
        "browserAuthorityReceiptSha256",
        "browserProcessInstanceSha256",
        "browserSessionIdSha256",
        "callbackStateCleared",
        "cleanClientAuthorityReceiptSha256",
        "cleanClientInitiallyEmpty",
        "cleanClientProcessInstanceSha256",
        "cleanClientSessionIdSha256",
        "cleanupEligible",
        "cookieSetupUseCount",
        "credentialMaterialReturned",
        "deployment",
        "distinctProfileSessions",
        "emailSha256",
        "freshOwnerAccountCoreResidueCount",
        "freshOwnerCloudProductStateCount",
        "freshOwnerConversationCount",
        "freshOwnerResetResidueCount",
        "onboardingMemoryEnabled",
        "onboardingMemoryRevision",
        "onboardingPhaseCount",
        "onboardingPreferenceAttestationSha256",
        "onboardingReceiptSetSha256",
        "ownerGenerationSha256",
        "ownerLifecycleState",
        "primaryAuthorityReceiptSha256",
        "primaryIdentitySha256",
        "primaryOwnerAccountSha256",
        "primaryProcessInstanceSha256",
        "primarySessionIdSha256",
        "profileSetSha256",
        "requestSetSha256",
        "sameAccountAcrossProfiles",
        "secondaryAuthorityReceiptSha256",
        "secondaryEmailSha256",
        "secondaryFreshOwnerAccountCoreResidueCount",
        "secondaryFreshOwnerCloudProductStateCount",
        "secondaryFreshOwnerConversationCount",
        "secondaryFreshOwnerResetResidueCount",
        "secondaryIdentitySha256",
        "secondaryJwtIssuerSha256",
        "secondaryJwtSubjectSha256",
        "secondaryJwtTokenIdentifierSha256",
        "secondaryOnboardingMemoryEnabled",
        "secondaryOnboardingMemoryRevision",
        "secondaryOnboardingPreferenceAttestationSha256",
        "secondaryOwnerAccountSha256",
        "secondaryOwnerGenerationSha256",
        "secondaryOwnerLifecycleState",
        "secondaryProcessInstanceSha256",
        "secondarySessionIdSha256",
        "distinctConnectedSecondaryAccount",
        "status",
      ],
      "primary_auth_handoff",
    );
    exactLiteral(
      checked.status,
      "verified-product-login",
      "primary_auth_handoff.status",
    );
    const deployment = validators.deployment_identity(
      checked.deployment,
      context,
      { allowPendingProductChat: true },
    );
    for (const [label, digest] of Object.entries({
      email: checked.emailSha256,
      profiles: checked.profileSetSha256,
      requests: checked.requestSetSha256,
      "primary process": checked.primaryProcessInstanceSha256,
      "clean-client process": checked.cleanClientProcessInstanceSha256,
      "browser process": checked.browserProcessInstanceSha256,
      identity: checked.primaryIdentitySha256,
      owner: checked.primaryOwnerAccountSha256,
      "primary session": checked.primarySessionIdSha256,
      "clean-client session": checked.cleanClientSessionIdSha256,
      "browser session": checked.browserSessionIdSha256,
      "primary authority": checked.primaryAuthorityReceiptSha256,
      "clean-client authority": checked.cleanClientAuthorityReceiptSha256,
      "browser authority": checked.browserAuthorityReceiptSha256,
      "secondary email": checked.secondaryEmailSha256,
      "secondary process": checked.secondaryProcessInstanceSha256,
      "secondary identity": checked.secondaryIdentitySha256,
      "secondary JWT issuer": checked.secondaryJwtIssuerSha256,
      "secondary JWT subject": checked.secondaryJwtSubjectSha256,
      "secondary JWT token identifier":
        checked.secondaryJwtTokenIdentifierSha256,
      "secondary onboarding preference":
        checked.secondaryOnboardingPreferenceAttestationSha256,
      "secondary owner": checked.secondaryOwnerAccountSha256,
      "secondary session": checked.secondarySessionIdSha256,
      "secondary authority": checked.secondaryAuthorityReceiptSha256,
      "secondary generation": checked.secondaryOwnerGenerationSha256,
      generation: checked.ownerGenerationSha256,
      "onboarding receipts": checked.onboardingReceiptSetSha256,
      "onboarding preference": checked.onboardingPreferenceAttestationSha256,
    })) {
      sha256Value(digest, `primary_auth_handoff ${label}`);
    }
    assert(
      checked.primaryIdentitySha256 === deployment.jwtSubjectSha256 &&
        checked.primaryOwnerAccountSha256 === context.identity.ownerIdSha256 &&
        checked.ownerGenerationSha256 ===
          sha256(context.identity.ownerGeneration) &&
        deployment.deploymentFingerprintSha256 ===
          context.identity.deploymentFingerprintSha256 &&
        deployment.sourceTreeSha256 === context.identity.sourceTreeSha256,
      "Primary auth handoff is not bound to its final acceptance identity.",
    );
    booleanTrue(
      checked.sameAccountAcrossProfiles,
      "primary_auth_handoff.sameAccountAcrossProfiles",
    );
    booleanTrue(
      checked.distinctConnectedSecondaryAccount,
      "primary_auth_handoff.distinctConnectedSecondaryAccount",
    );
    assert(
      checked.secondaryEmailSha256 !== checked.emailSha256 &&
        checked.secondaryIdentitySha256 !== checked.primaryIdentitySha256 &&
        checked.secondaryJwtIssuerSha256 ===
          sha256(context.target.convexSiteUrl) &&
        checked.secondaryJwtSubjectSha256 === checked.secondaryIdentitySha256 &&
        checked.secondaryJwtTokenIdentifierSha256 ===
          checked.secondaryOwnerAccountSha256 &&
        checked.secondaryOwnerAccountSha256 !==
          checked.primaryOwnerAccountSha256 &&
        new Set([
          checked.primarySessionIdSha256,
          checked.cleanClientSessionIdSha256,
          checked.browserSessionIdSha256,
          checked.secondarySessionIdSha256,
        ]).size === 4,
      "Primary auth handoff did not retain a distinct connected-secondary account and session.",
    );
    booleanTrue(
      checked.distinctProfileSessions,
      "primary_auth_handoff.distinctProfileSessions",
    );
    booleanTrue(
      checked.callbackStateCleared,
      "primary_auth_handoff.callbackStateCleared",
    );
    booleanTrue(
      checked.authDialogClosed,
      "primary_auth_handoff.authDialogClosed",
    );
    booleanTrue(
      checked.cleanClientInitiallyEmpty,
      "primary_auth_handoff.cleanClientInitiallyEmpty",
    );
    booleanTrue(
      checked.cleanupEligible,
      "primary_auth_handoff.cleanupEligible",
    );
    falseValue(
      checked.credentialMaterialReturned,
      "primary_auth_handoff.credentialMaterialReturned",
    );
    exactInteger(
      checked.cookieSetupUseCount,
      0,
      "primary_auth_handoff.cookieSetupUseCount",
    );
    for (const field of [
      "freshOwnerConversationCount",
      "freshOwnerResetResidueCount",
      "freshOwnerAccountCoreResidueCount",
      "secondaryFreshOwnerConversationCount",
      "secondaryFreshOwnerResetResidueCount",
      "secondaryFreshOwnerAccountCoreResidueCount",
    ]) {
      exactInteger(checked[field], 0, `primary_auth_handoff.${field}`);
    }
    exactInteger(
      checked.freshOwnerCloudProductStateCount,
      1,
      "primary_auth_handoff.freshOwnerCloudProductStateCount",
    );
    exactInteger(
      checked.secondaryFreshOwnerCloudProductStateCount,
      1,
      "primary_auth_handoff.secondaryFreshOwnerCloudProductStateCount",
    );
    exactInteger(
      checked.onboardingMemoryRevision,
      1,
      "primary_auth_handoff.onboardingMemoryRevision",
    );
    exactInteger(
      checked.secondaryOnboardingMemoryRevision,
      1,
      "primary_auth_handoff.secondaryOnboardingMemoryRevision",
    );
    assert(
      checked.onboardingMemoryEnabled === false,
      "primary_auth_handoff.onboardingMemoryEnabled must be false.",
    );
    assert(
      checked.secondaryOnboardingMemoryEnabled === false,
      "primary_auth_handoff.secondaryOnboardingMemoryEnabled must be false.",
    );
    finiteInteger(
      checked.onboardingPhaseCount,
      "primary_auth_handoff.onboardingPhaseCount",
      28,
    );
    exactLiteral(
      checked.ownerLifecycleState,
      "open",
      "primary_auth_handoff.ownerLifecycleState",
    );
    exactLiteral(
      checked.secondaryOwnerLifecycleState,
      "open",
      "primary_auth_handoff.secondaryOwnerLifecycleState",
    );
    return {
      ...checked,
      deployment,
      credentialMaterialReturned: false,
    };
  },
  deployment_identity(
    observation,
    context,
    { allowPendingProductChat = false } = {},
  ) {
    observation = exactRecord(
      observation,
      [
        "repoCommitSha",
        "repoTreeSha",
        "sourceTreeSha256",
        "cloudBuilderUrl",
        "workerName",
        "workerVersionId",
        "workerScriptSha256",
        "workerDeployedAt",
        "workerProbeRequestId",
        "convexDeployment",
        "convexUrl",
        "convexSiteUrl",
        "convexFunctionManifestSha256",
        "convexObservedAt",
        "convexProbeRequestId",
        "jwtIssuerSha256",
        "jwtSubjectSha256",
        "jwtTokenIdentifierSha256",
        "issuerQualifiedOwnerMatched",
        "canonicalPromptSchemaVersion",
        "canonicalPromptRevision",
        "canonicalPromptPublishedAt",
        "canonicalPromptManifestSha256",
        "canonicalPromptIdsSha256",
        "canonicalPromptCount",
        "canonicalPromptObservedAt",
        "canonicalPromptMatchesReviewedSource",
        "gitWorktreeClean",
        "workerSourceMatches",
        "convexFunctionsMatch",
        "productLoginChatStatus",
        "primaryProductLoginChatReceiptSha256",
        "cleanClientProductLoginChatReceiptSha256",
        "browserProductLoginChatReceiptSha256",
        "productLoginChatReceiptSetSha256",
        "productLoginChatSameAccount",
        "productLoginChatCredentialMaterialReturned",
      ],
      "deployment_identity",
    );
    const repoCommitSha = gitShaValue(
      observation.repoCommitSha,
      "repoCommitSha",
    );
    const repoTreeSha = gitShaValue(observation.repoTreeSha, "repoTreeSha");
    const sourceTreeSha256 = sha256Value(
      observation.sourceTreeSha256,
      "sourceTreeSha256",
    );
    const cloudBuilderUrl = exactLiteral(
      observation.cloudBuilderUrl,
      context.target.cloudBuilderUrl,
      "cloudBuilderUrl",
    );
    const workerName = exactLiteral(
      observation.workerName,
      REQUIRED_CLOUD_BUILDER_WORKER_NAME,
      "workerName",
    );
    const workerVersionId = uuidValue(
      observation.workerVersionId,
      "workerVersionId",
    );
    const workerScriptSha256 = sha256Value(
      observation.workerScriptSha256,
      "workerScriptSha256",
    );
    const convexDeployment = exactLiteral(
      observation.convexDeployment,
      context.target.deployment,
      "convexDeployment",
    );
    const convexUrl = exactLiteral(
      observation.convexUrl,
      context.target.convexUrl,
      "convexUrl",
    );
    const convexSiteUrl = exactLiteral(
      observation.convexSiteUrl,
      context.target.convexSiteUrl,
      "convexSiteUrl",
    );
    const convexFunctionManifestSha256 = sha256Value(
      observation.convexFunctionManifestSha256,
      "convexFunctionManifestSha256",
    );
    const canonicalPromptSchemaVersion = finiteInteger(
      observation.canonicalPromptSchemaVersion,
      "canonicalPromptSchemaVersion",
      2,
    );
    assert(
      canonicalPromptSchemaVersion === 2,
      "canonicalPromptSchemaVersion must be the reviewed schema version 2.",
    );
    const canonicalPromptRevision = sha256Value(
      observation.canonicalPromptRevision,
      "canonicalPromptRevision",
    );
    const canonicalPromptPublishedAt = finiteInteger(
      observation.canonicalPromptPublishedAt,
      "canonicalPromptPublishedAt",
    );
    const canonicalPromptManifestSha256 = sha256Value(
      observation.canonicalPromptManifestSha256,
      "canonicalPromptManifestSha256",
    );
    const canonicalPromptIdsSha256 = sha256Value(
      observation.canonicalPromptIdsSha256,
      "canonicalPromptIdsSha256",
    );
    const canonicalPromptCount = finiteInteger(
      observation.canonicalPromptCount,
      "canonicalPromptCount",
      10,
    );
    assert(
      canonicalPromptCount === 10,
      "canonicalPromptCount must be the exact reviewed 10-prompt roster.",
    );
    const canonicalPromptObservedAt = new Date(
      isoTimestamp(
        observation.canonicalPromptObservedAt,
        "canonicalPromptObservedAt",
      ),
    ).toISOString();
    booleanTrue(
      observation.canonicalPromptMatchesReviewedSource,
      "canonicalPromptMatchesReviewedSource",
    );
    const workerDeployedAt = new Date(
      isoTimestamp(observation.workerDeployedAt, "workerDeployedAt"),
    ).toISOString();
    const convexObservedAt = new Date(
      isoTimestamp(observation.convexObservedAt, "convexObservedAt"),
    ).toISOString();
    booleanTrue(observation.gitWorktreeClean, "gitWorktreeClean");
    booleanTrue(observation.workerSourceMatches, "workerSourceMatches");
    booleanTrue(observation.convexFunctionsMatch, "convexFunctionsMatch");
    const workerProbeRequestId = boundedIdentifier(
      observation.workerProbeRequestId,
      "workerProbeRequestId",
    );
    const convexProbeRequestId = boundedIdentifier(
      observation.convexProbeRequestId,
      "convexProbeRequestId",
    );
    const jwtIssuerSha256 = sha256Value(
      observation.jwtIssuerSha256,
      "jwtIssuerSha256",
    );
    const jwtSubjectSha256 = sha256Value(
      observation.jwtSubjectSha256,
      "jwtSubjectSha256",
    );
    const jwtTokenIdentifierSha256 = sha256Value(
      observation.jwtTokenIdentifierSha256,
      "jwtTokenIdentifierSha256",
    );
    assert(
      jwtIssuerSha256 === sha256(context.target.convexSiteUrl),
      "JWT issuer hash does not match the pinned Convex site.",
    );
    assert(
      jwtTokenIdentifierSha256 === context.identity.ownerIdSha256,
      "JWT issuer-qualified token identifier does not match the acceptance owner identity.",
    );
    booleanTrue(
      observation.issuerQualifiedOwnerMatched,
      "issuerQualifiedOwnerMatched",
    );
    const productLoginChatStatus = exactLiteral(
      observation.productLoginChatStatus,
      allowPendingProductChat
        ? "pending-post-deployment-conversation"
        : "verified",
      "productLoginChatStatus",
    );
    const primaryProductLoginChatReceiptSha256 = sha256Value(
      observation.primaryProductLoginChatReceiptSha256,
      "primaryProductLoginChatReceiptSha256",
    );
    const cleanClientProductLoginChatReceiptSha256 = sha256Value(
      observation.cleanClientProductLoginChatReceiptSha256,
      "cleanClientProductLoginChatReceiptSha256",
    );
    const browserProductLoginChatReceiptSha256 = sha256Value(
      observation.browserProductLoginChatReceiptSha256,
      "browserProductLoginChatReceiptSha256",
    );
    const productLoginChatReceiptSetSha256 = sha256Value(
      observation.productLoginChatReceiptSetSha256,
      "productLoginChatReceiptSetSha256",
    );
    booleanTrue(
      observation.productLoginChatSameAccount,
      "productLoginChatSameAccount",
    );
    falseValue(
      observation.productLoginChatCredentialMaterialReturned,
      "productLoginChatCredentialMaterialReturned",
    );
    const normalized = {
      repoCommitSha,
      repoTreeSha,
      sourceTreeSha256,
      cloudBuilderUrl,
      workerName,
      workerVersionId,
      workerScriptSha256,
      workerDeployedAt,
      workerProbeRequestId,
      convexDeployment,
      convexUrl,
      convexSiteUrl,
      convexFunctionManifestSha256,
      convexObservedAt,
      convexProbeRequestId,
      jwtIssuerSha256,
      jwtSubjectSha256,
      jwtTokenIdentifierSha256,
      issuerQualifiedOwnerMatched: true,
      canonicalPromptSchemaVersion,
      canonicalPromptRevision,
      canonicalPromptPublishedAt,
      canonicalPromptManifestSha256,
      canonicalPromptIdsSha256,
      canonicalPromptCount,
      canonicalPromptObservedAt,
      canonicalPromptMatchesReviewedSource: true,
      gitWorktreeClean: true,
      workerSourceMatches: true,
      convexFunctionsMatch: true,
      productLoginChatStatus,
      primaryProductLoginChatReceiptSha256,
      cleanClientProductLoginChatReceiptSha256,
      browserProductLoginChatReceiptSha256,
      productLoginChatReceiptSetSha256,
      productLoginChatSameAccount: true,
      productLoginChatCredentialMaterialReturned: false,
    };
    return {
      ...normalized,
      deploymentFingerprintSha256: deploymentFingerprint(normalized),
    };
  },
  local_runtime_lifecycle(observation, context) {
    const profileDir = safeIsolatedPath(
      existingDirectory(
        safeIsolatedPath(observation.profileDir, "profileDir"),
        "profileDir",
      ),
      "profileDir",
    );
    const secondaryProfileDir = safeIsolatedPath(
      existingDirectory(
        safeIsolatedPath(
          observation.secondaryProfileDir,
          "secondaryProfileDir",
        ),
        "secondaryProfileDir",
      ),
      "secondaryProfileDir",
    );
    assert(
      secondaryProfileDir !== profileDir,
      "Primary and connected-secondary Electron profiles must be isolated.",
    );
    const secondaryJwtSubjectSha256 = sha256Value(
      observation.secondaryJwtSubjectSha256,
      "secondaryJwtSubjectSha256",
    );
    const secondaryJwtTokenIdentifierSha256 = sha256Value(
      observation.secondaryJwtTokenIdentifierSha256,
      "secondaryJwtTokenIdentifierSha256",
    );
    const secondaryOwnerGenerationSha256 = sha256Value(
      observation.secondaryOwnerGenerationSha256,
      "secondaryOwnerGenerationSha256",
    );
    const secondaryConversationIdSha256 = sha256Value(
      observation.secondaryConversationIdSha256,
      "secondaryConversationIdSha256",
    );
    assert(
      secondaryJwtTokenIdentifierSha256 !== context.identity.ownerIdSha256,
      "Connected-secondary acceptance identity must differ from the primary owner.",
    );
    exactLiteral(
      observation.secondaryIdentityClass,
      "connected-secondary",
      "secondaryIdentityClass",
    );
    booleanTrue(
      observation.secondaryNonanonymousSession,
      "secondaryNonanonymousSession",
    );
    falseValue(
      observation.secondaryCredentialMaterialInEvidence,
      "secondaryCredentialMaterialInEvidence",
    );
    booleanTrue(
      observation.secondarySessionProtectedAtRest,
      "secondarySessionProtectedAtRest",
    );
    booleanTrue(
      observation.distinctDisposableOwners,
      "distinctDisposableOwners",
    );
    booleanTrue(
      observation.secondaryOwnerFenceVerified,
      "secondaryOwnerFenceVerified",
    );
    for (const field of [
      "ordinaryConversationIsolationVerified",
      "primaryOwnConversationVisible",
      "primarySecondaryConversationHidden",
      "secondaryOwnConversationVisible",
      "secondaryPrimaryConversationHidden",
    ]) {
      booleanTrue(observation[field], field);
    }
    const initialTurnId = boundedIdentifier(
      observation.initialTurnId,
      "initialTurnId",
    );
    const continuationTurnId = boundedIdentifier(
      observation.continuationTurnId,
      "continuationTurnId",
    );
    const childTurnId = boundedIdentifier(
      observation.childTurnId,
      "childTurnId",
    );
    assert(
      new Set([initialTurnId, continuationTurnId, childTurnId]).size === 3,
      "Local lifecycle turn identities must be distinct.",
    );
    const processIdBefore = finiteInteger(
      observation.processIdBefore,
      "processIdBefore",
      1,
    );
    const processIdAfter = finiteInteger(
      observation.processIdAfter,
      "processIdAfter",
      1,
    );
    assert(
      processIdBefore !== processIdAfter,
      "Local lifecycle did not prove a process restart.",
    );
    const historyBefore = sha256Value(
      observation.historySha256BeforeRestart,
      "historySha256BeforeRestart",
    );
    const historyAfter = sha256Value(
      observation.historySha256AfterRestart,
      "historySha256AfterRestart",
    );
    assert(
      historyBefore === historyAfter,
      "Local lifecycle history changed across process restart.",
    );
    const completedProviderLifecycle = joinedProviderLifecycle({
      phases: observation.providerLifecyclePhases,
      requestIdSha256: observation.providerRequestIdSha256,
      physicalAttempt: observation.providerPhysicalAttempt,
      streamOrdinal: observation.providerStreamOrdinal,
      outcome: observation.providerOutcome,
      rawRequestIdExposed: observation.providerRawRequestIdExposed,
      label: "providerLifecycle",
      expectedOutcome: "completed",
    });
    const interruptedProviderLifecycle = joinedProviderLifecycle({
      phases: observation.interruptedProviderLifecyclePhases,
      requestIdSha256: observation.interruptedProviderRequestIdSha256,
      physicalAttempt: observation.interruptedProviderPhysicalAttempt,
      streamOrdinal: observation.interruptedProviderStreamOrdinal,
      outcome: observation.interruptedProviderOutcome,
      rawRequestIdExposed: observation.interruptedProviderRawRequestIdExposed,
      label: "interruptedProviderLifecycle",
      expectedOutcome: "canceled",
    });
    assert(
      completedProviderLifecycle.requestIdSha256 !==
        interruptedProviderLifecycle.requestIdSha256,
      "Completed and interrupted provider attempts must have distinct hashed request identities.",
    );
    assert(
      completedProviderLifecycle.streamOrdinal !==
        interruptedProviderLifecycle.streamOrdinal,
      "Completed and interrupted provider attempts must come from distinct supervised streams.",
    );
    booleanTrue(
      observation.interruptedProviderStoppedAfterJoin,
      "interruptedProviderStoppedAfterJoin",
    );
    return {
      localConversationId: boundedIdentifier(
        observation.localConversationId,
        "localConversationId",
      ),
      initialTurnId,
      continuationTurnId,
      childTurnId,
      providerRequestIdSha256: completedProviderLifecycle.requestIdSha256,
      // Assistant text is delivered whole, so the floor is one event per
      // turn — not the many per-token stream events this used to count. A
      // turn that calls a tool emits more (preamble, then the answer).
      assistantMessageEventCount: finiteInteger(
        observation.assistantMessageEventCount,
        "assistantMessageEventCount",
        1,
      ),
      providerLifecyclePhases: completedProviderLifecycle.phases,
      providerPhysicalAttempt: completedProviderLifecycle.physicalAttempt,
      providerStreamOrdinal: completedProviderLifecycle.streamOrdinal,
      providerOutcome: completedProviderLifecycle.outcome,
      providerRawRequestIdExposed:
        completedProviderLifecycle.rawRequestIdExposed,
      toolCallId: boundedIdentifier(observation.toolCallId, "toolCallId"),
      toolDispatchCount: finiteInteger(
        observation.toolDispatchCount,
        "toolDispatchCount",
        1,
      ),
      toolResultSha256: sha256Value(
        observation.toolResultSha256,
        "toolResultSha256",
      ),
      childCompletionObserved: booleanTrue(
        observation.childCompletionObserved,
        "childCompletionObserved",
      ),
      interruptionRequested: booleanTrue(
        observation.interruptionRequested,
        "interruptionRequested",
      ),
      interruptedProviderStopped: booleanTrue(
        observation.interruptedProviderStopped,
        "interruptedProviderStopped",
      ),
      interruptedProviderRequestIdSha256:
        interruptedProviderLifecycle.requestIdSha256,
      interruptedProviderLifecyclePhases: interruptedProviderLifecycle.phases,
      interruptedProviderPhysicalAttempt:
        interruptedProviderLifecycle.physicalAttempt,
      interruptedProviderStreamOrdinal:
        interruptedProviderLifecycle.streamOrdinal,
      interruptedProviderOutcome: interruptedProviderLifecycle.outcome,
      interruptedProviderRawRequestIdExposed:
        interruptedProviderLifecycle.rawRequestIdExposed,
      interruptedProviderStoppedAfterJoin: true,
      continuationObserved: booleanTrue(
        observation.continuationObserved,
        "continuationObserved",
      ),
      persistenceObserved: booleanTrue(
        observation.persistenceObserved,
        "persistenceObserved",
      ),
      processRestarted: booleanTrue(
        observation.processRestarted,
        "processRestarted",
      ),
      processIdBefore,
      processIdAfter,
      historySha256: historyAfter,
      profileDir,
      secondaryProfileDir,
      secondaryJwtSubjectSha256,
      secondaryJwtTokenIdentifierSha256,
      secondaryOwnerGenerationSha256,
      secondaryConversationIdSha256,
      secondaryIdentityClass: "connected-secondary",
      secondaryNonanonymousSession: true,
      secondaryCredentialMaterialInEvidence: false,
      secondarySessionProtectedAtRest: true,
      distinctDisposableOwners: true,
      secondaryOwnerFenceVerified: true,
      ordinaryConversationIsolationVerified: true,
      primaryOwnConversationVisible: true,
      primarySecondaryConversationHidden: true,
      secondaryOwnConversationVisible: true,
      secondaryPrimaryConversationHidden: true,
      cloudSandboxStarted: falseValue(
        observation.cloudSandboxStarted,
        "cloudSandboxStarted",
      ),
    };
  },
  electron_real_stream(observation) {
    const profileDir = safeIsolatedPath(
      existingDirectory(
        safeIsolatedPath(observation.profileDir, "profileDir"),
        "profileDir",
      ),
      "profileDir",
    );
    const canonicalUserDataDir = safeIsolatedPath(
      existingDirectory(
        path.join(profileDir, "user-data"),
        "profileDir/user-data",
      ),
      "profileDir/user-data",
    );
    const expectedHarnessAppName = `Stella v2 Harness ${sha256(canonicalUserDataDir).slice(0, 12)}`;
    const harnessAppNameSha256 = sha256Value(
      observation.harnessAppNameSha256,
      "harnessAppNameSha256",
    );
    assert(
      harnessAppNameSha256 === sha256(expectedHarnessAppName),
      "Electron harness app name is not derived from the canonical isolated userData profile.",
    );
    const renderedProofSetSha256 = sha256Value(
      observation.renderedProofSetSha256,
      "renderedProofSetSha256",
    );
    const rendered = validateRenderedProofs(observation.renderedProofs, {
      surface: "electron-cdp",
      requiredOperations: [
        "rendered.list-open",
        "rendered.send-terminal",
        "rendered.fail-closed",
        "rendered.mounted-resume",
        "rendered.same-target-reload",
      ],
      expectedSetSha256: renderedProofSetSha256,
      label: "electron_real_stream.renderedProofs",
    });
    return {
      conversationId: nonEmptyString(
        observation.conversationId,
        "conversationId",
      ),
      durableObjectIdSha256: sha256Value(
        observation.durableObjectIdSha256,
        "durableObjectIdSha256",
      ),
      journalEpoch: boundedIdentifier(observation.journalEpoch, "journalEpoch"),
      turnId: nonEmptyString(observation.turnId, "turnId"),
      // Committed `record` frames plus advisory `tool` frames. Per-token
      // `delta` frames no longer exist, so this counts live socket traffic
      // rather than streaming volume.
      liveEventCount: finiteInteger(
        observation.liveEventCount,
        "liveEventCount",
        2,
      ),
      journalHeadSeq: finiteInteger(
        observation.journalHeadSeq,
        "journalHeadSeq",
      ),
      finalTextSha256: sha256Value(
        observation.finalTextSha256,
        "finalTextSha256",
      ),
      profileDir,
      harnessAppNameSha256,
      harnessAppNameProfileBound: booleanTrue(
        observation.harnessAppNameProfileBound,
        "harnessAppNameProfileBound",
      ),
      renderedProofs: rendered.entries,
      renderedProofSetSha256,
      renderedCanonicalRowsSha256: sha256Value(
        observation.renderedCanonicalRowsSha256,
        "renderedCanonicalRowsSha256",
      ),
      renderedProcessInstanceSha256: sha256Value(
        observation.renderedProcessInstanceSha256,
        "renderedProcessInstanceSha256",
      ),
      doObserved: booleanTrue(observation.doObserved, "doObserved"),
    };
  },
  consecutive_durable_turns(observation) {
    const firstTurnId = boundedIdentifier(
      observation.firstTurnId,
      "firstTurnId",
    );
    const secondTurnId = boundedIdentifier(
      observation.secondTurnId,
      "secondTurnId",
    );
    assert(
      firstTurnId !== secondTurnId,
      "Consecutive durable turns must use distinct turn ids.",
    );
    const headBeforeSecond = finiteInteger(
      observation.journalHeadSeqBeforeSecond,
      "journalHeadSeqBeforeSecond",
    );
    const secondPromptSeq = finiteInteger(
      observation.secondPromptSeq,
      "secondPromptSeq",
      headBeforeSecond + 1,
    );
    const secondTerminalSeq = finiteInteger(
      observation.secondTerminalSeq,
      "secondTerminalSeq",
      secondPromptSeq + 1,
    );
    const headAfterSecond = finiteInteger(
      observation.journalHeadSeqAfterSecond,
      "journalHeadSeqAfterSecond",
      secondTerminalSeq,
    );
    assert(
      headAfterSecond > headBeforeSecond,
      "The second durable turn did not advance the journal head.",
    );
    return {
      conversationId: boundedIdentifier(
        observation.conversationId,
        "conversationId",
      ),
      durableObjectIdSha256: sha256Value(
        observation.durableObjectIdSha256,
        "durableObjectIdSha256",
      ),
      journalEpoch: boundedIdentifier(observation.journalEpoch, "journalEpoch"),
      firstTurnId,
      secondTurnId,
      firstTurnRecordCount: finiteInteger(
        observation.firstTurnRecordCount,
        "firstTurnRecordCount",
        2,
      ),
      secondTurnRecordCount: finiteInteger(
        observation.secondTurnRecordCount,
        "secondTurnRecordCount",
        2,
      ),
      journalHeadSeqBeforeSecond: headBeforeSecond,
      secondPromptSeq,
      secondTerminalSeq,
      journalHeadSeqAfterSecond: headAfterSecond,
      secondTurnObservedFirst: booleanTrue(
        observation.secondTurnObservedFirst,
        "secondTurnObservedFirst",
      ),
      secondResponseSha256: sha256Value(
        observation.secondResponseSha256,
        "secondResponseSha256",
      ),
      historySha256: sha256Value(observation.historySha256, "historySha256"),
    };
  },
  duplicate_delivery_idempotency(observation) {
    const firstReceipt = sha256Value(
      observation.firstReceiptSha256,
      "firstReceiptSha256",
    );
    const replayReceipt = sha256Value(
      observation.replayReceiptSha256,
      "replayReceiptSha256",
    );
    assert(
      firstReceipt === replayReceipt,
      "Duplicate delivery did not return the exact stored receipt.",
    );
    const headBeforeReplay = finiteInteger(
      observation.journalHeadSeqBeforeReplay,
      "journalHeadSeqBeforeReplay",
    );
    const headAfterReplay = finiteInteger(
      observation.journalHeadSeqAfterReplay,
      "journalHeadSeqAfterReplay",
    );
    assert(
      headBeforeReplay === headAfterReplay,
      "Duplicate delivery advanced the journal head.",
    );
    const rowsBeforeReplay = finiteInteger(
      observation.journalRowCountBeforeReplay,
      "journalRowCountBeforeReplay",
      1,
    );
    const rowsAfterReplay = finiteInteger(
      observation.journalRowCountAfterReplay,
      "journalRowCountAfterReplay",
      1,
    );
    assert(
      rowsBeforeReplay === rowsAfterReplay,
      "Duplicate delivery changed the journal row count.",
    );
    assert(
      observation.promptRecordCount === 1,
      "Duplicate delivery must retain exactly one prompt record.",
    );
    assert(
      observation.terminalRecordCount === 1,
      "Duplicate delivery must retain exactly one terminal record.",
    );
    return {
      conversationId: boundedIdentifier(
        observation.conversationId,
        "conversationId",
      ),
      durableObjectIdSha256: sha256Value(
        observation.durableObjectIdSha256,
        "durableObjectIdSha256",
      ),
      journalEpoch: boundedIdentifier(observation.journalEpoch, "journalEpoch"),
      turnId: boundedIdentifier(observation.turnId, "turnId"),
      clientMsgIdSha256: sha256Value(
        observation.clientMsgIdSha256,
        "clientMsgIdSha256",
      ),
      deliveryFingerprintSha256: sha256Value(
        observation.deliveryFingerprintSha256,
        "deliveryFingerprintSha256",
      ),
      firstReceiptSha256: firstReceipt,
      replayReceiptSha256: replayReceipt,
      journalHeadSeqBeforeReplay: headBeforeReplay,
      journalHeadSeqAfterReplay: headAfterReplay,
      journalRowCountBeforeReplay: rowsBeforeReplay,
      journalRowCountAfterReplay: rowsAfterReplay,
      promptRecordCount: 1,
      terminalRecordCount: 1,
      terminalKind: exactLiteral(
        observation.terminalKind,
        "completed",
        "terminalKind",
      ),
      receiptReplayed: booleanTrue(
        observation.receiptReplayed,
        "receiptReplayed",
      ),
      duplicateAppendPrevented: booleanTrue(
        observation.duplicateAppendPrevented,
        "duplicateAppendPrevented",
      ),
    };
  },
  electron_restart_reconnect(observation) {
    const before = sha256Value(
      observation.historySha256Before,
      "historySha256Before",
    );
    const after = sha256Value(
      observation.historySha256After,
      "historySha256After",
    );
    assert(before === after, "History changed across restart/reconnect.");
    const headBefore = finiteInteger(
      observation.journalHeadSeqBefore,
      "journalHeadSeqBefore",
    );
    const headAfter = finiteInteger(
      observation.journalHeadSeqAfter,
      "journalHeadSeqAfter",
    );
    assert(headBefore === headAfter, "Journal head changed across reconnect.");
    const renderedProofSetSha256 = sha256Value(
      observation.renderedProofSetSha256,
      "electron_restart_reconnect.renderedProofSetSha256",
    );
    const rendered = validateRenderedProofs(observation.renderedProofs, {
      surface: "electron-cdp",
      requiredOperations: [
        "rendered.identity-round-trip",
        "rendered.cold-process",
      ],
      expectedSetSha256: renderedProofSetSha256,
      label: "electron_restart_reconnect.renderedProofs",
    });
    const identityProof = rendered.byOperation.get(
      "rendered.identity-round-trip",
    );
    const coldProof = rendered.byOperation.get("rendered.cold-process");
    const previousProcessInstanceSha256 = sha256Value(
      observation.previousProcessInstanceSha256,
      "electron_restart_reconnect.previousProcessInstanceSha256",
    );
    const currentProcessInstanceSha256 = sha256Value(
      observation.currentProcessInstanceSha256,
      "electron_restart_reconnect.currentProcessInstanceSha256",
    );
    const secondaryProcessBeforeSha256 = sha256Value(
      observation.secondaryProcessBeforeSha256,
      "electron_restart_reconnect.secondaryProcessBeforeSha256",
    );
    const secondaryProcessAfterSha256 = sha256Value(
      observation.secondaryProcessAfterSha256,
      "electron_restart_reconnect.secondaryProcessAfterSha256",
    );
    assert(
      previousProcessInstanceSha256 !== currentProcessInstanceSha256 &&
        secondaryProcessBeforeSha256 !== secondaryProcessAfterSha256 &&
        identityProof.receipt.processInstanceSha256 ===
          previousProcessInstanceSha256 &&
        identityProof.observation.primaryProcessInstanceSha256 ===
          previousProcessInstanceSha256 &&
        identityProof.observation.secondaryProcessBeforeSha256 ===
          secondaryProcessBeforeSha256 &&
        identityProof.observation.secondaryProcessAfterSha256 ===
          secondaryProcessAfterSha256 &&
        coldProof.receipt.processInstanceSha256 ===
          currentProcessInstanceSha256 &&
        coldProof.observation.previousProcessInstanceSha256 ===
          previousProcessInstanceSha256 &&
        coldProof.observation.currentProcessInstanceSha256 ===
          currentProcessInstanceSha256,
      "Electron A/B/A or cold-process receipts are not bound to the exact process transitions.",
    );
    assert(
      sha256Value(
        observation.identityRoundTripSha256,
        "electron_restart_reconnect.identityRoundTripSha256",
      ) === identityProof.receipt.receiptSha256 &&
        sha256Value(
          observation.coldProjectionSha256,
          "electron_restart_reconnect.coldProjectionSha256",
        ) === coldProof.observation.canonicalRowsSha256 &&
        sha256Value(
          observation.previousStopReceiptSha256,
          "electron_restart_reconnect.previousStopReceiptSha256",
        ) === coldProof.observation.priorStopReceiptSha256,
      "Electron restart receipt hashes do not bind the rendered cold/identity observations.",
    );
    return {
      conversationId: nonEmptyString(
        observation.conversationId,
        "conversationId",
      ),
      durableObjectIdSha256: sha256Value(
        observation.durableObjectIdSha256,
        "durableObjectIdSha256",
      ),
      journalEpoch: boundedIdentifier(observation.journalEpoch, "journalEpoch"),
      processRestarted: booleanTrue(
        observation.processRestarted,
        "processRestarted",
      ),
      socketReconnected: booleanTrue(
        observation.socketReconnected,
        "socketReconnected",
      ),
      historySha256: after,
      journalHeadSeqBefore: headBefore,
      journalHeadSeqAfter: headAfter,
      renderedProofs: rendered.entries,
      renderedProofSetSha256,
      previousProcessInstanceSha256,
      currentProcessInstanceSha256,
      previousStopReceiptSha256: observation.previousStopReceiptSha256,
      coldProjectionSha256: observation.coldProjectionSha256,
      identityRoundTripSha256: observation.identityRoundTripSha256,
      secondaryProcessBeforeSha256,
      secondaryProcessAfterSha256,
    };
  },
  clean_client_hydration(observation) {
    const profileA = safeIsolatedPath(
      existingDirectory(
        safeIsolatedPath(observation.profileA, "profileA"),
        "profileA",
      ),
      "profileA",
    );
    const profileB = safeIsolatedPath(
      existingDirectory(
        safeIsolatedPath(observation.profileB, "profileB"),
        "profileB",
      ),
      "profileB",
    );
    assert(profileA !== profileB, "Clean-client profiles must be distinct.");
    return {
      conversationId: nonEmptyString(
        observation.conversationId,
        "conversationId",
      ),
      profileA,
      profileB,
      profileBInitiallyHadConversationState:
        observation.profileBInitiallyHadConversationState === false
          ? false
          : (() => {
              throw new CloudProofError(
                "profileBInitiallyHadConversationState must be false.",
              );
            })(),
      profileBHadPreparedAuthOnly: booleanTrue(
        observation.profileBHadPreparedAuthOnly,
        "profileBHadPreparedAuthOnly",
      ),
      profileBInitialStateSha256: sha256Value(
        observation.profileBInitialStateSha256,
        "profileBInitialStateSha256",
      ),
      discoveredFromConvex: booleanTrue(
        observation.discoveredFromConvex,
        "discoveredFromConvex",
      ),
      hydratedFromCloud: booleanTrue(
        observation.hydratedFromCloud,
        "hydratedFromCloud",
      ),
      historySha256: sha256Value(observation.historySha256, "historySha256"),
    };
  },
  cache_loss_recovery(observation) {
    const before = sha256Value(
      observation.historySha256Before,
      "historySha256Before",
    );
    const after = sha256Value(
      observation.historySha256After,
      "historySha256After",
    );
    assert(before === after, "History changed after cache loss.");
    const declaredCachePath = safeIsolatedPath(
      observation.cachePath,
      "cachePath",
    );
    const cachePath = safeIsolatedPath(
      futureFile(declaredCachePath, "cachePath"),
      "cachePath",
    );
    return {
      conversationId: nonEmptyString(
        observation.conversationId,
        "conversationId",
      ),
      cachePath,
      cacheDeleted: booleanTrue(observation.cacheDeleted, "cacheDeleted"),
      hydratedFromCloud: booleanTrue(
        observation.hydratedFromCloud,
        "hydratedFromCloud",
      ),
      historySha256: after,
    };
  },
  projection_and_r2(observation, context) {
    const headSeq = finiteInteger(observation.journalHeadSeq, "journalHeadSeq");
    const synced = finiteInteger(observation.indexSyncedSeq, "indexSyncedSeq");
    const conversationId = nonEmptyString(
      observation.conversationId,
      "conversationId",
    );
    const r2ObjectKey = nonEmptyString(observation.r2ObjectKey, "r2ObjectKey");
    assert(
      /^conversations\/[a-f0-9]{64}\/[0-9a-f-]{36}\/seg\/.+\.jsonl\.gz$/.test(
        r2ObjectKey,
      ) &&
        r2ObjectKey.startsWith(
          `conversations/${context.identity.ownerIdSha256}/${conversationId}/seg/`,
        ),
      "r2ObjectKey is not the real owner-bound archive key for this conversation.",
    );
    const r2Etag = nonEmptyString(observation.r2Etag, "r2Etag");
    assert(/^[A-Za-z0-9'"_-]{8,256}$/.test(r2Etag), "r2Etag is malformed.");
    assert(
      synced === headSeq,
      "Convex projection is not caught up to the DO head.",
    );
    return {
      conversationId,
      journalEpoch: boundedIdentifier(observation.journalEpoch, "journalEpoch"),
      doSqliteCanonical: booleanTrue(
        observation.doSqliteCanonical,
        "doSqliteCanonical",
      ),
      journalGapless: booleanTrue(observation.journalGapless, "journalGapless"),
      journalHeadSeq: headSeq,
      indexSyncedSeq: synced,
      staleProjectionRejected: booleanTrue(
        observation.staleProjectionRejected,
        "staleProjectionRejected",
      ),
      r2HotRows: finiteInteger(observation.r2HotRows, "r2HotRows", 1),
      r2ColdRows: finiteInteger(observation.r2ColdRows, "r2ColdRows", 1),
      r2ObjectKey,
      r2Etag,
      r2Bytes: finiteInteger(observation.r2Bytes, "r2Bytes", 1),
      coldHistorySha256: sha256Value(
        observation.coldHistorySha256,
        "coldHistorySha256",
      ),
      hotHistorySha256: sha256Value(
        observation.hotHistorySha256,
        "hotHistorySha256",
      ),
      coldHistoryRead: booleanTrue(
        observation.coldHistoryRead,
        "coldHistoryRead",
      ),
    };
  },
  cancellation(observation) {
    assert(
      observation.terminalKind === "canceled",
      "terminalKind must be canceled.",
    );
    assert(
      observation.terminalRecordCount === 1,
      "Cancellation must write exactly one terminal record.",
    );
    return {
      conversationId: nonEmptyString(
        observation.conversationId,
        "conversationId",
      ),
      turnId: nonEmptyString(observation.turnId, "turnId"),
      cancelRequested: booleanTrue(
        observation.cancelRequested,
        "cancelRequested",
      ),
      providerStopped: booleanTrue(
        observation.providerStopped,
        "providerStopped",
      ),
      terminalKind: "canceled",
      terminalRecordCount: 1,
      reconnectIdle: booleanTrue(observation.reconnectIdle, "reconnectIdle"),
    };
  },
  cloud_failure_no_local_fallback(observation) {
    const before = finiteInteger(
      observation.localAuthorityRowsBefore,
      "localAuthorityRowsBefore",
    );
    const after = finiteInteger(
      observation.localAuthorityRowsAfter,
      "localAuthorityRowsAfter",
    );
    assert(
      before === after,
      "Cloud failure created a local-authoritative row.",
    );
    const digestBefore = sha256Value(
      observation.localAuthoritySha256Before,
      "localAuthoritySha256Before",
    );
    const digestAfter = sha256Value(
      observation.localAuthoritySha256After,
      "localAuthoritySha256After",
    );
    assert(
      digestBefore === digestAfter,
      "Cloud failure changed local-authoritative state.",
    );
    assert(
      observation.localExecutionStarted === false,
      "Cloud failure silently started local execution.",
    );
    const providerDispatchCountBefore = finiteInteger(
      observation.providerDispatchCountBefore,
      "providerDispatchCountBefore",
    );
    const providerDispatchCountAfter = finiteInteger(
      observation.providerDispatchCountAfter,
      "providerDispatchCountAfter",
    );
    assert(
      providerDispatchCountBefore === providerDispatchCountAfter,
      "Cold canonical prompt failure dispatched a model/provider request.",
    );
    const promptFailureTurnId = boundedIdentifier(observation.turnId, "turnId");
    const canonicalHistoryTurnId = boundedIdentifier(
      observation.canonicalHistoryTurnId,
      "canonicalHistoryTurnId",
    );
    assert(
      canonicalHistoryTurnId !== promptFailureTurnId,
      "Canonical prompt and canonical history failures must use distinct turns.",
    );
    const canonicalHistoryProviderDispatchCountBefore = finiteInteger(
      observation.canonicalHistoryProviderDispatchCountBefore,
      "canonicalHistoryProviderDispatchCountBefore",
    );
    const canonicalHistoryProviderDispatchCountAfter = finiteInteger(
      observation.canonicalHistoryProviderDispatchCountAfter,
      "canonicalHistoryProviderDispatchCountAfter",
    );
    assert(
      canonicalHistoryProviderDispatchCountBefore ===
        canonicalHistoryProviderDispatchCountAfter,
      "Malformed canonical history dispatched a model/provider request.",
    );
    assert(
      canonicalHistoryProviderDispatchCountBefore ===
        providerDispatchCountAfter,
      "Provider dispatch accounting changed between the two fail-closed context scenarios.",
    );
    const canonicalHistoryContextFirstSeq = finiteInteger(
      observation.canonicalHistoryContextFirstSeq,
      "canonicalHistoryContextFirstSeq",
    );
    const canonicalHistoryContextLastSeq = finiteInteger(
      observation.canonicalHistoryContextLastSeq,
      "canonicalHistoryContextLastSeq",
      canonicalHistoryContextFirstSeq,
    );
    const canonicalHistoryCorruptSeq = finiteInteger(
      observation.canonicalHistoryCorruptSeq,
      "canonicalHistoryCorruptSeq",
      canonicalHistoryContextFirstSeq,
    );
    assert(
      canonicalHistoryCorruptSeq <= canonicalHistoryContextLastSeq,
      "Malformed canonical row was not inside the active context window.",
    );
    const canonicalHistoryFailedEventSeq = finiteInteger(
      observation.canonicalHistoryFailedEventSeq,
      "canonicalHistoryFailedEventSeq",
      canonicalHistoryContextLastSeq + 1,
    );
    const corruptPayloadBefore = sha256Value(
      observation.canonicalHistoryCorruptPayloadSha256Before,
      "canonicalHistoryCorruptPayloadSha256Before",
    );
    const corruptPayloadAfter = sha256Value(
      observation.canonicalHistoryCorruptPayloadSha256After,
      "canonicalHistoryCorruptPayloadSha256After",
    );
    assert(
      corruptPayloadBefore === corruptPayloadAfter,
      "Malformed canonical row changed instead of being preserved for repair.",
    );
    const originalPayload = sha256Value(
      observation.canonicalHistoryOriginalPayloadSha256,
      "canonicalHistoryOriginalPayloadSha256",
    );
    const repairedPayload = sha256Value(
      observation.canonicalHistoryRepairedPayloadSha256,
      "canonicalHistoryRepairedPayloadSha256",
    );
    assert(
      originalPayload === repairedPayload,
      "Canonical history repair was not byte-identical to its original payload.",
    );
    const dispatchCountAfterRepair = finiteInteger(
      observation.canonicalHistoryProviderDispatchCountAfterRepair,
      "canonicalHistoryProviderDispatchCountAfterRepair",
      canonicalHistoryProviderDispatchCountAfter + 1,
    );
    const repairTurnId = boundedIdentifier(
      observation.canonicalHistoryRepairTurnId,
      "canonicalHistoryRepairTurnId",
    );
    assert(
      repairTurnId !== promptFailureTurnId &&
        repairTurnId !== canonicalHistoryTurnId,
      "Canonical history repair must resume in a distinct turn.",
    );
    return {
      conversationId: nonEmptyString(
        observation.conversationId,
        "conversationId",
      ),
      turnId: promptFailureTurnId,
      cloudFailureInjected: booleanTrue(
        observation.cloudFailureInjected,
        "cloudFailureInjected",
      ),
      userVisibleFailure: booleanTrue(
        observation.userVisibleFailure,
        "userVisibleFailure",
      ),
      localAuthorityRowsBefore: before,
      localAuthorityRowsAfter: after,
      localAuthoritySha256: digestAfter,
      localExecutionStarted: false,
      canonicalContextFailureExplicit: booleanTrue(
        observation.canonicalContextFailureExplicit,
        "canonicalContextFailureExplicit",
      ),
      canonicalContextFailureCode: exactLiteral(
        observation.canonicalContextFailureCode,
        "CLOUD_CONTEXT_UNAVAILABLE",
        "canonicalContextFailureCode",
      ),
      canonicalContextFailureComponent: exactLiteral(
        observation.canonicalContextFailureComponent,
        "canonical_prompt",
        "canonicalContextFailureComponent",
      ),
      canonicalContextTerminalKind: exactLiteral(
        observation.canonicalContextTerminalKind,
        "failed",
        "canonicalContextTerminalKind",
      ),
      canonicalFallbackPromptUsed: falseValue(
        observation.canonicalFallbackPromptUsed,
        "canonicalFallbackPromptUsed",
      ),
      providerDispatchCountBefore,
      providerDispatchCountAfter,
      canonicalHistoryTurnId,
      canonicalHistoryFailureInjected: booleanTrue(
        observation.canonicalHistoryFailureInjected,
        "canonicalHistoryFailureInjected",
      ),
      canonicalHistoryUserVisibleFailure: booleanTrue(
        observation.canonicalHistoryUserVisibleFailure,
        "canonicalHistoryUserVisibleFailure",
      ),
      canonicalHistoryFailureExplicit: booleanTrue(
        observation.canonicalHistoryFailureExplicit,
        "canonicalHistoryFailureExplicit",
      ),
      canonicalHistoryFailureCode: exactLiteral(
        observation.canonicalHistoryFailureCode,
        "CLOUD_CONTEXT_UNAVAILABLE",
        "canonicalHistoryFailureCode",
      ),
      canonicalHistoryFailureComponent: exactLiteral(
        observation.canonicalHistoryFailureComponent,
        "canonical_history",
        "canonicalHistoryFailureComponent",
      ),
      canonicalHistoryTerminalKind: exactLiteral(
        observation.canonicalHistoryTerminalKind,
        "failed",
        "canonicalHistoryTerminalKind",
      ),
      canonicalHistoryFallbackUsed: falseValue(
        observation.canonicalHistoryFallbackUsed,
        "canonicalHistoryFallbackUsed",
      ),
      canonicalHistoryProviderDispatchCountBefore,
      canonicalHistoryProviderDispatchCountAfter,
      canonicalHistoryContextFirstSeq,
      canonicalHistoryContextLastSeq,
      canonicalHistoryCorruptSeq,
      canonicalHistoryFailedEventSeq,
      canonicalHistoryCorruptPayloadSha256Before: corruptPayloadBefore,
      canonicalHistoryCorruptPayloadSha256After: corruptPayloadAfter,
      canonicalHistoryCorruptRowModelSkip: falseValue(
        observation.canonicalHistoryCorruptRowModelSkip,
        "canonicalHistoryCorruptRowModelSkip",
      ),
      canonicalHistoryCorruptRowPreserved: booleanTrue(
        observation.canonicalHistoryCorruptRowPreserved,
        "canonicalHistoryCorruptRowPreserved",
      ),
      canonicalHistoryReconnectObservedFailure: booleanTrue(
        observation.canonicalHistoryReconnectObservedFailure,
        "canonicalHistoryReconnectObservedFailure",
      ),
      canonicalHistoryRestartObservedFailure: booleanTrue(
        observation.canonicalHistoryRestartObservedFailure,
        "canonicalHistoryRestartObservedFailure",
      ),
      canonicalHistoryRepairObserved: booleanTrue(
        observation.canonicalHistoryRepairObserved,
        "canonicalHistoryRepairObserved",
      ),
      canonicalHistoryOriginalPayloadSha256: originalPayload,
      canonicalHistoryRepairedPayloadSha256: repairedPayload,
      canonicalHistoryRepairTurnId: repairTurnId,
      canonicalHistoryRepairTerminalKind: exactLiteral(
        observation.canonicalHistoryRepairTerminalKind,
        "completed",
        "canonicalHistoryRepairTerminalKind",
      ),
      canonicalHistoryProviderDispatchCountAfterRepair:
        dispatchCountAfterRepair,
    };
  },
  desktop_local_routing(observation) {
    assert(
      observation.chosenLocation === "computer",
      "Desktop route must choose computer.",
    );
    assert(
      observation.executedBy === "local-runtime",
      "Desktop route must execute locally.",
    );
    assert(
      observation.cloudSandboxStarted === false,
      "Desktop local route started a cloud sandbox.",
    );
    return {
      conversationId: boundedIdentifier(
        observation.conversationId,
        "conversationId",
      ),
      turnId: nonEmptyString(observation.turnId, "turnId"),
      subject: exactLiteral(observation.subject, "computer", "subject"),
      workspace: exactLiteral(observation.workspace, "computer", "workspace"),
      chosenLocation: "computer",
      executedBy: "local-runtime",
      cloudSandboxStarted: false,
      fenceVerified: booleanTrue(observation.fenceVerified, "fenceVerified"),
    };
  },
  mobile_reachable_computer_routing(observation) {
    assert(
      observation.chosenLocation === "computer",
      "Reachable mobile route must choose computer.",
    );
    assert(
      observation.executedBy === "paired-computer",
      "Reachable mobile route must execute on its pair.",
    );
    assert(
      observation.cloudSandboxStarted === false,
      "Reachable mobile route started a cloud sandbox.",
    );
    return {
      conversationId: boundedIdentifier(
        observation.conversationId,
        "conversationId",
      ),
      turnId: nonEmptyString(observation.turnId, "turnId"),
      deviceClaimId: nonEmptyString(observation.deviceClaimId, "deviceClaimId"),
      subject: exactLiteral(observation.subject, "computer", "subject"),
      workspace: exactLiteral(observation.workspace, "computer", "workspace"),
      chosenLocation: "computer",
      executedBy: "paired-computer",
      cloudSandboxStarted: false,
      fenceVerified: booleanTrue(observation.fenceVerified, "fenceVerified"),
    };
  },
  mobile_unreachable_cloud_routing(observation) {
    assert(
      observation.chosenLocation === "cloud",
      "Unreachable mobile route must choose cloud.",
    );
    assert(
      observation.localRuntimeStarted === false,
      "Unreachable mobile route silently ran locally.",
    );
    return {
      conversationId: boundedIdentifier(
        observation.conversationId,
        "conversationId",
      ),
      turnId: nonEmptyString(observation.turnId, "turnId"),
      subject: exactLiteral(observation.subject, "computer", "subject"),
      workspace: exactLiteral(observation.workspace, "computer", "workspace"),
      chosenLocation: "cloud",
      realSandboxStarted: booleanTrue(
        observation.realSandboxStarted,
        "realSandboxStarted",
      ),
      localRuntimeStarted: false,
      fenceVerified: booleanTrue(observation.fenceVerified, "fenceVerified"),
    };
  },
  mobile_signed_in_canonical_sync(observation, context) {
    exactRecord(
      observation,
      [
        "conversationId",
        "turnId",
        "dispatchId",
        "ownerGeneration",
        "chosenLocation",
        "terminalState",
        "terminalRevision",
        "journalEpoch",
        "promptSeq",
        "terminalSeq",
        "durableObjectIdSha256",
        "fenceVerified",
        "serverAuthorityFence",
        "mountedRn",
        "mountedRnResultSha256",
        "receiptSetSha256",
      ],
      "mobile_signed_in_canonical_sync",
    );
    const conversationId = boundedIdentifier(
      observation.conversationId,
      "conversationId",
    );
    const turnId = boundedIdentifier(observation.turnId, "turnId");
    const dispatchId = boundedIdentifier(observation.dispatchId, "dispatchId");
    const ownerGeneration = boundedIdentifier(
      observation.ownerGeneration,
      "ownerGeneration",
    );
    assert(
      ownerGeneration === context.identity.ownerGeneration,
      "Signed-in mobile execution is not bound to the current acceptance owner generation.",
    );
    const promptSeq = finiteInteger(observation.promptSeq, "promptSeq", 0);
    const terminalSeq = finiteInteger(
      observation.terminalSeq,
      "terminalSeq",
      promptSeq + 1,
    );

    const serverAuthorityFence = exactRecord(
      observation.serverAuthorityFence,
      [
        "anonymousAccountAdmissionStatus",
        "anonymousAccountStatusProbeStatus",
        "anonymousAccountCancelProbeStatus",
        "anonymousAccountPolicyReasonSha256",
        "initialCrossOwnerSocketCloseCode",
        "liveSocketIdentitySwitchCloseCode",
        "anonymousAccountAdmissionRejected",
        "initialCrossOwnerSocketPrivateNotFound",
        "liveSocketIdentitySwitchRejected",
      ],
      "serverAuthorityFence",
    );
    exactInteger(
      serverAuthorityFence.anonymousAccountAdmissionStatus,
      403,
      "serverAuthorityFence.anonymousAccountAdmissionStatus",
    );
    exactInteger(
      serverAuthorityFence.anonymousAccountStatusProbeStatus,
      403,
      "serverAuthorityFence.anonymousAccountStatusProbeStatus",
    );
    exactInteger(
      serverAuthorityFence.anonymousAccountCancelProbeStatus,
      403,
      "serverAuthorityFence.anonymousAccountCancelProbeStatus",
    );
    assert(
      sha256Value(
        serverAuthorityFence.anonymousAccountPolicyReasonSha256,
        "serverAuthorityFence.anonymousAccountPolicyReasonSha256",
      ) === sha256("Sign in with an account to use Stella mobile."),
      "serverAuthorityFence anonymous policy reason does not match the shipped account gate.",
    );
    exactInteger(
      serverAuthorityFence.initialCrossOwnerSocketCloseCode,
      4404,
      "serverAuthorityFence.initialCrossOwnerSocketCloseCode",
    );
    exactInteger(
      serverAuthorityFence.liveSocketIdentitySwitchCloseCode,
      4403,
      "serverAuthorityFence.liveSocketIdentitySwitchCloseCode",
    );
    booleanTrue(
      serverAuthorityFence.anonymousAccountAdmissionRejected,
      "serverAuthorityFence.anonymousAccountAdmissionRejected",
    );
    booleanTrue(
      serverAuthorityFence.initialCrossOwnerSocketPrivateNotFound,
      "serverAuthorityFence.initialCrossOwnerSocketPrivateNotFound",
    );
    booleanTrue(
      serverAuthorityFence.liveSocketIdentitySwitchRejected,
      "serverAuthorityFence.liveSocketIdentitySwitchRejected",
    );

    const mountedRn = exactRecord(
      observation.mountedRn,
      [
        "version",
        "contract",
        "mode",
        "passed",
        "runtime",
        "boundary",
        "authority",
        "enqueue",
        "replay",
        "clean",
        "generationCanaryOutboxStateSha256",
        "receipts",
        "summarySha256",
      ],
      "mountedRn",
    );
    exactInteger(mountedRn.version, 2, "mountedRn.version");
    exactLiteral(
      mountedRn.contract,
      "stella-mobile-rn-canonical-v2",
      "mountedRn.contract",
    );
    exactLiteral(mountedRn.mode, "full", "mountedRn.mode");
    booleanTrue(mountedRn.passed, "mountedRn.passed");

    const runtime = exactRecord(
      mountedRn.runtime,
      [
        "bunVersion",
        "executor",
        "renderer",
        "actualSignedInChatHookMounted",
        "actualProductScreenMounted",
        "actualAsyncStoragePackage",
        "actualAsyncStorageWrapper",
        "actualAppStateSubscription",
        "realHttp",
        "realWebSocket",
        "productModuleSha256",
      ],
      "mountedRn.runtime",
    );
    const bunVersion = nonEmptyString(
      runtime.bunVersion,
      "mountedRn.runtime.bunVersion",
    );
    assert(
      /^1\.4\.[0-9]+(?:[-+].*)?$/u.test(bunVersion),
      "mountedRn.runtime.bunVersion must identify Bun 1.4.x.",
    );
    exactLiteral(
      runtime.executor,
      "bun-jsdom-react-native-web",
      "mountedRn.runtime.executor",
    );
    exactLiteral(
      runtime.renderer,
      "react-dom-react-native-web",
      "mountedRn.runtime.renderer",
    );
    booleanTrue(
      runtime.actualSignedInChatHookMounted,
      "mountedRn.runtime.actualSignedInChatHookMounted",
    );
    falseValue(
      runtime.actualProductScreenMounted,
      "mountedRn.runtime.actualProductScreenMounted",
    );
    for (const field of [
      "actualAsyncStoragePackage",
      "actualAsyncStorageWrapper",
      "actualAppStateSubscription",
      "realHttp",
      "realWebSocket",
    ]) {
      booleanTrue(runtime[field], `mountedRn.runtime.${field}`);
    }
    const productModuleSha256 = exactRecord(
      runtime.productModuleSha256,
      MOBILE_RN_PRODUCT_MODULES,
      "mountedRn.runtime.productModuleSha256",
    );
    for (const filename of MOBILE_RN_PRODUCT_MODULES) {
      const observedDigest = sha256Value(
        productModuleSha256[filename],
        `mountedRn.runtime.productModuleSha256.${filename}`,
      );
      const expectedDigest = sha256(
        readFileSync(path.join(REPO_ROOT, "packages/mobile/src/lib", filename)),
      );
      assert(
        observedDigest === expectedDigest,
        `mountedRn.runtime.productModuleSha256.${filename} does not match the reviewed product module.`,
      );
    }

    const boundary = exactRecord(
      mountedRn.boundary,
      [
        "javascriptProcessRestartProved",
        "reactNativeWebUiInteractionProved",
        "asyncStorageWebAdapterProved",
        "appStateVisibilityLifecycleProved",
        "realDevHttpAndWebSocketProved",
        "expoNativeBinaryProved",
        "nativeAsyncStorageBackendProved",
        "osProcessDeathProved",
        "nativeAppStateDeliveryProved",
        "nativeLayoutAndTouchProved",
      ],
      "mountedRn.boundary",
    );
    for (const field of [
      "javascriptProcessRestartProved",
      "reactNativeWebUiInteractionProved",
      "asyncStorageWebAdapterProved",
      "appStateVisibilityLifecycleProved",
      "realDevHttpAndWebSocketProved",
    ]) {
      booleanTrue(boundary[field], `mountedRn.boundary.${field}`);
    }
    for (const field of [
      "expoNativeBinaryProved",
      "nativeAsyncStorageBackendProved",
      "osProcessDeathProved",
      "nativeAppStateDeliveryProved",
      "nativeLayoutAndTouchProved",
    ]) {
      falseValue(boundary[field], `mountedRn.boundary.${field}`);
    }

    const authority = mobileRnAuthority(
      mountedRn.authority,
      "mountedRn.authority",
    );
    assert(
      authority.ownerGenerationSha256 === sha256(ownerGeneration) &&
        authority.conversationIdSha256 === sha256(conversationId) &&
        authority.socketOriginSha256 === sha256(context.target.cloudBuilderUrl),
      "Mounted RN authority hashes do not bind the exact generation, conversation, and builder origin.",
    );

    const enqueue = exactRecord(
      mountedRn.enqueue,
      [
        "phase",
        "passed",
        "processIdSha256",
        "mountIdSha256",
        "authority",
        "storageStateSha256",
        "promptSha256",
        "sendIdSha256",
        "dispatchIdSha256",
        "uiSendAccepted",
        "asyncStorageWriteCompletedBeforeNetwork",
        "serverCommittedBeforeResponseLoss",
        "responseWithheldFromHook",
        "processExitsWithPendingOutbox",
        "ordering",
        "receipts",
      ],
      "mountedRn.enqueue",
    );
    exactLiteral(
      enqueue.phase,
      "enqueue_response_loss",
      "mountedRn.enqueue.phase",
    );
    booleanTrue(enqueue.passed, "mountedRn.enqueue.passed");
    for (const field of [
      "processIdSha256",
      "mountIdSha256",
      "storageStateSha256",
      "promptSha256",
      "sendIdSha256",
      "dispatchIdSha256",
    ]) {
      sha256Value(enqueue[field], `mountedRn.enqueue.${field}`);
    }
    assertSameMobileRnAuthority(
      mobileRnAuthority(enqueue.authority, "mountedRn.enqueue.authority"),
      authority,
      "Mounted RN enqueue authority differs from the full-result authority.",
    );
    for (const field of [
      "uiSendAccepted",
      "asyncStorageWriteCompletedBeforeNetwork",
      "serverCommittedBeforeResponseLoss",
      "responseWithheldFromHook",
      "processExitsWithPendingOutbox",
    ]) {
      booleanTrue(enqueue[field], `mountedRn.enqueue.${field}`);
    }
    const enqueueOrdering = exactRecord(
      enqueue.ordering,
      [
        "asyncStorageWriteCompletion",
        "submitStart",
        "serverResponse",
        "responseWithheld",
      ],
      "mountedRn.enqueue.ordering",
    );
    const enqueueOrdinals = [
      "asyncStorageWriteCompletion",
      "submitStart",
      "serverResponse",
      "responseWithheld",
    ].map((field) =>
      finiteInteger(
        enqueueOrdering[field],
        `mountedRn.enqueue.ordering.${field}`,
        1,
      ),
    );
    assert(
      enqueueOrdinals.every(
        (ordinal, index) => index === 0 || ordinal > enqueueOrdinals[index - 1],
      ),
      "Mounted RN enqueue ordering must prove storage completion before submit, server response, and response withholding.",
    );
    assert(
      Array.isArray(enqueue.receipts) && enqueue.receipts.length === 2,
      "mountedRn.enqueue.receipts must contain exactly two receipts.",
    );
    const enqueueUiReceipt = mobileRnReceipt({
      value: enqueue.receipts[0],
      label: "mountedRn.enqueue.receipts[0]",
      expected: {
        surface: "mobile-client",
        operation: "mobile.rn.ui-send",
        outcome: "accepted",
        fields: ["requestIdSha256", "stateSha256"],
        sha256Fields: ["requestIdSha256", "stateSha256"],
      },
    });
    const enqueueHttpReceipt = mobileRnReceipt({
      value: enqueue.receipts[1],
      label: "mountedRn.enqueue.receipts[1]",
      expected: {
        surface: "mobile-http",
        operation: "mobile.execution.submit.response-loss",
        outcome: "committed-response-withheld",
        fields: [
          "status",
          "requestIdSha256",
          "resourceIdSha256",
          "responseSha256",
        ],
        sha256Fields: ["requestIdSha256", "resourceIdSha256", "responseSha256"],
        status: true,
      },
    });
    assert(
      enqueueUiReceipt.requestIdSha256 === enqueue.sendIdSha256 &&
        enqueueHttpReceipt.requestIdSha256 === enqueue.sendIdSha256 &&
        enqueueHttpReceipt.resourceIdSha256 === enqueue.dispatchIdSha256,
      "Mounted RN enqueue receipts do not bind the durable send and dispatch identities.",
    );

    const replay = exactRecord(
      mountedRn.replay,
      [
        "phase",
        "passed",
        "processIdSha256",
        "mountIdSha256",
        "authority",
        "secondaryAuthority",
        "storageStateSha256",
        "sendIdSha256",
        "dispatchIdSha256",
        "restoredQueuedMessage",
        "replayCollapsedToCommittedDispatch",
        "acknowledgedAfterTerminal",
        "priorStateSha256",
        "terminalAcknowledgementOrdering",
        "cursorReconnect",
        "appState",
        "identitySwitch",
        "noLocalFallback",
        "messageStateSha256",
        "receipts",
      ],
      "mountedRn.replay",
    );
    exactLiteral(
      replay.phase,
      "replay_reconnect_switch",
      "mountedRn.replay.phase",
    );
    booleanTrue(replay.passed, "mountedRn.replay.passed");
    for (const field of [
      "processIdSha256",
      "mountIdSha256",
      "storageStateSha256",
      "sendIdSha256",
      "dispatchIdSha256",
      "priorStateSha256",
      "messageStateSha256",
    ]) {
      sha256Value(replay[field], `mountedRn.replay.${field}`);
    }
    assertSameMobileRnAuthority(
      mobileRnAuthority(replay.authority, "mountedRn.replay.authority"),
      authority,
      "Mounted RN replay authority differs from the full-result authority.",
    );
    const secondaryAuthority = mobileRnAuthority(
      replay.secondaryAuthority,
      "mountedRn.replay.secondaryAuthority",
    );
    assert(
      secondaryAuthority.identityKeySha256 !== authority.identityKeySha256 &&
        secondaryAuthority.accountScopeSha256 !==
          authority.accountScopeSha256 &&
        secondaryAuthority.ownerGenerationSha256 !==
          authority.ownerGenerationSha256 &&
        secondaryAuthority.conversationIdSha256 !==
          authority.conversationIdSha256 &&
        secondaryAuthority.socketOriginSha256 === authority.socketOriginSha256,
      "Mounted RN secondary authority must be a distinct account, generation, and conversation on the same builder origin.",
    );
    for (const field of [
      "restoredQueuedMessage",
      "replayCollapsedToCommittedDispatch",
      "acknowledgedAfterTerminal",
    ]) {
      booleanTrue(replay[field], `mountedRn.replay.${field}`);
    }
    assert(
      replay.sendIdSha256 === enqueue.sendIdSha256 &&
        replay.dispatchIdSha256 === enqueue.dispatchIdSha256 &&
        replay.priorStateSha256 === enqueue.storageStateSha256,
      "Mounted RN response-loss replay changed its durable request, dispatch, or sealed prior storage state.",
    );
    const terminalOrdering = exactRecord(
      replay.terminalAcknowledgementOrdering,
      ["serverTerminalStatus", "asyncStorageOutboxRemoval"],
      "mountedRn.replay.terminalAcknowledgementOrdering",
    );
    const serverTerminalStatus = finiteInteger(
      terminalOrdering.serverTerminalStatus,
      "mountedRn.replay.terminalAcknowledgementOrdering.serverTerminalStatus",
      1,
    );
    const asyncStorageOutboxRemoval = finiteInteger(
      terminalOrdering.asyncStorageOutboxRemoval,
      "mountedRn.replay.terminalAcknowledgementOrdering.asyncStorageOutboxRemoval",
      1,
    );
    assert(
      asyncStorageOutboxRemoval > serverTerminalStatus,
      "Mounted RN outbox removal must occur after terminal server status.",
    );
    const cursorReconnect = exactRecord(
      replay.cursorReconnect,
      [
        "sameMountedClient",
        "resumedWithCursor",
        "resumedWithEpoch",
        "epochStable",
        "gapCount",
        "duplicateCount",
        "recoveredRecordCount",
      ],
      "mountedRn.replay.cursorReconnect",
    );
    for (const field of [
      "sameMountedClient",
      "resumedWithCursor",
      "resumedWithEpoch",
      "epochStable",
    ]) {
      booleanTrue(
        cursorReconnect[field],
        `mountedRn.replay.cursorReconnect.${field}`,
      );
    }
    exactInteger(
      cursorReconnect.gapCount,
      0,
      "mountedRn.replay.cursorReconnect.gapCount",
    );
    exactInteger(
      cursorReconnect.duplicateCount,
      0,
      "mountedRn.replay.cursorReconnect.duplicateCount",
    );
    finiteInteger(
      cursorReconnect.recoveredRecordCount,
      "mountedRn.replay.cursorReconnect.recoveredRecordCount",
      1,
    );
    const appState = exactRecord(
      replay.appState,
      ["backgroundCallbacks", "activeCallbacks", "foregroundWakeObserved"],
      "mountedRn.replay.appState",
    );
    finiteInteger(
      appState.backgroundCallbacks,
      "mountedRn.replay.appState.backgroundCallbacks",
      1,
    );
    finiteInteger(
      appState.activeCallbacks,
      "mountedRn.replay.appState.activeCallbacks",
      1,
    );
    booleanTrue(
      appState.foregroundWakeObserved,
      "mountedRn.replay.appState.foregroundWakeObserved",
    );
    const identitySwitch = exactRecord(
      replay.identitySwitch,
      [
        "actualHookRerendered",
        "accountsDiffer",
        "aToBToA",
        "outboxIsolated",
        "aAcknowledgementPreserved",
        "serverAuthorityFenceProved",
      ],
      "mountedRn.replay.identitySwitch",
    );
    for (const field of [
      "actualHookRerendered",
      "accountsDiffer",
      "aToBToA",
      "outboxIsolated",
      "aAcknowledgementPreserved",
    ]) {
      booleanTrue(
        identitySwitch[field],
        `mountedRn.replay.identitySwitch.${field}`,
      );
    }
    falseValue(
      identitySwitch.serverAuthorityFenceProved,
      "mountedRn.replay.identitySwitch.serverAuthorityFenceProved",
    );
    const noLocalFallback = exactRecord(
      replay.noLocalFallback,
      [
        "explicitIssueSha256",
        "attemptedPromptSha256",
        "blockedSendPreservedDraft",
        "localFallbackCount",
        "fallbackNetworkCount",
      ],
      "mountedRn.replay.noLocalFallback",
    );
    sha256Value(
      noLocalFallback.explicitIssueSha256,
      "mountedRn.replay.noLocalFallback.explicitIssueSha256",
    );
    sha256Value(
      noLocalFallback.attemptedPromptSha256,
      "mountedRn.replay.noLocalFallback.attemptedPromptSha256",
    );
    booleanTrue(
      noLocalFallback.blockedSendPreservedDraft,
      "mountedRn.replay.noLocalFallback.blockedSendPreservedDraft",
    );
    exactInteger(
      noLocalFallback.localFallbackCount,
      0,
      "mountedRn.replay.noLocalFallback.localFallbackCount",
    );
    exactInteger(
      noLocalFallback.fallbackNetworkCount,
      0,
      "mountedRn.replay.noLocalFallback.fallbackNetworkCount",
    );
    assert(
      Array.isArray(replay.receipts) && replay.receipts.length === 5,
      "mountedRn.replay.receipts must contain exactly five receipts.",
    );
    const replayHttpReceipt = mobileRnReceipt({
      value: replay.receipts[0],
      label: "mountedRn.replay.receipts[0]",
      expected: {
        surface: "mobile-http",
        operation: "mobile.execution.submit.replay",
        outcome: "idempotent-replay",
        fields: [
          "status",
          "requestIdSha256",
          "resourceIdSha256",
          "responseSha256",
        ],
        sha256Fields: ["requestIdSha256", "resourceIdSha256", "responseSha256"],
        status: true,
      },
    });
    const reconnectReceipt = mobileRnReceipt({
      value: replay.receipts[1],
      label: "mountedRn.replay.receipts[1]",
      expected: {
        surface: "mobile-client",
        operation: "mobile.rn.websocket.cursor-reconnect",
        outcome: "gapless",
        fields: ["stateSha256", "count"],
        sha256Fields: ["stateSha256"],
        countMinimum: 1,
      },
    });
    const appStateReceipt = mobileRnReceipt({
      value: replay.receipts[2],
      label: "mountedRn.replay.receipts[2]",
      expected: {
        surface: "mobile-client",
        operation: "mobile.rn.app-state",
        outcome: "background-active",
        fields: ["count"],
        countMinimum: 2,
      },
    });
    mobileRnReceipt({
      value: replay.receipts[3],
      label: "mountedRn.replay.receipts[3]",
      expected: {
        surface: "mobile-client",
        operation: "mobile.rn.identity-switch",
        outcome: "a-b-a",
        fields: ["stateSha256"],
        sha256Fields: ["stateSha256"],
      },
    });
    const noFallbackReceipt = mobileRnReceipt({
      value: replay.receipts[4],
      label: "mountedRn.replay.receipts[4]",
      expected: {
        surface: "mobile-client",
        operation: "mobile.rn.no-local-fallback",
        outcome: "explicit-error",
        fields: ["responseSha256", "count"],
        sha256Fields: ["responseSha256"],
        countMinimum: 0,
      },
    });
    assert(
      replayHttpReceipt.requestIdSha256 === replay.sendIdSha256 &&
        replayHttpReceipt.resourceIdSha256 === replay.dispatchIdSha256 &&
        reconnectReceipt.count >= cursorReconnect.recoveredRecordCount &&
        appStateReceipt.count ===
          appState.backgroundCallbacks + appState.activeCallbacks &&
        noFallbackReceipt.responseSha256 ===
          noLocalFallback.explicitIssueSha256 &&
        noFallbackReceipt.count === 0,
      "Mounted RN replay receipts do not bind replay, reconnect, AppState, and no-fallback evidence.",
    );

    const clean = exactRecord(
      mountedRn.clean,
      [
        "phase",
        "passed",
        "processIdSha256",
        "mountIdSha256",
        "authority",
        "cleanNamespaceStartedEmpty",
        "canonicalUserProjected",
        "canonicalAssistantProjected",
        "localFallbackCount",
        "messageStateSha256",
        "generationCanaryOutboxStateSha256",
        "generationCanarySendIdSha256",
        "receipts",
      ],
      "mountedRn.clean",
    );
    exactLiteral(clean.phase, "clean_hydrate", "mountedRn.clean.phase");
    booleanTrue(clean.passed, "mountedRn.clean.passed");
    for (const field of [
      "processIdSha256",
      "mountIdSha256",
      "messageStateSha256",
      "generationCanaryOutboxStateSha256",
      "generationCanarySendIdSha256",
    ]) {
      sha256Value(clean[field], `mountedRn.clean.${field}`);
    }
    assertSameMobileRnAuthority(
      mobileRnAuthority(clean.authority, "mountedRn.clean.authority"),
      authority,
      "Mounted RN clean-hydration authority differs from the full-result authority.",
    );
    for (const field of [
      "cleanNamespaceStartedEmpty",
      "canonicalUserProjected",
      "canonicalAssistantProjected",
    ]) {
      booleanTrue(clean[field], `mountedRn.clean.${field}`);
    }
    exactInteger(
      clean.localFallbackCount,
      0,
      "mountedRn.clean.localFallbackCount",
    );
    assert(
      Array.isArray(clean.receipts) && clean.receipts.length === 2,
      "mountedRn.clean.receipts must contain exactly two receipts.",
    );
    const cleanHydrationReceipt = mobileRnReceipt({
      value: clean.receipts[0],
      label: "mountedRn.clean.receipts[0]",
      expected: {
        surface: "mobile-client",
        operation: "mobile.rn.clean-hydration",
        outcome: "canonical",
        fields: ["stateSha256", "count"],
        sha256Fields: ["stateSha256"],
        countMinimum: 2,
      },
    });
    const generationCanaryReceipt = mobileRnReceipt({
      value: clean.receipts[1],
      label: "mountedRn.clean.receipts[1]",
      expected: {
        surface: "mobile-client",
        operation: "mobile.rn.generation-canary",
        outcome: "durable",
        fields: ["requestIdSha256", "stateSha256", "count"],
        sha256Fields: ["requestIdSha256", "stateSha256"],
        countMinimum: 1,
      },
    });
    exactInteger(
      generationCanaryReceipt.count,
      1,
      "mountedRn.clean.receipts[1].count",
    );
    assert(
      cleanHydrationReceipt.stateSha256 === clean.messageStateSha256 &&
        generationCanaryReceipt.requestIdSha256 ===
          clean.generationCanarySendIdSha256 &&
        generationCanaryReceipt.stateSha256 ===
          clean.generationCanaryOutboxStateSha256,
      "Mounted RN clean-hydration receipts do not bind canonical messages and the durable generation canary.",
    );

    assert(
      new Set([
        enqueue.processIdSha256,
        replay.processIdSha256,
        clean.processIdSha256,
      ]).size === 3,
      "Mounted RN full acceptance must use three distinct JavaScript processes.",
    );
    assert(
      new Set([
        enqueue.mountIdSha256,
        replay.mountIdSha256,
        clean.mountIdSha256,
      ]).size === 3,
      "Mounted RN full acceptance must use three distinct hook mounts.",
    );
    assert(
      enqueue.dispatchIdSha256 === sha256(dispatchId),
      "Mounted RN dispatch hash does not bind the independently observed Convex dispatch.",
    );
    const generationCanaryOutboxStateSha256 = sha256Value(
      mountedRn.generationCanaryOutboxStateSha256,
      "mountedRn.generationCanaryOutboxStateSha256",
    );
    assert(
      generationCanaryOutboxStateSha256 ===
        clean.generationCanaryOutboxStateSha256,
      "Mounted RN top-level generation canary state differs from clean hydration.",
    );
    const phaseReceipts = [
      ...enqueue.receipts,
      ...replay.receipts,
      ...clean.receipts,
    ];
    assert(
      Array.isArray(mountedRn.receipts) &&
        mountedRn.receipts.length === 9 &&
        stableJson(mountedRn.receipts) === stableJson(phaseReceipts),
      "mountedRn.receipts must be the exact ordered concatenation of all nine phase receipts.",
    );
    const expectedSummarySha256 = sha256(
      stableJson({
        enqueue: enqueue.storageStateSha256,
        replay: replay.messageStateSha256,
        clean: clean.messageStateSha256,
      }),
    );
    assert(
      sha256Value(mountedRn.summarySha256, "mountedRn.summarySha256") ===
        expectedSummarySha256,
      "mountedRn.summarySha256 does not seal the three mounted phase states.",
    );
    const mountedRnResultSha256 = sha256Value(
      observation.mountedRnResultSha256,
      "mountedRnResultSha256",
    );
    assert(
      mountedRnResultSha256 === sha256(stableJson(mountedRn)),
      "mountedRnResultSha256 does not seal the complete mounted RN result.",
    );
    const receiptSetSha256 = sha256Value(
      observation.receiptSetSha256,
      "receiptSetSha256",
    );
    assert(
      receiptSetSha256 === sha256(stableJson(mountedRn.receipts)),
      "receiptSetSha256 does not seal the exact ordered mobile receipt set.",
    );

    return {
      conversationId,
      turnId,
      dispatchId,
      ownerGeneration,
      chosenLocation: exactLiteral(
        observation.chosenLocation,
        "cloud",
        "chosenLocation",
      ),
      terminalState: exactLiteral(
        observation.terminalState,
        "completed",
        "terminalState",
      ),
      terminalRevision: finiteInteger(
        observation.terminalRevision,
        "terminalRevision",
        1,
      ),
      journalEpoch: finiteInteger(observation.journalEpoch, "journalEpoch", 0),
      promptSeq,
      terminalSeq,
      durableObjectIdSha256: sha256Value(
        observation.durableObjectIdSha256,
        "durableObjectIdSha256",
      ),
      fenceVerified: booleanTrue(observation.fenceVerified, "fenceVerified"),
      serverAuthorityFence: { ...serverAuthorityFence },
      mountedRn: JSON.parse(JSON.stringify(mountedRn)),
      mountedRnResultSha256,
      receiptSetSha256,
    };
  },
  browser_cloud_routing(observation, context) {
    assert(
      observation.chosenLocation === "cloud",
      "Browser-only route must choose cloud.",
    );
    assert(
      observation.localRuntimeStarted === false,
      "Browser-only route silently ran locally.",
    );
    const expectedOwnerGeneration = boundedIdentifier(
      observation.expectedOwnerGeneration,
      "expectedOwnerGeneration",
    );
    assert(
      expectedOwnerGeneration === context.identity.ownerGeneration,
      "Browser execution admission is not bound to the current acceptance owner generation.",
    );
    const renderedProofSetSha256 = sha256Value(
      observation.renderedProofSetSha256,
      "browser_cloud_routing.renderedProofSetSha256",
    );
    const rendered = validateRenderedProofs(observation.renderedProofs, {
      surface: "browser-cdp",
      requiredOperations: [
        "rendered.list-open",
        "rendered.send-terminal",
        "rendered.fail-closed",
        "rendered.mounted-resume",
        "rendered.same-target-reload",
        "rendered.cold-process",
        "rendered.storage-recovery",
      ],
      expectedSetSha256: renderedProofSetSha256,
      label: "browser_cloud_routing.renderedProofs",
    });
    const priorProcessInstanceSha256 = sha256Value(
      observation.renderedPriorProcessInstanceSha256,
      "browser_cloud_routing.renderedPriorProcessInstanceSha256",
    );
    const currentProcessInstanceSha256 = sha256Value(
      observation.renderedProcessInstanceSha256,
      "browser_cloud_routing.renderedProcessInstanceSha256",
    );
    const cold = rendered.byOperation.get("rendered.cold-process");
    const storage = rendered.byOperation.get("rendered.storage-recovery");
    const priorOperations = [
      "rendered.list-open",
      "rendered.send-terminal",
      "rendered.fail-closed",
      "rendered.mounted-resume",
      "rendered.same-target-reload",
    ];
    assert(
      priorProcessInstanceSha256 !== currentProcessInstanceSha256 &&
        priorOperations.every(
          (operation) =>
            rendered.byOperation.get(operation).receipt
              .processInstanceSha256 === priorProcessInstanceSha256,
        ) &&
        cold.receipt.processInstanceSha256 === currentProcessInstanceSha256 &&
        storage.receipt.processInstanceSha256 ===
          currentProcessInstanceSha256 &&
        cold.observation.previousProcessInstanceSha256 ===
          priorProcessInstanceSha256 &&
        cold.observation.currentProcessInstanceSha256 ===
          currentProcessInstanceSha256,
      "Browser rendered proofs are not bound to the exact cold process transition.",
    );
    const renderedCanonicalRowsSha256 = sha256Value(
      observation.renderedCanonicalRowsSha256,
      "browser_cloud_routing.renderedCanonicalRowsSha256",
    );
    assert(
      sha256Value(
        observation.renderedColdProjectionSha256,
        "browser_cloud_routing.renderedColdProjectionSha256",
      ) === renderedCanonicalRowsSha256 &&
        cold.observation.canonicalRowsSha256 === renderedCanonicalRowsSha256 &&
        storage.observation.canonicalRowsSha256 ===
          renderedCanonicalRowsSha256 &&
        sha256Value(
          observation.renderedBrowserStopReceiptSha256,
          "browser_cloud_routing.renderedBrowserStopReceiptSha256",
        ) === cold.observation.priorStopReceiptSha256 &&
        sha256Value(
          observation.renderedStorageRecoverySha256,
          "browser_cloud_routing.renderedStorageRecoverySha256",
        ) === storage.receipt.receiptSha256 &&
        sha256Value(
          observation.renderedStorageRecoveryCheckpointSha256,
          "browser_cloud_routing.renderedStorageRecoveryCheckpointSha256",
        ) === storage.observation.checkpointSha256,
      "Browser cold/storage recovery receipts do not preserve the exact canonical projection.",
    );
    return {
      conversationId: boundedIdentifier(
        observation.conversationId,
        "conversationId",
      ),
      turnId: nonEmptyString(observation.turnId, "turnId"),
      subject: exactLiteral(observation.subject, "cloud", "subject"),
      expectedOwnerGeneration,
      chosenLocation: "cloud",
      realSandboxStarted: booleanTrue(
        observation.realSandboxStarted,
        "realSandboxStarted",
      ),
      localRuntimeStarted: false,
      renderedProofs: rendered.entries,
      renderedProofSetSha256,
      renderedCanonicalRowsSha256,
      renderedProcessInstanceSha256: currentProcessInstanceSha256,
      renderedPriorProcessInstanceSha256: priorProcessInstanceSha256,
      renderedColdProjectionSha256: observation.renderedColdProjectionSha256,
      renderedBrowserStopReceiptSha256:
        observation.renderedBrowserStopReceiptSha256,
      renderedStorageRecoverySha256: observation.renderedStorageRecoverySha256,
      renderedStorageRecoveryCheckpointSha256:
        observation.renderedStorageRecoveryCheckpointSha256,
      renderedStorageRecoveryRequiredHumanAction: booleanTrue(
        observation.renderedStorageRecoveryRequiredHumanAction,
        "renderedStorageRecoveryRequiredHumanAction",
      ),
      renderedStorageRecoveryCredentialMaterialReturned: falseValue(
        observation.renderedStorageRecoveryCredentialMaterialReturned,
        "renderedStorageRecoveryCredentialMaterialReturned",
      ),
      browserUiSubmittedExecutionPlacement: booleanTrue(
        observation.browserUiSubmittedExecutionPlacement,
        "browserUiSubmittedExecutionPlacement",
      ),
      fenceVerified: booleanTrue(observation.fenceVerified, "fenceVerified"),
    };
  },
  child_completion(observation) {
    assert(
      observation.completionDeliveryCount === 1,
      "Child completion was not delivered exactly once.",
    );
    return {
      parentConversationId: nonEmptyString(
        observation.parentConversationId,
        "parentConversationId",
      ),
      parentTurnId: boundedIdentifier(observation.parentTurnId, "parentTurnId"),
      childTurnId: nonEmptyString(observation.childTurnId, "childTurnId"),
      completionJournalSeq: finiteInteger(
        observation.completionJournalSeq,
        "completionJournalSeq",
      ),
      completionObserved: booleanTrue(
        observation.completionObserved,
        "completionObserved",
      ),
      completionDeliveryCount: 1,
    };
  },
  memory_restart_recall(observation, context) {
    const memoryDocumentId = boundedIdentifier(
      observation.memoryDocumentId,
      "memoryDocumentId",
    );
    const memoryVersionId = boundedIdentifier(
      observation.memoryVersionId,
      "memoryVersionId",
    );
    const memoryContentSha256 = sha256Value(
      observation.memoryContentSha256,
      "memoryContentSha256",
    );
    const memoryR2Key = boundedIdentifier(
      observation.memoryR2Key,
      "memoryR2Key",
      1_024,
    );
    const expectedPrefix = agentHomeGenerationPrefix(context.identity);
    assert(
      memoryR2Key ===
        `${expectedPrefix}memory-versions/${memoryDocumentId}/${memoryVersionId}/${memoryContentSha256}.md`,
      "MEMORY.md evidence does not name the exact generation-fenced document version for this owner.",
    );
    const workerBefore = uuidValue(
      observation.workerVersionIdBeforeRestart,
      "workerVersionIdBeforeRestart",
    );
    const workerAfter = uuidValue(
      observation.workerVersionIdAfterRestart,
      "workerVersionIdAfterRestart",
    );
    assert(
      workerBefore === workerAfter,
      "Memory restart proof crossed Worker deployment versions.",
    );
    const writeTurnId = boundedIdentifier(
      observation.writeTurnId,
      "writeTurnId",
    );
    const recallTurnId = boundedIdentifier(
      observation.recallTurnId,
      "recallTurnId",
    );
    const laterTurnId = boundedIdentifier(
      observation.laterTurnId,
      "laterTurnId",
    );
    assert(
      new Set([writeTurnId, recallTurnId, laterTurnId]).size === 3,
      "Memory write, recall, and later-context turns must be distinct.",
    );
    const profileDocumentId = boundedIdentifier(
      observation.profileDocumentId,
      "profileDocumentId",
    );
    const profileVersionId = boundedIdentifier(
      observation.profileVersionId,
      "profileVersionId",
    );
    const profileContentSha256 = sha256Value(
      observation.profileContentSha256,
      "profileContentSha256",
    );
    const profileR2Key = boundedIdentifier(
      observation.profileR2Key,
      "profileR2Key",
      1_024,
    );
    assert(
      profileR2Key ===
        `${expectedPrefix}memory-versions/${profileDocumentId}/${profileVersionId}/${profileContentSha256}.md`,
      "Remember evidence does not name the exact generation-fenced profile version for this owner.",
    );
    const memoryWriteIdempotencySha256 = sha256Value(
      observation.memoryWriteIdempotencySha256,
      "memoryWriteIdempotencySha256",
    );
    assert(
      memoryWriteIdempotencySha256 ===
        sha256(`memory:${writeTurnId}`.slice(0, 128)),
      "The authenticated MEMORY.md write is not bound to writeTurnId.",
    );
    return {
      conversationId: boundedIdentifier(
        observation.conversationId,
        "conversationId",
      ),
      writeTurnId,
      recallTurnId,
      laterTurnId,
      memoryDocumentName: exactLiteral(
        observation.memoryDocumentName,
        "MEMORY.md",
        "memoryDocumentName",
      ),
      memoryDocumentId,
      memoryVersionId,
      memoryRevision: finiteInteger(
        observation.memoryRevision,
        "memoryRevision",
        1,
      ),
      memoryContentSha256,
      memoryMarkerSha256: sha256Value(
        observation.memoryMarkerSha256,
        "memoryMarkerSha256",
      ),
      memoryR2Key,
      memoryR2Etag: boundedIdentifier(observation.memoryR2Etag, "memoryR2Etag"),
      memoryWriteReceiptSha256: sha256Value(
        observation.memoryWriteReceiptSha256,
        "memoryWriteReceiptSha256",
      ),
      memoryWriteIdempotencySha256,
      profileDocumentName: exactLiteral(
        observation.profileDocumentName,
        "memories/profile.md",
        "profileDocumentName",
      ),
      profileDocumentId,
      profileVersionId,
      profileRevision: finiteInteger(
        observation.profileRevision,
        "profileRevision",
        1,
      ),
      profileContentSha256,
      profileR2Key,
      profileR2Etag: boundedIdentifier(
        observation.profileR2Etag,
        "profileR2Etag",
      ),
      rememberReceiptSha256: sha256Value(
        observation.rememberReceiptSha256,
        "rememberReceiptSha256",
      ),
      profileContainsMarker: booleanTrue(
        observation.profileContainsMarker,
        "profileContainsMarker",
      ),
      workerVersionIdBeforeRestart: workerBefore,
      workerVersionIdAfterRestart: workerAfter,
      workerRestartObserved: booleanTrue(
        observation.workerRestartObserved,
        "workerRestartObserved",
      ),
      recallResultSha256: sha256Value(
        observation.recallResultSha256,
        "recallResultSha256",
      ),
      laterTurnContextSha256: sha256Value(
        observation.laterTurnContextSha256,
        "laterTurnContextSha256",
      ),
      markerObservedAfterRestart: booleanTrue(
        observation.markerObservedAfterRestart,
        "markerObservedAfterRestart",
      ),
      laterTurnObservedMemory: booleanTrue(
        observation.laterTurnObservedMemory,
        "laterTurnObservedMemory",
      ),
      laterTurnPromptContainsMarker: falseValue(
        observation.laterTurnPromptContainsMarker,
        "laterTurnPromptContainsMarker",
      ),
      laterTurnRecallToolCallCount: exactInteger(
        observation.laterTurnRecallToolCallCount,
        0,
        "laterTurnRecallToolCallCount",
      ),
      authoritativeMemoryLoadedAtTurnStartup: booleanTrue(
        observation.authoritativeMemoryLoadedAtTurnStartup,
        "authoritativeMemoryLoadedAtTurnStartup",
      ),
      authoritativePersonalityLoadedAtTurnStartup: booleanTrue(
        observation.authoritativePersonalityLoadedAtTurnStartup,
        "authoritativePersonalityLoadedAtTurnStartup",
      ),
      authoritativeContextFailureBlocksTurn: booleanTrue(
        observation.authoritativeContextFailureBlocksTurn,
        "authoritativeContextFailureBlocksTurn",
      ),
      childTaskContextExplicitOnly: booleanTrue(
        observation.childTaskContextExplicitOnly,
        "childTaskContextExplicitOnly",
      ),
      childPinnedSkillCatalog: booleanTrue(
        observation.childPinnedSkillCatalog,
        "childPinnedSkillCatalog",
      ),
      childImplicitFullMemoryDump: falseValue(
        observation.childImplicitFullMemoryDump,
        "childImplicitFullMemoryDump",
      ),
      memoryArchitectureSourceSha256: sha256Value(
        observation.memoryArchitectureSourceSha256,
        "memoryArchitectureSourceSha256",
      ),
    };
  },
  cloud_skill_discovery_use(observation, context) {
    const skillId = boundedIdentifier(observation.skillId, "skillId");
    const skillVersionId = boundedIdentifier(
      observation.skillVersionId,
      "skillVersionId",
    );
    const assetPath = boundedIdentifier(
      observation.assetPath,
      "assetPath",
      512,
    );
    assert(
      !assetPath.startsWith("/") &&
        !assetPath.endsWith("/") &&
        !assetPath.includes("\\") &&
        path.posix.normalize(assetPath) === assetPath &&
        !assetPath
          .split("/")
          .some((segment) => segment === "." || segment === ".."),
      "Cloud skill assetPath must be a normalized relative path.",
    );
    const skillRoot = `${agentHomeGenerationPrefix(context.identity)}skills/${skillId}/${skillVersionId}/`;
    const manifestR2Key = boundedIdentifier(
      observation.manifestR2Key,
      "manifestR2Key",
      1_024,
    );
    assert(
      manifestR2Key === `${skillRoot}manifest.json`,
      "Cloud skill manifest is outside this owner's generation-fenced Agent Home.",
    );
    const assetR2Key = boundedIdentifier(
      observation.assetR2Key,
      "assetR2Key",
      1_024,
    );
    assert(
      assetR2Key === `${skillRoot}files/${assetPath}`,
      "Cloud skill asset is outside the exact versioned skill package.",
    );
    assert(
      observation.macFilesystemReadCount === 0,
      "Cloud skill proof read Rahul's Mac filesystem.",
    );
    return {
      conversationId: boundedIdentifier(
        observation.conversationId,
        "conversationId",
      ),
      discoveryTurnId: boundedIdentifier(
        observation.discoveryTurnId,
        "discoveryTurnId",
      ),
      useTurnId: boundedIdentifier(observation.useTurnId, "useTurnId"),
      skillId,
      skillVersionId,
      skillRevision: finiteInteger(
        observation.skillRevision,
        "skillRevision",
        1,
      ),
      manifestSha256: sha256Value(observation.manifestSha256, "manifestSha256"),
      assetPath,
      assetSha256: sha256Value(observation.assetSha256, "assetSha256"),
      manifestR2Key,
      manifestR2Etag: boundedIdentifier(
        observation.manifestR2Etag,
        "manifestR2Etag",
      ),
      assetR2Key,
      assetR2Etag: boundedIdentifier(observation.assetR2Etag, "assetR2Etag"),
      catalogRevisionSha256: sha256Value(
        observation.catalogRevisionSha256,
        "catalogRevisionSha256",
      ),
      skillUseReceiptSha256: sha256Value(
        observation.skillUseReceiptSha256,
        "skillUseReceiptSha256",
      ),
      discoveredByCloudAgent: booleanTrue(
        observation.discoveredByCloudAgent,
        "discoveredByCloudAgent",
      ),
      loadedByWorker: booleanTrue(observation.loadedByWorker, "loadedByWorker"),
      assetReadByWorker: booleanTrue(
        observation.assetReadByWorker,
        "assetReadByWorker",
      ),
      usedByCloudAgent: booleanTrue(
        observation.usedByCloudAgent,
        "usedByCloudAgent",
      ),
      macFilesystemReadCount: 0,
    };
  },
  code_mode_real_mcp(observation) {
    for (const forbiddenRawField of [
      "initializeRequestId",
      "toolsListRequestId",
      "toolsListRequestIds",
      "describeRequestId",
      "toolsDescribeRequestId",
      "toolsCallRequestId",
      "callRequestId",
      "mcpServerId",
      "connectedAccountId",
      "endpoint",
      "token",
    ]) {
      assert(
        !Object.hasOwn(observation, forbiddenRawField),
        `code_mode_real_mcp must not persist raw ${forbiddenRawField}.`,
      );
    }
    const initializeRequestIdSha256 = sha256Value(
      observation.initializeRequestIdSha256,
      "initializeRequestIdSha256",
    );
    assert(
      Array.isArray(observation.toolsListRequestIdSha256s),
      "toolsListRequestIdSha256s must be an array.",
    );
    const toolsListRequestIdSha256s = observation.toolsListRequestIdSha256s.map(
      (value, index) =>
        sha256Value(value, `toolsListRequestIdSha256s[${index}]`),
    );
    const toolsCallRequestIdSha256 = sha256Value(
      observation.toolsCallRequestIdSha256,
      "toolsCallRequestIdSha256",
    );
    const describeRequestIdSha256 = sha256Value(
      observation.describeRequestIdSha256,
      "describeRequestIdSha256",
    );
    const toolsListPageCount = finiteInteger(
      observation.toolsListPageCount,
      "toolsListPageCount",
      1,
    );
    assert(
      toolsListRequestIdSha256s.length === toolsListPageCount,
      "Every MCP tools/list page must expose exactly one request-id hash.",
    );
    const rpcRequestIdSha256s = [
      initializeRequestIdSha256,
      ...toolsListRequestIdSha256s,
      describeRequestIdSha256,
      toolsCallRequestIdSha256,
    ];
    assert(
      new Set(rpcRequestIdSha256s).size === rpcRequestIdSha256s.length,
      "MCP initialize, every tools/list page, describe, and tools/call request hashes must be distinct.",
    );
    const listedToolIdSha256 = sha256Value(
      observation.listedToolIdSha256,
      "listedToolIdSha256",
    );
    const describedToolIdSha256 = sha256Value(
      observation.describedToolIdSha256,
      "describedToolIdSha256",
    );
    const calledToolIdSha256 = sha256Value(
      observation.calledToolIdSha256,
      "calledToolIdSha256",
    );
    assert(
      listedToolIdSha256 === describedToolIdSha256 &&
        listedToolIdSha256 === calledToolIdSha256,
      "MCP list, describe, and call evidence must name the exact same tool identity.",
    );
    return {
      conversationId: boundedIdentifier(
        observation.conversationId,
        "conversationId",
      ),
      turnId: boundedIdentifier(observation.turnId, "turnId"),
      workerVersionId: uuidValue(
        observation.workerVersionId,
        "workerVersionId",
      ),
      codeExecutionId: boundedIdentifier(
        observation.codeExecutionId,
        "codeExecutionId",
      ),
      mcpServerIdSha256: sha256Value(
        observation.mcpServerIdSha256,
        "mcpServerIdSha256",
      ),
      connectedAccountIdSha256: sha256Value(
        observation.connectedAccountIdSha256,
        "connectedAccountIdSha256",
      ),
      protocolVersion: exactLiteral(
        observation.protocolVersion,
        "2025-03-26",
        "protocolVersion",
      ),
      integrationId: boundedIdentifier(
        observation.integrationId,
        "integrationId",
      ),
      toolName: boundedIdentifier(observation.toolName, "toolName"),
      toolRevision: codeToolRevisionValue(
        observation.toolRevision,
        "toolRevision",
      ),
      codePolicyVersion: boundedIdentifier(
        observation.codePolicyVersion,
        "codePolicyVersion",
        128,
      ),
      toolkitVersion: boundedIdentifier(
        observation.toolkitVersion,
        "toolkitVersion",
        64,
      ),
      catalogRevisionSha256: sha256Value(
        observation.catalogRevisionSha256,
        "catalogRevisionSha256",
      ),
      reviewedInputSchemaSha256: sha256Value(
        observation.reviewedInputSchemaSha256,
        "reviewedInputSchemaSha256",
      ),
      initializeRequestIdSha256,
      toolsListRequestIdSha256s,
      describeRequestIdSha256,
      toolsCallRequestIdSha256,
      listedToolIdSha256,
      describedToolIdSha256,
      calledToolIdSha256,
      toolsListPageCount,
      initializationReceiptSha256: sha256Value(
        observation.initializationReceiptSha256,
        "initializationReceiptSha256",
      ),
      initializedNotificationReceiptSha256: sha256Value(
        observation.initializedNotificationReceiptSha256,
        "initializedNotificationReceiptSha256",
      ),
      describeReceiptSha256: sha256Value(
        observation.describeReceiptSha256,
        "describeReceiptSha256",
      ),
      providerReceiptSha256: sha256Value(
        observation.providerReceiptSha256,
        "providerReceiptSha256",
      ),
      toolResultSha256: sha256Value(
        observation.toolResultSha256,
        "toolResultSha256",
      ),
      initializeCompleted: booleanTrue(
        observation.initializeCompleted,
        "initializeCompleted",
      ),
      initializedNotificationSent: booleanTrue(
        observation.initializedNotificationSent,
        "initializedNotificationSent",
      ),
      toolsListCompleted: booleanTrue(
        observation.toolsListCompleted,
        "toolsListCompleted",
      ),
      toolDescribed: booleanTrue(observation.toolDescribed, "toolDescribed"),
      toolsCallCompleted: booleanTrue(
        observation.toolsCallCompleted,
        "toolsCallCompleted",
      ),
      realConnectedService: booleanTrue(
        observation.realConnectedService,
        "realConnectedService",
      ),
      externalTransport: exactLiteral(
        observation.externalTransport,
        "composio",
        "externalTransport",
      ),
      disposableConnectedAccount: booleanTrue(
        observation.disposableConnectedAccount,
        "disposableConnectedAccount",
      ),
      externalAccountHashMatched: booleanTrue(
        observation.externalAccountHashMatched,
        "externalAccountHashMatched",
      ),
      catalogPolicyVerifiedBeforeCall: booleanTrue(
        observation.catalogPolicyVerifiedBeforeCall,
        "catalogPolicyVerifiedBeforeCall",
      ),
      annotationsReadOnly: booleanTrue(
        observation.annotationsReadOnly,
        "annotationsReadOnly",
      ),
      annotationsDestructive: falseValue(
        observation.annotationsDestructive,
        "annotationsDestructive",
      ),
      inProcessFixture: falseValue(
        observation.inProcessFixture,
        "inProcessFixture",
      ),
      readOnlyTool: booleanTrue(observation.readOnlyTool, "readOnlyTool"),
      serverPolicyRechecked: booleanTrue(
        observation.serverPolicyRechecked,
        "serverPolicyRechecked",
      ),
      childGlobalOutboundBlocked: booleanTrue(
        observation.childGlobalOutboundBlocked,
        "childGlobalOutboundBlocked",
      ),
    };
  },
  general_agent_real_sandbox(observation) {
    assert(
      observation.terminalKind === "completed",
      "General sandbox agent must reach a completed terminal.",
    );
    const parentTurnId = boundedIdentifier(
      observation.parentTurnId,
      "parentTurnId",
    );
    const childTurnId = boundedIdentifier(
      observation.childTurnId,
      "childTurnId",
    );
    assert(
      parentTurnId !== childTurnId,
      "General sandbox parent and child turn identities must be distinct.",
    );
    return {
      conversationId: boundedIdentifier(
        observation.conversationId,
        "conversationId",
      ),
      parentTurnId,
      childTurnId,
      agentId: boundedIdentifier(observation.agentId, "agentId"),
      threadId: boundedIdentifier(observation.threadId, "threadId"),
      sandboxIdSha256: sha256Value(
        observation.sandboxIdSha256,
        "sandboxIdSha256",
      ),
      sandboxProvider: exactLiteral(
        observation.sandboxProvider,
        "cloudflare",
        "sandboxProvider",
      ),
      sandboxImageRevision: boundedIdentifier(
        observation.sandboxImageRevision,
        "sandboxImageRevision",
      ),
      sandboxOutputSha256: sha256Value(
        observation.sandboxOutputSha256,
        "sandboxOutputSha256",
      ),
      completionJournalSeq: finiteInteger(
        observation.completionJournalSeq,
        "completionJournalSeq",
        1,
      ),
      realSandboxStarted: booleanTrue(
        observation.realSandboxStarted,
        "realSandboxStarted",
      ),
      sandboxCommandExecuted: booleanTrue(
        observation.sandboxCommandExecuted,
        "sandboxCommandExecuted",
      ),
      placementFenceVerified: booleanTrue(
        observation.placementFenceVerified,
        "placementFenceVerified",
      ),
      ownerGenerationVerified: booleanTrue(
        observation.ownerGenerationVerified,
        "ownerGenerationVerified",
      ),
      completionObserved: booleanTrue(
        observation.completionObserved,
        "completionObserved",
      ),
      completionDeliveryCount:
        observation.completionDeliveryCount === 1
          ? 1
          : (() => {
              throw new CloudProofError(
                "General sandbox completion must be delivered exactly once.",
              );
            })(),
      localRuntimeStarted: falseValue(
        observation.localRuntimeStarted,
        "localRuntimeStarted",
      ),
      terminalKind: "completed",
    };
  },
  owner_reset_memory_reimport(observation) {
    const oldOwnerGenerationSha256 = sha256Value(
      observation.oldOwnerGenerationSha256,
      "oldOwnerGenerationSha256",
    );
    const newOwnerGenerationSha256 = sha256Value(
      observation.newOwnerGenerationSha256,
      "newOwnerGenerationSha256",
    );
    assert(
      oldOwnerGenerationSha256 !== newOwnerGenerationSha256,
      "Owner reset must rotate to a distinct generation.",
    );
    const initialVersionId = boundedIdentifier(
      observation.initialVersionId,
      "initialVersionId",
    );
    const explicitReimportVersionId = boundedIdentifier(
      observation.explicitReimportVersionId,
      "explicitReimportVersionId",
    );
    const postResetVersionId = boundedIdentifier(
      observation.postResetVersionId,
      "postResetVersionId",
    );
    assert(
      new Set([initialVersionId, explicitReimportVersionId, postResetVersionId])
        .size === 3,
      "Wipe/reimport/reset must produce three distinct memory versions.",
    );
    const localDocumentName = boundedIdentifier(
      observation.localDocumentName,
      "localDocumentName",
    );
    assert(
      /^imports\/local\/[A-Za-z0-9._-]+\.md$/u.test(localDocumentName),
      "Local memory proof must use the scanner-owned imports/local Markdown namespace.",
    );
    assert(
      observation.remainingResetOwnedCoreStoreCount === 0 &&
        observation.oldGenerationR2ObjectCount === 0,
      "Owner reset retained reset-owned core data or old-generation R2 residue.",
    );
    const integrationBeforeResetSha256 = sha256Value(
      observation.integrationBeforeResetSha256,
      "integrationBeforeResetSha256",
    );
    const integrationAfterResetSha256 = sha256Value(
      observation.integrationAfterResetSha256,
      "integrationAfterResetSha256",
    );
    assert(
      integrationBeforeResetSha256 === integrationAfterResetSha256,
      "Owner reset must preserve the reviewed connected integration exactly.",
    );
    const oldConversationId = boundedIdentifier(
      observation.oldConversationId,
      "oldConversationId",
    );
    const newConversationId = boundedIdentifier(
      observation.newConversationId,
      "newConversationId",
    );
    const renderedGenerationProofs = observation.renderedGenerationProofs;
    assert(
      Array.isArray(renderedGenerationProofs) &&
        renderedGenerationProofs.length === 2 &&
        renderedGenerationProofs[0]?.receipt?.surface === "browser-cdp" &&
        renderedGenerationProofs[1]?.receipt?.surface === "electron-cdp",
      "Owner reset must include ordered browser and Electron generation receipts.",
    );
    const oneRenderedProofSetSha256 = (entry) =>
      sha256(
        renderedCanonicalJson([
          {
            receiptSha256: entry.receipt?.receiptSha256,
            observationSha256: entry.receipt?.observationSha256,
          },
        ]),
      );
    const browserRenderedGeneration = validateRenderedProofs(
      [renderedGenerationProofs[0]],
      {
        surface: "browser-cdp",
        requiredOperations: ["rendered.generation-rotation"],
        expectedSetSha256: oneRenderedProofSetSha256(
          renderedGenerationProofs[0],
        ),
        label: "owner_reset_memory_reimport.browserGeneration",
      },
    );
    const electronRenderedGeneration = validateRenderedProofs(
      [renderedGenerationProofs[1]],
      {
        surface: "electron-cdp",
        requiredOperations: ["rendered.generation-rotation"],
        expectedSetSha256: oneRenderedProofSetSha256(
          renderedGenerationProofs[1],
        ),
        label: "owner_reset_memory_reimport.electronGeneration",
      },
    );
    const renderedGenerationProofSetSha256 = sha256Value(
      observation.renderedGenerationProofSetSha256,
      "renderedGenerationProofSetSha256",
    );
    assert(
      renderedGenerationProofSetSha256 ===
        sha256(
          renderedCanonicalJson(
            renderedGenerationProofs.map(({ receipt }) => ({
              receiptSha256: receipt.receiptSha256,
              observationSha256: receipt.observationSha256,
            })),
          ),
        ),
      "Rendered owner-generation proof set digest is invalid.",
    );
    const browserRotation = browserRenderedGeneration.entries[0].observation;
    const electronRotation = electronRenderedGeneration.entries[0].observation;
    assert(
      browserRotation.oldOwnerGenerationSha256 === oldOwnerGenerationSha256 &&
        browserRotation.newOwnerGenerationSha256 === newOwnerGenerationSha256 &&
        electronRotation.oldOwnerGenerationSha256 ===
          oldOwnerGenerationSha256 &&
        electronRotation.newOwnerGenerationSha256 ===
          newOwnerGenerationSha256 &&
        browserRotation.replacementConversationSha256 ===
          sha256(newConversationId) &&
        electronRotation.replacementConversationSha256 ===
          sha256(newConversationId),
      "Rendered generation receipts are not bound to the exact reset transition.",
    );
    const renderedGenerationReadySha256 = sha256Value(
      observation.renderedGenerationReadySha256,
      "renderedGenerationReadySha256",
    );
    const mobileGenerationResult = exactRecord(
      observation.mobileGenerationRotation,
      [
        "version",
        "contract",
        "mode",
        "passed",
        "runtime",
        "boundary",
        "generationRotation",
        "receipts",
        "summarySha256",
      ],
      "mobileGenerationRotation",
    );
    exactInteger(
      mobileGenerationResult.version,
      2,
      "mobileGenerationRotation.version",
    );
    exactLiteral(
      mobileGenerationResult.contract,
      "stella-mobile-rn-canonical-v2",
      "mobileGenerationRotation.contract",
    );
    exactLiteral(
      mobileGenerationResult.mode,
      "post_reset_generation",
      "mobileGenerationRotation.mode",
    );
    booleanTrue(
      mobileGenerationResult.passed,
      "mobileGenerationRotation.passed",
    );
    const mobileRuntime = exactRecord(
      mobileGenerationResult.runtime,
      [
        "bunVersion",
        "executor",
        "renderer",
        "actualSignedInChatHookMounted",
        "actualProductScreenMounted",
        "actualAsyncStoragePackage",
        "actualAsyncStorageWrapper",
        "actualAppStateSubscription",
        "realHttp",
        "realWebSocket",
        "productModuleSha256",
      ],
      "mobileGenerationRotation.runtime",
    );
    assert(
      /^1\.4\.[0-9]+(?:[-+].*)?$/u.test(
        nonEmptyString(
          mobileRuntime.bunVersion,
          "mobileGenerationRotation.runtime.bunVersion",
        ),
      ),
      "mobileGenerationRotation.runtime.bunVersion must identify Bun 1.4.x.",
    );
    exactLiteral(
      mobileRuntime.executor,
      "bun-jsdom-react-native-web",
      "mobileGenerationRotation.runtime.executor",
    );
    exactLiteral(
      mobileRuntime.renderer,
      "react-dom-react-native-web",
      "mobileGenerationRotation.runtime.renderer",
    );
    booleanTrue(
      mobileRuntime.actualSignedInChatHookMounted,
      "mobileGenerationRotation.runtime.actualSignedInChatHookMounted",
    );
    falseValue(
      mobileRuntime.actualProductScreenMounted,
      "mobileGenerationRotation.runtime.actualProductScreenMounted",
    );
    for (const field of [
      "actualAsyncStoragePackage",
      "actualAsyncStorageWrapper",
      "actualAppStateSubscription",
      "realHttp",
      "realWebSocket",
    ]) {
      booleanTrue(
        mobileRuntime[field],
        `mobileGenerationRotation.runtime.${field}`,
      );
    }
    const mobileProductModuleSha256 = exactRecord(
      mobileRuntime.productModuleSha256,
      MOBILE_RN_PRODUCT_MODULES,
      "mobileGenerationRotation.runtime.productModuleSha256",
    );
    for (const filename of MOBILE_RN_PRODUCT_MODULES) {
      const observedDigest = sha256Value(
        mobileProductModuleSha256[filename],
        `mobileGenerationRotation.runtime.productModuleSha256.${filename}`,
      );
      assert(
        observedDigest ===
          sha256(
            readFileSync(
              path.join(REPO_ROOT, "packages/mobile/src/lib", filename),
            ),
          ),
        `mobileGenerationRotation.runtime.productModuleSha256.${filename} does not match the reviewed product module.`,
      );
    }
    const mobileBoundary = exactRecord(
      mobileGenerationResult.boundary,
      [
        "javascriptProcessRestartProved",
        "reactNativeWebUiInteractionProved",
        "asyncStorageWebAdapterProved",
        "appStateVisibilityLifecycleProved",
        "realDevHttpAndWebSocketProved",
        "expoNativeBinaryProved",
        "nativeAsyncStorageBackendProved",
        "osProcessDeathProved",
        "nativeAppStateDeliveryProved",
        "nativeLayoutAndTouchProved",
      ],
      "mobileGenerationRotation.boundary",
    );
    for (const field of [
      "javascriptProcessRestartProved",
      "reactNativeWebUiInteractionProved",
      "asyncStorageWebAdapterProved",
      "appStateVisibilityLifecycleProved",
      "realDevHttpAndWebSocketProved",
    ]) {
      booleanTrue(
        mobileBoundary[field],
        `mobileGenerationRotation.boundary.${field}`,
      );
    }
    for (const field of [
      "expoNativeBinaryProved",
      "nativeAsyncStorageBackendProved",
      "osProcessDeathProved",
      "nativeAppStateDeliveryProved",
      "nativeLayoutAndTouchProved",
    ]) {
      falseValue(
        mobileBoundary[field],
        `mobileGenerationRotation.boundary.${field}`,
      );
    }
    const mobileGeneration = exactRecord(
      mobileGenerationResult.generationRotation,
      [
        "phase",
        "passed",
        "processIdSha256",
        "mountIdSha256",
        "accountScopeSha256",
        "oldConversationIdSha256",
        "conversationIdSha256",
        "oldGenerationSha256",
        "newGenerationSha256",
        "generationsDiffer",
        "liveAcrossResetBarrier",
        "serverAdmissionResponseHeldAcrossReset",
        "heldOldResponseDeliveredAfterRerender",
        "actualHookRerendered",
        "oldGenerationOutboxPurged",
        "staleSocketRetired",
        "staleCallbackDropCount",
        "staleOutboxAckRejected",
        "newGenerationHydrated",
        "newAuthorityIdleAfterStaleCallback",
        "localFallbackCount",
        "priorStateSha256",
        "finalStateSha256",
        "receipts",
      ],
      "mobileGenerationRotation.generationRotation",
    );
    exactLiteral(
      mobileGeneration.phase,
      "generation_rotation",
      "mobileGenerationRotation.generationRotation.phase",
    );
    booleanTrue(
      mobileGeneration.passed,
      "mobileGenerationRotation.generationRotation.passed",
    );
    for (const field of [
      "processIdSha256",
      "mountIdSha256",
      "accountScopeSha256",
      "oldConversationIdSha256",
      "conversationIdSha256",
      "oldGenerationSha256",
      "newGenerationSha256",
      "priorStateSha256",
      "finalStateSha256",
    ]) {
      sha256Value(
        mobileGeneration[field],
        `mobileGenerationRotation.generationRotation.${field}`,
      );
    }
    assert(
      mobileGeneration.oldConversationIdSha256 === sha256(oldConversationId) &&
        mobileGeneration.conversationIdSha256 === sha256(newConversationId) &&
        mobileGeneration.oldGenerationSha256 === oldOwnerGenerationSha256 &&
        mobileGeneration.newGenerationSha256 === newOwnerGenerationSha256 &&
        mobileGeneration.oldGenerationSha256 !==
          mobileGeneration.newGenerationSha256,
      "Mounted RN live reset is not bound to the exact old/new conversations and generations.",
    );
    for (const field of [
      "generationsDiffer",
      "liveAcrossResetBarrier",
      "serverAdmissionResponseHeldAcrossReset",
      "heldOldResponseDeliveredAfterRerender",
      "actualHookRerendered",
      "oldGenerationOutboxPurged",
      "staleSocketRetired",
      "staleOutboxAckRejected",
      "newGenerationHydrated",
      "newAuthorityIdleAfterStaleCallback",
    ]) {
      booleanTrue(
        mobileGeneration[field],
        `mobileGenerationRotation.generationRotation.${field}`,
      );
    }
    exactInteger(
      mobileGeneration.staleCallbackDropCount,
      1,
      "mobileGenerationRotation.generationRotation.staleCallbackDropCount",
    );
    exactInteger(
      mobileGeneration.localFallbackCount,
      0,
      "mobileGenerationRotation.generationRotation.localFallbackCount",
    );
    assert(
      Array.isArray(mobileGeneration.receipts) &&
        mobileGeneration.receipts.length === 1 &&
        Array.isArray(mobileGenerationResult.receipts) &&
        stableJson(mobileGenerationResult.receipts) ===
          stableJson(mobileGeneration.receipts),
      "Mounted RN live reset must contain one identical nested/top-level receipt.",
    );
    const mobileGenerationReceipt = mobileRnReceipt({
      value: mobileGeneration.receipts[0],
      label: "mobileGenerationRotation.receipts[0]",
      expected: {
        surface: "mobile-client",
        operation: "mobile.rn.owner-generation-rotation",
        outcome: "retired-and-purged",
        fields: ["requestIdSha256", "stateSha256", "count"],
        sha256Fields: ["requestIdSha256", "stateSha256"],
        countMinimum: 1,
      },
    });
    assert(
      mobileGenerationReceipt.stateSha256 ===
        mobileGeneration.finalStateSha256 &&
        mobileGenerationReceipt.count === 1,
      "Mounted RN live reset receipt does not seal the exact final state once.",
    );
    assert(
      sha256Value(
        mobileGenerationResult.summarySha256,
        "mobileGenerationRotation.summarySha256",
      ) === sha256(stableJson(mobileGeneration)),
      "Mounted RN live reset summary does not seal the complete rotation.",
    );
    const mobileGenerationResultSha256 = sha256Value(
      observation.mobileGenerationResultSha256,
      "mobileGenerationResultSha256",
    );
    assert(
      mobileGenerationResultSha256 ===
        sha256(stableJson(mobileGenerationResult)),
      "mobileGenerationResultSha256 does not seal the complete mounted RN live reset result.",
    );
    const mobileGenerationReadySha256 = sha256Value(
      observation.mobileGenerationReadySha256,
      "mobileGenerationReadySha256",
    );
    booleanTrue(
      observation.mobileGenerationBarrierRemoved,
      "mobileGenerationBarrierRemoved",
    );
    return {
      oldConversationId,
      newConversationId,
      oldOwnerGenerationSha256,
      newOwnerGenerationSha256,
      oldMemoryEpochSha256: sha256Value(
        observation.oldMemoryEpochSha256,
        "oldMemoryEpochSha256",
      ),
      wipedMemoryEpochSha256: sha256Value(
        observation.wipedMemoryEpochSha256,
        "wipedMemoryEpochSha256",
      ),
      postResetMemoryEpochSha256: sha256Value(
        observation.postResetMemoryEpochSha256,
        "postResetMemoryEpochSha256",
      ),
      localDocumentName,
      localDocumentSha256: sha256Value(
        observation.localDocumentSha256,
        "localDocumentSha256",
      ),
      initialVersionId,
      explicitReimportVersionId,
      explicitReimportR2KeySha256: sha256Value(
        observation.explicitReimportR2KeySha256,
        "explicitReimportR2KeySha256",
      ),
      explicitReimportR2Etag: boundedIdentifier(
        observation.explicitReimportR2Etag,
        "explicitReimportR2Etag",
      ),
      postResetVersionId,
      postResetR2KeySha256: sha256Value(
        observation.postResetR2KeySha256,
        "postResetR2KeySha256",
      ),
      postResetR2Etag: boundedIdentifier(
        observation.postResetR2Etag,
        "postResetR2Etag",
      ),
      remainingResetOwnedCoreStoreCount: 0,
      oldGenerationR2ObjectCount: 0,
      signedInOwnershipConfirmed: booleanTrue(
        observation.signedInOwnershipConfirmed,
        "signedInOwnershipConfirmed",
      ),
      initialLocalImportObserved: booleanTrue(
        observation.initialLocalImportObserved,
        "initialLocalImportObserved",
      ),
      memoryWipeCompleted: booleanTrue(
        observation.memoryWipeCompleted,
        "memoryWipeCompleted",
      ),
      implicitReimportBlocked: booleanTrue(
        observation.implicitReimportBlocked,
        "implicitReimportBlocked",
      ),
      explicitReimportAuthorized: booleanTrue(
        observation.explicitReimportAuthorized,
        "explicitReimportAuthorized",
      ),
      explicitReimportExact: booleanTrue(
        observation.explicitReimportExact,
        "explicitReimportExact",
      ),
      ownerGenerationRotated: booleanTrue(
        observation.ownerGenerationRotated,
        "ownerGenerationRotated",
      ),
      resetJobCompleted: booleanTrue(
        observation.resetJobCompleted,
        "resetJobCompleted",
      ),
      integrationBeforeResetSha256,
      integrationAfterResetSha256,
      connectedIntegrationPreservedByReset: booleanTrue(
        observation.connectedIntegrationPreservedByReset,
        "connectedIntegrationPreservedByReset",
      ),
      connectedIntegrationRoutedAfterReset: booleanTrue(
        observation.connectedIntegrationRoutedAfterReset,
        "connectedIntegrationRoutedAfterReset",
      ),
      connectedIntegrationUsedAfterReset: booleanTrue(
        observation.connectedIntegrationUsedAfterReset,
        "connectedIntegrationUsedAfterReset",
      ),
      postResetMcpCallRequestIdSha256: sha256Value(
        observation.postResetMcpCallRequestIdSha256,
        "postResetMcpCallRequestIdSha256",
      ),
      postResetMcpToolIdSha256: sha256Value(
        observation.postResetMcpToolIdSha256,
        "postResetMcpToolIdSha256",
      ),
      postResetMcpProviderReceiptSha256: sha256Value(
        observation.postResetMcpProviderReceiptSha256,
        "postResetMcpProviderReceiptSha256",
      ),
      mobileGenerationRotation: mobileGenerationResult,
      mobileGenerationResultSha256,
      mobileGenerationReadySha256,
      mobileGenerationBarrierRemoved: true,
      renderedGenerationProofs: [
        browserRenderedGeneration.entries[0],
        electronRenderedGeneration.entries[0],
      ],
      renderedGenerationProofSetSha256,
      renderedGenerationReadySha256,
      preResetSandboxTerminalVerified: booleanTrue(
        observation.preResetSandboxTerminalVerified,
        "preResetSandboxTerminalVerified",
      ),
      localMemoryPreservedByHardReset: booleanTrue(
        observation.localMemoryPreservedByHardReset,
        "localMemoryPreservedByHardReset",
      ),
      localOwnershipMarkerPreserved: booleanTrue(
        observation.localOwnershipMarkerPreserved,
        "localOwnershipMarkerPreserved",
      ),
      postResetReimportExact: booleanTrue(
        observation.postResetReimportExact,
        "postResetReimportExact",
      ),
    };
  },
  apps_host_workerd_runtime(observation) {
    const exactStatus = (field, expected) => {
      const value = finiteInteger(observation[field], field);
      assert(value === expected, `${field} must be ${expected}.`);
      return value;
    };
    const normalized = {
      workerName: exactLiteral(
        observation.workerName,
        REQUIRED_APPS_HOST_WORKER_NAME,
        "workerName",
      ),
      deploymentIdentity: exactLiteral(
        observation.deploymentIdentity,
        REQUIRED_CONVEX.deployment,
        "deploymentIdentity",
      ),
      runtimeEngine: exactLiteral(
        observation.runtimeEngine,
        "workerd",
        "runtimeEngine",
      ),
      wranglerVersion: exactLiteral(
        observation.wranglerVersion,
        "4.127.1",
        "wranglerVersion",
      ),
      bundleSha256: sha256Value(observation.bundleSha256, "bundleSha256"),
      bundleBytes: finiteInteger(observation.bundleBytes, "bundleBytes", 1),
      routeSetSha256: sha256Value(observation.routeSetSha256, "routeSetSha256"),
      appAssetSha256: sha256Value(observation.appAssetSha256, "appAssetSha256"),
      blockedProxyResponseSha256: sha256Value(
        observation.blockedProxyResponseSha256,
        "blockedProxyResponseSha256",
      ),
      receiptChainSha256: sha256Value(
        observation.receiptChainSha256,
        "receiptChainSha256",
      ),
      healthStatus: exactStatus("healthStatus", 200),
      appAssetStatus: exactStatus("appAssetStatus", 200),
      appHeadStatus: exactStatus("appHeadStatus", 200),
      blockedProxyStatus: exactStatus("blockedProxyStatus", 401),
      invalidConfigStatus: exactStatus("invalidConfigStatus", 503),
    };
    for (const field of [
      "productionBundleBuilt",
      "workerdRuntimeStarted",
      "realKvBindingUsed",
      "realR2BindingUsed",
      "strictHostedContentSecurityPolicy",
      "unauthenticatedProxyBlockedBeforeFetch",
      "invalidConfigurationFailedClosed",
      "runtimeDisposed",
      "isolatedStateRemoved",
    ]) {
      normalized[field] = booleanTrue(observation[field], field);
    }
    return normalized;
  },
  cleanup(observation) {
    assert(
      Array.isArray(observation.remainingResources),
      "remainingResources must be an array.",
    );
    assert(
      observation.remainingResources.length === 0,
      "Disposable resources remain after cleanup.",
      {
        remainingResources: observation.remainingResources,
      },
    );
    const liveBefore = sha256Value(
      observation.liveProfileSha256Before,
      "liveProfileSha256Before",
    );
    const liveAfter = sha256Value(
      observation.liveProfileSha256After,
      "liveProfileSha256After",
    );
    assert(
      liveBefore === liveAfter,
      "Live profile digest changed during cleanup.",
    );
    return {
      conversationPurged: booleanTrue(
        observation.conversationPurged,
        "conversationPurged",
      ),
      r2ObjectsPurged: booleanTrue(
        observation.r2ObjectsPurged,
        "r2ObjectsPurged",
      ),
      cloudMemoryPurged: booleanTrue(
        observation.cloudMemoryPurged,
        "cloudMemoryPurged",
      ),
      cloudSkillsPurged: booleanTrue(
        observation.cloudSkillsPurged,
        "cloudSkillsPurged",
      ),
      sandboxResourcesPurged: booleanTrue(
        observation.sandboxResourcesPurged,
        "sandboxResourcesPurged",
      ),
      appsHostWorkerdStateRemoved: booleanTrue(
        observation.appsHostWorkerdStateRemoved,
        "appsHostWorkerdStateRemoved",
      ),
      ownerGenerationsPurged: booleanTrue(
        observation.ownerGenerationsPurged,
        "ownerGenerationsPurged",
      ),
      oldOwnerResetCorePurged: booleanTrue(
        observation.oldOwnerResetCorePurged,
        "oldOwnerResetCorePurged",
      ),
      connectedTestAccountRevoked: booleanTrue(
        observation.connectedTestAccountRevoked,
        "connectedTestAccountRevoked",
      ),
      primarySessionRevoked: booleanTrue(
        observation.primarySessionRevoked,
        "primarySessionRevoked",
      ),
      primaryOwnerResidueRemoved: booleanTrue(
        observation.primaryOwnerResidueRemoved,
        "primaryOwnerResidueRemoved",
      ),
      primaryLifecycleTombstoned: booleanTrue(
        observation.primaryLifecycleTombstoned,
        "primaryLifecycleTombstoned",
      ),
      primaryPurgeJobCompleted: booleanTrue(
        observation.primaryPurgeJobCompleted,
        "primaryPurgeJobCompleted",
      ),
      primaryConversationResidueCount: exactInteger(
        observation.primaryConversationResidueCount,
        0,
        "primaryConversationResidueCount",
      ),
      primaryResetCoreResidueCount: exactInteger(
        observation.primaryResetCoreResidueCount,
        0,
        "primaryResetCoreResidueCount",
      ),
      primaryAccountCoreResidueCount: exactInteger(
        observation.primaryAccountCoreResidueCount,
        0,
        "primaryAccountCoreResidueCount",
      ),
      primaryCloudStoreResidueCount: exactInteger(
        observation.primaryCloudStoreResidueCount,
        0,
        "primaryCloudStoreResidueCount",
      ),
      secondaryTestAccountRevoked: booleanTrue(
        observation.secondaryTestAccountRevoked,
        "secondaryTestAccountRevoked",
      ),
      secondarySessionRevoked: booleanTrue(
        observation.secondarySessionRevoked,
        "secondarySessionRevoked",
      ),
      secondaryOwnerResidueRemoved: booleanTrue(
        observation.secondaryOwnerResidueRemoved,
        "secondaryOwnerResidueRemoved",
      ),
      secondaryConversationPurged: booleanTrue(
        observation.secondaryConversationPurged,
        "secondaryConversationPurged",
      ),
      secondaryResetCorePurged: booleanTrue(
        observation.secondaryResetCorePurged,
        "secondaryResetCorePurged",
      ),
      secondaryAccountCorePurged: booleanTrue(
        observation.secondaryAccountCorePurged,
        "secondaryAccountCorePurged",
      ),
      secondaryCloudStoresPurged: booleanTrue(
        observation.secondaryCloudStoresPurged,
        "secondaryCloudStoresPurged",
      ),
      secondaryLifecycleTombstoned: booleanTrue(
        observation.secondaryLifecycleTombstoned,
        "secondaryLifecycleTombstoned",
      ),
      secondaryPurgeJobCompleted: booleanTrue(
        observation.secondaryPurgeJobCompleted,
        "secondaryPurgeJobCompleted",
      ),
      primarySessionRestoredAfterSecondaryRevocation: booleanTrue(
        observation.primarySessionRestoredAfterSecondaryRevocation,
        "primarySessionRestoredAfterSecondaryRevocation",
      ),
      secondaryRevocationPrecededPrimaryRevocation: booleanTrue(
        observation.secondaryRevocationPrecededPrimaryRevocation,
        "secondaryRevocationPrecededPrimaryRevocation",
      ),
      secondaryConversationResidueCount: exactInteger(
        observation.secondaryConversationResidueCount,
        0,
        "secondaryConversationResidueCount",
      ),
      secondaryResetCoreResidueCount: exactInteger(
        observation.secondaryResetCoreResidueCount,
        0,
        "secondaryResetCoreResidueCount",
      ),
      secondaryAccountCoreResidueCount: exactInteger(
        observation.secondaryAccountCoreResidueCount,
        0,
        "secondaryAccountCoreResidueCount",
      ),
      secondaryCloudStoreResidueCount: exactInteger(
        observation.secondaryCloudStoreResidueCount,
        0,
        "secondaryCloudStoreResidueCount",
      ),
      anonymousMobilePolicyAccountDisposed: booleanTrue(
        observation.anonymousMobilePolicyAccountDisposed,
        "anonymousMobilePolicyAccountDisposed",
      ),
      anonymousMobilePolicySessionRevoked: booleanTrue(
        observation.anonymousMobilePolicySessionRevoked,
        "anonymousMobilePolicySessionRevoked",
      ),
      anonymousMobilePolicyOwnerResidueRemoved: booleanTrue(
        observation.anonymousMobilePolicyOwnerResidueRemoved,
        "anonymousMobilePolicyOwnerResidueRemoved",
      ),
      connectedIntegrationRemovedAfterAccountDeletion: booleanTrue(
        observation.connectedIntegrationRemovedAfterAccountDeletion,
        "connectedIntegrationRemovedAfterAccountDeletion",
      ),
      processLogsPromptRedacted: booleanTrue(
        observation.processLogsPromptRedacted,
        "processLogsPromptRedacted",
      ),
      processLogsRemoved: booleanTrue(
        observation.processLogsRemoved,
        "processLogsRemoved",
      ),
      harnessProcessGroupsStopped: booleanTrue(
        observation.harnessProcessGroupsStopped,
        "harnessProcessGroupsStopped",
      ),
      trustedLoopbackPortReleased: booleanTrue(
        observation.trustedLoopbackPortReleased,
        "trustedLoopbackPortReleased",
      ),
      isolatedProfilesRemoved: booleanTrue(
        observation.isolatedProfilesRemoved,
        "isolatedProfilesRemoved",
      ),
      liveProfileUntouched: booleanTrue(
        observation.liveProfileUntouched,
        "liveProfileUntouched",
      ),
      liveProfileSha256: liveAfter,
      remainingResources: [],
    };
  },
};

export const validateStepEvidence = ({
  stepId,
  payload,
  runId,
  target,
  expectedRawLogFile,
}) => {
  assert(
    REQUIRED_STEP_IDS.includes(stepId),
    `Unknown acceptance evidence step: ${stepId}.`,
  );
  const common = commonEvidence(stepId, payload, runId);
  if (expectedRawLogFile !== undefined) {
    assert(
      common.artifact.path === expectedRawLogFile,
      `${stepId}.artifacts.rawLog.path is not the runner-selected raw receipt file.`,
    );
  }
  return {
    identity: common.identity,
    artifact: common.artifact,
    startedAt: common.startedAt,
    finishedAt: common.finishedAt,
    evidence: validators[stepId](common.observations, {
      identity: common.identity,
      target,
    }),
  };
};

const inside = (candidate, root) =>
  candidate === root || candidate.startsWith(`${root}${path.sep}`);

export const assertEvidenceIdentityCoherence = (steps) => {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const deploymentStep = byId.get("deployment_identity");
  assert(deploymentStep, "Acceptance evidence is missing deployment_identity.");
  const deployment = deploymentStep.evidence;
  assert(
    deployment.sourceTreeSha256 === deploymentStep.identity.sourceTreeSha256,
    "Deployment evidence names a different reviewed source tree than its identity envelope.",
  );
  assert(
    deployment.deploymentFingerprintSha256 ===
      deploymentStep.identity.deploymentFingerprintSha256,
    "Deployment evidence fingerprint does not match its identity envelope.",
  );
  for (const step of steps) {
    assert(
      identityEquals(step.identity, deploymentStep.identity),
      `${step.id} belongs to a different deployment, source tree, owner, or owner generation.`,
    );
  }
  return deploymentStep;
};

export const assertEvidenceCoherence = (steps, isolatedRoots) => {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const required = (id) => {
    const step = byId.get(id);
    assert(step, `Acceptance evidence is missing ${id}.`);
    return step;
  };
  const deploymentStep = assertEvidenceIdentityCoherence(steps);
  const deployment = deploymentStep.evidence;

  const local = required("local_runtime_lifecycle").evidence;
  const stream = required("electron_real_stream").evidence;
  const consecutive = required("consecutive_durable_turns").evidence;
  const duplicate = required("duplicate_delivery_idempotency").evidence;
  const reconnect = required("electron_restart_reconnect").evidence;
  const clean = required("clean_client_hydration").evidence;
  const cache = required("cache_loss_recovery").evidence;
  const projection = required("projection_and_r2").evidence;
  const cancellation = required("cancellation").evidence;
  const noFallback = required("cloud_failure_no_local_fallback").evidence;
  const desktopRoute = required("desktop_local_routing").evidence;
  const mobileReachableRoute = required(
    "mobile_reachable_computer_routing",
  ).evidence;
  const mobileUnreachableRoute = required(
    "mobile_unreachable_cloud_routing",
  ).evidence;
  const mobileCanonical = required("mobile_signed_in_canonical_sync").evidence;
  const browserRoute = required("browser_cloud_routing").evidence;
  const child = required("child_completion").evidence;
  const memory = required("memory_restart_recall").evidence;
  const skill = required("cloud_skill_discovery_use").evidence;
  const codeMode = required("code_mode_real_mcp").evidence;
  const sandbox = required("general_agent_real_sandbox").evidence;
  const ownerReset = required("owner_reset_memory_reimport").evidence;
  const appsHost = required("apps_host_workerd_runtime").evidence;

  assert(
    local.secondaryIdentityClass === "connected-secondary" &&
      local.secondaryJwtSubjectSha256 !== deployment.jwtSubjectSha256 &&
      local.secondaryJwtTokenIdentifierSha256 !==
        deployment.jwtTokenIdentifierSha256 &&
      local.secondaryProfileDir !== local.profileDir,
    "The secondary acceptance authority is not a distinct isolated connected identity.",
  );

  const rawLogPaths = steps.map((step) => step.artifact?.path);
  assert(
    rawLogPaths.every(
      (rawLogPath) =>
        typeof rawLogPath === "string" &&
        isolatedRoots.some((root) => inside(rawLogPath, root)),
    ),
    "A retained raw log is outside the declared isolated roots.",
  );
  assert(
    new Set(rawLogPaths).size === rawLogPaths.length,
    "Acceptance steps reused a raw log artifact.",
  );

  for (const [stepId, observation] of [
    ["consecutive_durable_turns", consecutive],
    ["duplicate_delivery_idempotency", duplicate],
    ["electron_restart_reconnect", reconnect],
    ["clean_client_hydration", clean],
    ["cache_loss_recovery", cache],
    ["projection_and_r2", projection],
    ["cancellation", cancellation],
    ["cloud_failure_no_local_fallback", noFallback],
    ["memory_restart_recall", memory],
    ["cloud_skill_discovery_use", skill],
    ["code_mode_real_mcp", codeMode],
  ]) {
    assert(
      observation.conversationId === stream.conversationId,
      `${stepId} did not prove the primary Electron conversation.`,
    );
  }
  assert(
    consecutive.firstTurnId === stream.turnId &&
      consecutive.durableObjectIdSha256 === stream.durableObjectIdSha256 &&
      consecutive.journalEpoch === stream.journalEpoch &&
      consecutive.journalHeadSeqBeforeSecond === stream.journalHeadSeq,
    "The second-turn evidence is not a continuation of the exact streamed DO turn.",
  );
  assert(
    duplicate.turnId === consecutive.secondTurnId &&
      duplicate.durableObjectIdSha256 === stream.durableObjectIdSha256 &&
      duplicate.journalEpoch === stream.journalEpoch &&
      duplicate.journalHeadSeqBeforeReplay ===
        consecutive.journalHeadSeqAfterSecond,
    "Duplicate-delivery evidence does not replay the exact second durable turn.",
  );
  const distinctPrimaryTurns = [
    stream.turnId,
    consecutive.secondTurnId,
    cancellation.turnId,
    noFallback.turnId,
    noFallback.canonicalHistoryTurnId,
    noFallback.canonicalHistoryRepairTurnId,
    memory.recallTurnId,
    memory.laterTurnId,
    skill.discoveryTurnId,
    skill.useTurnId,
    codeMode.turnId,
  ];
  assert(
    new Set(distinctPrimaryTurns).size === distinctPrimaryTurns.length,
    "Primary cloud scenarios reused a turn identity that must be independently observed.",
  );
  assert(
    noFallback.canonicalContextFailureCode === "CLOUD_CONTEXT_UNAVAILABLE" &&
      noFallback.canonicalContextFailureComponent === "canonical_prompt" &&
      noFallback.providerDispatchCountBefore ===
        noFallback.providerDispatchCountAfter &&
      noFallback.canonicalHistoryFailureCode === "CLOUD_CONTEXT_UNAVAILABLE" &&
      noFallback.canonicalHistoryFailureComponent === "canonical_history" &&
      noFallback.canonicalHistoryProviderDispatchCountBefore ===
        noFallback.canonicalHistoryProviderDispatchCountAfter &&
      noFallback.canonicalHistoryCorruptPayloadSha256Before ===
        noFallback.canonicalHistoryCorruptPayloadSha256After &&
      noFallback.canonicalHistoryOriginalPayloadSha256 ===
        noFallback.canonicalHistoryRepairedPayloadSha256 &&
      noFallback.canonicalHistoryProviderDispatchCountAfterRepair >
        noFallback.canonicalHistoryProviderDispatchCountAfter,
    "Canonical prompt/history failures were not fenced, preserved, byte-identically repaired, and followed by resumed provider dispatch.",
  );
  assert(
    reconnect.durableObjectIdSha256 === stream.durableObjectIdSha256 &&
      reconnect.journalEpoch === stream.journalEpoch &&
      reconnect.journalHeadSeqBefore === duplicate.journalHeadSeqAfterReplay &&
      reconnect.journalHeadSeqAfter === duplicate.journalHeadSeqAfterReplay,
    "Restart/reconnect did not return to the same post-duplicate DO journal head.",
  );
  assert(
    reconnect.historySha256 === consecutive.historySha256 &&
      reconnect.historySha256 === clean.historySha256 &&
      reconnect.historySha256 === cache.historySha256,
    "Second-turn, reconnect, clean-client, and cache-loss histories do not match.",
  );
  assert(
    projection.journalEpoch === stream.journalEpoch &&
      projection.journalHeadSeq >= duplicate.journalHeadSeqAfterReplay,
    "Projection evidence predates the second durable turn or names another journal epoch.",
  );
  assert(
    projection.coldHistorySha256 === projection.hotHistorySha256,
    "Hot and cold R2 history reconstructions do not match.",
  );
  assert(
    clean.profileA === stream.profileDir,
    "Clean-client profile A is not the Electron streaming profile.",
  );
  assert(
    desktopRoute.conversationId === local.localConversationId &&
      desktopRoute.turnId === local.initialTurnId,
    "Desktop-local routing did not execute the local lifecycle's exact first turn.",
  );
  assert(
    local.providerLifecyclePhases.at(-1) === "transport-joined" &&
      local.providerOutcome === "completed" &&
      local.interruptedProviderLifecyclePhases.at(-1) === "transport-joined" &&
      local.interruptedProviderOutcome === "canceled" &&
      local.interruptedProviderStoppedAfterJoin === true,
    "Local lifecycle did not bind provider stop to a physically closed and joined Effect stream.",
  );
  const independentPlacementTurns = [
    desktopRoute,
    mobileReachableRoute,
    mobileUnreachableRoute,
    mobileCanonical,
    browserRoute,
  ].map((route) => `${route.conversationId}\u0000${route.turnId}`);
  assert(
    new Set(independentPlacementTurns).size ===
      independentPlacementTurns.length,
    "Independent placement scenarios reused the same conversation turn.",
  );
  assert(
    mobileCanonical.ownerGeneration ===
      deploymentStep.identity.ownerGeneration &&
      mobileCanonical.promptSeq < mobileCanonical.terminalSeq &&
      mobileCanonical.mountedRn.authority.ownerGenerationSha256 ===
        sha256(mobileCanonical.ownerGeneration) &&
      mobileCanonical.mountedRn.authority.conversationIdSha256 ===
        sha256(mobileCanonical.conversationId) &&
      mobileCanonical.mountedRn.replay.secondaryAuthority
        .ownerGenerationSha256 === local.secondaryOwnerGenerationSha256 &&
      mobileCanonical.mountedRn.replay.secondaryAuthority
        .conversationIdSha256 === local.secondaryConversationIdSha256,
    "Signed-in mobile evidence is not fenced to the deployed owner generation and one monotonic canonical journal.",
  );
  assert(
    browserRoute.expectedOwnerGeneration ===
      deploymentStep.identity.ownerGeneration,
    "Browser execution evidence is not fenced to the deployed owner generation.",
  );
  assert(
    memory.writeTurnId === consecutive.secondTurnId &&
      memory.workerVersionIdBeforeRestart === deployment.workerVersionId &&
      memory.workerVersionIdAfterRestart === deployment.workerVersionId,
    "Memory restart evidence is not tied to the second turn and deployed Worker version.",
  );
  assert(
    skill.discoveryTurnId !== skill.useTurnId,
    "Cloud skill discovery and use must be observed in distinct operations.",
  );
  assert(
    codeMode.workerVersionId === deployment.workerVersionId,
    "Code-mode MCP evidence came from another Worker version.",
  );
  assert(
    ownerReset.postResetMcpToolIdSha256 === codeMode.calledToolIdSha256 &&
      ownerReset.postResetMcpCallRequestIdSha256 !==
        codeMode.toolsCallRequestIdSha256,
    "Post-reset MCP evidence did not perform a distinct call through the exact reviewed connected tool.",
  );
  assert(
    sandbox.conversationId === browserRoute.conversationId &&
      sandbox.parentTurnId === browserRoute.turnId,
    "General sandbox execution is not the exact browser-cloud routed turn.",
  );
  assert(
    ownerReset.oldConversationId === stream.conversationId &&
      ownerReset.newConversationId !== ownerReset.oldConversationId &&
      ownerReset.oldOwnerGenerationSha256 ===
        sha256(deploymentStep.identity.ownerGeneration) &&
      ownerReset.newOwnerGenerationSha256 !==
        ownerReset.oldOwnerGenerationSha256,
    "Owner reset evidence is not the terminal rotation of the exact acceptance owner and primary conversation.",
  );
  const mountedMobile = mobileCanonical.mountedRn;
  const mountedGeneration =
    ownerReset.mobileGenerationRotation.generationRotation;
  assert(
    ownerReset.oldConversationId === mobileCanonical.conversationId &&
      mountedGeneration.oldConversationIdSha256 ===
        sha256(mobileCanonical.conversationId) &&
      mountedGeneration.conversationIdSha256 ===
        sha256(ownerReset.newConversationId) &&
      mountedGeneration.oldGenerationSha256 ===
        ownerReset.oldOwnerGenerationSha256 &&
      mountedGeneration.newGenerationSha256 ===
        ownerReset.newOwnerGenerationSha256,
    "Mounted RN generation rotation is not bound to the exact pre-reset mobile canary and post-reset authority.",
  );
  assert(
    mountedGeneration.accountScopeSha256 ===
      mountedMobile.authority.accountScopeSha256 &&
      mountedGeneration.priorStateSha256 ===
        mountedMobile.generationCanaryOutboxStateSha256 &&
      mountedGeneration.priorStateSha256 ===
        mountedMobile.clean.generationCanaryOutboxStateSha256 &&
      mountedGeneration.receipts[0].requestIdSha256 ===
        mountedMobile.clean.generationCanarySendIdSha256,
    "Mounted RN generation rotation did not consume the exact durable old-generation canary.",
  );
  assert(
    stableJson(
      ownerReset.mobileGenerationRotation.runtime.productModuleSha256,
    ) === stableJson(mountedMobile.runtime.productModuleSha256) &&
      ownerReset.mobileGenerationBarrierRemoved === true,
    "Mounted RN generation rotation changed reviewed product modules or retained its private barrier.",
  );
  assert(
    appsHost.deploymentIdentity === deployment.convexDeployment &&
      appsHost.productionBundleBuilt === true &&
      appsHost.workerdRuntimeStarted === true &&
      appsHost.isolatedStateRemoved === true,
    "Apps Host Workerd evidence is not bound to the pinned deployment and cleaned runtime.",
  );
  assert(
    child.parentConversationId === sandbox.conversationId &&
      child.parentTurnId === sandbox.parentTurnId &&
      child.childTurnId === sandbox.childTurnId &&
      child.completionJournalSeq === sandbox.completionJournalSeq,
    "Child completion does not identify the exact real sandbox child and journal record.",
  );

  for (const [label, observedPath] of [
    ["local lifecycle profileDir", local.profileDir],
    ["electron profileDir", stream.profileDir],
    ["clean profileA", clean.profileA],
    ["clean profileB", clean.profileB],
    ["cachePath", cache.cachePath],
  ]) {
    assert(
      isolatedRoots.some((root) => inside(observedPath, root)),
      `${label} is outside the declared isolated roots.`,
      { observedPath },
    );
  }
  assert(
    (cache.cachePath !== clean.profileA &&
      inside(cache.cachePath, clean.profileA)) ||
      (cache.cachePath !== clean.profileB &&
        inside(cache.cachePath, clean.profileB)),
    "Cache-loss evidence did not remove a narrow cache path inside either disposable profile.",
  );
};

const printChecklist = () => {
  console.log("Required real-product acceptance steps:\n");
  for (const [id, description] of Object.entries(requiredStepDescriptions)) {
    console.log(`- ${id}: ${description}`);
  }
  console.log(
    "\nEach command receives STELLA_CLOUD_ACCEPTANCE_RUN_ID, STELLA_CLOUD_ACCEPTANCE_STEP, STELLA_CLOUD_ACCEPTANCE_EVIDENCE_FILE, and STELLA_CLOUD_ACCEPTANCE_RAW_LOG_FILE and must write version-2 JSON evidence plus strict raw receipts.",
  );
};

const readJson = async (filePath, label) => {
  let text;
  try {
    const metadata = await stat(filePath);
    if (!metadata.isFile() || metadata.size > MAX_JSON_FILE_BYTES) {
      throw new CloudProofError(
        `${label} must be a JSON file no larger than ${MAX_JSON_FILE_BYTES} bytes.`,
      );
    }
    text = await readFile(filePath, "utf8");
  } catch (error) {
    throw new CloudProofError(
      `${label} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_FILE_BYTES) {
    throw new CloudProofError(
      `${label} grew beyond ${MAX_JSON_FILE_BYTES} bytes while being read.`,
    );
  }
  if (FORBIDDEN_TARGET_PATTERN.test(text)) {
    throw new CloudProofError(
      `${label} contains a forbidden historical or production target.`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CloudProofError(`${label} is not valid JSON.`);
  }
};

const existingDirectory = (value, label) => {
  try {
    const resolved = realpathSync(value);
    assert(statSync(resolved).isDirectory(), `${label} must be a directory.`);
    return resolved;
  } catch (error) {
    if (error instanceof CloudProofError) throw error;
    throw new CloudProofError(
      `${label} could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const futureFile = (value, label) => {
  const resolved = path.resolve(value);
  const parent = existingDirectory(path.dirname(resolved), `${label} parent`);
  return path.join(parent, path.basename(resolved));
};

const assertFreshFile = async (filePath, label) => {
  try {
    await access(filePath);
    throw new CloudProofError(
      `${label} already exists; use a fresh run directory.`,
    );
  } catch (error) {
    if (error instanceof CloudProofError) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
};

const validateCommand = (step, cwdRoots, isolatedRoots) => {
  assert(
    step.driverContract === ACCEPTANCE_DRIVER_CONTRACT,
    `${step.id}.driverContract must be ${ACCEPTANCE_DRIVER_CONTRACT}.`,
  );
  const expectedHumanAction =
    step.id === "primary_auth_handoff"
      ? "external-inbox-primary-login"
      : step.id === "browser_cloud_routing"
        ? "external-inbox-storage-recovery-login"
        : "none";
  assert(
    step.humanAction === expectedHumanAction,
    `${step.id}.humanAction must be ${expectedHumanAction}.`,
  );
  assert(
    Array.isArray(step.command) && step.command.length > 0,
    `${step.id}.command must be a non-empty argv array.`,
  );
  const command = step.command.map((argument, index) => {
    const checked = nonEmptyString(argument, `${step.id}.command[${index}]`);
    assert(!checked.includes("\0"), `${step.id}.command contains a null byte.`);
    assert(
      !FORBIDDEN_TARGET_PATTERN.test(checked),
      `${step.id}.command contains a forbidden target.`,
    );
    return checked;
  });
  assert(
    command[0] === "node" || command[0] === "bun",
    `${step.id}.command must invoke an explicit node or bun acceptance driver.`,
  );
  const declaredDriver = path.resolve(
    nonEmptyString(step.driverFile, `${step.id}.driverFile`),
  );
  assert(
    path.isAbsolute(step.driverFile),
    `${step.id}.driverFile must be absolute.`,
  );
  assert(
    path.isAbsolute(command[1]),
    `${step.id}.command[1] must be an absolute driver path.`,
  );
  assert(
    command[1] && path.resolve(command[1]) === declaredDriver,
    `${step.id}.command[1] must be its declared driverFile.`,
  );
  let driverFile;
  let driverBytes;
  try {
    driverFile = realpathSync(declaredDriver);
    const metadata = statSync(driverFile);
    assert(metadata.isFile(), `${step.id}.driverFile must be a regular file.`);
    assert(
      metadata.size <= MAX_JSON_FILE_BYTES,
      `${step.id}.driverFile exceeds the reviewable size limit.`,
    );
    driverBytes = readFileSync(driverFile);
  } catch (error) {
    if (error instanceof CloudProofError) throw error;
    throw new CloudProofError(
      `${step.id}.driverFile could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assert(
    inside(driverFile, REPO_ROOT),
    `${step.id}.driverFile must be a reviewed file inside the integration worktree.`,
    { driverFile },
  );
  command[1] = driverFile;
  const declaredCwd = path.resolve(nonEmptyString(step.cwd, `${step.id}.cwd`));
  assert(path.isAbsolute(step.cwd), `${step.id}.cwd must be absolute.`);
  const cwd = existingDirectory(declaredCwd, `${step.id}.cwd`);
  assert(
    cwdRoots.some((root) => inside(cwd, root)),
    `${step.id}.cwd is outside the integration worktree and declared isolated roots.`,
    { cwd },
  );
  const declaredOutput = nonEmptyString(
    step.evidenceFile,
    `${step.id}.evidenceFile`,
  );
  assert(
    path.isAbsolute(declaredOutput),
    `${step.id}.evidenceFile must be absolute.`,
  );
  const output = futureFile(declaredOutput, `${step.id}.evidenceFile`);
  assert(
    isolatedRoots.some((root) => inside(output, root)),
    `${step.id}.evidenceFile is outside the disposable isolated roots.`,
    { output },
  );
  assert(output.endsWith(".json"), `${step.id}.evidenceFile must be JSON.`);
  const artifactRoot = [...isolatedRoots]
    .sort((left, right) => right.length - left.length)
    .find((root) => inside(output, root));
  assert(artifactRoot, `${step.id} has no disposable artifact root.`);
  const rawLogFile = futureFile(
    path.join(artifactRoot, "raw", `${step.id}.jsonl`),
    `${step.id}.rawLogFile`,
  );
  const timeoutMs = step.timeoutMs ?? 300_000;
  assert(
    Number.isSafeInteger(timeoutMs) &&
      timeoutMs >= 5_000 &&
      timeoutMs <= MAX_STEP_TIMEOUT_MS,
    `${step.id}.timeoutMs must be 5 seconds to 60 minutes.`,
  );
  return {
    id: step.id,
    humanAction: expectedHumanAction,
    driverContract: ACCEPTANCE_DRIVER_CONTRACT,
    command,
    driverFile,
    driverSha256: sha256(driverBytes),
    cwd,
    evidenceFile: output,
    rawLogFile,
    timeoutMs,
  };
};

const validateManifest = (manifest) => {
  assert(manifest?.version === 3, "Acceptance manifest version must be 3.");
  assert(
    manifest?.stepCount === REQUIRED_STEP_IDS.length,
    `Acceptance manifest stepCount must be ${REQUIRED_STEP_IDS.length}.`,
  );
  const target = loadNonMutatingTarget({
    deployment: manifest?.target?.convexDeployment,
    convexUrl: manifest?.target?.convexUrl,
    convexSiteUrl: manifest?.target?.convexSiteUrl,
    cloudBuilderUrl: manifest?.target?.cloudBuilderUrl,
  });
  const isolatedRoots = Array.isArray(manifest.isolatedRoots)
    ? manifest.isolatedRoots.map((root, index) => {
        const label = `isolatedRoots[${index}]`;
        const declared = safeIsolatedPath(root, label);
        return safeIsolatedPath(existingDirectory(declared, label), label);
      })
    : [];
  assert(
    isolatedRoots.length > 0,
    "manifest.isolatedRoots must name at least one disposable harness root.",
  );
  assert(
    new Set(isolatedRoots).size === isolatedRoots.length,
    "manifest.isolatedRoots contains a duplicate path.",
  );
  assert(
    isolatedRoots.every(
      (root) => !inside(REPO_ROOT, root) && !inside(root, REPO_ROOT),
    ),
    "A disposable harness root must not overlap the integration worktree.",
  );
  const cwdRoots = [REPO_ROOT, ...isolatedRoots];
  const declaredOutput = nonEmptyString(manifest.output, "manifest.output");
  assert(path.isAbsolute(declaredOutput), "manifest.output must be absolute.");
  const output = futureFile(declaredOutput, "manifest.output");
  assert(
    isolatedRoots.some((root) => inside(output, root)),
    "manifest.output is outside the disposable isolated roots.",
  );
  assert(output.endsWith(".json"), "manifest.output must be a JSON file.");
  assert(Array.isArray(manifest.steps), "manifest.steps must be an array.");
  assert(
    manifest.steps.length === manifest.stepCount,
    "manifest.steps length must equal manifest.stepCount.",
  );
  const byId = new Map();
  for (const rawStep of manifest.steps) {
    assert(
      rawStep && typeof rawStep === "object",
      "Every manifest step must be an object.",
    );
    assert(
      REQUIRED_STEP_IDS.includes(rawStep.id),
      `Unknown acceptance step: ${rawStep.id}.`,
    );
    assert(!byId.has(rawStep.id), `Duplicate acceptance step: ${rawStep.id}.`);
    byId.set(rawStep.id, validateCommand(rawStep, cwdRoots, isolatedRoots));
  }
  const missing = REQUIRED_STEP_IDS.filter((id) => !byId.has(id));
  assert(
    missing.length === 0,
    `Acceptance manifest is missing: ${missing.join(", ")}.`,
  );
  const evidenceFiles = [...byId.values()].map((step) => step.evidenceFile);
  assert(
    new Set(evidenceFiles).size === evidenceFiles.length,
    "Every acceptance step needs a distinct evidence file.",
  );
  assert(
    !evidenceFiles.includes(output),
    "The aggregate output must differ from every step evidence file.",
  );
  return {
    target,
    isolatedRoots,
    output,
    steps: REQUIRED_STEP_IDS.map((id) => byId.get(id)),
  };
};

const primaryAuthCheckpointPath = (validated) => {
  const first = validated.steps[0];
  assert(
    first?.id === "primary_auth_handoff",
    "primary_auth_handoff must be the first acceptance step.",
  );
  const stateDirectory = existingDirectory(
    path.join(first.cwd, "state"),
    "primary auth checkpoint directory",
  );
  const checkpoint = path.join(stateDirectory, "primary-auth-handoff-run.json");
  assert(
    validated.isolatedRoots.some((root) => inside(checkpoint, root)),
    "Primary auth checkpoint is outside the disposable isolated roots.",
  );
  return checkpoint;
};

const normalizedDisposableEmail = (
  environment,
  key = "STELLA_CLOUD_ACCEPTANCE_DISPOSABLE_EMAIL",
) => {
  const email = environment[key]?.trim().toLowerCase();
  assert(
    email &&
      email === environment[key] &&
      email.length <= 320 &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email),
    `${key} must be a normalized disposable inbox address.`,
  );
  return email;
};

const sealPrimaryAuthCheckpoint = (body) => ({
  ...body,
  checkpointSha256: sha256(canonicalJson(body)),
});

const validatePrimaryAuthPrepareReceipt = (value, { runId, step }) => {
  const receipt = value && typeof value === "object" ? value : null;
  assert(receipt, "Primary auth preparation did not return a receipt.");
  const exactKeys = [
    "contract",
    "runId",
    "status",
    "profileSetSha256",
    "requestSetSha256",
    "stateSha256",
    "receiptSha256",
  ];
  assert(
    JSON.stringify(Object.keys(receipt).sort()) ===
      JSON.stringify([...exactKeys].sort()),
    "Primary auth preparation receipt has an unreviewed field set.",
  );
  assert(
    receipt.contract === PRIMARY_AUTH_HANDOFF_PREPARE_CONTRACT &&
      receipt.runId === runId &&
      receipt.status === "awaiting-external-inbox-completion",
    "Primary auth preparation receipt is not bound to this awaiting run.",
  );
  for (const [label, digest] of Object.entries({
    profiles: receipt.profileSetSha256,
    requests: receipt.requestSetSha256,
    state: receipt.stateSha256,
    receipt: receipt.receiptSha256,
  })) {
    sha256Value(digest, `Primary auth preparation ${label}`);
  }
  const { receiptSha256, ...body } = receipt;
  assert(
    receiptSha256 === sha256(canonicalJson(body)),
    "Primary auth preparation receipt hash is invalid.",
  );
  assert(
    step.id === "primary_auth_handoff",
    "Primary auth preparation used the wrong manifest step.",
  );
  return receipt;
};

const readPrimaryAuthRunCheckpoint = async (
  checkpointPath,
  {
    manifestSha256,
    validated,
    expectedEmailSha256,
    expectedSecondaryEmailSha256,
    allowPreparing = false,
  },
) => {
  const checkpoint = await readJson(
    checkpointPath,
    "primary auth run checkpoint",
  );
  const exactKeys = [
    "contract",
    "checkpointSha256",
    "createdAt",
    "driverSha256",
    "emailSha256",
    "harnessRootSha256",
    "manifestSha256",
    "prepareReceiptSha256",
    "profileSetSha256",
    "requestCount",
    "requestSetSha256",
    "runId",
    "secondaryEmailSha256",
    "status",
    "surfaceCount",
    "targetSha256",
  ];
  assert(
    checkpoint &&
      typeof checkpoint === "object" &&
      JSON.stringify(Object.keys(checkpoint).sort()) ===
        JSON.stringify([...exactKeys].sort()),
    "Primary auth run checkpoint has an unreviewed field set.",
  );
  const { checkpointSha256, ...body } = checkpoint;
  sha256Value(checkpointSha256, "Primary auth checkpoint seal");
  assert(
    checkpointSha256 === sha256(canonicalJson(body)),
    "Primary auth run checkpoint seal is invalid.",
  );
  assert(
    checkpoint.contract === PRIMARY_AUTH_HANDOFF_CHECKPOINT_CONTRACT &&
      (checkpoint.status === "awaiting-external-inbox-completion" ||
        (allowPreparing && checkpoint.status === "preparing-product-login")),
    "Primary auth run checkpoint is not awaiting product login.",
  );
  uuidValue(checkpoint.runId, "Primary auth checkpoint run id");
  const first = validated.steps[0];
  assert(
    checkpoint.manifestSha256 === manifestSha256 &&
      checkpoint.driverSha256 === first.driverSha256 &&
      checkpoint.targetSha256 === sha256(canonicalJson(validated.target)) &&
      checkpoint.harnessRootSha256 === sha256(first.cwd) &&
      checkpoint.emailSha256 === expectedEmailSha256 &&
      checkpoint.secondaryEmailSha256 === expectedSecondaryEmailSha256,
    "Primary auth run checkpoint does not match this manifest, driver, or target.",
  );
  sha256Value(checkpoint.emailSha256, "Primary auth checkpoint email");
  sha256Value(
    checkpoint.secondaryEmailSha256,
    "Secondary auth checkpoint email",
  );
  assert(
    checkpoint.surfaceCount === 4 && checkpoint.requestCount === 4,
    "Initial auth checkpoint must cover the three primary surfaces and the distinct connected-secondary surface.",
  );
  if (checkpoint.status === "awaiting-external-inbox-completion") {
    sha256Value(
      checkpoint.prepareReceiptSha256,
      "Primary auth checkpoint prepare receipt",
    );
    sha256Value(
      checkpoint.profileSetSha256,
      "Primary auth checkpoint profile set",
    );
    sha256Value(
      checkpoint.requestSetSha256,
      "Primary auth checkpoint request set",
    );
  } else {
    assert(
      checkpoint.prepareReceiptSha256 === null &&
        checkpoint.profileSetSha256 === null &&
        checkpoint.requestSetSha256 === null,
      "Preparing auth checkpoint already claims completed requests.",
    );
  }
  assert(
    Number.isFinite(Date.parse(checkpoint.createdAt)),
    "Primary auth checkpoint timestamp is invalid.",
  );
  return checkpoint;
};

const runPrimaryAuthPreparation = async (
  step,
  runId,
  target,
  parentEnvironment,
) => {
  const currentDriver = await readFile(step.driverFile);
  assert(
    sha256(currentDriver) === step.driverSha256,
    "primary_auth_handoff.driverFile changed after manifest validation.",
  );
  const normalizedEmail = normalizedDisposableEmail(parentEnvironment);
  const normalizedSecondaryEmail = normalizedDisposableEmail(
    parentEnvironment,
    "STELLA_CLOUD_ACCEPTANCE_SECONDARY_DISPOSABLE_EMAIL",
  );
  assert(
    normalizedSecondaryEmail !== normalizedEmail,
    "Primary and secondary disposable inbox addresses must differ.",
  );
  const env = {
    ...Object.fromEntries(
      [
        "PATH",
        "TMPDIR",
        "TMP",
        "TEMP",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TZ",
        "DISPLAY",
        "XDG_RUNTIME_DIR",
        "STELLA_CLOUD_ACCEPTANCE_BROWSER_BINARY",
      ]
        .filter(
          (key) =>
            typeof parentEnvironment[key] === "string" &&
            parentEnvironment[key].length > 0,
        )
        .map((key) => [key, parentEnvironment[key]]),
    ),
    CONVEX_DEPLOYMENT: target.deployment,
    CONVEX_URL: target.convexUrl,
    CONVEX_SITE_URL: target.convexSiteUrl,
    VITE_CONVEX_URL: target.convexUrl,
    VITE_CONVEX_SITE_URL: target.convexSiteUrl,
    CLOUD_BUILDER_URL: target.cloudBuilderUrl,
    STELLA_CLOUD_ACCEPTANCE_RUN_ID: runId,
    STELLA_CLOUD_ACCEPTANCE_STEP: step.id,
    STELLA_CLOUD_ACCEPTANCE_EVIDENCE_FILE: step.evidenceFile,
    STELLA_CLOUD_ACCEPTANCE_RAW_LOG_FILE: step.rawLogFile,
    STELLA_CLOUD_ACCEPTANCE_DRIVER_CONTRACT: step.driverContract,
    STELLA_CLOUD_PROOF_IDENTITY_KIND: "disposable",
    STELLA_CLOUD_ACCEPTANCE_DISPOSABLE_EMAIL: normalizedEmail,
    STELLA_CLOUD_ACCEPTANCE_SECONDARY_DISPOSABLE_EMAIL:
      normalizedSecondaryEmail,
  };
  const child = spawn(step.command[0], [step.command[1], "--prepare-auth"], {
    cwd: step.cwd,
    env,
    detached: DRIVER_PROCESS_GROUPS,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  let bytes = 0;
  let overflow = false;
  const collect = (chunks) => (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_COMMAND_OUTPUT_BYTES) {
      overflow = true;
      child.kill("SIGTERM");
      return;
    }
    chunks.push(chunk);
  };
  child.stdout.on("data", collect(stdout));
  child.stderr.on("data", collect(stderr));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    signalDriverProcessTree(child, "SIGTERM");
  }, step.timeoutMs);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  const stdoutBytes = Buffer.concat(stdout);
  const stderrBytes = Buffer.concat(stderr);
  assert(!overflow, "Primary auth preparation exceeded the output limit.");
  assert(!timedOut, "Primary auth preparation timed out.");
  assert(result.code === 0, "Primary auth preparation command failed.", {
    code: result.code,
    signal: result.signal,
    stdoutSha256: sha256(stdoutBytes),
    stderrSha256: sha256(stderrBytes),
  });
  let parsed;
  try {
    parsed = JSON.parse(stdoutBytes.toString("utf8").trim());
  } catch {
    throw new CloudProofError(
      "Primary auth preparation stdout was not one hash-only JSON receipt.",
    );
  }
  return validatePrimaryAuthPrepareReceipt(parsed, { runId, step });
};

const runCommand = async (
  step,
  runId,
  target,
  parentEnvironment = process.env,
) => {
  const currentDriver = await readFile(step.driverFile);
  assert(
    sha256(currentDriver) === step.driverSha256,
    `${step.id}.driverFile changed after manifest validation.`,
  );
  await assertFreshFile(step.evidenceFile, `${step.id} evidence file`);
  await assertFreshFile(step.rawLogFile, `${step.id} raw-log file`);

  const env = {
    ...stripInheritedAcceptanceAuthority(parentEnvironment),
    CONVEX_DEPLOYMENT: target.deployment,
    CONVEX_URL: target.convexUrl,
    CONVEX_SITE_URL: target.convexSiteUrl,
    VITE_CONVEX_URL: target.convexUrl,
    VITE_CONVEX_SITE_URL: target.convexSiteUrl,
    CLOUD_BUILDER_URL: target.cloudBuilderUrl,
    STELLA_CLOUD_ACCEPTANCE_RUN_ID: runId,
    STELLA_CLOUD_ACCEPTANCE_STEP: step.id,
    STELLA_CLOUD_ACCEPTANCE_EVIDENCE_FILE: step.evidenceFile,
    STELLA_CLOUD_ACCEPTANCE_RAW_LOG_FILE: step.rawLogFile,
    STELLA_CLOUD_ACCEPTANCE_DRIVER_CONTRACT: step.driverContract,
  };
  // Product profiles, not inherited frozen secrets, are the only accepted
  // authority source for this run.
  for (const key of Object.keys(env)) {
    if (
      /(?:CONVEX|CLOUD_BUILDER|STELLA.*CLOUD)/i.test(key) &&
      FORBIDDEN_TARGET_PATTERN.test(String(env[key] ?? ""))
    ) {
      throw new CloudProofError(
        `Inherited ${key} contains a forbidden target.`,
      );
    }
  }

  const started = Date.now();
  const child = spawn(step.command[0], step.command.slice(1), {
    cwd: step.cwd,
    env,
    detached: DRIVER_PROCESS_GROUPS,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  let bytes = 0;
  let outputOverflow = false;
  let forceKillTimer;
  let terminationRequested = false;
  const terminate = () => {
    terminationRequested = true;
    signalDriverProcessTree(child, "SIGTERM");
    if (!forceKillTimer) {
      forceKillTimer = setTimeout(
        () => signalDriverProcessTree(child, "SIGKILL"),
        5_000,
      );
    }
  };
  const collect = (chunks) => (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_COMMAND_OUTPUT_BYTES) {
      outputOverflow = true;
      terminate();
      return;
    }
    chunks.push(chunk);
  };
  child.stdout.on("data", collect(stdout));
  child.stderr.on("data", collect(stderr));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, step.timeoutMs);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    clearTimeout(timer);
    if (driverProcessGroupAlive(child.pid)) terminate();
    if (forceKillTimer && !terminationRequested) clearTimeout(forceKillTimer);
  });
  const stdoutBytes = Buffer.concat(stdout);
  const stderrBytes = Buffer.concat(stderr);
  assert(!outputOverflow, `${step.id} exceeded the command-output limit.`);
  assert(!timedOut, `${step.id} timed out after ${step.timeoutMs}ms.`, {
    signal: result.signal,
  });
  if (result.code === PRIMARY_AUTH_AWAITING_EXIT_CODE) {
    throw new ProductHandoffAwaitingError(
      step.id === "primary_auth_handoff"
        ? "The initial connected product logins are still awaiting their authorized inbox handoff."
        : `${step.id} is awaiting a required product login handoff.`,
      {
        step: step.id,
        stdoutSha256: sha256(stdoutBytes),
        stderrSha256: sha256(stderrBytes),
      },
    );
  }
  if (result.code === AUTHORITY_RUNWAY_EXHAUSTED_EXIT_CODE) {
    throw new CloudProofError(
      `${step.id} exhausted its checked product-profile authority runway.`,
      {
        code: AUTHORITY_RUNWAY_EXHAUSTED,
        step: step.id,
        stdoutSha256: sha256(stdoutBytes),
        stderrSha256: sha256(stderrBytes),
      },
    );
  }
  assert(result.code === 0, `${step.id} command failed.`, {
    code: result.code,
    signal: result.signal,
    stdoutSha256: sha256(stdoutBytes),
    stderrSha256: sha256(stderrBytes),
  });
  const payload = await readJson(step.evidenceFile, `${step.id} evidence`);
  const validatedEvidence = validateStepEvidence({
    stepId: step.id,
    payload,
    runId,
    target,
    expectedRawLogFile: step.rawLogFile,
  });
  return {
    id: step.id,
    passed: true,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    commandExecutable: path.basename(step.command[0]),
    driverContract: step.driverContract,
    driverFile: step.driverFile,
    driverSha256: step.driverSha256,
    cwd: step.cwd,
    stdoutBytes: stdoutBytes.length,
    stderrBytes: stderrBytes.length,
    stdoutSha256: sha256(stdoutBytes),
    stderrSha256: sha256(stderrBytes),
    identity: validatedEvidence.identity,
    artifact: validatedEvidence.artifact,
    driverStartedAt: validatedEvidence.startedAt,
    driverFinishedAt: validatedEvidence.finishedAt,
    evidence: validatedEvidence.evidence,
  };
};

const fileExists = async (filePath) => {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

export const loadCompletedAcceptancePrefix = async (validated, runId) => {
  const completed = [];
  let foundGap = false;
  for (const step of validated.steps) {
    const [hasEvidence, hasRawLog] = await Promise.all([
      fileExists(step.evidenceFile),
      fileExists(step.rawLogFile),
    ]);
    assert(
      hasEvidence === hasRawLog,
      `${step.id} has only one half of its evidence/raw-log pair.`,
    );
    if (step.id === "cleanup") {
      assert(
        !hasEvidence,
        "A prior cleanup receipt exists without a final aggregate report; refusing to resume a terminated run.",
      );
      continue;
    }
    if (!hasEvidence) {
      foundGap = true;
      continue;
    }
    assert(
      !foundGap,
      `${step.id} evidence exists after an incomplete predecessor.`,
    );
    const payload = await readJson(step.evidenceFile, `${step.id} evidence`);
    const validatedEvidence = validateStepEvidence({
      stepId: step.id,
      payload,
      runId,
      target: validated.target,
      expectedRawLogFile: step.rawLogFile,
    });
    completed.push({
      id: step.id,
      passed: true,
      resumedFromValidatedArtifact: true,
      startedAt: validatedEvidence.startedAt,
      finishedAt: validatedEvidence.finishedAt,
      durationMs:
        Date.parse(validatedEvidence.finishedAt) -
        Date.parse(validatedEvidence.startedAt),
      commandExecutable: path.basename(step.command[0]),
      driverContract: step.driverContract,
      driverFile: step.driverFile,
      driverSha256: step.driverSha256,
      cwd: step.cwd,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutSha256: sha256(Buffer.alloc(0)),
      stderrSha256: sha256(Buffer.alloc(0)),
      identity: validatedEvidence.identity,
      artifact: validatedEvidence.artifact,
      driverStartedAt: validatedEvidence.startedAt,
      driverFinishedAt: validatedEvidence.finishedAt,
      evidence: validatedEvidence.evidence,
    });
  }
  return completed;
};

export const runAcceptanceCli = async (
  argv = process.argv.slice(2),
  environment = process.env,
) => {
  const [mode, manifestArgument, ...extra] = argv;
  if (mode === "--list" && !manifestArgument && extra.length === 0) {
    printChecklist();
    return;
  }
  if (
    !["--check", "--prepare-auth", "--run"].includes(mode) ||
    !manifestArgument ||
    extra.length > 0
  ) {
    throw new CloudProofError(
      "Use --list, --check /absolute/manifest.json, --prepare-auth /absolute/manifest.json, or --run /absolute/manifest.json.",
    );
  }
  assert(path.isAbsolute(manifestArgument), "Manifest path must be absolute.");
  const manifestBytes = await readFile(manifestArgument);
  const manifestSha256 = sha256(manifestBytes);
  const manifest = await readJson(manifestArgument, "acceptance manifest");
  const validated = validateManifest(manifest);
  if (mode === "--check") {
    console.log(
      `Acceptance manifest is structurally valid for ${validated.target.deployment}.`,
    );
    return;
  }
  assertSafeAcceptanceEnvironment(manifest, environment);
  const authCheckpointPath = primaryAuthCheckpointPath(validated);
  const disposableEmail = normalizedDisposableEmail(environment);
  const disposableEmailSha256 = sha256(disposableEmail);
  const secondaryDisposableEmail = normalizedDisposableEmail(
    environment,
    "STELLA_CLOUD_ACCEPTANCE_SECONDARY_DISPOSABLE_EMAIL",
  );
  assert(
    secondaryDisposableEmail !== disposableEmail,
    "Primary and secondary disposable inbox addresses must differ.",
  );
  const secondaryDisposableEmailSha256 = sha256(secondaryDisposableEmail);
  if (mode === "--prepare-auth") {
    await Promise.all([
      assertFreshFile(validated.output, "Acceptance report"),
      ...validated.steps.map((step) =>
        assertFreshFile(step.evidenceFile, `${step.id} evidence file`),
      ),
      ...validated.steps.map((step) =>
        assertFreshFile(step.rawLogFile, `${step.id} raw-log file`),
      ),
    ]);
    const first = validated.steps[0];
    let checkpoint;
    try {
      await access(authCheckpointPath);
      checkpoint = await readPrimaryAuthRunCheckpoint(authCheckpointPath, {
        manifestSha256,
        validated,
        expectedEmailSha256: disposableEmailSha256,
        expectedSecondaryEmailSha256: secondaryDisposableEmailSha256,
        allowPreparing: true,
      });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const body = {
        contract: PRIMARY_AUTH_HANDOFF_CHECKPOINT_CONTRACT,
        status: "preparing-product-login",
        runId: randomUUID(),
        createdAt: new Date().toISOString(),
        manifestSha256,
        driverSha256: first.driverSha256,
        targetSha256: sha256(canonicalJson(validated.target)),
        harnessRootSha256: sha256(first.cwd),
        emailSha256: disposableEmailSha256,
        secondaryEmailSha256: secondaryDisposableEmailSha256,
        surfaceCount: 4,
        requestCount: 4,
        prepareReceiptSha256: null,
        profileSetSha256: null,
        requestSetSha256: null,
      };
      checkpoint = sealPrimaryAuthCheckpoint(body);
      await atomicWritePrivateJson(authCheckpointPath, checkpoint);
    }
    if (checkpoint.status === "awaiting-external-inbox-completion") {
      console.log(
        `PRIMARY AUTH HANDOFF AWAITING. Open all four delivered links in the two authorized disposable inboxes, then rerun with --run. Keep the prepared isolated product processes alive; full machine or app-process death requires restarting the acceptance run. Receipt: ${checkpoint.prepareReceiptSha256}`,
      );
      return;
    }
    const receipt = await runPrimaryAuthPreparation(
      first,
      checkpoint.runId,
      validated.target,
      environment,
    );
    const awaitingBody = {
      contract: PRIMARY_AUTH_HANDOFF_CHECKPOINT_CONTRACT,
      status: "awaiting-external-inbox-completion",
      runId: checkpoint.runId,
      createdAt: checkpoint.createdAt,
      manifestSha256,
      driverSha256: first.driverSha256,
      targetSha256: sha256(canonicalJson(validated.target)),
      harnessRootSha256: sha256(first.cwd),
      emailSha256: disposableEmailSha256,
      secondaryEmailSha256: secondaryDisposableEmailSha256,
      surfaceCount: 4,
      requestCount: 4,
      prepareReceiptSha256: receipt.receiptSha256,
      profileSetSha256: receipt.profileSetSha256,
      requestSetSha256: receipt.requestSetSha256,
    };
    await atomicWritePrivateJson(
      authCheckpointPath,
      sealPrimaryAuthCheckpoint(awaitingBody),
    );
    console.log(
      `PRIMARY AUTH HANDOFF AWAITING. Open all four delivered links in the two authorized disposable inboxes, then rerun with --run. Keep the prepared isolated product processes alive; full machine or app-process death requires restarting the acceptance run. Receipt: ${receipt.receiptSha256}`,
    );
    return;
  }
  const authCheckpoint = await readPrimaryAuthRunCheckpoint(
    authCheckpointPath,
    {
      manifestSha256,
      validated,
      expectedEmailSha256: disposableEmailSha256,
      expectedSecondaryEmailSha256: secondaryDisposableEmailSha256,
    },
  );
  const runId = authCheckpoint.runId;
  await assertFreshFile(validated.output, "Acceptance report");
  const completedPrefix = await loadCompletedAcceptancePrefix(validated, runId);
  const report = {
    version: 3,
    stepCount: REQUIRED_STEP_IDS.length,
    kind: "cloud-canonical-real-product-acceptance",
    runId,
    startedAt: new Date().toISOString(),
    target: validated.target,
    repoRoot: REPO_ROOT,
    isolatedRoots: validated.isolatedRoots,
    resumed: completedPrefix.length > 0,
    steps: [...completedPrefix],
  };
  let failure = null;
  const cleanupStep = validated.steps.find((step) => step.id === "cleanup");
  const authStep = validated.steps[0];

  if (completedPrefix.length === 0) {
    try {
      report.steps.push(
        await runCommand(authStep, runId, validated.target, environment),
      );
    } catch (error) {
      // A partially prepared human-auth profile is the only authority capable
      // of resuming or cleaning itself. Never delete it before the product has
      // verified and committed the primary_auth_handoff step.
      const awaiting = error instanceof ProductHandoffAwaitingError;
      const safe = sanitizeEvidence({
        message: error instanceof Error ? error.message : String(error),
      });
      console.error(
        awaiting
          ? "PRIMARY AUTH HANDOFF STILL AWAITING. The four prepared isolated profiles were preserved; complete the links in both disposable inboxes and rerun --run."
          : `PRIMARY AUTH HANDOFF FAILED BEFORE CLEANUP WAS ARMED: ${safe.message}. The prepared isolated profiles were preserved for audit/retry.`,
      );
      process.exitCode = awaiting ? PRIMARY_AUTH_AWAITING_EXIT_CODE : 1;
      return;
    }
  } else {
    assert(
      completedPrefix[0]?.id === "primary_auth_handoff",
      "Resumed evidence does not begin with primary_auth_handoff.",
    );
  }

  let awaitingHandoff = null;
  try {
    for (const step of validated.steps.slice(report.steps.length)) {
      if (step.id === "cleanup") continue;
      report.steps.push(
        await runCommand(step, runId, validated.target, environment),
      );
    }
    assertEvidenceCoherence(report.steps, validated.isolatedRoots);
  } catch (error) {
    if (error instanceof ProductHandoffAwaitingError) {
      awaitingHandoff = error;
    } else {
      failure = error;
      report.failure = sanitizeEvidence({
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
        details: error instanceof CloudProofError ? error.details : undefined,
      });
    }
  }
  if (awaitingHandoff) {
    const pendingStep = awaitingHandoff.details?.step ?? "product login";
    console.error(
      `PRODUCT HANDOFF AWAITING FOR ${pendingStep}. Complete the requested action in the preserved isolated profile, then rerun --run. Keep the prepared isolated product processes alive; full machine or app-process death requires restarting the acceptance run. No cleanup or aggregate evidence was emitted.`,
    );
    process.exitCode = PRIMARY_AUTH_AWAITING_EXIT_CODE;
    return;
  }
  try {
    const cleanupResult = await runCommand(
      cleanupStep,
      runId,
      validated.target,
      environment,
    );
    const deploymentResult = report.steps.find(
      (step) => step.id === "deployment_identity",
    );
    if (deploymentResult) {
      assert(
        identityEquals(cleanupResult.identity, deploymentResult.identity),
        "cleanup belongs to a different deployment, source tree, owner, or owner generation.",
      );
    }
    report.steps.push(cleanupResult);
  } catch (error) {
    report.cleanupFailure = sanitizeEvidence({
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      details: error instanceof CloudProofError ? error.details : undefined,
    });
    if (!failure) failure = error;
  } finally {
    report.finishedAt = new Date().toISOString();
    report.durationMs =
      Date.parse(report.finishedAt) - Date.parse(report.startedAt);
    report.result = failure ? "failed" : "passed";
    await writeEvidence(validated.output, report);
  }

  if (failure) {
    const safe = sanitizeEvidence({
      message: failure instanceof Error ? failure.message : String(failure),
    });
    console.error(
      `REAL CLOUD ACCEPTANCE FAILED: ${safe.message}. Evidence: ${validated.output}`,
    );
    process.exitCode = 1;
  } else {
    console.log(`REAL CLOUD ACCEPTANCE PASSED. Evidence: ${validated.output}`);
  }
};

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) await runAcceptanceCli();
