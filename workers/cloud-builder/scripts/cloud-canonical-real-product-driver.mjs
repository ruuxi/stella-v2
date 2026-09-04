#!/usr/bin/env node

/**
 * Strict, in-tree driver for the cloud-canonical real-product acceptance run.
 *
 * This program intentionally has no fixture, observation-file, command-plugin,
 * or "trust me" mode.  Every step uses a fixed Stella/Cloudflare/Convex
 * surface and derives its observations from the returned product state.  If a
 * credential, deployed capability, durable receipt, or cross-step identity is
 * missing, the step fails before evidence is written.
 *
 * The runner invokes one fresh process per step.  The processes coordinate via
 * a private, atomically replaced, SHA-256 chained state document under the
 * runner-created disposable root. Raw credentials never enter that document;
 * raw owner identifiers are confined to its mode-0600 cleanup ledger and never
 * enter an evidence artifact.
 */

import { spawn } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  createReadStream,
  existsSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CloudProofError,
  FORBIDDEN_TARGET_PATTERN,
  REQUIRED_AGENT_HOME_BUCKET_NAME,
  REQUIRED_APPS_HOST_ORIGIN,
  REQUIRED_APPS_HOST_WORKER_NAME,
  REQUIRED_CLOUDFLARE_ENVIRONMENT,
  REQUIRED_CLOUD_BUILDER_WORKER_NAME,
  REQUIRED_CONVERSATION_ARCHIVE_BUCKET_NAME,
  REQUIRED_CONVEX,
  assert,
  poll,
  requestJson,
  sanitizeEvidence,
  sha256,
} from "./cloud-proof-lib.mjs";
import {
  ACCEPTANCE_DRIVER_CONTRACT,
  loadAcceptanceDriverContext,
  writeAcceptanceDriverEvidence,
} from "./cloud-canonical-acceptance-driver-contract.mjs";
import { runAppsHostWorkerdAcceptance } from "../../apps-host/scripts/workerd-runtime-acceptance.mjs";
import {
  beginRenderedProductMagicLinkLogin,
  completeRenderedProductMagicLinkLogin,
  composeRenderedCrossProcessIdentityRoundTrip,
  connectRenderedClientCdp,
  beginRenderedBrowserStorageRecovery,
  completeRenderedBrowserStorageRecovery,
  exerciseMountedTransportResume,
  exerciseRenderedBrowserGenerationRotation,
  exerciseRenderedElectronGenerationRotation,
  exerciseRenderedTabReload,
  fingerprintRenderedProcess,
  launchIsolatedChromium,
  listRenderedConversations,
  navigateRenderedClient,
  refreshRenderedClientIdentity,
  renderedBrowserProcessIdentity,
  renderedClientReceipt,
  renderedProcessIdentity,
  selectRenderedConversation,
  sendRenderedPrompt,
  snapshotFullRenderedConversation,
  snapshotRenderedConversation,
  stopIsolatedChromium,
  verifyRenderedColdProcessHydration,
  verifyExistingPrimaryBrowserProfile,
  verifyExistingPrimaryElectronProfile,
  verifyRenderedProductLoginSameProfileChat,
  verifyRenderedProductOnboardingPersistence,
  waitForRenderedFailClosed,
  waitForRenderedStreaming,
  waitForRenderedTerminal,
} from "./rendered-client-cdp.mjs";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = realpathSync(
  path.resolve(path.dirname(SCRIPT_FILE), "../../.."),
);
const LIVE_STELLA_ROOT = path.resolve(homedir(), ".stella");
const WORKER_NAME = REQUIRED_CLOUD_BUILDER_WORKER_NAME;
const STATE_VERSION = 3;
const PRIMARY_AUTH_HANDOFF_PREPARE_CONTRACT =
  "stella-cloud-primary-auth-handoff-prepare-v1";
const PRIMARY_AUTH_AWAITING_EXIT_CODE = 75;
export const AUTHORITY_RUNWAY_EXHAUSTED_EXIT_CODE = 76;
const STATE_FILE_NAME = "real-product-driver-state.json";
const LOCK_FILE_NAME = "real-product-driver.lock";
const PROCESS_LOG_DIRECTORY = "process-logs";
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_COMMAND_BYTES = 4 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;
const CANONICAL_PROMPT_SCHEMA_VERSION = 2;
export const CANONICAL_PROMPT_SOURCES = Object.freeze([
  Object.freeze({
    id: "agents/orchestrator.md",
    kind: "agent-metadata",
    relativePath:
      "packages/runtime/extensions/stella-runtime/agent-metadata/orchestrator.md",
  }),
  Object.freeze({
    id: "agents/general.md",
    kind: "agent-metadata",
    relativePath:
      "packages/runtime/extensions/stella-runtime/agent-metadata/general.md",
  }),
  Object.freeze({
    id: "agents/fashion.md",
    kind: "agent-metadata",
    relativePath:
      "packages/runtime/extensions/stella-runtime/agent-metadata/fashion.md",
  }),
  Object.freeze({
    id: "agents/explore.md",
    kind: "agent-metadata",
    relativePath:
      "packages/runtime/extensions/stella-runtime/agent-metadata/explore.md",
  }),
  Object.freeze({
    id: "prompts/thread-compaction.md",
    kind: "prompt",
    relativePath:
      "packages/runtime/extensions/stella-runtime/prompts/thread-compaction.md",
  }),
  Object.freeze({
    id: "prompts/fallback-orchestrator.md",
    kind: "prompt",
    relativePath:
      "packages/runtime/extensions/stella-runtime/prompts/fallback-orchestrator.md",
  }),
  Object.freeze({
    id: "prompts/fallback-subagent.md",
    kind: "prompt",
    relativePath:
      "packages/runtime/extensions/stella-runtime/prompts/fallback-subagent.md",
  }),
  Object.freeze({
    id: "prompts/personality.md",
    kind: "prompt",
    relativePath:
      "packages/runtime/extensions/stella-runtime/prompts/personality.md",
  }),
]);
export const CANONICAL_PROMPT_IDS = Object.freeze(
  CANONICAL_PROMPT_SOURCES.map(({ id }) => id),
);
const CANONICAL_PROMPT_MAX_CONTENT_BYTES = 256 * 1_024;
const CANONICAL_PROMPT_MAX_TOTAL_CONTENT_BYTES = 1_024 * 1_024;
const CANONICAL_PROMPT_MAX_MANIFEST_BYTES = 1_200 * 1_024;
const AGENT_METADATA_FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n\r?\n/u;
const REQUIRED_PROVIDER_PHASES = Object.freeze([
  "request-admitted",
  "request-dispatched",
  "stream-open",
  "transport-closed",
  "transport-joined",
]);

class ProductHandoffAwaitingError extends CloudProofError {}

export const REAL_PRODUCT_DRIVER_STEP_IDS = Object.freeze([
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

const STEP_INDEX = new Map(
  REAL_PRODUCT_DRIVER_STEP_IDS.map((step, index) => [step, index]),
);

const ATTESTATIONS = Object.freeze({
  passed: true,
  productPath: true,
  syntheticAssistantRecords: false,
  mocked: false,
  realNetwork: true,
});

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const requireRecord = (value, label) => {
  assert(isRecord(value), `${label} must be an object.`);
  return value;
};

const requireString = (value, label, maximum = 4_096) => {
  assert(typeof value === "string", `${label} must be a string.`);
  const checked = value.trim();
  assert(
    checked.length > 0 &&
      checked.length <= maximum &&
      !/[\u0000-\u001f\u007f]/u.test(checked),
    `${label} must be a non-empty bounded string without control characters.`,
  );
  return checked;
};

const requireInteger = (value, label, minimum = 0) => {
  assert(
    Number.isSafeInteger(value) && value >= minimum,
    `${label} must be an integer >= ${minimum}.`,
  );
  return value;
};

const requireBoolean = (value, expected, label) => {
  assert(value === expected, `${label} must be ${String(expected)}.`);
  return expected;
};

const requireSha256 = (value, label) => {
  assert(
    typeof value === "string" && /^[a-f0-9]{64}$/u.test(value),
    `${label} must be a lowercase SHA-256 digest.`,
  );
  return value;
};

const requireUuid = (value, label) => {
  const checked = requireString(value, label, 64);
  assert(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      checked,
    ),
    `${label} must be a UUID.`,
  );
  return checked;
};

const requiredEnv = (key) => {
  const value = process.env[key]?.trim();
  if (!value) throw new CloudProofError(`${key} is required.`);
  return value;
};

const optionalIntegerEnv = (key, fallback, minimum, maximum) => {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  assert(
    Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    `${key} must be an integer from ${minimum} through ${maximum}.`,
  );
  return value;
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
};

const canonicalJson = (value) => JSON.stringify(canonicalize(value));

export const canonicalPromptSourceBody = (raw, source) => {
  assert(
    typeof raw === "string",
    `Reviewed canonical prompt ${source.id} is not text.`,
  );
  if (source.kind === "prompt") return raw;
  assert(
    source.kind === "agent-metadata",
    `Reviewed canonical prompt ${source.id} has an unknown source kind.`,
  );
  const frontmatter = raw.match(AGENT_METADATA_FRONTMATTER);
  assert(
    frontmatter,
    `Reviewed canonical prompt ${source.id} has no leading agent frontmatter plus required blank separator.`,
  );
  // The body is evidence-bearing content. Remove exactly the matched fence
  // and its one blank separator; never trim, normalize line endings, or add a
  // trailing newline here.
  return raw.slice(frontmatter[0].length);
};

const targetSha256 = (target) => sha256(canonicalJson(target));

const inside = (candidate, root) =>
  candidate === root || candidate.startsWith(`${root}${path.sep}`);

const overlaps = (left, right) => inside(left, right) || inside(right, left);

const assertNarrowIsolatedPath = (candidate, root, label) => {
  const resolved = path.resolve(candidate);
  assert(path.isAbsolute(candidate), `${label} must be absolute.`);
  assert(
    inside(resolved, root) &&
      resolved !== root &&
      !overlaps(resolved, REPO_ROOT) &&
      !overlaps(resolved, LIVE_STELLA_ROOT) &&
      !FORBIDDEN_TARGET_PATTERN.test(resolved),
    `${label} must be a narrow path inside the disposable harness root.`,
  );
  return resolved;
};

const pathExists = async (candidate) => {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

const fsyncDirectory = async (directory) => {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const SERIALIZED_AUTHORITY_KEY_PATTERN =
  /(?:jwt|token|cookie|secret|credential|session(?:id|cookie)?)/iu;
const SERIALIZED_JWT_PATTERN =
  /[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/u;

export const assertNoSerializedCredentialMaterial = (
  value,
  forbiddenValues = [],
) => {
  const visit = (candidate, keyPath = "root") => {
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => visit(entry, `${keyPath}[${index}]`));
      return;
    }
    if (!isRecord(candidate)) return;
    for (const [key, child] of Object.entries(candidate)) {
      const childPath = `${keyPath}.${key}`;
      if (SERIALIZED_AUTHORITY_KEY_PATTERN.test(key)) {
        const hashed = /sha256$/iu.test(key);
        const harmlessAttestation =
          typeof child === "boolean" ||
          (Number.isSafeInteger(child) && child === 0) ||
          child === null;
        assert(
          (hashed &&
            typeof child === "string" &&
            /^[a-f0-9]{64}$/u.test(child)) ||
            harmlessAttestation,
          `Private acceptance state contains raw authority material at ${childPath}.`,
        );
      }
      visit(child, childPath);
    }
  };
  visit(value);
  const serialized = JSON.stringify(value);
  assert(
    !SERIALIZED_JWT_PATTERN.test(serialized) &&
      !/(?:better-auth|stella)[._-][A-Za-z0-9_-]*(?:session|cookie)[A-Za-z0-9_.-]*=/iu.test(
        serialized,
      ),
    "Private acceptance state contains serialized credential material.",
  );
  for (const forbidden of forbiddenValues) {
    if (typeof forbidden !== "string" || forbidden.length < 8) continue;
    assert(
      !serialized.includes(forbidden),
      "Private acceptance state contains a known credential or inbox value.",
    );
  }
  return true;
};

const atomicWritePrivateJson = async (filePath, value) => {
  assertNoSerializedCredentialMaterial(value, [
    process.env.BUILDER_SERVICE_SECRET,
    process.env.CLOUDFLARE_API_TOKEN,
    process.env.CONVEX_DEPLOY_KEY,
    process.env.STELLA_CLOUD_PROOF_JWT,
    process.env.STELLA_CLOUD_PROOF_SESSION_COOKIE,
    process.env.STELLA_CLOUD_ACCEPTANCE_SECONDARY_JWT,
    process.env.STELLA_CLOUD_ACCEPTANCE_SECONDARY_SESSION_COOKIE,
    process.env.STELLA_MOBILE_ACCEPTANCE_JWT,
    process.env.STELLA_MOBILE_ACCEPTANCE_SECONDARY_JWT,
    process.env.STELLA_MOBILE_RN_ACCEPTANCE_JWT,
    process.env.STELLA_CLOUD_ACCEPTANCE_DISPOSABLE_EMAIL,
    process.env.STELLA_CLOUD_ACCEPTANCE_SECONDARY_DISPOSABLE_EMAIL,
  ]);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  assert(bytes.byteLength <= MAX_STATE_BYTES, "Driver state is too large.");
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, filePath);
    await fsyncDirectory(path.dirname(filePath));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

const stateBody = (state) => {
  const { stateSha256: _ignored, ...body } = state;
  return body;
};

const sealState = (body) => ({
  ...body,
  stateSha256: sha256(canonicalJson(body)),
});

const verifyState = (state, context, paths) => {
  const checked = requireRecord(state, "Driver state");
  assert(checked.version === STATE_VERSION, "Driver state version is invalid.");
  assert(
    checked.runId === context.runId,
    "Driver state belongs to another run.",
  );
  assert(
    checked.targetSha256 === targetSha256(context.target),
    "Driver state belongs to another cloud target.",
  );
  requireSha256(checked.stateSha256, "Driver state hash");
  assert(
    checked.stateSha256 === sha256(canonicalJson(stateBody(checked))),
    "Driver state hash chain is corrupt.",
  );
  assert(
    checked.harnessRoot === paths.root,
    "Driver state belongs to another harness root.",
  );
  assert(
    Array.isArray(checked.completedSteps),
    "Driver state steps are invalid.",
  );
  for (let index = 0; index < checked.completedSteps.length; index += 1) {
    const receipt = requireRecord(
      checked.completedSteps[index],
      `Driver state step ${index}`,
    );
    assert(
      receipt.step === REAL_PRODUCT_DRIVER_STEP_IDS[index],
      "Driver state step order is corrupt.",
    );
    requireSha256(receipt.evidenceSha256, `${receipt.step} evidence hash`);
    requireSha256(receipt.rawLogSha256, `${receipt.step} raw-log hash`);
    requireSha256(receipt.chainSha256, `${receipt.step} chain hash`);
    const expectedPrevious =
      index === 0
        ? sha256(`${ACCEPTANCE_DRIVER_CONTRACT}\n${context.runId}`)
        : checked.completedSteps[index - 1].chainSha256;
    assert(
      receipt.previousChainSha256 === expectedPrevious,
      "Driver state step chain has a broken predecessor.",
    );
    assert(
      receipt.chainSha256 ===
        sha256(
          canonicalJson({
            step: receipt.step,
            evidenceSha256: receipt.evidenceSha256,
            rawLogSha256: receipt.rawLogSha256,
            previousChainSha256: receipt.previousChainSha256,
          }),
        ),
      "Driver state step chain is corrupt.",
    );
  }
  return checked;
};

const initialState = (context, paths) =>
  sealState({
    version: STATE_VERSION,
    runId: context.runId,
    targetSha256: targetSha256(context.target),
    harnessRoot: paths.root,
    createdAt: new Date().toISOString(),
    completedSteps: [],
    identity: null,
    deployment: null,
    authHandoff: null,
    primary: null,
    local: null,
    electron: null,
    authCleanElectron: null,
    renderedBrowser: null,
    secondaryElectron: null,
    anonymousPolicyElectron: null,
    secondary: null,
    anonymousMobilePolicy: null,
    cleanClient: null,
    placement: null,
    memory: null,
    skill: null,
    codeMode: null,
    sandbox: null,
    ownerReset: null,
    appsHostWorkerd: null,
    browserRecovery: null,
    resources: {
      conversations: [],
      r2Prefixes: [],
      connectedAccountIdsSha256: [],
      sandboxIdsSha256: [],
      ownerGenerations: [],
    },
  });

export const resolveRealProductHarnessPaths = (
  context,
  cwd = process.cwd(),
) => {
  const evidenceParent = realpathSync(path.dirname(context.evidenceFile));
  const rawParent = realpathSync(path.dirname(context.rawLogFile));
  const rootFromEvidence = realpathSync(path.dirname(evidenceParent));
  const rootFromRaw = realpathSync(path.dirname(rawParent));
  const workingDirectory = realpathSync(cwd);
  assert(
    rootFromEvidence === rootFromRaw && workingDirectory === rootFromRaw,
    "Evidence, raw logs, and cwd must share the runner-created harness root.",
  );
  assert(
    !overlaps(rootFromRaw, REPO_ROOT) &&
      !overlaps(rootFromRaw, LIVE_STELLA_ROOT) &&
      rootFromRaw !== path.parse(rootFromRaw).root &&
      !FORBIDDEN_TARGET_PATTERN.test(rootFromRaw),
    "Harness root overlaps protected or forbidden state.",
  );
  for (const directory of ["evidence", "raw", "state", "profile"]) {
    const resolved = realpathSync(path.join(rootFromRaw, directory));
    assert(
      statSync(resolved).isDirectory() && inside(resolved, rootFromRaw),
      `Harness ${directory} directory is invalid.`,
    );
  }
  const stateDirectory = path.join(rootFromRaw, "state");
  return Object.freeze({
    root: rootFromRaw,
    evidenceDirectory: evidenceParent,
    rawDirectory: rawParent,
    stateDirectory,
    profileDirectory: path.join(rootFromRaw, "profile"),
    stateFile: path.join(stateDirectory, STATE_FILE_NAME),
    lockFile: path.join(stateDirectory, LOCK_FILE_NAME),
    processLogDirectory: path.join(stateDirectory, PROCESS_LOG_DIRECTORY),
  });
};

const acquireLock = async (paths, context) => {
  let handle;
  try {
    handle = await open(paths.lockFile, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new CloudProofError(
        "Another real-product driver process owns this harness state lock.",
      );
    }
    throw error;
  }
  await handle.writeFile(
    `${JSON.stringify({ pid: process.pid, runId: context.runId, step: context.step })}\n`,
  );
  await handle.sync();
  return async () => {
    await handle.close().catch(() => undefined);
    await unlink(paths.lockFile).catch(() => undefined);
  };
};

const loadState = async (context, paths) => {
  if (!(await pathExists(paths.stateFile))) {
    assert(
      context.step === "primary_auth_handoff" || context.step === "cleanup",
      "The primary_auth_handoff step must initialize this fresh harness.",
    );
    return initialState(context, paths);
  }
  const metadata = await stat(paths.stateFile);
  assert(
    metadata.isFile() && metadata.size > 0 && metadata.size <= MAX_STATE_BYTES,
    "Driver state file is invalid.",
  );
  let parsed;
  try {
    parsed = JSON.parse(await readFile(paths.stateFile, "utf8"));
  } catch {
    throw new CloudProofError("Driver state is not valid JSON.");
  }
  return verifyState(parsed, context, paths);
};

const checkpointState = async (paths, state, patch) => {
  const next = sealState({
    ...stateBody(state),
    ...patch,
    updatedAt: new Date().toISOString(),
  });
  await atomicWritePrivateJson(paths.stateFile, next);
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, next);
};

const assertStepOrder = (context, state) => {
  if (context.step === "cleanup") return;
  const expectedIndex = STEP_INDEX.get(context.step);
  assert(expectedIndex !== undefined, `Unknown driver step ${context.step}.`);
  assert(
    state.completedSteps.length === expectedIndex,
    `Step ${context.step} is out of order; expected ${REAL_PRODUCT_DRIVER_STEP_IDS[state.completedSteps.length] ?? "cleanup complete"}.`,
  );
};

const fileSha256 = async (filePath) => {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
};

const commitCompletedStep = async (context, paths, state, patch) => {
  const evidenceSha256 = await fileSha256(context.evidenceFile);
  const rawLogSha256 = await fileSha256(context.rawLogFile);
  const previousChainSha256 =
    state.completedSteps.at(-1)?.chainSha256 ??
    sha256(`${ACCEPTANCE_DRIVER_CONTRACT}\n${context.runId}`);
  const chainSha256 = sha256(
    canonicalJson({
      step: context.step,
      evidenceSha256,
      rawLogSha256,
      previousChainSha256,
    }),
  );
  const nextBody = {
    ...stateBody(state),
    ...patch,
    completedSteps: [
      ...state.completedSteps,
      {
        step: context.step,
        evidenceSha256,
        rawLogSha256,
        previousChainSha256,
        chainSha256,
      },
    ],
    updatedAt: new Date().toISOString(),
  };
  await atomicWritePrivateJson(paths.stateFile, sealState(nextBody));
};

const COMMAND_PROCESS_GROUPS = process.platform !== "win32";
const activeCommandChildren = new Set();
const activeCommandProcessGroups = new Set();

const commandProcessGroupAlive = (processGroupId) => {
  if (!COMMAND_PROCESS_GROUPS || !Number.isSafeInteger(processGroupId)) {
    return false;
  }
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

const signalCommandProcessGroup = (processGroupId, signal) => {
  if (!COMMAND_PROCESS_GROUPS || !Number.isSafeInteger(processGroupId)) {
    return false;
  }
  try {
    process.kill(-processGroupId, signal);
    return true;
  } catch {
    return false;
  }
};

const signalCommandProcessTree = (child, signal) => {
  if (signalCommandProcessGroup(child.pid, signal)) return;
  try {
    child.kill(signal);
  } catch {
    // A concurrently exited child is already terminated.
  }
};

const boundedCommandDeadlineError = ({ executable, output, authorityBound }) =>
  new CloudProofError("Fixed product command exceeded its checked deadline.", {
    code: authorityBound
      ? AUTHORITY_RUNWAY_EXHAUSTED
      : "bounded_command_timeout",
    executable: path.basename(executable),
    outputSha256: sha256(output),
  });

export const commandResult = async (
  executable,
  args,
  {
    cwd = REPO_ROOT,
    env = process.env,
    timeoutMs = 120_000,
    authorityIdentities = [],
    terminationGraceMs = 5_000,
  } = {},
) => {
  assert(
    path.isAbsolute(executable),
    "Fixed command executable must be absolute.",
  );
  assert(
    Array.isArray(authorityIdentities),
    "Fixed command authorities invalid.",
  );
  requireInteger(terminationGraceMs, "Fixed command termination grace", 10);
  assert(
    terminationGraceMs <= 30_000,
    "Fixed command termination grace exceeds 30 seconds.",
  );
  const started = Date.now();
  const deadlineAt = started + timeoutMs;
  for (const [index, authority] of authorityIdentities.entries()) {
    const checked = requireRecord(
      authority,
      `Fixed command authority ${index + 1}`,
    );
    assertJwtAuthorityThroughDeadline(checked.identity, checked.label, {
      nowMs: started,
      deadlineMs: deadlineAt,
    });
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      detached: COMMAND_PROCESS_GROUPS,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeCommandChildren.add(child);
    const processGroupId = COMMAND_PROCESS_GROUPS ? child.pid : null;
    if (COMMAND_PROCESS_GROUPS) {
      assert(
        Number.isSafeInteger(processGroupId) && processGroupId > 0,
        "Fixed command did not return a process-group id.",
      );
      activeCommandProcessGroups.add(processGroupId);
    }
    const chunks = [];
    let bytes = 0;
    let exceeded = false;
    let timedOut = false;
    let forceKillTimer = null;
    const releaseProcessGroupIfEmpty = () => {
      if (commandProcessGroupAlive(processGroupId)) return false;
      if (processGroupId !== null) {
        activeCommandProcessGroups.delete(processGroupId);
      }
      return true;
    };
    const terminate = () => {
      signalCommandProcessTree(child, "SIGTERM");
      if (forceKillTimer === null) {
        forceKillTimer = setTimeout(() => {
          if (!signalCommandProcessGroup(processGroupId, "SIGKILL")) {
            signalCommandProcessTree(child, "SIGKILL");
          }
          if (processGroupId !== null) {
            activeCommandProcessGroups.delete(processGroupId);
          }
        }, terminationGraceMs);
      }
    };
    const take = (chunk) => {
      if (exceeded) return;
      const copy = Buffer.from(chunk);
      bytes += copy.byteLength;
      if (bytes > MAX_COMMAND_BYTES) {
        exceeded = true;
        terminate();
        return;
      }
      chunks.push(copy);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      activeCommandChildren.delete(child);
      if (releaseProcessGroupIfEmpty()) {
        if (forceKillTimer !== null) clearTimeout(forceKillTimer);
      } else {
        terminate();
      }
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      activeCommandChildren.delete(child);
      const descendantsRemain = !releaseProcessGroupIfEmpty();
      if (descendantsRemain) {
        terminate();
      } else if (forceKillTimer !== null) {
        clearTimeout(forceKillTimer);
      }
      const output = Buffer.concat(chunks).toString("utf8");
      if (exceeded) {
        reject(new CloudProofError("Fixed command output exceeded 4 MiB."));
        return;
      }
      if (timedOut || Date.now() > deadlineAt) {
        reject(
          boundedCommandDeadlineError({
            executable,
            output,
            authorityBound: authorityIdentities.length > 0,
          }),
        );
        return;
      }
      if (descendantsRemain) {
        reject(
          new CloudProofError(
            "Fixed product command left a live descendant process.",
            {
              executable: path.basename(executable),
              outputSha256: sha256(output),
            },
          ),
        );
        return;
      }
      if (code !== 0) {
        reject(
          new CloudProofError("Fixed product command failed.", {
            executable: path.basename(executable),
            code,
            signal,
            outputSha256: sha256(output),
          }),
        );
        return;
      }
      resolve({
        output,
        outputSha256: sha256(output),
        durationMs: Date.now() - started,
      });
    });
  });
};

const activeBoundedCommands = new Set();

const startBoundedCommand = (
  executable,
  args,
  {
    cwd = REPO_ROOT,
    env = process.env,
    timeoutMs = 120_000,
    authorityIdentities = [],
    terminationGraceMs = 5_000,
  } = {},
) => {
  assert(
    path.isAbsolute(executable),
    "Fixed background command executable must be absolute.",
  );
  assert(
    Array.isArray(authorityIdentities),
    "Fixed background command authorities invalid.",
  );
  requireInteger(
    terminationGraceMs,
    "Fixed background command termination grace",
    10,
  );
  assert(
    terminationGraceMs <= 30_000,
    "Fixed background command termination grace exceeds 30 seconds.",
  );
  const started = Date.now();
  const deadlineAt = started + timeoutMs;
  for (const [index, authority] of authorityIdentities.entries()) {
    const checked = requireRecord(
      authority,
      `Fixed background command authority ${index + 1}`,
    );
    assertJwtAuthorityThroughDeadline(checked.identity, checked.label, {
      nowMs: started,
      deadlineMs: deadlineAt,
    });
  }
  const child = spawn(executable, args, {
    cwd,
    env,
    detached: COMMAND_PROCESS_GROUPS,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeCommandChildren.add(child);
  const processGroupId = COMMAND_PROCESS_GROUPS ? child.pid : null;
  if (COMMAND_PROCESS_GROUPS) {
    assert(
      Number.isSafeInteger(processGroupId) && processGroupId > 0,
      "Fixed background command did not return a process-group id.",
    );
    activeCommandProcessGroups.add(processGroupId);
  }
  assert(
    Number.isSafeInteger(child.pid) && child.pid > 0,
    "Fixed background command did not return a pid.",
  );
  const chunks = [];
  let bytes = 0;
  let exceeded = false;
  let timedOut = false;
  let settled = false;
  let forceKillTimer = null;
  const releaseProcessGroupIfEmpty = () => {
    if (commandProcessGroupAlive(processGroupId)) return false;
    if (processGroupId !== null) {
      activeCommandProcessGroups.delete(processGroupId);
    }
    return true;
  };
  const beginTermination = () => {
    signalCommandProcessTree(child, "SIGTERM");
    if (forceKillTimer === null) {
      forceKillTimer = setTimeout(() => {
        if (!signalCommandProcessGroup(processGroupId, "SIGKILL")) {
          signalCommandProcessTree(child, "SIGKILL");
        }
        if (processGroupId !== null) {
          activeCommandProcessGroups.delete(processGroupId);
        }
      }, terminationGraceMs);
    }
  };
  const take = (chunk) => {
    if (exceeded) return;
    const copy = Buffer.from(chunk);
    bytes += copy.byteLength;
    if (bytes > MAX_COMMAND_BYTES) {
      exceeded = true;
      beginTermination();
      return;
    }
    chunks.push(copy);
  };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  const timer = setTimeout(() => {
    timedOut = true;
    beginTermination();
  }, timeoutMs);
  const handle = {
    child,
    completion: null,
    terminate: null,
    startedAt: started,
    deadlineAt,
    timeoutMs,
  };
  const completion = new Promise((resolve, reject) => {
    child.once("error", (error) => {
      clearTimeout(timer);
      settled = true;
      activeCommandChildren.delete(child);
      if (releaseProcessGroupIfEmpty()) {
        if (forceKillTimer !== null) clearTimeout(forceKillTimer);
      } else {
        beginTermination();
      }
      activeBoundedCommands.delete(handle);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      settled = true;
      activeCommandChildren.delete(child);
      const descendantsRemain = !releaseProcessGroupIfEmpty();
      if (descendantsRemain) {
        beginTermination();
      } else if (forceKillTimer !== null) {
        clearTimeout(forceKillTimer);
      }
      activeBoundedCommands.delete(handle);
      const output = Buffer.concat(chunks).toString("utf8");
      if (exceeded) {
        reject(
          new CloudProofError(
            "Fixed background command output exceeded 4 MiB.",
          ),
        );
        return;
      }
      if (timedOut || Date.now() > deadlineAt) {
        reject(
          boundedCommandDeadlineError({
            executable,
            output,
            authorityBound: authorityIdentities.length > 0,
          }),
        );
        return;
      }
      if (descendantsRemain) {
        reject(
          new CloudProofError(
            "Fixed background product command left a live descendant process.",
            {
              executable: path.basename(executable),
              outputSha256: sha256(output),
            },
          ),
        );
        return;
      }
      if (code !== 0) {
        reject(
          new CloudProofError("Fixed background product command failed.", {
            executable: path.basename(executable),
            code,
            signal,
            outputSha256: sha256(output),
          }),
        );
        return;
      }
      resolve({
        output,
        outputSha256: sha256(output),
        durationMs: Date.now() - started,
      });
    });
  });
  // The actual await happens after an external reset barrier. Attach a handler
  // now so an early child failure cannot become an unhandled rejection while
  // the driver is still performing the bounded remote operation.
  void completion.catch(() => undefined);
  const terminate = async () => {
    if (settled) return;
    beginTermination();
    await Promise.race([
      completion.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, terminationGraceMs + 1_000)),
    ]);
    if (!settled) signalCommandProcessTree(child, "SIGKILL");
  };
  handle.completion = completion;
  handle.terminate = terminate;
  activeBoundedCommands.add(handle);
  return handle;
};

const terminateBoundedCommands = async () => {
  const commands = [...activeBoundedCommands];
  await Promise.all(commands.map((command) => command.terminate()));
};

const terminateCommandChildrenForSignal = async () => {
  const children = [...activeCommandChildren];
  const processGroups = [...activeCommandProcessGroups];
  if (children.length === 0 && processGroups.length === 0) return;
  for (const processGroupId of processGroups) {
    signalCommandProcessGroup(processGroupId, "SIGTERM");
  }
  for (const child of children) {
    if (!COMMAND_PROCESS_GROUPS) signalCommandProcessTree(child, "SIGTERM");
  }
  const graceDeadline = Date.now() + 4_000;
  while (
    Date.now() < graceDeadline &&
    (processGroups.some(commandProcessGroupAlive) ||
      (!COMMAND_PROCESS_GROUPS &&
        children.some(
          (child) => child.exitCode === null && child.signalCode === null,
        )))
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const processGroupId of processGroups) {
    if (commandProcessGroupAlive(processGroupId)) {
      signalCommandProcessGroup(processGroupId, "SIGKILL");
    }
    activeCommandProcessGroups.delete(processGroupId);
  }
  if (!COMMAND_PROCESS_GROUPS) {
    for (const child of activeCommandChildren) {
      signalCommandProcessTree(child, "SIGKILL");
    }
  }
};

const parseJsonOutput = (output, label) => {
  const candidates = [output.trim(), ...output.trim().split("\n").reverse()];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Convex/Wrangler may print a bounded status line before the JSON body.
    }
  }
  throw new CloudProofError(`${label} did not return JSON.`, {
    outputSha256: sha256(output),
  });
};

const rawReceipt = (surface, operation, fields = {}) => ({
  at: new Date().toISOString(),
  surface,
  operation,
  mocked: false,
  synthetic: false,
  ...fields,
});

const renderedProofEntry = ({
  surface,
  operation,
  processIdentity,
  observation,
  rawLog,
}) => {
  const receipt = renderedClientReceipt({
    surface,
    operation,
    processIdentity,
    observation,
  });
  rawLog.push(
    rawReceipt(surface, operation, {
      outcome: receipt.outcome,
      requestIdSha256: receipt.processInstanceSha256,
      resourceIdSha256: receipt.profileSha256,
      responseSha256: receipt.observationSha256,
      stateSha256: receipt.receiptSha256,
    }),
  );
  return Object.freeze({ receipt, observation });
};

const renderedProofSetSha256 = (entries) =>
  sha256(
    canonicalJson(
      entries.map((entry) => ({
        receiptSha256: entry.receipt.receiptSha256,
        observationSha256: entry.receipt.observationSha256,
      })),
    ),
  );

const requestReceipt = (surface, operation, response, startedAt, resource) =>
  rawReceipt(surface, operation, {
    status: response.status,
    durationMs: Date.now() - startedAt,
    responseSha256: sha256(canonicalJson(response.body)),
    ...(resource ? { resourceIdSha256: sha256(resource) } : {}),
  });

const loadSecrets = () => {
  assert(
    requiredEnv("STELLA_CLOUD_PROOF_IDENTITY_KIND") === "disposable",
    "STELLA_CLOUD_PROOF_IDENTITY_KIND must be disposable.",
  );
  for (const key of [
    "STELLA_CLOUD_PROOF_JWT",
    "STELLA_CLOUD_PROOF_SESSION_COOKIE",
    "STELLA_CLOUD_ACCEPTANCE_SECONDARY_JWT",
    "STELLA_CLOUD_ACCEPTANCE_SECONDARY_SESSION_COOKIE",
    "STELLA_MOBILE_ACCEPTANCE_JWT",
    "STELLA_MOBILE_ACCEPTANCE_SECONDARY_JWT",
    "STELLA_MOBILE_RN_ACCEPTANCE_JWT",
  ]) {
    assert(
      !process.env[key]?.trim(),
      `${key} must be absent; authority is refreshed from the isolated product profile.`,
    );
  }
  return Object.freeze({
    builderServiceSecret: requiredEnv("BUILDER_SERVICE_SECRET"),
    cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID?.trim(),
    cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN?.trim(),
    convexDeployKey: process.env.CONVEX_DEPLOY_KEY?.trim(),
  });
};

const ephemeralJwtSecrets = (secrets, jwt, label) =>
  Object.freeze({
    ...secrets,
    jwt: requireString(jwt, `${label} JWT`, 16 * 1_024),
  });

const userHeaders = (secrets) => ({
  authorization: `Bearer ${requireString(
    secrets.jwt,
    "Ephemeral product-profile JWT",
    16 * 1_024,
  )}`,
  "content-type": "application/json",
});

const serviceHeaders = (secrets) => ({
  authorization: `Bearer ${secrets.builderServiceSecret}`,
  "content-type": "application/json",
});

const convexCall = async (
  context,
  secrets,
  kind,
  functionPath,
  args,
  label,
  rawLog,
) => {
  const started = Date.now();
  const response = await requestJson(
    `${context.target.convexUrl}/api/${kind}`,
    {
      label,
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      method: "POST",
      headers: userHeaders(secrets),
      body: JSON.stringify({ path: functionPath, args, format: "json" }),
      maxResponseBytes: 2_000_000,
    },
  );
  rawLog.push(
    requestReceipt(
      "convex",
      `${kind}.${functionPath.replaceAll(":", ".")}`.toLowerCase(),
      response,
      started,
    ),
  );
  const body = requireRecord(response.body, `${label} response`);
  assert(body.status !== "error", `${label} returned a Convex error.`, {
    errorMessage: body.errorMessage,
    errorData: sanitizeEvidence(body.errorData),
  });
  assert(Object.hasOwn(body, "value"), `${label} omitted its value.`);
  return body.value;
};

const workerRequest = async (
  context,
  secrets,
  pathname,
  init,
  label,
  rawLog,
  { surface = "worker", expectedStatuses = [200], maxResponseBytes } = {},
) => {
  const started = Date.now();
  const response = await requestJson(
    `${context.target.cloudBuilderUrl}${pathname}`,
    {
      label,
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      expectedStatuses,
      maxResponseBytes: maxResponseBytes ?? 2_000_000,
      ...init,
      headers: {
        ...serviceHeaders(secrets),
        ...(init.headers ?? {}),
      },
    },
  );
  rawLog.push(
    requestReceipt(
      surface,
      label.toLowerCase().replace(/[^a-z0-9._:-]+/gu, "."),
      response,
      started,
    ),
  );
  return response;
};

const ownerLookup = async (context, secrets, conversationId, rawLog) => {
  const started = Date.now();
  const response = await requestJson(
    `${context.target.convexSiteUrl}/api/cloud/conversation-owner?conversationId=${encodeURIComponent(conversationId)}`,
    {
      label: "conversation owner lookup",
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      method: "GET",
      headers: serviceHeaders(secrets),
      maxResponseBytes: 64_000,
    },
  );
  rawLog.push(
    requestReceipt(
      "convex",
      "conversation.owner.lookup",
      response,
      started,
      conversationId,
    ),
  );
  const body = requireRecord(response.body, "Conversation owner lookup");
  return {
    ownerId: requireString(body.ownerId, "Conversation owner id", 512),
    ownerGeneration: requireString(
      body.ownerGeneration,
      "Conversation owner generation",
      512,
    ),
  };
};

const acceptanceOwnerMarker = (runId, ownerId) =>
  sha256(`stella-cloud-acceptance-owner-v1\n${runId}\n${ownerId}`);

const acceptanceProbe = async (
  context,
  secrets,
  identity,
  conversationId,
  operation,
  rawLog,
  fault,
) => {
  const requestId = `acceptance-${operation}-${randomUUID()}`;
  const body = {
    version: 1,
    operation,
    runId: context.runId,
    requestId,
    ownerId: identity.ownerId,
    ownerGeneration: identity.ownerGeneration,
    acceptanceOwnerMarkerSha256: acceptanceOwnerMarker(
      context.runId,
      identity.ownerId,
    ),
    ...(fault ? { fault } : {}),
  };
  const response = await workerRequest(
    context,
    secrets,
    `/internal/dev-acceptance/conversations/${encodeURIComponent(conversationId)}/probe`,
    { method: "POST", body: JSON.stringify(body) },
    `acceptance.probe.${operation}${fault ? `.${fault}` : ""}`,
    rawLog,
    { expectedStatuses: operation === "self_abort" ? [202] : [200] },
  );
  const receipt = requireRecord(response.body, "Acceptance probe response");
  assert(receipt.version === 1, "Acceptance probe version is invalid.");
  assert(
    receipt.operation === operation,
    "Acceptance probe operation drifted.",
  );
  requireBoolean(receipt.replayed, false, "Acceptance probe replay flag");
  requireSha256(receipt.bootIdSha256, "Acceptance probe boot id");
  requireSha256(
    receipt.durableObjectIdSha256,
    "Acceptance probe Durable Object id",
  );
  requireInteger(
    receipt.providerDispatchCount,
    "Acceptance probe provider dispatch count",
  );
  requireSha256(receipt.receiptSha256, "Acceptance probe receipt");
  if (operation === "self_abort") {
    requireBoolean(
      receipt.selfAbortScheduled,
      true,
      "Acceptance probe self-abort scheduling",
    );
  }
  if (operation === "arm_fault") {
    const armed = requireRecord(receipt.fault, "Acceptance probe fault");
    assert(armed.kind === fault, "Acceptance probe armed another fault.");
    requireBoolean(armed.armed, true, "Acceptance probe fault armed flag");
    if (fault === "canonical_history") {
      requireInteger(armed.corruptSeq, "Canonical history corrupt seq");
      requireSha256(
        armed.originalPayloadSha256,
        "Canonical history original payload hash",
      );
      requireSha256(
        armed.corruptPayloadSha256,
        "Canonical history corrupt payload hash",
      );
      requireInteger(
        armed.observedFailures,
        "Canonical history observed failures",
      );
      requireInteger(
        armed.repairAfterFailures,
        "Canonical history repair threshold",
        2,
      );
    }
  } else if (operation === "status") {
    assert(
      receipt.fault === null || isRecord(receipt.fault),
      "Acceptance status fault state is invalid.",
    );
  }
  return receipt;
};

const loadWholeJournal = async (context, secrets, conversationId, rawLog) => {
  const probe = async (beforeSeq) => {
    const query = new URLSearchParams({ limit: "200" });
    if (beforeSeq !== undefined) query.set("beforeSeq", String(beforeSeq));
    return (
      await workerRequest(
        context,
        secrets,
        `/conversations/${encodeURIComponent(conversationId)}/journal?${query}`,
        { method: "GET" },
        "journal.read",
        rawLog,
        { maxResponseBytes: 2_000_000 },
      )
    ).body;
  };
  const initial = requireRecord(await probe(), "Journal probe");
  const head = requireRecord(initial.head, "Journal head");
  requireInteger(head.headSeq, "Journal head seq");
  requireInteger(head.floorSeq, "Journal floor seq");
  requireInteger(head.epoch, "Journal epoch");
  let beforeSeq = head.headSeq + 1;
  let records = [];
  let pages = 0;
  while (beforeSeq > head.floorSeq) {
    pages += 1;
    assert(pages <= 256, "Journal pagination exceeded its hard bound.");
    const page = requireRecord(await probe(beforeSeq), "Journal page");
    assert(Array.isArray(page.records), "Journal page omitted records.");
    assert(page.records.length > 0, "Journal pagination stopped before floor.");
    const firstSeq = requireInteger(
      page.records[0]?.seq,
      "Journal page first seq",
    );
    assert(firstSeq < beforeSeq, "Journal pagination cursor did not advance.");
    records = [...page.records, ...records];
    beforeSeq = firstSeq;
  }
  const expected =
    head.headSeq >= head.floorSeq ? head.headSeq - head.floorSeq + 1 : 0;
  assert(records.length === expected, "Journal reconstruction is not gapless.");
  for (let index = 0; index < records.length; index += 1) {
    assert(
      records[index]?.seq === head.floorSeq + index,
      "Journal reconstruction contains a sequence gap.",
    );
  }
  return {
    probe: initial,
    head,
    records,
    historySha256: sha256(canonicalJson(records)),
  };
};

const recordsForTurn = (journal, turnId) =>
  journal.records.filter((record) => record?.turnId === turnId);

const terminalForTurn = (journal, turnId) => {
  const terminal = recordsForTurn(journal, turnId).filter(
    (record) =>
      record?.kind === "turn" &&
      ["completed", "failed", "canceled", "timeout"].includes(record.phase),
  );
  assert(
    terminal.length === 1,
    `Turn ${turnId} does not have exactly one terminal row.`,
  );
  return terminal[0];
};

const messageText = (payload) => {
  if (!isRecord(payload) || !Array.isArray(payload.content)) return "";
  return payload.content
    .filter(
      (block) =>
        isRecord(block) &&
        block.type === "text" &&
        typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
};

const assistantTextForTurn = (journal, turnId) =>
  recordsForTurn(journal, turnId)
    .filter(
      (record) => record?.kind === "message" && record.role === "assistant",
    )
    .map((record) => messageText(record.payload))
    .join("\n");

const toolCallsForRows = (rows, toolName) =>
  rows.flatMap((record) => {
    if (
      record?.kind !== "message" ||
      record.role !== "assistant" ||
      !Array.isArray(record.payload?.content)
    ) {
      return [];
    }
    return record.payload.content
      .filter(
        (block) =>
          isRecord(block) &&
          (block.type === "toolCall" || block.type === "tool_call") &&
          block.name === toolName &&
          typeof (block.id ?? block.toolCallId) === "string",
      )
      .map((block) => ({
        record,
        block,
        toolCallId: block.id ?? block.toolCallId,
      }));
  });

const matchedToolReceipts = (rows, toolName) =>
  toolCallsForRows(rows, toolName).map((call) => {
    const result = rows.find(
      (record) =>
        record?.kind === "message" &&
        record.role === "toolResult" &&
        (record.toolCallId ?? record.payload?.toolCallId) === call.toolCallId &&
        (record.toolName ?? record.payload?.toolName) === toolName,
    );
    assert(
      result,
      `${toolName} call ${call.toolCallId} has no matched durable tool result.`,
    );
    return { ...call, result };
  });

const waitForTurnTerminal = async (
  context,
  secrets,
  conversationId,
  turnId,
  rawLog,
  timeoutMs = DEFAULT_TURN_TIMEOUT_MS,
) =>
  await poll(
    async () =>
      await loadWholeJournal(context, secrets, conversationId, rawLog),
    (journal) =>
      recordsForTurn(journal, turnId).some(
        (record) =>
          record?.kind === "turn" &&
          ["completed", "failed", "canceled", "timeout"].includes(record.phase),
      ),
    { timeoutMs, intervalMs: 1_000, label: `turn ${turnId} terminal` },
  );

const waitForTailTurnTerminal = async (
  context,
  secrets,
  conversationId,
  turnId,
  rawLog,
) => {
  const started = Date.now();
  const terminal = await poll(
    async () => {
      const response = await requestJson(
        `${context.target.cloudBuilderUrl}/conversations/${encodeURIComponent(conversationId)}/journal?limit=50`,
        {
          label: "tail journal cancellation terminal",
          timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
          method: "GET",
          headers: serviceHeaders(secrets),
          maxResponseBytes: 1_000_000,
        },
      );
      const body = requireRecord(response.body, "Tail journal probe");
      assert(
        Array.isArray(body.records),
        "Tail journal probe omitted records.",
      );
      return (
        body.records.find(
          (record) =>
            record?.turnId === turnId &&
            record.kind === "turn" &&
            ["completed", "failed", "canceled", "timeout"].includes(
              record.phase,
            ),
        ) ?? null
      );
    },
    (record) => isRecord(record),
    {
      timeoutMs: 30_000,
      intervalMs: 50,
      label: `tail cancellation terminal ${turnId}`,
    },
  );
  rawLog.push(
    rawReceipt("worker", "journal.tail-cancellation-terminal", {
      outcome: requireString(terminal.phase, "Tail terminal phase", 32),
      resourceIdSha256: sha256(turnId),
      responseSha256: sha256(canonicalJson(terminal)),
      durationMs: Date.now() - started,
      seq: requireInteger(terminal.seq, "Tail terminal seq", 1),
    }),
  );
  return terminal;
};

export const parseJwtIdentity = (jwt) => {
  assert(
    typeof jwt === "string" && jwt.length > 0 && jwt.length <= 16 * 1_024,
    "Disposable JWT is malformed.",
  );
  const parts = jwt.split(".");
  assert(parts.length === 3, "Disposable JWT is malformed.");
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new CloudProofError("Disposable JWT payload is invalid.");
  }
  const issuer = requireString(payload.iss, "Disposable JWT issuer", 1_024);
  let issuerUrl;
  try {
    issuerUrl = new URL(issuer);
  } catch {
    throw new CloudProofError("Disposable JWT issuer is invalid.");
  }
  const localIssuer =
    issuerUrl.protocol === "http:" &&
    (issuerUrl.hostname === "localhost" || issuerUrl.hostname === "127.0.0.1");
  assert(
    (issuerUrl.protocol === "https:" || localIssuer) &&
      !issuerUrl.username &&
      !issuerUrl.password &&
      !issuerUrl.search &&
      !issuerUrl.hash &&
      issuerUrl.pathname === "/" &&
      issuer === issuerUrl.origin,
    "Disposable JWT issuer is invalid.",
  );
  const subject = requireString(payload.sub, "Disposable JWT subject", 512);
  const exp = requireInteger(payload.exp, "Disposable JWT expiry", 1);
  assert(exp * 1_000 > Date.now() + 60_000, "Disposable JWT expires too soon.");
  return Object.freeze({
    issuer,
    subject,
    tokenIdentifier: `${issuer}|${subject}`,
    exp,
  });
};

export const AUTHORITY_RUNWAY_EXHAUSTED = "authority_runway_exhausted";
export const REFRESHED_JWT_MINIMUM_RUNWAY_MS = 20 * 60_000;

const authorityRunwayError = ({ label, nowMs, expiryMs, requiredThroughMs }) =>
  new CloudProofError(
    `${label} product-profile authority cannot cover the bounded proof window.`,
    {
      code: AUTHORITY_RUNWAY_EXHAUSTED,
      expiryMs,
      nowMs,
      requiredThroughMs,
      remainingRunwayMs: Math.max(0, expiryMs - nowMs),
      requiredRunwayMs: Math.max(0, requiredThroughMs - nowMs),
    },
  );

export const assertRefreshedJwtRunway = (
  identity,
  label,
  {
    nowMs = Date.now(),
    minimumRunwayMs = REFRESHED_JWT_MINIMUM_RUNWAY_MS,
  } = {},
) => {
  const checked = requireRecord(identity, `${label} JWT identity`);
  const expiryMs =
    requireInteger(checked.exp, `${label} JWT expiry`, 1) * 1_000;
  requireInteger(nowMs, `${label} JWT runway clock`, 0);
  requireInteger(minimumRunwayMs, `${label} minimum JWT runway`, 60_000);
  const requiredThroughMs = nowMs + minimumRunwayMs;
  if (expiryMs <= requiredThroughMs) {
    throw authorityRunwayError({
      label,
      nowMs,
      expiryMs,
      requiredThroughMs,
    });
  }
  return identity;
};

export const assertJwtAuthorityThroughDeadline = (
  identity,
  label,
  { nowMs = Date.now(), deadlineMs } = {},
) => {
  const checked = requireRecord(identity, `${label} JWT identity`);
  const expiryMs =
    requireInteger(checked.exp, `${label} JWT expiry`, 1) * 1_000;
  requireInteger(nowMs, `${label} JWT deadline clock`, 0);
  requireInteger(deadlineMs, `${label} JWT proof deadline`, 1);
  if (deadlineMs <= nowMs || expiryMs <= deadlineMs) {
    throw authorityRunwayError({
      label,
      nowMs,
      expiryMs,
      requiredThroughMs: deadlineMs,
    });
  }
  return identity;
};

const parseJwtSubject = (jwt) => parseJwtIdentity(jwt).subject;
const parseJwtTokenIdentifier = (jwt) => parseJwtIdentity(jwt).tokenIdentifier;

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

const sourceTreeIdentity = async (rawLog) => {
  const git = path.join(REPO_ROOT, ".git");
  assert(existsSync(git), "Integration checkout is not a Git worktree.");
  const executable = "/usr/bin/git";
  const [commit, tree, statusResult, lsTree] = await Promise.all([
    commandResult(executable, ["rev-parse", "HEAD"], { cwd: REPO_ROOT }),
    commandResult(executable, ["rev-parse", "HEAD^{tree}"], {
      cwd: REPO_ROOT,
    }),
    commandResult(
      executable,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      {
        cwd: REPO_ROOT,
      },
    ),
    commandResult(executable, ["ls-tree", "-r", "--full-tree", "HEAD"], {
      cwd: REPO_ROOT,
    }),
  ]);
  const repoCommitSha = commit.output.trim();
  const repoTreeSha = tree.output.trim();
  assert(/^[a-f0-9]{40}$/u.test(repoCommitSha), "Git commit SHA is invalid.");
  assert(/^[a-f0-9]{40}$/u.test(repoTreeSha), "Git tree SHA is invalid.");
  assert(
    statusResult.output === "",
    "Real-product acceptance requires a completely clean reviewed worktree.",
    { statusSha256: sha256(statusResult.output) },
  );
  const normalizedTree = lsTree.output
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(/^\d+\s+blob\s+/u, ""))
    .sort()
    .join("\n");
  assert(normalizedTree.length > 0, "Git tree inventory is empty.");
  const sourceTreeSha256 = sha256(
    `stella-reviewed-source-tree-v1\n${repoCommitSha}\n${repoTreeSha}\n${normalizedTree}\n`,
  );
  rawLog.push(
    rawReceipt("git", "reviewed.source.tree", {
      outcome: "clean",
      stateSha256: sourceTreeSha256,
      processOutputSha256: sha256(
        `${commit.output}${tree.output}${statusResult.output}${lsTree.output}`,
      ),
      count: normalizedTree.split("\n").length,
    }),
  );
  return { repoCommitSha, repoTreeSha, sourceTreeSha256 };
};

const boundedFetchBytes = async (
  url,
  init,
  label,
  maximum = 32 * 1024 * 1024,
) => {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const declared = Number(response.headers.get("content-length"));
    assert(
      !Number.isFinite(declared) || declared <= maximum,
      `${label} declared an oversized response.`,
    );
    const reader = response.body?.getReader();
    const chunks = [];
    let bytes = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        bytes += chunk.byteLength;
        assert(bytes <= maximum, `${label} exceeded its response limit.`);
        chunks.push(chunk);
      }
    }
    return {
      status: response.status,
      headers: response.headers,
      bytes: Buffer.concat(chunks, bytes),
    };
  } catch (error) {
    if (error instanceof CloudProofError) throw error;
    throw new CloudProofError(`${label} failed.`, {
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timer);
  }
};

const cloudflareJson = async (secrets, pathname, label, rawLog) => {
  assert(
    secrets.cloudflareAccountId && secrets.cloudflareApiToken,
    "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required for real Cloudflare inspection.",
  );
  const started = Date.now();
  const response = await requestJson(
    `https://api.cloudflare.com/client/v4${pathname}`,
    {
      label,
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      method: "GET",
      headers: { authorization: `Bearer ${secrets.cloudflareApiToken}` },
      maxResponseBytes: 4_000_000,
    },
  );
  rawLog.push(
    requestReceipt(
      "cloudflare",
      label.toLowerCase().replace(/[^a-z0-9._:-]+/gu, "."),
      response,
      started,
    ),
  );
  const envelope = requireRecord(response.body, label);
  requireBoolean(envelope.success, true, `${label}.success`);
  return envelope.result;
};

const findTimestamp = (value) => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findTimestamp(entry);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const [key, entry] of Object.entries(value)) {
    if (
      typeof entry === "string" &&
      /(?:created|deployed)(?:_|)at|created_on/iu.test(key) &&
      Number.isFinite(Date.parse(entry))
    ) {
      return new Date(entry).toISOString();
    }
  }
  for (const entry of Object.values(value)) {
    const found = findTimestamp(entry);
    if (found) return found;
  }
  return null;
};

const parseMultipartModules = (bytes, contentType) => {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;\s]+))/iu.exec(
    contentType ?? "",
  );
  if (!boundaryMatch) return new Map([["index.js", bytes]]);
  const boundary = boundaryMatch[1] ?? boundaryMatch[2];
  const delimiter = Buffer.from(`--${boundary}`);
  const modules = new Map();
  let cursor = 0;
  while (cursor < bytes.length) {
    const start = bytes.indexOf(delimiter, cursor);
    if (start < 0) break;
    const headerStart = start + delimiter.length;
    if (bytes.subarray(headerStart, headerStart + 2).toString() === "--") break;
    const normalizedStart =
      bytes.subarray(headerStart, headerStart + 2).toString() === "\r\n"
        ? headerStart + 2
        : headerStart + 1;
    const headerEnd = bytes.indexOf(Buffer.from("\r\n\r\n"), normalizedStart);
    if (headerEnd < 0) break;
    const headers = bytes.subarray(normalizedStart, headerEnd).toString("utf8");
    const next = bytes.indexOf(delimiter, headerEnd + 4);
    if (next < 0) break;
    let bodyEnd = next;
    if (bytes.subarray(bodyEnd - 2, bodyEnd).toString() === "\r\n")
      bodyEnd -= 2;
    const nameMatch = /filename="([^"]+)"|name="([^"]+)"/iu.exec(headers);
    const name = nameMatch?.[1] ?? nameMatch?.[2];
    if (name)
      modules.set(
        path.posix.basename(name),
        bytes.subarray(headerEnd + 4, bodyEnd),
      );
    cursor = next;
  }
  assert(modules.size > 0, "Cloudflare Worker content contained no modules.");
  return modules;
};

const canonicalModuleDigest = (modules) => {
  const hash = createHash("sha256");
  for (const [name, bytes] of [...modules.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    hash.update(name);
    hash.update("\0");
    hash.update(String(bytes.byteLength));
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
};

const listFilesRecursively = async (root, relative = "") => {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory())
      files.push(...(await listFilesRecursively(root, next)));
    else if (entry.isFile()) files.push(next);
    else
      throw new CloudProofError(
        "Symlinks and special files are forbidden in generated Worker output.",
      );
  }
  return files;
};

const workerDeploymentIdentity = async (secrets, paths, rawLog) => {
  const account = encodeURIComponent(secrets.cloudflareAccountId ?? "");
  const script = encodeURIComponent(WORKER_NAME);
  const deployments = await cloudflareJson(
    secrets,
    `/accounts/${account}/workers/scripts/${script}/deployments`,
    "worker deployments",
    rawLog,
  );
  const deploymentRows = Array.isArray(deployments)
    ? deployments
    : Array.isArray(deployments?.deployments)
      ? deployments.deployments
      : Array.isArray(deployments?.items)
        ? deployments.items
        : [];
  assert(
    deploymentRows.length > 0 && deploymentRows.every(isRecord),
    "Cloudflare returned no explicit Worker deployment rows.",
  );
  const datedDeployments = deploymentRows.map((deployment) => ({
    deployment,
    deployedAt: findTimestamp(deployment),
  }));
  assert(
    datedDeployments.every((entry) => entry.deployedAt),
    "A Cloudflare Worker deployment omitted its activation timestamp.",
  );
  datedDeployments.sort(
    (left, right) => Date.parse(right.deployedAt) - Date.parse(left.deployedAt),
  );
  const activeDeployment = datedDeployments[0];
  const activeVersions = Array.isArray(activeDeployment.deployment.versions)
    ? activeDeployment.deployment.versions
    : [];
  assert(
    activeVersions.length === 1 && isRecord(activeVersions[0]),
    "Active Worker deployment must bind exactly one version for byte identity proof.",
  );
  if (activeVersions[0].percentage !== undefined) {
    assert(
      Number(activeVersions[0].percentage) === 100,
      "Active Worker deployment is traffic-split and has no single reviewable version.",
    );
  }
  const workerVersionId = requireUuid(
    activeVersions[0].version_id,
    "Active Worker version id",
  );
  const version = await cloudflareJson(
    secrets,
    `/accounts/${account}/workers/scripts/${script}/versions/${workerVersionId}`,
    "worker version",
    rawLog,
  );
  assert(
    !isRecord(version) ||
      version.id === undefined ||
      version.id === workerVersionId,
    "Cloudflare version metadata returned another version.",
  );
  const workerDeployedAt =
    findTimestamp(version) ?? activeDeployment.deployedAt;
  assert(
    workerDeployedAt,
    "Cloudflare deployment omitted a deployed timestamp.",
  );

  const started = Date.now();
  const remote = await boundedFetchBytes(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${script}/content`,
    {
      method: "GET",
      headers: { authorization: `Bearer ${secrets.cloudflareApiToken}` },
    },
    "deployed Worker content",
  );
  assert(
    remote.status === 200,
    "Deployed Worker content returned a non-200 status.",
    {
      status: remote.status,
    },
  );
  const remoteModules = parseMultipartModules(
    remote.bytes,
    remote.headers.get("content-type"),
  );
  const workerScriptSha256 = canonicalModuleDigest(remoteModules);
  rawLog.push(
    rawReceipt("cloudflare", "worker.script.content", {
      status: remote.status,
      durationMs: Date.now() - started,
      bytes: remote.bytes.byteLength,
      responseSha256: workerScriptSha256,
      count: remoteModules.size,
    }),
  );

  const bundleRoot = assertNarrowIsolatedPath(
    path.join(paths.stateDirectory, "worker-dry-run"),
    paths.root,
    "Worker dry-run directory",
  );
  assert(
    !(await pathExists(bundleRoot)),
    "Worker dry-run directory is not fresh.",
  );
  await mkdir(bundleRoot, { recursive: false, mode: 0o700 });
  const wrangler = path.join(
    REPO_ROOT,
    "workers/cloud-builder/node_modules/.bin/wrangler",
  );
  assert(existsSync(wrangler), "Pinned Wrangler executable is unavailable.");
  const result = await commandResult(
    wrangler,
    [
      "deploy",
      "--dry-run",
      "--env",
      REQUIRED_CLOUDFLARE_ENVIRONMENT,
      "--outdir",
      bundleRoot,
      "--config",
      path.join(REPO_ROOT, "workers/cloud-builder/wrangler.jsonc"),
    ],
    { cwd: path.join(REPO_ROOT, "workers/cloud-builder"), timeoutMs: 300_000 },
  );
  const localModules = new Map();
  for (const relative of await listFilesRecursively(bundleRoot)) {
    if (relative.endsWith(".map")) continue;
    localModules.set(
      path.posix.basename(relative.split(path.sep).join("/")),
      await readFile(path.join(bundleRoot, relative)),
    );
  }
  const localDigest = canonicalModuleDigest(localModules);
  rawLog.push(
    rawReceipt("cloudflare", "worker.local.dry-run", {
      outcome: localDigest === workerScriptSha256 ? "matched" : "mismatch",
      stateSha256: localDigest,
      processOutputSha256: result.outputSha256,
      durationMs: result.durationMs,
      count: localModules.size,
    }),
  );
  assert(
    localDigest === workerScriptSha256,
    "Deployed Worker modules do not match a fresh dry-run bundle of the reviewed tree.",
    { remoteSha256: workerScriptSha256, localSha256: localDigest },
  );
  return { workerVersionId, workerScriptSha256, workerDeployedAt };
};

const extractRemoteFunctionPaths = (value, paths = new Set()) => {
  if (Array.isArray(value)) {
    for (const entry of value) extractRemoteFunctionPaths(entry, paths);
    return paths;
  }
  if (!isRecord(value)) return paths;
  for (const [key, entry] of Object.entries(value)) {
    if (
      typeof entry === "string" &&
      /(?:udfpath|functionpath|identifier|name)$/iu.test(key) &&
      /^[A-Za-z0-9_./-]+:[A-Za-z0-9_]+$/u.test(entry)
    ) {
      paths.add(entry.replace(/\.(?:js|ts):/u, ":"));
    }
    extractRemoteFunctionPaths(entry, paths);
  }
  return paths;
};

const localConvexFunctionPaths = async () => {
  const root = path.join(REPO_ROOT, "packages/backend/convex");
  const files = (await listFilesRecursively(root)).filter(
    (relative) =>
      relative.endsWith(".ts") &&
      !relative.includes(`${path.sep}_generated${path.sep}`) &&
      !relative.endsWith(".test.ts") &&
      !relative.endsWith(".convex.test.ts"),
  );
  const result = new Set();
  for (const relative of files) {
    const source = await readFile(path.join(root, relative), "utf8");
    const moduleName = relative.slice(0, -3).split(path.sep).join("/");
    for (const match of source.matchAll(
      /export\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:query|mutation|action|internalQuery|internalMutation|internalAction)\s*\(/gu,
    )) {
      result.add(`${moduleName}:${match[1]}`);
    }
  }
  return result;
};

const convexDeploymentIdentity = async (secrets, rawLog) => {
  assert(
    secrets.convexDeployKey,
    "CONVEX_DEPLOY_KEY is required for deployed Convex function inspection.",
  );
  const executable = path.join(REPO_ROOT, "node_modules/.bin/convex");
  assert(existsSync(executable), "Pinned Convex CLI is unavailable.");
  const result = await commandResult(
    executable,
    ["function-spec", "--deployment", REQUIRED_CONVEX.deploymentName],
    {
      cwd: path.join(REPO_ROOT, "packages/backend"),
      env: { ...process.env, CONVEX_DEPLOY_KEY: secrets.convexDeployKey },
      timeoutMs: 180_000,
    },
  );
  const manifest = parseJsonOutput(result.output, "Convex function-spec");
  const convexFunctionManifestSha256 = sha256(canonicalJson(manifest));
  const remotePaths = extractRemoteFunctionPaths(manifest);
  const localPaths = await localConvexFunctionPaths();
  assert(
    remotePaths.size > 0,
    "Convex function manifest contained no callable functions.",
  );
  const missingRemote = [...remotePaths]
    .filter((entry) => !localPaths.has(entry))
    .sort();
  const extraLocal = [...localPaths]
    .filter((entry) => !remotePaths.has(entry))
    .sort();
  assert(
    missingRemote.length === 0 &&
      extraLocal.length === 0 &&
      localPaths.size === remotePaths.size,
    "Deployed Convex function manifest does not match reviewed exported functions.",
    {
      missingRemoteSha256: sha256(canonicalJson(missingRemote)),
      missingRemoteCount: missingRemote.length,
      extraLocalSha256: sha256(canonicalJson(extraLocal)),
      extraLocalCount: extraLocal.length,
      remoteCount: remotePaths.size,
      localCount: localPaths.size,
    },
  );
  rawLog.push(
    rawReceipt("convex", "function.manifest.inspect", {
      outcome: "matched",
      stateSha256: convexFunctionManifestSha256,
      processOutputSha256: result.outputSha256,
      durationMs: result.durationMs,
      count: remotePaths.size,
    }),
  );
  return {
    convexFunctionManifestSha256,
    convexObservedAt: new Date().toISOString(),
  };
};

const canonicalPromptPublicationIdentity = async (context, rawLog) => {
  const started = Date.now();
  const response = await requestJson(
    `${context.target.convexSiteUrl}/api/stella/prompts`,
    {
      label: "canonical prompt publication",
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      method: "GET",
      headers: { accept: "application/json" },
      maxResponseBytes: CANONICAL_PROMPT_MAX_MANIFEST_BYTES,
    },
  );
  rawLog.push(
    requestReceipt("convex", "canonical.prompt.publication", response, started),
  );
  assert(
    response.status === 200,
    "Canonical prompt publication returned a non-200 status.",
    { status: response.status },
  );
  const publication = requireRecord(
    response.body,
    "Canonical prompt publication",
  );
  assert(
    Object.keys(publication).sort().join("\n") ===
      ["prompts", "publishedAt", "revision", "schemaVersion"].sort().join("\n"),
    "Canonical prompt publication has an unexpected top-level shape.",
  );
  assert(
    publication.schemaVersion === CANONICAL_PROMPT_SCHEMA_VERSION,
    "Canonical prompt publication schema version is not the reviewed contract.",
  );
  const revision = requireSha256(
    publication.revision,
    "Canonical prompt revision",
  );
  const publishedAt = requireInteger(
    publication.publishedAt,
    "Canonical prompt publishedAt",
  );
  assert(
    response.headers.get("etag") === `"${publishedAt}-${revision}"`,
    "Canonical prompt publication ETag does not bind its version.",
  );
  assert(
    Array.isArray(publication.prompts) &&
      publication.prompts.length === CANONICAL_PROMPT_IDS.length,
    "Canonical prompt publication does not contain the exact reviewed roster.",
  );

  const expectedIds = new Set(CANONICAL_PROMPT_IDS);
  const reviewedSources = new Map(
    CANONICAL_PROMPT_SOURCES.map((source) => [source.id, source]),
  );
  const promptDigests = [];
  let totalBytes = 0;
  for (const value of publication.prompts) {
    const prompt = requireRecord(value, "Canonical prompt entry");
    assert(
      Object.keys(prompt).sort().join("\n") ===
        ["content", "id", "sha256"].sort().join("\n"),
      "Canonical prompt entry has an unexpected shape.",
    );
    assert(
      typeof prompt.id === "string" && expectedIds.delete(prompt.id),
      "Canonical prompt publication contains an unknown or duplicate id.",
    );
    assert(
      typeof prompt.content === "string" && prompt.content.trim().length > 0,
      "Canonical prompt publication contains an empty prompt.",
    );
    const contentBytes = Buffer.byteLength(prompt.content, "utf8");
    totalBytes += contentBytes;
    assert(
      contentBytes <= CANONICAL_PROMPT_MAX_CONTENT_BYTES &&
        totalBytes <= CANONICAL_PROMPT_MAX_TOTAL_CONTENT_BYTES,
      "Canonical prompt publication exceeds the reviewed content bounds.",
    );
    const digest = requireSha256(
      prompt.sha256,
      `Canonical prompt digest ${prompt.id}`,
    );
    assert(
      sha256(prompt.content) === digest,
      `Canonical prompt ${prompt.id} does not match its declared digest.`,
    );
    const source = reviewedSources.get(prompt.id);
    assert(
      source,
      `Reviewed canonical prompt ${prompt.id} has no runtime source mapping.`,
    );
    const localRaw = await readFile(
      path.join(REPO_ROOT, source.relativePath),
      "utf8",
    );
    const localContent = canonicalPromptSourceBody(localRaw, source);
    assert(
      Buffer.byteLength(localContent, "utf8") > 0,
      `Reviewed canonical prompt ${prompt.id} has an empty body.`,
    );
    assert(
      prompt.content === localContent && sha256(localContent) === digest,
      `Deployed canonical prompt ${prompt.id} does not match the reviewed source.`,
    );
    promptDigests.push({ id: prompt.id, sha256: digest });
  }
  assert(
    expectedIds.size === 0,
    "Canonical prompt publication omitted a reviewed prompt id.",
  );
  promptDigests.sort((left, right) => left.id.localeCompare(right.id));
  const derivedRevision = sha256(
    promptDigests.map((prompt) => `${prompt.id}:${prompt.sha256}`).join("\n"),
  );
  assert(
    derivedRevision === revision,
    "Canonical prompt publication revision does not match its prompt digests.",
  );
  const promptIds = promptDigests.map((prompt) => prompt.id);
  const canonicalPromptManifestSha256 = sha256(
    canonicalJson({
      schemaVersion: CANONICAL_PROMPT_SCHEMA_VERSION,
      revision,
      publishedAt,
      prompts: promptDigests,
    }),
  );
  const canonicalPromptIdsSha256 = sha256(canonicalJson(promptIds));
  rawLog.push(
    rawReceipt("convex", "canonical.prompt.digest.verify", {
      outcome: "matched-reviewed-source",
      stateSha256: canonicalPromptManifestSha256,
      responseSha256: revision,
      count: promptDigests.length,
    }),
  );
  return {
    canonicalPromptSchemaVersion: CANONICAL_PROMPT_SCHEMA_VERSION,
    canonicalPromptRevision: revision,
    canonicalPromptPublishedAt: publishedAt,
    canonicalPromptManifestSha256,
    canonicalPromptIdsSha256,
    canonicalPromptCount: promptDigests.length,
    canonicalPromptObservedAt: new Date().toISOString(),
    canonicalPromptMatchesReviewedSource: true,
  };
};

const processAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForHttp = async (url, label, timeoutMs = 60_000) =>
  await poll(
    async () => {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(2_000),
        });
        return { ok: response.ok, status: response.status };
      } catch {
        return { ok: false, status: 0 };
      }
    },
    (value) => value.ok,
    { timeoutMs, intervalMs: 250, label },
  );

const detachedProcess = async (executable, args, { cwd, env, logFile }) => {
  await mkdir(path.dirname(logFile), { recursive: true, mode: 0o700 });
  const output = openSync(logFile, "a", 0o600);
  const child = spawn(executable, args, {
    cwd,
    env,
    shell: false,
    detached: true,
    stdio: ["ignore", output, output],
  });
  closeSync(output);
  child.unref();
  assert(child.pid && child.pid > 0, "Product process did not return a pid.");
  return child.pid;
};

// Better Auth deliberately trusts the product's fixed loopback development
// origin. The harness must exclusively own this exact port; it may never
// broaden trusted origins, reuse an ambient listener, or kill a user's Stella.
const vitePortForRun = (_runId) => 57_314;

export const parseTrustedViteListenerRecords = (
  output,
  { pid, port = 57_314 } = {},
) => {
  requireInteger(pid, "Trusted Vite listener pid", 1);
  requireInteger(port, "Trusted Vite listener port", 1);
  let currentPid = null;
  const records = [];
  for (const line of String(output).split(/\r?\n/u)) {
    if (/^p[1-9][0-9]*$/u.test(line)) {
      currentPid = Number(line.slice(1));
      continue;
    }
    if (line.startsWith("n")) {
      assert(
        Number.isSafeInteger(currentPid),
        "Trusted Vite listener record omitted its owning pid.",
      );
      records.push({ pid: currentPid, address: line.slice(1) });
    }
  }
  assert(
    records.length > 0 &&
      records.every(
        (record) =>
          record.pid === pid && record.address === `127.0.0.1:${port}`,
      ),
    "Trusted Vite listener is not exclusively bound by the expected process to the exact IPv4 loopback address.",
  );
  return Object.freeze(records.map((record) => Object.freeze({ ...record })));
};

const electronProfilePaths = (paths, profileName) => {
  assert(
    /^[a-z][a-z0-9-]{0,31}$/u.test(profileName),
    "Electron profile name is invalid.",
  );
  const root = assertNarrowIsolatedPath(
    path.join(paths.profileDirectory, profileName),
    paths.root,
    "Electron profile root",
  );
  return {
    root,
    userData: path.join(root, "user-data"),
    data: path.join(root, "data"),
    cache: path.join(root, "user-data", "Cache"),
  };
};

const viteDataPath = (paths) =>
  assertNarrowIsolatedPath(
    path.join(paths.profileDirectory, "vite-server", "data"),
    paths.root,
    "Vite state root",
  );

const launchVite = async (context, paths) => {
  const port = vitePortForRun(context.runId);
  try {
    const occupied = await commandResult(
      "/usr/sbin/lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { timeoutMs: 10_000 },
    );
    assert(
      occupied.output.trim() === "",
      `Trusted loopback port ${port} is already owned by another process; stop it explicitly before preparing acceptance auth.`,
    );
  } catch (error) {
    if (!(error instanceof CloudProofError) || error.details?.code !== 1) {
      throw error;
    }
  }
  try {
    const existing = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(500),
    });
    if (existing.ok) {
      throw new CloudProofError(
        `Trusted loopback port ${port} is already serving another process; the isolated driver will not reuse or stop it.`,
      );
    }
  } catch (error) {
    if (error instanceof CloudProofError) throw error;
  }
  const vite = path.join(REPO_ROOT, "node_modules/vite/bin/vite.js");
  assert(existsSync(vite), "Pinned Vite executable is unavailable.");
  const dataDir = viteDataPath(paths);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const logFile = path.join(paths.processLogDirectory, "vite.log");
  const pid = await detachedProcess(
    process.execPath,
    [vite, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: path.join(REPO_ROOT, "packages/desktop-ui"),
      env: {
        ...isolatedElectronEnvironment(),
        STELLA_DATA_DIR: dataDir,
        VITE_CONVEX_URL: context.target.convexUrl,
        VITE_CONVEX_SITE_URL: context.target.convexSiteUrl,
        VITE_STELLA_APPS_HOST: REQUIRED_APPS_HOST_ORIGIN,
      },
      logFile,
    },
  );
  await waitForHttp(`http://127.0.0.1:${port}/`, "isolated Vite server");
  assert(processAlive(pid), "Isolated Vite process exited during startup.");
  const lsof = await commandResult(
    "/usr/sbin/lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
    { timeoutMs: 10_000 },
  );
  const listenerPids = [
    ...new Set(lsof.output.trim().split(/\s+/u).filter(Boolean).map(Number)),
  ];
  assert(
    listenerPids.length === 1 && listenerPids[0] === pid,
    "The spawned Vite process is not the exclusive loopback listener for its per-run port.",
  );
  const listenerDetails = await commandResult(
    "/usr/sbin/lsof",
    ["-nP", "-a", "-p", String(pid), `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpn"],
    { timeoutMs: 10_000 },
  );
  const listenerRecords = parseTrustedViteListenerRecords(
    listenerDetails.output,
    { pid, port },
  );
  const processFingerprintSha256 = await fingerprintRenderedProcess(pid);
  return {
    pid,
    port,
    logFile,
    dataDir,
    processFingerprintSha256,
    listenerAddressesSha256: sha256(
      canonicalJson(listenerRecords.map(({ address }) => address)),
    ),
  };
};

const verifyTrustedViteOwnership = async (vite) => {
  const pid = requireInteger(vite?.pid, "Trusted Vite pid", 1);
  const port = requireInteger(vite?.port, "Trusted Vite port", 1);
  assert(
    port === vitePortForRun("pinned"),
    "Acceptance Vite moved away from the exact Better Auth trusted origin.",
  );
  const expectedFingerprint = requireSha256(
    vite?.processFingerprintSha256,
    "Trusted Vite process fingerprint",
  );
  const expectedListeners = requireSha256(
    vite?.listenerAddressesSha256,
    "Trusted Vite listener-address set",
  );
  assert(processAlive(pid), "Trusted acceptance Vite process is not alive.");
  const actualFingerprint = await fingerprintRenderedProcess(pid);
  assert(
    actualFingerprint === expectedFingerprint,
    "Trusted acceptance Vite pid was recycled or replaced.",
  );
  const allListeners = await commandResult(
    "/usr/sbin/lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
    { timeoutMs: 10_000 },
  );
  const listenerPids = [
    ...new Set(
      allListeners.output.trim().split(/\s+/u).filter(Boolean).map(Number),
    ),
  ];
  assert(
    listenerPids.length === 1 && listenerPids[0] === pid,
    "Trusted acceptance Vite no longer exclusively owns its fixed port.",
  );
  const details = await commandResult(
    "/usr/sbin/lsof",
    ["-nP", "-a", "-p", String(pid), `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpn"],
    { timeoutMs: 10_000 },
  );
  const records = parseTrustedViteListenerRecords(details.output, {
    pid,
    port,
  });
  assert(
    sha256(canonicalJson(records.map(({ address }) => address))) ===
      expectedListeners,
    "Trusted acceptance Vite listener identity changed.",
  );
  return true;
};

const verifyTrustedVitePortReleased = async (port = 57_314) => {
  requireInteger(port, "Released Vite port", 1);
  try {
    const listeners = await commandResult(
      "/usr/sbin/lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { timeoutMs: 10_000 },
    );
    assert(
      listeners.output.trim() === "",
      "Trusted acceptance port still has a listener after cleanup.",
    );
  } catch (error) {
    if (error instanceof CloudProofError && error.details?.code === 1) {
      return true;
    }
    throw error;
  }
  return true;
};

const buildElectron = async (rawLog) => {
  const script = path.join(
    REPO_ROOT,
    "packages/desktop/scripts/dev-electron-build.mjs",
  );
  const result = await commandResult(process.execPath, [script, "--once"], {
    cwd: REPO_ROOT,
    timeoutMs: 10 * 60_000,
  });
  rawLog.push(
    rawReceipt("electron-process", "electron.bundle.build", {
      outcome: "completed",
      processOutputSha256: result.outputSha256,
      durationMs: result.durationMs,
    }),
  );
};

const ELECTRON_SYSTEM_ENV_ALLOWLIST = Object.freeze([
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
]);

export const isolatedElectronEnvironment = (source = process.env) =>
  Object.fromEntries(
    ELECTRON_SYSTEM_ENV_ALLOWLIST.filter(
      (key) => typeof source[key] === "string" && source[key].length > 0,
    ).map((key) => [key, source[key]]),
  );

export const parseDevToolsActivePort = (text) => {
  const [portText, browserPath, ...extra] = String(text).trim().split(/\r?\n/u);
  const port = Number(portText);
  assert(
    Number.isSafeInteger(port) && port >= 1_024 && port <= 65_535,
    "Electron DevToolsActivePort did not contain a valid assigned port.",
  );
  assert(
    /^\/devtools\/browser\/[A-Za-z0-9-]+$/u.test(browserPath ?? "") &&
      extra.length === 0,
    "Electron DevToolsActivePort contained an invalid browser endpoint.",
  );
  return port;
};

const electronBinaryPath = () => {
  const candidate =
    process.platform === "darwin"
      ? path.join(
          REPO_ROOT,
          "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
        )
      : process.platform === "win32"
        ? path.join(REPO_ROOT, "node_modules/electron/dist/electron.exe")
        : path.join(REPO_ROOT, "node_modules/electron/dist/electron");
  assert(existsSync(candidate), "Pinned Electron executable is unavailable.");
  return realpathSync(candidate);
};

const electronProfileIdentity = async (paths, profile) => {
  const identityFile = assertNarrowIsolatedPath(
    path.join(profile.root, ".rendered-profile-identity.json"),
    paths.root,
    "Electron rendered profile identity",
  );
  if (!(await pathExists(identityFile))) {
    await atomicWritePrivateJson(identityFile, {
      contract: "stella-rendered-profile-v1",
      nonce: randomUUID(),
    });
  }
  const metadata = await stat(identityFile);
  assert(
    metadata.isFile() && (metadata.mode & 0o777) === 0o600,
    "Electron rendered profile identity is not a private regular file.",
  );
  let value;
  try {
    value = JSON.parse(await readFile(identityFile, "utf8"));
  } catch {
    throw new CloudProofError(
      "Electron rendered profile identity is not valid JSON.",
    );
  }
  assert(
    value?.contract === "stella-rendered-profile-v1" &&
      typeof value.nonce === "string" &&
      /^[0-9a-f-]{36}$/iu.test(value.nonce),
    "Electron rendered profile identity is invalid.",
  );
  return Object.freeze({
    identityFile,
    profileSha256: sha256(value.nonce),
  });
};

const launchElectron = async (
  context,
  secrets,
  paths,
  profileName,
  vite,
  rawLog,
) => {
  await verifyTrustedViteOwnership(vite);
  const profile = electronProfilePaths(paths, profileName);
  await mkdir(profile.root, { recursive: true, mode: 0o700 });
  await mkdir(profile.userData, { recursive: true, mode: 0o700 });
  await mkdir(profile.data, { recursive: true, mode: 0o700 });
  const runtimeStateDir = path.join(
    "/tmp",
    `stella-core-${sha256(profile.root).slice(0, 12)}`,
  );
  const runtimeIpcDir = path.join(paths.root, "runtime-ipc", profileName);
  const browserSocketDir = assertNarrowIsolatedPath(
    path.join(profile.root, "browser-sockets"),
    paths.root,
    "Electron browser socket directory",
  );
  await mkdir(runtimeStateDir, { recursive: true, mode: 0o700 });
  await mkdir(runtimeIpcDir, { recursive: true, mode: 0o700 });
  await mkdir(browserSocketDir, { recursive: true, mode: 0o700 });
  const profileIdentity = await electronProfileIdentity(paths, profile);
  const canonicalUserDataDir = realpathSync(profile.userData);
  const harnessAppName = `Stella v2 Harness ${sha256(canonicalUserDataDir).slice(0, 12)}`;
  const harnessAppNameSha256 = sha256(harnessAppName);
  const activePortFile = assertNarrowIsolatedPath(
    path.join(profile.userData, "DevToolsActivePort"),
    paths.root,
    "Electron assigned CDP port file",
  );
  if (await pathExists(activePortFile)) await unlink(activePortFile);
  const electronBinary = electronBinaryPath();
  const [binarySha256, versionResult] = await Promise.all([
    fileSha256(electronBinary),
    commandResult(electronBinary, ["--version"], { timeoutMs: 10_000 }),
  ]);
  assert(
    versionResult.output.trim().length > 0,
    "Pinned Electron executable did not report its version.",
  );
  const versionSha256 = sha256(versionResult.output);
  const logFile = path.join(
    paths.processLogDirectory,
    `electron-${profileName}.log`,
  );
  const pid = await detachedProcess(electronBinary, [REPO_ROOT, "--dev"], {
    cwd: REPO_ROOT,
    env: {
      ...isolatedElectronEnvironment(),
      STELLA_DEV_HARNESS: "1",
      STELLA_V2_DEV_USER_DATA_DIR: profile.userData,
      STELLA_V2_DEV_DATA_DIR: profile.data,
      STELLA_RUNTIME_STATE_DIR: runtimeStateDir,
      STELLA_RUNTIME_IPC_DIR: runtimeIpcDir,
      STELLA_BROWSER_SOCKET_DIR: browserSocketDir,
      STELLA_REMOTE_DEBUG_PORT: "0",
      STELLA_DEV_SERVER_URL: `http://127.0.0.1:${vite.port}`,
      CONVEX_DEPLOYMENT: context.target.deployment,
      CONVEX_URL: context.target.convexUrl,
      CONVEX_SITE_URL: context.target.convexSiteUrl,
      CLOUD_BUILDER_URL: context.target.cloudBuilderUrl,
    },
    logFile,
  });
  const debugPort = await poll(
    async () => {
      try {
        return parseDevToolsActivePort(await readFile(activePortFile, "utf8"));
      } catch {
        return null;
      }
    },
    (value) => Number.isSafeInteger(value),
    {
      timeoutMs: 90_000,
      intervalMs: 100,
      label: "Electron OS-assigned CDP port",
    },
  );
  assert(processAlive(pid), "Isolated Electron exited during startup.");
  const processFingerprintSha256 = await fingerprintRenderedProcess(pid);
  const cdpVersion = await requestJson(
    `http://127.0.0.1:${debugPort}/json/version`,
    {
      label: "isolated Electron CDP version",
      timeoutMs: 10_000,
      method: "GET",
      maxResponseBytes: 128_000,
    },
  );
  assert(
    cdpVersion.status === 200 &&
      typeof cdpVersion.body?.Browser === "string" &&
      cdpVersion.body.Browser.length > 0,
    "Isolated Electron CDP omitted its browser build identity.",
  );
  const cdpBrowserSha256 = sha256(cdpVersion.body.Browser);
  const expectedRendererUrl = new URL(
    `http://127.0.0.1:${vite.port}/index.html?window=full`,
  ).href;
  const cdp = await connectRenderedClientCdp({
    debugPort,
    expectedUrl: expectedRendererUrl,
    surface: "electron-cdp",
    expectedProcess: { pid, processFingerprintSha256 },
    timeoutMs: 90_000,
  });
  cdp.close();
  const processIdentity = renderedProcessIdentity({
    pid,
    processFingerprintSha256,
    profileSha256: profileIdentity.profileSha256,
    binarySha256,
    versionSha256,
    cdpBrowserSha256,
    applicationIdentitySha256: harnessAppNameSha256,
  });
  rawLog.push(
    rawReceipt("electron-process", "electron.launch", {
      outcome: "running",
      resourceIdSha256: sha256(`${pid}`),
      stateSha256: sha256(profile.root),
      responseSha256: processFingerprintSha256,
      requestIdSha256: harnessAppNameSha256,
    }),
  );
  return {
    profileName,
    ...profile,
    debugPort,
    processFingerprintSha256,
    profileSha256: profileIdentity.profileSha256,
    binarySha256,
    versionSha256,
    cdpBrowserSha256,
    processIdentity,
    harnessAppName,
    harnessAppNameSha256,
    expectedRendererUrl,
    devServerPort: vite.port,
    pid,
    logFile,
    vitePid: vite.pid,
    viteProcessFingerprintSha256: requireSha256(
      vite.processFingerprintSha256,
      "Vite process fingerprint",
    ),
    viteListenerAddressesSha256: requireSha256(
      vite.listenerAddressesSha256,
      "Vite listener-address set",
    ),
    viteDataDir: vite.dataDir ?? viteDataPath(paths),
  };
};

const cdpEvaluate = async (electron, expression, label, timeoutMs = 30_000) => {
  const client = await connectRenderedClientCdp({
    debugPort: requireInteger(electron.debugPort, "Electron debug port", 1),
    expectedUrl: requireString(
      electron.expectedRendererUrl,
      "Electron expected renderer URL",
      2_048,
    ),
    surface: "electron-cdp",
    expectedProcess: {
      pid: requireInteger(electron.pid, "Electron process id", 1),
      processFingerprintSha256: requireSha256(
        electron.processFingerprintSha256,
        "Electron process fingerprint",
      ),
    },
    timeoutMs,
  });
  try {
    return await client.evaluate(expression, label, timeoutMs);
  } finally {
    client.close();
  }
};

const connectElectronRenderedClient = async (electron) =>
  await connectRenderedClientCdp({
    debugPort: requireInteger(electron.debugPort, "Electron debug port", 1),
    expectedUrl: requireString(
      electron.expectedRendererUrl,
      "Electron expected renderer URL",
      2_048,
    ),
    surface: "electron-cdp",
    expectedProcess: {
      pid: requireInteger(electron.pid, "Electron process id", 1),
      processFingerprintSha256: requireSha256(
        electron.processFingerprintSha256,
        "Electron process fingerprint",
      ),
    },
    timeoutMs: 90_000,
  });

const configureElectronSession = async (
  context,
  _secrets,
  electron,
  conversationId,
  rawLog,
) => {
  const value = await cdpEvaluate(
    electron,
    `(async () => {
      await window.electronAPI.system.configurePiRuntime({
        convexUrl: ${JSON.stringify(context.target.convexUrl)},
        convexSiteUrl: ${JSON.stringify(context.target.convexSiteUrl)}
      });
      const auth = await import("/src/global/auth/services/auth-session.ts");
      await auth.refreshAuthSession();
      const snapshot = auth.getAuthSessionSnapshot();
      if (!snapshot.data?.user?.id || snapshot.data.user.isAnonymous === true || snapshot.isPending) {
        throw new Error("fresh disposable product login is incomplete");
      }
      await window.electronAPI.ui.setState({ mode: "chat", conversationId: ${JSON.stringify(conversationId)} });
      const token = await window.electronAPI.system.getConvexAuthToken();
      const health = await window.electronAPI.agent.healthCheck();
      return {
        authenticated: typeof token === "string" && token.length > 0,
        health,
        identityRevision: snapshot.identityRevision,
        subjectSha256: await (async (value) => {
          const bytes = new TextEncoder().encode(value);
          const digest = await crypto.subtle.digest("SHA-256", bytes);
          return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        })(snapshot.data.user.id)
      };
    })()`,
    "configure isolated Electron session",
    60_000,
  );
  requireBoolean(value?.authenticated, true, "Electron authentication");
  assert(value?.health?.ready === true, "Electron local runtime is not ready.");
  rawLog.push(
    rawReceipt("electron-cdp", "electron.session.configure", {
      outcome: "authenticated",
      responseSha256: sha256(canonicalJson(value.health)),
      resourceIdSha256: sha256(conversationId),
      stateSha256: requireSha256(
        value.subjectSha256,
        "Configured Electron subject hash",
      ),
    }),
  );
  return value;
};

const electronCloudTurn = async (
  context,
  electron,
  identity,
  conversationId,
  { prompt, clientMsgId, execution },
  rawLog,
) => {
  const result = await cdpEvaluate(
    electron,
    `(async () => {
      const { convexClient } = await import("/src/platform/convex/convex-client.ts");
      const { cloudApi } = await import("/src/features/cloud/cloud-api.ts");
      const { ConversationSocket } = await import("/src/features/cloud/conversation-socket.ts");
      const token = await window.electronAPI.system.getConvexAuthToken();
      if (!token) throw new Error("Electron has no Convex token");
      convexClient.setAuth(async () => token);
      const events = [];
      const socket = new ConversationSocket({
        conversationId: ${JSON.stringify(conversationId)},
        baseUrl: ${JSON.stringify(context.target.cloudBuilderUrl)},
        getToken: async () => token,
        onEvent: (event) => {
          if (events.length < 5000) events.push(event);
        }
      });
      socket.start();
      const wait = async (predicate, timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error("Electron cloud turn timed out");
      };
      await wait(() => events.some((event) => event.type === "ready"), 30000);
      const receipt = await convexClient.mutation(cloudApi.startCloudChat, {
        conversationId: ${JSON.stringify(conversationId)},
        expectedOwnerGeneration: ${JSON.stringify(identity.ownerGeneration)},
        prompt: ${JSON.stringify(prompt)},
        clientMsgId: ${JSON.stringify(clientMsgId)}${execution ? `, execution: ${JSON.stringify(execution)}` : ""}
      });
      await wait(
        () => events.some((event) =>
          event.type === "records" && event.records.some((record) =>
            record.turnId === receipt.turnId && record.kind === "turn" &&
            ["completed", "failed", "canceled", "timeout"].includes(record.phase)
          )
        ),
        ${DEFAULT_TURN_TIMEOUT_MS}
      );
      socket.stop();
      const records = events
        .filter((event) => event.type === "records")
        .flatMap((event) => event.records);
      return {
        receipt,
        ready: events.find((event) => event.type === "ready")?.ready ?? null,
        liveEventCount: events.filter((event) => event.type === "records" || event.type === "tool").length,
        records,
        statusEvents: events.filter((event) => event.type === "status")
      };
    })()`,
    "real Electron cloud turn",
    DEFAULT_TURN_TIMEOUT_MS + 60_000,
  );
  const receipt = requireRecord(result?.receipt, "Electron cloud-turn receipt");
  assert(
    receipt.conversationId === conversationId,
    "Electron turn switched conversations.",
  );
  const turnId = requireUuid(receipt.turnId, "Electron cloud turn id");
  requireInteger(result.liveEventCount, "Electron live socket event count", 2);
  assert(
    Array.isArray(result.records),
    "Electron cloud turn omitted socket records.",
  );
  const terminal = result.records.filter(
    (record) =>
      record?.turnId === turnId &&
      record.kind === "turn" &&
      ["completed", "failed", "canceled", "timeout"].includes(record.phase),
  );
  assert(
    terminal.length === 1,
    "Electron did not observe exactly one cloud terminal.",
  );
  rawLog.push(
    rawReceipt("electron-cdp", "electron.cloud.turn", {
      outcome: terminal[0].phase,
      resourceIdSha256: sha256(turnId),
      responseSha256: sha256(canonicalJson(result.records)),
      count: result.liveEventCount,
    }),
  );
  return { ...result, turnId };
};

const electronHydrateConversation = async (
  context,
  electron,
  conversationId,
  rawLog,
) => {
  const result = await cdpEvaluate(
    electron,
    `(async () => {
      const { ConversationSocket } = await import("/src/features/cloud/conversation-socket.ts");
      const token = await window.electronAPI.system.getConvexAuthToken();
      if (!token) throw new Error("Electron has no Convex token");
      const events = [];
      const socket = new ConversationSocket({
        conversationId: ${JSON.stringify(conversationId)},
        baseUrl: ${JSON.stringify(context.target.cloudBuilderUrl)},
        getToken: async () => token,
        onEvent: (event) => { if (events.length < 5000) events.push(event); }
      });
      socket.start();
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const ready = events.find((event) => event.type === "ready")?.ready;
        const records = events.filter((event) => event.type === "records").flatMap((event) => event.records);
        if (ready && records.length >= ready.headSeq - ready.windowStartSeq + 1) {
          socket.stop();
          return { ready, records, statusEvents: events.filter((event) => event.type === "status") };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      socket.stop();
      throw new Error("Electron hydration timed out");
    })()`,
    "Electron cloud hydration",
    90_000,
  );
  const ready = requireRecord(result?.ready, "Electron hydration ready frame");
  assert(
    ready.conversationId === conversationId,
    "Electron hydrated another conversation.",
  );
  assert(Array.isArray(result.records), "Electron hydration omitted records.");
  rawLog.push(
    rawReceipt("electron-cdp", "electron.cloud.hydrate", {
      outcome: "hydrated",
      resourceIdSha256: sha256(conversationId),
      responseSha256: sha256(canonicalJson(result.records)),
      count: result.records.length,
      seq: requireInteger(ready.headSeq, "Electron ready head seq"),
    }),
  );
  return result;
};

const electronLocalTurn = async (
  electron,
  conversationId,
  prompt,
  clientRequestId,
  rawLog,
  { cancel = false } = {},
) => {
  const result = await cdpEvaluate(
    electron,
    `(async () => {
      const events = [];
      const off = window.electronAPI.agent.onStream((event) => {
        if (events.length < 10000) events.push(event);
      });
      const receipt = await window.electronAPI.agent.startChat({
        conversationId: ${JSON.stringify(conversationId)},
        userPrompt: ${JSON.stringify(prompt)},
        storageMode: "local",
        clientRequestId: ${JSON.stringify(clientRequestId)},
        agentType: "orchestrator"
      });
      const deadline = Date.now() + ${DEFAULT_TURN_TIMEOUT_MS};
      let runId = receipt.runId;
      while (!runId && Date.now() < deadline) {
        runId = events.find((event) => event.type === "run-started" && event.requestId === receipt.requestId)?.runId;
        if (!runId) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!runId) throw new Error("Local run never started");
      ${
        cancel
          ? `while (
        !events.some((event) =>
          event.type === "provider-lifecycle" &&
          event.runId === runId &&
          event.providerLifecyclePhase === "stream-open"
        ) && Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!events.some((event) =>
        event.type === "provider-lifecycle" &&
        event.runId === runId &&
        event.providerLifecyclePhase === "stream-open"
      )) throw new Error("Interrupted provider transport never opened");
      window.electronAPI.agent.cancelChat(runId);`
          : ""
      }
      while (Date.now() < deadline) {
        const terminal = events.find((event) => event.type === "run-finished" && event.runId === runId);
        if (terminal) {
          off();
          return { receipt, runId, terminal, events: events.filter((event) => event.runId === runId) };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      off();
      throw new Error("Local run never reached a terminal");
    })()`,
    cancel ? "cancel real local runtime turn" : "run real local runtime turn",
    DEFAULT_TURN_TIMEOUT_MS + 60_000,
  );
  requireString(result?.runId, "Local runtime run id", 256);
  assert(Array.isArray(result.events), "Local runtime turn omitted events.");
  const terminal = requireRecord(result.terminal, "Local runtime terminal");
  assert(
    terminal.outcome === (cancel ? "canceled" : "completed"),
    `Local runtime turn ended as ${String(terminal.outcome)}.`,
  );
  rawLog.push(
    rawReceipt(
      "local-runtime",
      cancel ? "local.turn.cancel" : "local.turn.complete",
      {
        outcome: terminal.outcome,
        resourceIdSha256: sha256(result.runId),
        responseSha256: sha256(canonicalJson(result.events)),
        count: result.events.length,
      },
    ),
  );
  return result;
};

const detachedProcessGroupAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const parseDetachedProcessGroupId = (output, expectedPid) => {
  requireInteger(expectedPid, "Detached process pid", 1);
  const values = String(output).trim().split(/\s+/u).filter(Boolean);
  assert(
    values.length === 1 && /^[1-9][0-9]*$/u.test(values[0]),
    "Detached process group lookup returned an invalid result.",
  );
  const processGroupId = Number(values[0]);
  assert(
    Number.isSafeInteger(processGroupId) && processGroupId === expectedPid,
    "Owned product process is no longer the leader of its detached process group.",
  );
  return processGroupId;
};

const stopProcess = async (
  pid,
  label,
  rawLog,
  { surface = "electron-process", expectedProcessFingerprintSha256 } = {},
) => {
  if (!processAlive(pid)) return false;
  const expectedFingerprint = requireSha256(
    expectedProcessFingerprintSha256,
    `${label} expected process fingerprint`,
  );
  assert(
    (await fingerprintRenderedProcess(pid)) === expectedFingerprint,
    `${label} pid was recycled or replaced before shutdown.`,
  );
  const group = await commandResult(
    "/bin/ps",
    ["-p", String(pid), "-o", "pgid="],
    { timeoutMs: 10_000 },
  );
  parseDetachedProcessGroupId(group.output, pid);
  // detachedProcess() makes the reviewed child its own process-group leader.
  // Signal the complete owned group so Chromium/Electron helper children cannot
  // outlive the acceptance process. Re-fingerprint immediately before the
  // synchronous signal so a stale checkpoint can never target a recycled pid.
  assert(
    (await fingerprintRenderedProcess(pid)) === expectedFingerprint,
    `${label} pid changed while shutdown ownership was being verified.`,
  );
  process.kill(-pid, "SIGTERM");
  const gracefulDeadline = Date.now() + 15_000;
  while (detachedProcessGroupAlive(pid) && Date.now() < gracefulDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (detachedProcessGroupAlive(pid)) {
    process.kill(-pid, "SIGKILL");
  }
  await poll(
    async () => !detachedProcessGroupAlive(pid),
    (stopped) => stopped,
    {
      timeoutMs: 5_000,
      intervalMs: 100,
      label: `${label} process-group stop`,
    },
  );
  assert(
    !processAlive(pid),
    `${label} leader remained alive after group stop.`,
  );
  rawLog.push(
    rawReceipt(
      surface,
      `${label.toLowerCase().replace(/[^a-z0-9]+/gu, ".")}.stop`,
      {
        outcome: "stopped",
        resourceIdSha256: sha256(String(pid)),
        responseSha256: expectedFingerprint,
      },
    ),
  );
  return true;
};

const stopRenderedElectron = async (electron, label, rawLog) => {
  const stopped = await stopProcess(electron.pid, label, rawLog, {
    expectedProcessFingerprintSha256: requireSha256(
      electron.processFingerprintSha256,
      `${label} process fingerprint`,
    ),
  });
  assert(stopped, `${label} was not alive for its rendered stop receipt.`);
  const identity = requireRecord(
    electron.processIdentity,
    `${label} rendered process identity`,
  );
  return Object.freeze({
    stopped: true,
    processInstanceSha256: requireSha256(
      identity.processInstanceSha256,
      `${label} process instance hash`,
    ),
    profileSha256: requireSha256(
      identity.profileSha256,
      `${label} profile hash`,
    ),
    applicationIdentitySha256: requireSha256(
      identity.applicationIdentitySha256,
      `${label} application identity hash`,
    ),
  });
};

const recoverOwnerIdentity = async (context, secrets, state, rawLog) => {
  const primary = requireRecord(state.primary, "Primary conversation state");
  const conversationId = requireUuid(
    primary.conversationId,
    "Primary conversation id",
  );
  const owner = await ownerLookup(context, secrets, conversationId, rawLog);
  assert(
    sha256(owner.ownerId) === state.identity?.ownerIdSha256,
    "Current conversation owner does not match the acceptance identity.",
  );
  assert(
    owner.ownerGeneration === state.identity?.ownerGeneration,
    "Current owner generation does not match the acceptance identity.",
  );
  return { ...owner, conversationId };
};

const currentElectron = (state) => {
  const electron = requireRecord(state.electron, "Electron process state");
  requireInteger(electron.pid, "Electron pid", 1);
  requireInteger(electron.vitePid, "Vite pid", 1);
  requireSha256(
    electron.viteProcessFingerprintSha256,
    "Vite process fingerprint",
  );
  requireSha256(
    electron.viteListenerAddressesSha256,
    "Vite listener-address set",
  );
  requireInteger(electron.debugPort, "Electron debug port", 1);
  requireInteger(electron.devServerPort, "Electron Vite port", 1);
  requireSha256(
    electron.processFingerprintSha256,
    "Electron process fingerprint",
  );
  for (const [label, value] of Object.entries({
    "Electron profile": electron.profileSha256,
    "Electron binary": electron.binarySha256,
    "Electron version": electron.versionSha256,
    "Electron CDP build": electron.cdpBrowserSha256,
  })) {
    requireSha256(value, `${label} hash`);
  }
  const processIdentity = requireRecord(
    electron.processIdentity,
    "Electron rendered process identity",
  );
  assert(
    processIdentity.processIdSha256 === sha256(String(electron.pid)) &&
      processIdentity.profileSha256 === electron.profileSha256 &&
      processIdentity.applicationIdentitySha256 ===
        electron.harnessAppNameSha256,
    "Electron rendered process identity is inconsistent with its checkpoint.",
  );
  requireString(
    electron.expectedRendererUrl,
    "Electron expected renderer URL",
    2_048,
  );
  assert(
    processAlive(electron.pid),
    "Recorded Electron process is not running.",
  );
  assert(
    processAlive(electron.vitePid),
    "Recorded Vite process is not running.",
  );
  return electron;
};

const currentSecondaryElectron = (state) => {
  const electron = requireRecord(
    state.secondaryElectron,
    "Secondary Electron process state",
  );
  requireInteger(electron.pid, "Secondary Electron pid", 1);
  requireInteger(electron.vitePid, "Secondary Electron Vite pid", 1);
  requireInteger(electron.debugPort, "Secondary Electron debug port", 1);
  requireSha256(
    electron.processFingerprintSha256,
    "Secondary Electron process fingerprint",
  );
  requireSha256(
    electron.processIdentity?.processInstanceSha256,
    "Secondary Electron process instance hash",
  );
  requireSha256(
    electron.profileSha256,
    "Secondary Electron profile-instance hash",
  );
  assert(
    electron.profileName === "secondary" &&
      processAlive(electron.pid) &&
      processAlive(electron.vitePid),
    "Recorded secondary Electron boundary is unavailable.",
  );
  return electron;
};

const currentAuthCleanElectron = (state) => {
  const electron = requireRecord(
    state.authCleanElectron,
    "Prepared clean-client Electron process state",
  );
  requireInteger(electron.pid, "Prepared clean-client Electron pid", 1);
  requireInteger(
    electron.debugPort,
    "Prepared clean-client Electron debug port",
    1,
  );
  requireSha256(
    electron.processIdentity?.processInstanceSha256,
    "Prepared clean-client Electron process instance",
  );
  assert(
    electron.profileName === "clean-client" &&
      processAlive(electron.pid) &&
      processAlive(electron.vitePid),
    "Prepared clean-client Electron boundary is unavailable.",
  );
  return electron;
};

const readAnonymousElectronAuthority = async (
  context,
  secrets,
  electron,
  rawLog,
  label,
  { createIfMissing = true } = {},
) => {
  const value = requireRecord(
    await cdpEvaluate(
      electron,
      `(async () => {
        await window.electronAPI.system.configurePiRuntime({
          convexUrl: ${JSON.stringify(context.target.convexUrl)},
          convexSiteUrl: ${JSON.stringify(context.target.convexSiteUrl)}
        });
        const authModule = await import("/src/global/auth/services/auth-session.ts");
        let first = await window.electronAPI.system.getAuthSession();
        let second = await window.electronAPI.system.getAuthSession();
        let bootstrap = "product-auto";
        if (!second?.user?.id && ${JSON.stringify(createIfMissing)}) {
          await authModule.signInAnonymous();
          bootstrap = "driver-explicit-product-api";
          first = await window.electronAPI.system.getAuthSession();
          second = await window.electronAPI.system.getAuthSession();
        }
        if (!second?.user?.id && !first?.user?.id) throw new Error("isolated anonymous session is absent");
        const token = await window.electronAPI.system.getConvexAuthToken();
        return {
          subject: second?.user?.id ?? first?.user?.id ?? null,
          sessionId: second?.session?.id ?? first?.session?.id ?? null,
          anonymous: second?.user?.isAnonymous === true || first?.user?.isAnonymous === true,
          bootstrap,
          token
        };
      })()`,
      `read ${label} isolated anonymous authority`,
      60_000,
    ),
    `${label} isolated anonymous authority`,
  );
  const subject = requireString(value.subject, `${label} subject`, 512);
  const sessionId = requireString(value.sessionId, `${label} session id`, 512);
  requireBoolean(value.anonymous, true, `${label} anonymous identity`);
  const token = requireString(value.token, `${label} Convex token`, 16 * 1_024);
  const jwtIdentity = assertRefreshedJwtRunway(parseJwtIdentity(token), label);
  assert(
    jwtIdentity.issuer === context.target.convexSiteUrl &&
      jwtIdentity.subject === subject,
    `${label} token is not the exact isolated anonymous session authority.`,
  );
  assert(
    value.bootstrap === "product-auto" ||
      value.bootstrap === "driver-explicit-product-api",
    `${label} did not use the product anonymous bootstrap path.`,
  );
  const secondarySecrets = ephemeralJwtSecrets(secrets, token, label);
  rawLog.push(
    rawReceipt("electron-cdp", "electron.secondary.anonymous-authority", {
      outcome: value.bootstrap,
      requestIdSha256: sha256(sessionId),
      resourceIdSha256: sha256(jwtIdentity.tokenIdentifier),
      responseSha256: sha256(
        canonicalJson({
          subjectSha256: sha256(subject),
          sessionIdSha256: sha256(sessionId),
          tokenIdentifierSha256: sha256(jwtIdentity.tokenIdentifier),
          anonymous: true,
          bootstrap: value.bootstrap,
        }),
      ),
    }),
  );
  return Object.freeze({
    subject,
    sessionId,
    jwtIdentity,
    secrets: secondarySecrets,
    bootstrap: value.bootstrap,
  });
};

const relaunchElectron = async (
  context,
  secrets,
  paths,
  state,
  profileName,
  rawLog,
) => {
  const existingVite = state.electron?.vitePid;
  const vite = processAlive(existingVite)
    ? {
        pid: existingVite,
        port: requireInteger(
          state.electron?.devServerPort,
          "Persisted Vite port",
          1,
        ),
        logFile: path.join(paths.processLogDirectory, "vite.log"),
        dataDir: viteDataPath(paths),
        processFingerprintSha256: requireSha256(
          state.electron?.viteProcessFingerprintSha256,
          "Persisted Vite process fingerprint",
        ),
        listenerAddressesSha256: requireSha256(
          state.electron?.viteListenerAddressesSha256,
          "Persisted Vite listener-address set",
        ),
      }
    : await launchVite(context, paths);
  const electron = await launchElectron(
    context,
    secrets,
    paths,
    profileName,
    vite,
    rawLog,
  );
  return electron;
};

const renderedBrowserAppUrl = (state) =>
  new URL(
    `http://127.0.0.1:${requireInteger(
      state.electron?.devServerPort,
      "Rendered browser Vite port",
      1,
    )}/`,
  ).href;

const launchRenderedBrowser = async (
  paths,
  state,
  { profileMode = "reuse" } = {},
) => {
  const appUrl = renderedBrowserAppUrl(state);
  const profileDirectory = assertNarrowIsolatedPath(
    path.join(paths.profileDirectory, "rendered-browser"),
    paths.root,
    "Rendered browser profile",
  );
  const browser = await launchIsolatedChromium({
    harnessRoot: paths.root,
    profileDirectory,
    debugPort: 0,
    appUrl,
    profileMode,
    headless: true,
    env: process.env,
  });
  const client = await connectRenderedClientCdp({
    debugPort: browser.debugPort,
    expectedUrl: "about:blank",
    surface: "browser-cdp",
    expectedProcess: {
      pid: browser.pid,
      processFingerprintSha256: browser.processFingerprintSha256,
    },
    timeoutMs: 90_000,
  });
  try {
    await navigateRenderedClient(client, { appUrl, timeoutMs: 90_000 });
  } finally {
    client.close();
  }
  return Object.freeze({
    ...browser,
    appUrl,
    processIdentity: renderedBrowserProcessIdentity(browser),
  });
};

const currentRenderedBrowser = (state) => {
  const browser = requireRecord(
    state.renderedBrowser,
    "Rendered browser process state",
  );
  assert(
    browser.surface === "browser-cdp" &&
      processAlive(requireInteger(browser.pid, "Rendered browser pid", 1)),
    "Recorded rendered browser process is unavailable.",
  );
  requireInteger(browser.debugPort, "Rendered browser debug port", 1);
  requireSha256(
    browser.processFingerprintSha256,
    "Rendered browser process fingerprint",
  );
  requireSha256(
    browser.processIdentity?.processInstanceSha256,
    "Rendered browser process instance hash",
  );
  requireString(browser.appUrl, "Rendered browser app URL", 2_048);
  return browser;
};

const connectBrowserRenderedClient = async (browser) =>
  await connectRenderedClientCdp({
    debugPort: browser.debugPort,
    expectedUrl: browser.appUrl,
    surface: "browser-cdp",
    expectedProcess: {
      pid: browser.pid,
      processFingerprintSha256: browser.processFingerprintSha256,
    },
    timeoutMs: 90_000,
  });

const STRICT_PRODUCT_ORIGIN = "http://127.0.0.1:57314";
const REVIEWED_ONBOARDING_PHASES = Object.freeze([
  "capabilities",
  "theme",
  "personality",
  "permissions",
  "browser",
  "extension",
  "engine",
  "voice",
  "memory",
  "enter",
]);

const trustedRenderedClick = async (client, selector, label) => {
  const point = await poll(
    () =>
      client.evaluate(
        `(() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (!(element instanceof HTMLElement)) return null;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          const disabled = element instanceof HTMLButtonElement ? element.disabled : false;
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const hit = document.elementFromPoint(x, y);
          if (disabled || style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none" || Number(style.opacity) === 0 || rect.width <= 0 || rect.height <= 0 || !(hit === element || element.contains(hit))) {
            return null;
          }
          return { x, y };
        })()`,
        label,
      ),
    (value) => Number.isFinite(value?.x) && Number.isFinite(value?.y),
    { timeoutMs: 30_000, intervalMs: 100, label },
  );
  assert(
    Number.isFinite(point?.x) &&
      Number.isFinite(point?.y) &&
      point.x >= 0 &&
      point.y >= 0,
    `${label} returned an invalid viewport point.`,
  );
  await client.command("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
  });
  await client.command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await client.command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
};

const driveVisibleProductOnboarding = async (
  client,
  { profileSha256, rawLog, timeoutMs = 5 * 60_000 },
) => {
  requireSha256(profileSha256, "Visible onboarding profile");
  const targetIdSha256 = requireSha256(
    client.targetIdSha256,
    "Visible onboarding target",
  );
  const started = Date.now();
  const observedPhases = [];
  const interactionHashes = [];
  const initial = await poll(
    () =>
      client.evaluate(
        `(() => ({
          exactOrigin: location.origin === ${JSON.stringify(STRICT_PRODUCT_ORIGIN)},
          onboardingShell: document.querySelector('.window-shell.full')?.getAttribute('data-window-mode') === 'onboarding',
          startVisible: Boolean(document.querySelector('.onboarding-start-button')),
          phase: document.querySelector('.onboarding-dialogue')?.getAttribute('data-phase') ?? null,
          crashSurfacePresent: Boolean(document.querySelector('.error-boundary'))
        }))()`,
        `observe ${client.surface} onboarding entry`,
      ),
    (value) =>
      value?.exactOrigin === true &&
      value.crashSurfacePresent === false &&
      value.onboardingShell === true &&
      (value.startVisible === true || typeof value.phase === "string"),
    {
      timeoutMs,
      intervalMs: 100,
      label: `${client.surface} visible onboarding entry`,
    },
  );
  if (initial.startVisible === true) {
    await trustedRenderedClick(
      client,
      ".onboarding-start-button",
      `start ${client.surface} product onboarding`,
    );
    interactionHashes.push(sha256("start"));
  }

  let priorPhase = null;
  let themeConfigured = false;
  while (Date.now() - started < timeoutMs) {
    const state = await poll(
      () =>
        client.evaluate(
          `(() => {
            const dialogue = document.querySelector('.onboarding-dialogue');
            const phase = dialogue?.getAttribute('data-phase') ?? null;
            const leaving = dialogue?.getAttribute('data-leaving') === 'true';
            const confirm = dialogue?.querySelector('.onboarding-confirm');
            const memoryOff = dialogue?.querySelector('.onboarding-memory-choice:nth-of-type(2)');
            const complete = !document.querySelector('.onboarding-start-button') && !dialogue;
            return {
              phase,
              leaving,
              confirmReady: confirm instanceof HTMLButtonElement && !confirm.disabled,
              memoryOffReady: memoryOff instanceof HTMLButtonElement && !memoryOff.disabled,
              memoryOffSelected: memoryOff?.getAttribute('aria-checked') === 'true',
              complete,
              crashSurfacePresent: Boolean(document.querySelector('.error-boundary'))
            };
          })()`,
          `observe ${client.surface} onboarding phase`,
        ),
      (value) =>
        value?.crashSurfacePresent === false &&
        (value.complete === true ||
          (typeof value.phase === "string" && value.leaving === false)),
      {
        timeoutMs: Math.max(1_000, timeoutMs - (Date.now() - started)),
        intervalMs: 100,
        label: `${client.surface} stable onboarding phase`,
      },
    );
    if (state.complete === true) break;
    const phase = requireString(state.phase, "Visible onboarding phase", 64);
    const phaseIndex = REVIEWED_ONBOARDING_PHASES.indexOf(phase);
    assert(
      phaseIndex >= 0,
      `Visible onboarding reached unreviewed phase ${phase}.`,
    );
    if (phase !== priorPhase) {
      const priorIndex =
        priorPhase === null
          ? -1
          : REVIEWED_ONBOARDING_PHASES.indexOf(priorPhase);
      assert(
        phaseIndex > priorIndex,
        "Visible onboarding repeated or moved backward through its reviewed phase order.",
      );
      observedPhases.push(phase);
      priorPhase = phase;
    }
    if (
      phase === "memory" &&
      state.memoryOffSelected !== true &&
      state.memoryOffReady === true
    ) {
      await trustedRenderedClick(
        client,
        ".onboarding-memory-choice:nth-of-type(2)",
        `select ${client.surface} product onboarding memory preference`,
      );
      interactionHashes.push(sha256(`${phase}:memory-off`));
      continue;
    }
    if (phase === "theme" && themeConfigured !== true) {
      const selections = [
        ".onboarding-theme-orb",
        '.onboarding-theme-grow-in[data-visible="true"]:not(.onboarding-theme-grow-in--delayed-1):not(.onboarding-theme-grow-in--delayed-2) button:not(:disabled)',
        '.onboarding-theme-grow-in--delayed-1[data-visible="true"] button:not(:disabled)',
        '.onboarding-theme-grow-in--delayed-2[data-visible="true"] button:not(:disabled)',
      ];
      for (const [index, selector] of selections.entries()) {
        await trustedRenderedClick(
          client,
          selector,
          `configure ${client.surface} product onboarding theme ${index + 1}`,
        );
        interactionHashes.push(sha256(`${phase}:selection-${index + 1}`));
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      themeConfigured = true;
      continue;
    }
    if (state.confirmReady !== true) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    await trustedRenderedClick(
      client,
      ".onboarding-dialogue .onboarding-confirm",
      `advance ${client.surface} product onboarding ${phase}`,
    );
    interactionHashes.push(sha256(`${phase}:confirm`));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(
    observedPhases[0] === "capabilities" &&
      observedPhases.includes("memory") &&
      new Set(observedPhases).size === observedPhases.length,
    "Visible onboarding did not traverse the reviewed first-run product flow.",
  );
  const welcomeDeadline = Date.now() + 5_000;
  let welcomeVisible = false;
  while (Date.now() <= welcomeDeadline && welcomeVisible !== true) {
    welcomeVisible = await client.evaluate(
      `Boolean(document.querySelector('.welcome-dialog-content'))`,
      `observe ${client.surface} post-onboarding welcome`,
    );
    if (welcomeVisible !== true) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (welcomeVisible === true) {
    await trustedRenderedClick(
      client,
      ".welcome-dialog-close",
      `dismiss ${client.surface} post-onboarding welcome`,
    );
  }
  const transcript = Object.freeze({
    contract: "stella-driver-visible-onboarding-v1",
    surface: client.surface,
    targetIdSha256,
    profileSha256,
    phaseCount: observedPhases.length,
    phaseOrderSha256: sha256(canonicalJson(observedPhases)),
    interactionCount: interactionHashes.length,
    interactionSetSha256: sha256(canonicalJson(interactionHashes)),
    trustedCdpInput: true,
    productCompletionWriterOnly: true,
  });
  const transcriptSha256 = sha256(canonicalJson(transcript));
  const productReceipt = await verifyRenderedProductOnboardingPersistence(
    client,
    {
      productOrigin: STRICT_PRODUCT_ORIGIN,
      profileSha256,
      driverVisibleOnboardingAttestationSha256: transcriptSha256,
      timeoutMs,
    },
  );
  rawLog.push(
    rawReceipt(client.surface, "rendered.product-onboarding", {
      outcome: "visible-product-flow-completed",
      requestIdSha256: targetIdSha256,
      resourceIdSha256: profileSha256,
      responseSha256: transcriptSha256,
      stateSha256: productReceipt.onboardingReceiptSha256,
      count: observedPhases.length,
    }),
  );
  return Object.freeze({ transcript, transcriptSha256, productReceipt });
};

const navigateRenderedProduct = async (client, appUrl, label) => {
  const target = new URL(appUrl);
  assert(
    target.origin === STRICT_PRODUCT_ORIGIN,
    "Rendered product route must stay on the trusted loopback origin.",
  );
  const search = Object.fromEntries(target.searchParams.entries());
  const observed = await client.evaluate(
    `(async () => {
      const { router } = await import("/src/router.tsx");
      await router.navigate({
        to: ${JSON.stringify(target.pathname)},
        search: ${JSON.stringify(search)},
        replace: true
      });
      const expectedPathname = ${JSON.stringify(target.pathname)};
      const expectedSearch = ${JSON.stringify(search)};
      const deadline = Date.now() + 30000;
      let snapshot;
      do {
        const routeSearch = router.state.location.search;
        const unexpectedSearchKeys = routeSearch && typeof routeSearch === "object"
          ? Object.keys(routeSearch).filter((key) => !(key in expectedSearch))
          : [];
        const canonicalConversationRoute =
          expectedPathname === "/chat" &&
          unexpectedSearchKeys.length === 1 &&
          unexpectedSearchKeys[0] === "c" &&
          /^[0-9a-f-]{36}$/iu.test(routeSearch?.c);
        const routeMatches =
          router.state.location.pathname === expectedPathname &&
          routeSearch &&
          typeof routeSearch === "object" &&
          Object.entries(expectedSearch).every(([key, value]) => routeSearch[key] === value) &&
          (unexpectedSearchKeys.length === 0 || canonicalConversationRoute);
        snapshot = {
          routeHref: router.state.location.href,
          routePathname: router.state.location.pathname,
          routeSearch,
          pending: Boolean(document.querySelector('.error-boundary[role="status"]')),
          crash: Boolean(document.querySelector('.error-boundary:not([role="status"])'))
        };
        if (snapshot.crash || (routeMatches && !snapshot.pending)) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      return snapshot;
    })()`,
    label,
    45_000,
  );
  const observedSearch =
    observed?.routeSearch && typeof observed.routeSearch === "object"
      ? observed.routeSearch
      : null;
  const unexpectedSearchKeys = observedSearch
    ? Object.keys(observedSearch).filter((key) => !(key in search))
    : [];
  const canonicalConversationRoute =
    target.pathname === "/chat" &&
    unexpectedSearchKeys.length === 1 &&
    unexpectedSearchKeys[0] === "c" &&
    /^[0-9a-f-]{36}$/iu.test(observedSearch.c);
  const expectedSearchMatched =
    observedSearch !== null &&
    Object.entries(search).every(
      ([key, value]) => observedSearch[key] === value,
    );
  if (
    observed?.routePathname !== target.pathname ||
    !expectedSearchMatched ||
    (unexpectedSearchKeys.length !== 0 && !canonicalConversationRoute) ||
    observed.pending !== false ||
    observed.crash !== false
  ) {
    throw new CloudProofError(
      `${label} did not reach a clean exact product route.`,
      {
        observedRoutePathname: observed?.routePathname ?? null,
        expectedRoutePathname: target.pathname,
        observedSearchKeys: observedSearch ? Object.keys(observedSearch) : [],
        expectedSearchKeys: Object.keys(search),
        expectedSearchMatched,
        unexpectedSearchCount: unexpectedSearchKeys.length,
        pending: observed?.pending === true,
        crash: observed?.crash === true,
      },
    );
  }
  const welcomeVisible = await client.evaluate(
    `Boolean(document.querySelector('.welcome-dialog-content'))`,
    `${label} observe post-onboarding welcome`,
  );
  if (welcomeVisible === true) {
    await trustedRenderedClick(
      client,
      ".welcome-dialog-close",
      `${label} dismiss post-onboarding welcome`,
    );
  }
  return appUrl;
};

const attestRenderedZeroConversations = async (
  client,
  { profileSha256, rawLog },
) => {
  const value = await client.evaluate(
    `(async () => {
      const hash = async (text) => {
        const bytes = new TextEncoder().encode(String(text));
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      };
      const { convexClient } = await import("/src/platform/convex/convex-client.ts");
      const { cloudApi } = await import("/src/features/cloud/cloud-api.ts");
      const { refreshAuthSession, getAuthSessionSnapshot } = await import("/src/global/auth/services/auth-session.ts");
      await refreshAuthSession();
      const snapshot = getAuthSessionSnapshot();
      const rows = await convexClient.query(cloudApi.listMyConversations, {});
      return {
        conversationCount: Array.isArray(rows) ? rows.length : -1,
        rowsSha256: await hash(JSON.stringify(rows)),
        identitySha256: snapshot.data?.user?.id ? await hash(snapshot.data.user.id) : await hash("signed-out"),
        signedOutOrAnonymous: !snapshot.data?.user?.id || snapshot.data.user.isAnonymous === true,
        settingsAuthRoute: location.pathname === "/settings" && new URLSearchParams(location.search).get("dialog") === "auth",
        chatSurfaceAbsent: !document.querySelector('[data-testid="chat-surface"]'),
        crashSurfaceAbsent: !document.querySelector('.error-boundary')
      };
    })()`,
    `attest ${client.surface} zero-conversation pre-login state`,
    60_000,
  );
  assert(
    value?.conversationCount === 0 &&
      value.signedOutOrAnonymous === true &&
      value.settingsAuthRoute === true &&
      value.chatSurfaceAbsent === true &&
      value.crashSurfaceAbsent === true,
    "Prepared product login profile already has a conversation or left the pre-chat auth route.",
  );
  const body = Object.freeze({
    contract: "stella-driver-zero-conversation-v1",
    surface: client.surface,
    targetIdSha256: requireSha256(
      client.targetIdSha256,
      "Zero-conversation target",
    ),
    profileSha256: requireSha256(profileSha256, "Zero-conversation profile"),
    identitySha256: requireSha256(
      value.identitySha256,
      "Zero-conversation identity",
    ),
    rowsSha256: requireSha256(value.rowsSha256, "Zero-conversation rows"),
    conversationCount: 0,
    signedOutOrAnonymous: true,
    settingsAuthRoute: true,
    chatSurfaceAbsent: true,
    crashSurfaceAbsent: true,
  });
  const receiptSha256 = sha256(canonicalJson(body));
  rawLog.push(
    rawReceipt(client.surface, "rendered.primary-auth.zero-conversations", {
      outcome: "zero",
      requestIdSha256: body.targetIdSha256,
      resourceIdSha256: body.profileSha256,
      responseSha256: receiptSha256,
      stateSha256: body.rowsSha256,
      count: 0,
    }),
  );
  return Object.freeze({ ...body, receiptSha256 });
};

const preparedSurfaceState = (state, surfaceName) => {
  const candidate = state.authHandoff?.surfaces?.[surfaceName];
  return isRecord(candidate) ? candidate : null;
};

const authHandoffWithSurface = (state, surfaceName, value, base = {}) => ({
  ...(isRecord(state.authHandoff) ? state.authHandoff : {}),
  ...base,
  surfaces: {
    ...(isRecord(state.authHandoff?.surfaces)
      ? state.authHandoff.surfaces
      : {}),
    [surfaceName]: value,
  },
});

const prepareRenderedLoginSurface = async ({
  context,
  paths,
  state,
  checkpoint,
  surfaceName,
  processStateKey,
  processState,
  connect,
  profileSha256,
  email,
  rawLog,
}) => {
  const existing = preparedSurfaceState(state, surfaceName);
  if (existing?.requestReceipt) {
    assert(
      existing.profileSha256 === profileSha256 &&
        existing.processInstanceSha256 ===
          processState.processIdentity.processInstanceSha256,
      `Prepared ${surfaceName} login belongs to another process/profile.`,
    );
    return existing;
  }
  const client = await connect(processState);
  try {
    let onboarding = existing?.onboarding ?? null;
    if (!onboarding) {
      onboarding = await driveVisibleProductOnboarding(client, {
        profileSha256,
        rawLog,
      });
    }
    const authUrl = new URL("/settings?dialog=auth", STRICT_PRODUCT_ORIGIN)
      .href;
    await navigateRenderedProduct(
      client,
      authUrl,
      `navigate ${surfaceName} to product auth settings`,
    );
    const updatedProcessState =
      processStateKey === "renderedBrowser"
        ? { ...processState, appUrl: authUrl }
        : { ...processState, expectedRendererUrl: authUrl };
    const partial = Object.freeze({
      surfaceName,
      surface: client.surface,
      processInstanceSha256: processState.processIdentity.processInstanceSha256,
      profileSha256,
      targetIdSha256: client.targetIdSha256,
      onboarding,
      authSetupUseCount: 0,
    });
    await checkpoint({
      [processStateKey]: updatedProcessState,
      authHandoff: authHandoffWithSurface(state, surfaceName, partial, {
        status: "preparing-product-login",
      }),
    });
    const zeroConversation = await attestRenderedZeroConversations(client, {
      profileSha256,
      rawLog,
    });
    const requestReceipt = await beginRenderedProductMagicLinkLogin(client, {
      email,
      productOnboardingReceipt: onboarding.productReceipt,
      driverZeroConversationAttestationSha256: zeroConversation.receiptSha256,
      timeoutMs: 120_000,
    });
    const completed = Object.freeze({
      ...partial,
      zeroConversation,
      requestReceipt,
    });
    await checkpoint({
      [processStateKey]: updatedProcessState,
      authHandoff: authHandoffWithSurface(state, surfaceName, completed, {
        status: "preparing-product-login",
      }),
    });
    rawLog.push(
      rawReceipt(client.surface, "rendered.primary-auth.request", {
        outcome: "awaiting-external-inbox-completion",
        requestIdSha256: requestReceipt.requestReceiptSha256,
        resourceIdSha256: profileSha256,
        responseSha256: requestReceipt.networkDeltaSha256,
        stateSha256: zeroConversation.receiptSha256,
      }),
    );
    return completed;
  } finally {
    client.close();
  }
};

const primaryAuthPrepareReceipt = (context, state) => {
  const surfaces = ["primary", "clean-client", "browser", "secondary"].map(
    (name) => {
      const surface = requireRecord(
        state.authHandoff?.surfaces?.[name],
        `Prepared primary auth ${name}`,
      );
      return {
        name,
        profileSha256: requireSha256(
          surface.profileSha256,
          `Prepared primary auth ${name} profile`,
        ),
        processInstanceSha256: requireSha256(
          surface.processInstanceSha256,
          `Prepared primary auth ${name} process`,
        ),
        onboardingReceiptSha256: requireSha256(
          surface.onboarding?.productReceipt?.onboardingReceiptSha256,
          `Prepared primary auth ${name} onboarding`,
        ),
        zeroConversationReceiptSha256: requireSha256(
          surface.zeroConversation?.receiptSha256,
          `Prepared primary auth ${name} zero-conversation receipt`,
        ),
        requestReceiptSha256: requireSha256(
          surface.requestReceipt?.requestReceiptSha256,
          `Prepared primary auth ${name} request`,
        ),
      };
    },
  );
  const profileSetSha256 = sha256(
    canonicalJson(
      surfaces.map(({ name, profileSha256 }) => ({ name, profileSha256 })),
    ),
  );
  const requestSetSha256 = sha256(
    canonicalJson(
      surfaces.map(
        ({
          name,
          onboardingReceiptSha256,
          zeroConversationReceiptSha256,
          requestReceiptSha256,
        }) => ({
          name,
          onboardingReceiptSha256,
          zeroConversationReceiptSha256,
          requestReceiptSha256,
        }),
      ),
    ),
  );
  const stateSha256 = sha256(
    canonicalJson({
      runId: context.runId,
      targetSha256: targetSha256(context.target),
      emailSha256: requireSha256(
        state.authHandoff?.emailSha256,
        "Prepared primary auth email",
      ),
      secondaryEmailSha256: requireSha256(
        state.authHandoff?.secondaryEmailSha256,
        "Prepared secondary auth email",
      ),
      profileSetSha256,
      requestSetSha256,
      processSetSha256: sha256(
        canonicalJson(
          surfaces.map(({ name, processInstanceSha256 }) => ({
            name,
            processInstanceSha256,
          })),
        ),
      ),
    }),
  );
  const body = Object.freeze({
    contract: PRIMARY_AUTH_HANDOFF_PREPARE_CONTRACT,
    runId: context.runId,
    status: "awaiting-external-inbox-completion",
    profileSetSha256,
    requestSetSha256,
    stateSha256,
  });
  return Object.freeze({
    ...body,
    receiptSha256: sha256(canonicalJson(body)),
  });
};

const runPrimaryAuthPreparation = async ({
  env = process.env,
  cwd = process.cwd(),
} = {}) => {
  assert(
    env === process.env,
    "The executable driver does not accept injected preparation environments.",
  );
  const context = loadAcceptanceDriverContext("primary_auth_handoff", env);
  const paths = resolveRealProductHarnessPaths(context, cwd);
  const releaseLock = await acquireLock(paths, context);
  const rawLog = [];
  try {
    assert(
      !(await pathExists(context.evidenceFile)) &&
        !(await pathExists(context.rawLogFile)),
      "Primary auth preparation must not create evidence or raw-log files.",
    );
    const email = requiredEnv(
      "STELLA_CLOUD_ACCEPTANCE_DISPOSABLE_EMAIL",
    ).toLowerCase();
    const secondaryEmail = requiredEnv(
      "STELLA_CLOUD_ACCEPTANCE_SECONDARY_DISPOSABLE_EMAIL",
    ).toLowerCase();
    assert(
      email === process.env.STELLA_CLOUD_ACCEPTANCE_DISPOSABLE_EMAIL &&
        email.length <= 320 &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email),
      "Disposable primary email must already be normalized.",
    );
    assert(
      secondaryEmail ===
        process.env.STELLA_CLOUD_ACCEPTANCE_SECONDARY_DISPOSABLE_EMAIL &&
        secondaryEmail.length <= 320 &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(secondaryEmail) &&
        secondaryEmail !== email,
      "Disposable connected-secondary email must be normalized and distinct.",
    );
    const state = await loadState(context, paths);
    assert(
      state.completedSteps.length === 0 &&
        state.identity === null &&
        state.deployment === null,
      "Primary auth preparation cannot resume after acceptance work began.",
    );
    if (!(await pathExists(paths.stateFile))) {
      await atomicWritePrivateJson(paths.stateFile, state);
    }
    const checkpoint = async (patch) =>
      await checkpointState(
        paths,
        state,
        requireRecord(patch, "Primary auth preparation checkpoint"),
      );
    assert(
      !state.authHandoff?.emailSha256 ||
        state.authHandoff.emailSha256 === sha256(email),
      "Primary auth preparation email changed across resume.",
    );
    assert(
      !state.authHandoff?.secondaryEmailSha256 ||
        state.authHandoff.secondaryEmailSha256 === sha256(secondaryEmail),
      "Connected-secondary auth preparation email changed across resume.",
    );
    if (state.authHandoff?.status === "awaiting-external-inbox-completion") {
      return primaryAuthPrepareReceipt(context, state);
    }

    let primary;
    if (
      isRecord(state.electron) &&
      state.electron.profileName === "primary" &&
      processAlive(state.electron.pid)
    ) {
      primary = currentElectron(state);
    } else {
      await buildElectron(rawLog);
      const vite = await launchVite(context, paths);
      primary = await launchElectron(
        context,
        Object.freeze({}),
        paths,
        "primary",
        vite,
        rawLog,
      );
      await checkpoint({
        electron: primary,
        authHandoff: {
          ...(isRecord(state.authHandoff) ? state.authHandoff : {}),
          status: "preparing-product-login",
          emailSha256: sha256(email),
          secondaryEmailSha256: sha256(secondaryEmail),
          surfaces: state.authHandoff?.surfaces ?? {},
        },
      });
    }
    const vite = {
      pid: primary.vitePid,
      port: primary.devServerPort,
      logFile: path.join(paths.processLogDirectory, "vite.log"),
      dataDir: primary.viteDataDir,
      processFingerprintSha256: primary.viteProcessFingerprintSha256,
      listenerAddressesSha256: primary.viteListenerAddressesSha256,
    };
    let clean;
    if (
      isRecord(state.authCleanElectron) &&
      state.authCleanElectron.profileName === "clean-client" &&
      processAlive(state.authCleanElectron.pid)
    ) {
      clean = currentAuthCleanElectron(state);
    } else {
      clean = await launchElectron(
        context,
        Object.freeze({}),
        paths,
        "clean-client",
        vite,
        rawLog,
      );
      await checkpoint({ authCleanElectron: clean });
    }
    let secondary;
    if (
      isRecord(state.secondaryElectron) &&
      state.secondaryElectron.profileName === "secondary" &&
      processAlive(state.secondaryElectron.pid)
    ) {
      secondary = currentSecondaryElectron(state);
    } else {
      secondary = await launchElectron(
        context,
        Object.freeze({}),
        paths,
        "secondary",
        vite,
        rawLog,
      );
      await checkpoint({ secondaryElectron: secondary });
    }
    let browser;
    if (
      isRecord(state.renderedBrowser) &&
      processAlive(state.renderedBrowser.pid)
    ) {
      browser = currentRenderedBrowser(state);
    } else {
      assert(
        !isRecord(state.renderedBrowser),
        "Prepared browser process was lost; preserving its profile for audit instead of inventing continuity.",
      );
      browser = await launchRenderedBrowser(paths, state, {
        profileMode: "fresh",
      });
      await checkpoint({ renderedBrowser: browser });
    }

    const primaryPrepared = await prepareRenderedLoginSurface({
      context,
      paths,
      state,
      checkpoint,
      surfaceName: "primary",
      processStateKey: "electron",
      processState: primary,
      connect: connectElectronRenderedClient,
      profileSha256: primary.profileSha256,
      email,
      rawLog,
    });
    primary = state.electron;
    const cleanPrepared = await prepareRenderedLoginSurface({
      context,
      paths,
      state,
      checkpoint,
      surfaceName: "clean-client",
      processStateKey: "authCleanElectron",
      processState: clean,
      connect: connectElectronRenderedClient,
      profileSha256: clean.profileSha256,
      email,
      rawLog,
    });
    clean = state.authCleanElectron;
    const browserPrepared = await prepareRenderedLoginSurface({
      context,
      paths,
      state,
      checkpoint,
      surfaceName: "browser",
      processStateKey: "renderedBrowser",
      processState: browser,
      connect: connectBrowserRenderedClient,
      profileSha256: browser.processIdentity.profileSha256,
      email,
      rawLog,
    });
    browser = state.renderedBrowser;
    const secondaryPrepared = await prepareRenderedLoginSurface({
      context,
      paths,
      state,
      checkpoint,
      surfaceName: "secondary",
      processStateKey: "secondaryElectron",
      processState: secondary,
      connect: connectElectronRenderedClient,
      profileSha256: secondary.profileSha256,
      email: secondaryEmail,
      rawLog,
    });
    secondary = state.secondaryElectron;
    assert(
      [
        primaryPrepared,
        cleanPrepared,
        browserPrepared,
        secondaryPrepared,
      ].every((surface) => surface.authSetupUseCount === 0),
      "Primary auth preparation used an unreviewed credential setup seam.",
    );
    const receipt = primaryAuthPrepareReceipt(context, state);
    await checkpoint({
      authHandoff: {
        ...state.authHandoff,
        status: "awaiting-external-inbox-completion",
        profileSetSha256: receipt.profileSetSha256,
        requestSetSha256: receipt.requestSetSha256,
        prepareStateSha256: receipt.stateSha256,
        prepareReceiptSha256: receipt.receiptSha256,
      },
    });
    assert(
      !(await pathExists(context.evidenceFile)) &&
        !(await pathExists(context.rawLogFile)),
      "Primary auth preparation wrote an evidence artifact.",
    );
    return receipt;
  } finally {
    await releaseLock();
  }
};

const connectPreparedAuthSurface = async (
  processState,
  surface,
  expectedTargetIdSha256,
) => {
  const targets = await requestJson(
    `http://127.0.0.1:${requireInteger(processState.debugPort, `${surface} prepared debug port`, 1)}/json/list`,
    {
      label: `${surface} prepared auth CDP targets`,
      timeoutMs: 10_000,
      method: "GET",
      maxResponseBytes: 256_000,
    },
  );
  assert(
    targets.status === 200 && Array.isArray(targets.body),
    `${surface} prepared auth target list is unavailable.`,
  );
  const allowed = new Set([
    new URL("/settings?dialog=auth", STRICT_PRODUCT_ORIGIN).href,
    new URL("/settings", STRICT_PRODUCT_ORIGIN).href,
  ]);
  const matches = targets.body.filter(
    (target) =>
      target?.type === "page" &&
      allowed.has(target.url) &&
      sha256(String(target.id ?? "")) === expectedTargetIdSha256,
  );
  assert(
    matches.length === 1,
    `${surface} prepared auth target changed outside the exact product settings handoff.`,
  );
  return await connectRenderedClientCdp({
    debugPort: processState.debugPort,
    expectedUrl: matches[0].url,
    surface,
    expectedProcess: {
      pid: processState.pid,
      processFingerprintSha256: processState.processFingerprintSha256,
    },
    timeoutMs: 90_000,
  });
};

const providerLifecycleFromEvents = (events, expectedOutcome, label) => {
  const lifecycle = events.filter(
    (event) =>
      event?.type === "provider-lifecycle" &&
      typeof event.providerRequestIdSha256 === "string",
  );
  const byRequest = new Map();
  for (const event of lifecycle) {
    const key = event.providerRequestIdSha256;
    const group = byRequest.get(key) ?? [];
    group.push(event);
    byRequest.set(key, group);
  }
  for (const [requestIdSha256, group] of byRequest) {
    const phases = group.map((event) => event.providerLifecyclePhase);
    const compact = phases.filter(
      (phase, index) => index === 0 || phase !== phases[index - 1],
    );
    if (
      compact.length === REQUIRED_PROVIDER_PHASES.length &&
      compact.every(
        (phase, index) => phase === REQUIRED_PROVIDER_PHASES[index],
      ) &&
      group.at(-1)?.providerOutcome === expectedOutcome
    ) {
      requireSha256(requestIdSha256, `${label} request id hash`);
      return {
        phases: compact,
        requestIdSha256,
        physicalAttempt: requireInteger(
          group.at(-1)?.providerPhysicalAttempt,
          `${label} physical attempt`,
          1,
        ),
        streamOrdinal: requireInteger(
          group.at(-1)?.providerStreamOrdinal,
          `${label} stream ordinal`,
          1,
        ),
        outcome: expectedOutcome,
      };
    }
  }
  throw new CloudProofError(
    `${label} did not emit a closed and joined provider lifecycle.`,
  );
};

const assertNoRawProviderRequestId = (events, label) => {
  const lifecycle = events.filter(
    (event) => event?.type === "provider-lifecycle",
  );
  assert(
    lifecycle.length > 0,
    `${label} emitted no provider lifecycle events.`,
  );
  for (const [index, event] of lifecycle.entries()) {
    assert(
      !Object.hasOwn(event, "providerRequestId") &&
        !Object.hasOwn(event, "providerRawRequestId") &&
        !Object.hasOwn(event, "rawProviderRequestId"),
      `${label} event ${index} exposed a raw provider request id.`,
    );
    requireSha256(
      event.providerRequestIdSha256,
      `${label} event ${index} hashed provider request id`,
    );
  }
  return false;
};

const localHistorySnapshot = async (electron, conversationId, rawLog) => {
  const result = await cdpEvaluate(
    electron,
    `(async () => {
      const resumed = await window.electronAPI.agent.resumeConversationExecution({
        conversationId: ${JSON.stringify(conversationId)},
        lastSeq: 0
      });
      const messages = await window.electronAPI.localChat.listMessages({
        conversationId: ${JSON.stringify(conversationId)},
        limit: 1000
      });
      const activity = await window.electronAPI.localChat.listActivity({
        conversationId: ${JSON.stringify(conversationId)},
        limit: 1000
      });
      return { resumed, messages, activity };
    })()`,
    "local runtime history snapshot",
    60_000,
  );
  const digest = sha256(canonicalJson(result));
  rawLog.push(
    rawReceipt("local-runtime", "local.history.snapshot", {
      stateSha256: digest,
      responseSha256: digest,
    }),
  );
  return { digest, result };
};

const liveProfileMetadataSha256 = async () => {
  if (!(await pathExists(LIVE_STELLA_ROOT))) return sha256("absent");
  const entries = [];
  const walk = async (directory, relative = "") => {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const nextRelative = path.join(relative, child.name);
      const absolute = path.join(directory, child.name);
      const metadata = await lstat(absolute);
      entries.push({
        path: nextRelative.split(path.sep).join("/"),
        kind: child.isDirectory()
          ? "directory"
          : child.isFile()
            ? "file"
            : "other",
        size: metadata.size,
        mode: metadata.mode & 0o777,
        mtimeMs: Math.trunc(metadata.mtimeMs),
      });
      if (child.isDirectory()) await walk(absolute, nextRelative);
    }
  };
  await walk(LIVE_STELLA_ROOT);
  return sha256(canonicalJson(entries));
};

const inspectReviewedDeploymentIdentity = async (
  context,
  secrets,
  paths,
  jwtIdentity,
  rawLog,
) => {
  const source = await sourceTreeIdentity(rawLog);
  const worker = await workerDeploymentIdentity(secrets, paths, rawLog);
  const convex = await convexDeploymentIdentity(secrets, rawLog);
  const canonicalPrompts = await canonicalPromptPublicationIdentity(
    context,
    rawLog,
  );

  const workerStarted = Date.now();
  const health = await requestJson(
    `${context.target.cloudBuilderUrl}/healthz`,
    {
      label: "deployed Worker health",
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      method: "GET",
    },
  );
  assert(health.body?.ok === true, "Deployed Worker health check failed.");
  const workerProbeRequestId =
    health.headers.get("cf-ray") ?? health.headers.get("x-request-id");
  requireString(workerProbeRequestId, "Worker probe request id", 256);
  rawLog.push(
    requestReceipt("worker", "worker.health.probe", health, workerStarted),
  );

  const convexStarted = Date.now();
  const convexProbe = await requestJson(
    `${context.target.convexUrl}/api/query`,
    {
      label: "deployed Convex probe",
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      method: "POST",
      headers: userHeaders(secrets),
      body: JSON.stringify({
        path: "cloud_apps:getCloudRealtimeConfig",
        args: {},
        format: "json",
      }),
    },
  );
  assert(convexProbe.body?.status !== "error", "Deployed Convex probe failed.");
  assert(
    convexProbe.body?.value?.httpOrigin === context.target.cloudBuilderUrl,
    "Convex is not paired with the selected Worker.",
  );
  const convexProbeRequestId =
    convexProbe.headers.get("cf-ray") ??
    convexProbe.headers.get("x-request-id") ??
    `convex-${sha256(canonicalJson(convexProbe.body)).slice(0, 32)}`;
  rawLog.push(
    requestReceipt(
      "convex",
      "convex.realtime.probe",
      convexProbe,
      convexStarted,
    ),
  );

  const observations = {
    ...source,
    cloudBuilderUrl: context.target.cloudBuilderUrl,
    workerName: WORKER_NAME,
    ...worker,
    workerProbeRequestId,
    convexDeployment: context.target.deployment,
    convexUrl: context.target.convexUrl,
    convexSiteUrl: context.target.convexSiteUrl,
    ...convex,
    ...canonicalPrompts,
    convexProbeRequestId,
    jwtIssuerSha256: sha256(jwtIdentity.issuer),
    jwtSubjectSha256: sha256(jwtIdentity.subject),
    jwtTokenIdentifierSha256: sha256(jwtIdentity.tokenIdentifier),
    issuerQualifiedOwnerMatched: true,
    gitWorktreeClean: true,
    workerSourceMatches: true,
    convexFunctionsMatch: true,
  };
  return Object.freeze({ source, observations });
};

const inspectFreshPrimaryOwner = async (secrets, ownerId, rawLog) => {
  const [lifecycle, conversations, resetCore, accountCore, cloudStores] =
    await Promise.all([
      convexInternalRun(
        secrets,
        "owner_lifecycle:getOwnerDataAccessStateInternal",
        { ownerId },
        rawLog,
      ),
      convexInternalRun(
        secrets,
        "cloud_purge:listOwnerConversationsInternal",
        { ownerId },
        rawLog,
      ),
      convexInternalRun(
        secrets,
        "reset:remainingOwnerResetStoresInternal",
        { ownerId },
        rawLog,
      ),
      convexInternalRun(
        secrets,
        "account_deletion:remainingOwnerAccountCoreStoresInternal",
        { ownerId },
        rawLog,
      ),
      convexInternalRun(
        secrets,
        "cloud_purge:remainingOwnerStoresInternal",
        { ownerId },
        rawLog,
      ),
    ]);
  const checkedLifecycle = requireRecord(
    lifecycle,
    "Fresh primary owner lifecycle",
  );
  assert(
    Array.isArray(conversations) && conversations.length === 0,
    "Fresh primary owner already has a conversation.",
  );
  assert(
    Array.isArray(resetCore) && resetCore.length === 0,
    "Fresh primary owner has non-onboarding reset-core state.",
  );
  assert(
    Array.isArray(accountCore) && accountCore.length === 0,
    "Fresh primary owner has non-onboarding account-core state.",
  );
  assert(
    canonicalJson(cloudStores) ===
      canonicalJson(["cloud_agent_home_preferences"]),
    "Fresh primary owner cloud state is not exactly the product-created onboarding memory preference.",
  );
  const ownerGeneration = requireString(
    checkedLifecycle.generation,
    "Fresh primary owner generation",
    512,
  );
  assert(
    checkedLifecycle.allowed === true && checkedLifecycle.state === "open",
    "Fresh primary owner lifecycle is not open.",
  );
  const preference = requireRecord(
    await convexInternalRun(
      secrets,
      "cloud_memory:getOwnerMemoryPreferenceInternal",
      { ownerId, ownerGeneration },
      rawLog,
    ),
    "Fresh primary onboarding memory preference",
  );
  assert(
    preference.ownerGeneration === ownerGeneration &&
      preference.memoryEpoch === "legacy" &&
      preference.memoryEnabled === false &&
      preference.revision === 1 &&
      Number.isSafeInteger(preference.updatedAt) &&
      preference.updatedAt > 0,
    "Fresh primary product onboarding preference is not the exact disabled revision-one state.",
  );
  const onboardingPreferenceAttestationSha256 = sha256(
    canonicalJson({
      conversationCount: 0,
      resetStores: [],
      accountCoreStores: [],
      cloudStores: ["cloud_agent_home_preferences"],
      ownerGenerationSha256: sha256(ownerGeneration),
      memoryEpochSha256: sha256("legacy"),
      memoryEnabled: false,
      revision: 1,
      updatedAtSha256: sha256(String(preference.updatedAt)),
    }),
  );
  rawLog.push(
    rawReceipt("convex", "convex.primary-auth.fresh-owner", {
      outcome: "empty-open-owner",
      resourceIdSha256: sha256(ownerId),
      stateSha256: sha256(
        canonicalJson({
          generationSha256: sha256(ownerGeneration),
          conversationCount: conversations.length,
          resetCoreCount: resetCore.length,
          accountCoreCount: accountCore.length,
          cloudStoreCount: cloudStores.length,
          onboardingPreferenceAttestationSha256,
        }),
      ),
      count: 0,
    }),
  );
  return Object.freeze({
    ownerGeneration,
    ownerLifecycleState: checkedLifecycle.state,
    conversationCount: conversations.length,
    resetCoreCount: resetCore.length,
    accountCoreCount: accountCore.length,
    cloudStoreCount: cloudStores.length,
    onboardingPreferenceAttestationSha256,
    onboardingMemoryEnabled: false,
    onboardingMemoryRevision: 1,
  });
};

const stepPrimaryAuthHandoff = async ({
  context,
  secrets,
  paths,
  state,
  rawLog,
  checkpoint,
}) => {
  assert(
    state.authHandoff?.status === "awaiting-external-inbox-completion" &&
      state.completedSteps.length === 0 &&
      state.identity === null &&
      state.deployment === null,
    "Primary auth handoff was not prepared as the first acceptance step.",
  );
  const preparedReceipt = primaryAuthPrepareReceipt(context, state);
  assert(
    preparedReceipt.profileSetSha256 === state.authHandoff.profileSetSha256 &&
      preparedReceipt.requestSetSha256 === state.authHandoff.requestSetSha256 &&
      preparedReceipt.stateSha256 === state.authHandoff.prepareStateSha256 &&
      preparedReceipt.receiptSha256 === state.authHandoff.prepareReceiptSha256,
    "Prepared primary auth receipt changed before inbox completion.",
  );
  const primary = currentElectron(state);
  const clean = currentAuthCleanElectron(state);
  const browser = currentRenderedBrowser(state);
  const secondary = currentSecondaryElectron(state);
  const surfaceDefinitions = [
    {
      name: "primary",
      surface: "electron-cdp",
      processStateKey: "electron",
      processState: primary,
      verify: verifyExistingPrimaryElectronProfile,
    },
    {
      name: "clean-client",
      surface: "electron-cdp",
      processStateKey: "authCleanElectron",
      processState: clean,
      verify: verifyExistingPrimaryElectronProfile,
    },
    {
      name: "browser",
      surface: "browser-cdp",
      processStateKey: "renderedBrowser",
      processState: browser,
      verify: verifyExistingPrimaryBrowserProfile,
    },
    {
      name: "secondary",
      surface: "electron-cdp",
      processStateKey: "secondaryElectron",
      processState: secondary,
      verify: verifyExistingPrimaryElectronProfile,
    },
  ];
  const completions = {};
  const authorities = {};
  for (const definition of surfaceDefinitions) {
    const prepared = requireRecord(
      state.authHandoff.surfaces?.[definition.name],
      `Prepared ${definition.name} auth surface`,
    );
    const client = await connectPreparedAuthSurface(
      definition.processState,
      definition.surface,
      requireSha256(
        prepared.targetIdSha256,
        `Prepared ${definition.name} target`,
      ),
    );
    try {
      let completion = prepared.completionReceipt ?? null;
      if (!completion) {
        try {
          completion = await completeRenderedProductMagicLinkLogin(client, {
            requestReceipt: prepared.requestReceipt,
            convexUrl: context.target.convexUrl,
            convexSiteUrl: context.target.convexSiteUrl,
            timeoutMs: 10_000,
          });
        } catch (error) {
          const waiting = await client.evaluate(
            `(async () => {
              const { refreshAuthSession, getAuthSessionSnapshot } = await import("/src/global/auth/services/auth-session.ts");
              await refreshAuthSession();
              const snapshot = getAuthSessionSnapshot();
              return {
                pending: snapshot.isPending === true,
                authenticated: Boolean(snapshot.data?.user?.id),
                anonymous: snapshot.data?.user?.isAnonymous === true,
                crashSurfacePresent: Boolean(document.querySelector('.error-boundary'))
              };
            })()`,
            `classify ${definition.name} product login wait`,
            60_000,
          );
          if (
            waiting?.crashSurfacePresent === false &&
            waiting.pending === false &&
            (!waiting.authenticated || waiting.anonymous === true)
          ) {
            throw new ProductHandoffAwaitingError(
              `The ${definition.name} product profile is still awaiting its authorized inbox link.`,
            );
          }
          throw error;
        }
      }
      const settingsUrl = new URL("/settings", STRICT_PRODUCT_ORIGIN).href;
      await navigateRenderedProduct(
        client,
        settingsUrl,
        `clear ${definition.name} product auth callback route`,
      );
      const processState =
        definition.processStateKey === "renderedBrowser"
          ? { ...definition.processState, appUrl: settingsUrl }
          : { ...definition.processState, expectedRendererUrl: settingsUrl };
      const authority = await definition.verify(client, {
        convexUrl: context.target.convexUrl,
        convexSiteUrl: context.target.convexSiteUrl,
        expectedIdentitySha256: completion.identitySha256,
        expectedSessionIdSha256: completion.sessionIdSha256,
        expectedOwnerAccountSha256: completion.ownerAccountSha256,
      });
      const surfaceState = Object.freeze({
        ...prepared,
        completionReceipt: completion,
        authorityReceipt: authority,
        authSetupUseCount: 0,
        callbackStateCleared: true,
        authDialogClosed: true,
      });
      await checkpoint({
        [definition.processStateKey]: processState,
        authHandoff: authHandoffWithSurface(
          state,
          definition.name,
          surfaceState,
          { status: "verifying-product-login" },
        ),
      });
      completions[definition.name] = completion;
      authorities[definition.name] = authority;
      rawLog.push(
        rawReceipt(
          definition.surface,
          "rendered.primary-auth.product-login-complete",
          {
            outcome: "nonanonymous-product-session",
            requestIdSha256: completion.requestReceiptSha256,
            resourceIdSha256: completion.ownerAccountSha256,
            responseSha256: completion.completionReceiptSha256,
            stateSha256: authority.sessionJwtBindingSha256,
          },
        ),
      );
    } finally {
      client.close();
    }
  }
  const primarySurfaceNames = ["primary", "clean-client", "browser"];
  const completionValues = primarySurfaceNames.map((name) => completions[name]);
  const secondaryCompletion = requireRecord(
    completions.secondary,
    "Connected-secondary completion",
  );
  const authorityValues = surfaceDefinitions.map(
    ({ name }) => authorities[name],
  );
  assert(
    completionValues.every(
      (value) =>
        value.identitySha256 === completionValues[0].identitySha256 &&
        value.ownerAccountSha256 === completionValues[0].ownerAccountSha256 &&
        value.emailSha256 === state.authHandoff.emailSha256 &&
        value.credentialMaterialReturned === false,
    ),
    "Prepared product profiles did not converge on one fresh nonanonymous account.",
  );
  assert(
    secondaryCompletion.emailSha256 ===
      state.authHandoff.secondaryEmailSha256 &&
      secondaryCompletion.identitySha256 !==
        completionValues[0].identitySha256 &&
      secondaryCompletion.ownerAccountSha256 !==
        completionValues[0].ownerAccountSha256 &&
      !completionValues.some(
        (value) =>
          value.sessionIdSha256 === secondaryCompletion.sessionIdSha256,
      ) &&
      secondaryCompletion.credentialMaterialReturned === false,
    "Connected-secondary product profile did not complete as the distinct second account.",
  );
  assert(
    new Set(completionValues.map(({ sessionIdSha256 }) => sessionIdSha256))
      .size === completionValues.length,
    "Prepared product profiles did not receive distinct sessions.",
  );
  assert(
    authorityValues.every(
      (authority) =>
        authority.authenticated === true &&
        authority.anonymous === false &&
        authority.identityClass === "non-anonymous" &&
        authority.credentialMaterialReturned === false &&
        authority.existingProfileContinuityVerified === true,
    ),
    "Prepared product authority verification was not no-cookie and profile-bound.",
  );

  const currentPrimary = currentElectron(state);
  const primaryAuthority = await readElectronSessionAuthority(
    context,
    secrets,
    currentPrimary,
    null,
    rawLog,
    "primary auth handoff",
    {
      expectedIdentitySha256: completions.primary.identitySha256,
      expectedSessionIdSha256: completions.primary.sessionIdSha256,
      expectedOwnerAccountSha256: completions.primary.ownerAccountSha256,
    },
  );
  const productSecrets = ephemeralJwtSecrets(
    secrets,
    primaryAuthority.token,
    "primary auth handoff",
  );
  const ownerId = primaryAuthority.tokenIdentity.tokenIdentifier;
  assert(
    sha256(ownerId) === completions.primary.ownerAccountSha256,
    "Primary product profile token does not identify the completed owner.",
  );
  const fresh = await inspectFreshPrimaryOwner(productSecrets, ownerId, rawLog);
  const currentSecondary = currentSecondaryElectron(state);
  const secondaryAuthority = await readElectronSessionAuthority(
    context,
    secrets,
    currentSecondary,
    null,
    rawLog,
    "connected-secondary auth handoff",
    {
      expectedIdentitySha256: secondaryCompletion.identitySha256,
      expectedSessionIdSha256: secondaryCompletion.sessionIdSha256,
      expectedOwnerAccountSha256: secondaryCompletion.ownerAccountSha256,
    },
  );
  const secondarySecrets = ephemeralJwtSecrets(
    secrets,
    secondaryAuthority.token,
    "connected-secondary auth handoff",
  );
  const secondaryOwnerId = secondaryAuthority.tokenIdentity.tokenIdentifier;
  assert(
    sha256(secondaryOwnerId) === secondaryCompletion.ownerAccountSha256 &&
      secondaryOwnerId !== ownerId,
    "Connected-secondary product token does not identify the distinct completed owner.",
  );
  const secondaryFresh = await inspectFreshPrimaryOwner(
    secondarySecrets,
    secondaryOwnerId,
    rawLog,
  );
  const inspected = await inspectReviewedDeploymentIdentity(
    context,
    productSecrets,
    paths,
    primaryAuthority.tokenIdentity,
    rawLog,
  );
  const preChatDeployment = Object.freeze({
    ...inspected.observations,
    productLoginChatStatus: "pending-post-deployment-conversation",
    primaryProductLoginChatReceiptSha256: sha256("pending:primary"),
    cleanClientProductLoginChatReceiptSha256: sha256("pending:clean-client"),
    browserProductLoginChatReceiptSha256: sha256("pending:browser"),
    productLoginChatReceiptSetSha256: sha256("pending:receipt-set"),
    productLoginChatSameAccount: true,
    productLoginChatCredentialMaterialReturned: false,
  });
  const identity = Object.freeze({
    deploymentFingerprintSha256: deploymentFingerprint(inspected.observations),
    sourceTreeSha256: inspected.source.sourceTreeSha256,
    ownerIdSha256: sha256(ownerId),
    ownerGeneration: fresh.ownerGeneration,
  });
  const authorityReceiptSha256 = Object.fromEntries(
    surfaceDefinitions.map(({ name }) => [
      name,
      sha256(canonicalJson(authorities[name])),
    ]),
  );
  const observations = {
    status: "verified-product-login",
    emailSha256: state.authHandoff.emailSha256,
    profileSetSha256: preparedReceipt.profileSetSha256,
    requestSetSha256: preparedReceipt.requestSetSha256,
    primaryProcessInstanceSha256:
      state.electron.processIdentity.processInstanceSha256,
    cleanClientProcessInstanceSha256:
      state.authCleanElectron.processIdentity.processInstanceSha256,
    browserProcessInstanceSha256:
      state.renderedBrowser.processIdentity.processInstanceSha256,
    secondaryProcessInstanceSha256:
      state.secondaryElectron.processIdentity.processInstanceSha256,
    primaryIdentitySha256: completions.primary.identitySha256,
    primaryOwnerAccountSha256: completions.primary.ownerAccountSha256,
    primarySessionIdSha256: completions.primary.sessionIdSha256,
    cleanClientSessionIdSha256: completions["clean-client"].sessionIdSha256,
    browserSessionIdSha256: completions.browser.sessionIdSha256,
    secondaryEmailSha256: state.authHandoff.secondaryEmailSha256,
    secondaryIdentitySha256: secondaryCompletion.identitySha256,
    secondaryJwtIssuerSha256: sha256(secondaryAuthority.tokenIdentity.issuer),
    secondaryJwtSubjectSha256: sha256(secondaryAuthority.tokenIdentity.subject),
    secondaryJwtTokenIdentifierSha256: sha256(
      secondaryAuthority.tokenIdentity.tokenIdentifier,
    ),
    secondaryOwnerAccountSha256: secondaryCompletion.ownerAccountSha256,
    secondarySessionIdSha256: secondaryCompletion.sessionIdSha256,
    primaryAuthorityReceiptSha256: authorityReceiptSha256.primary,
    cleanClientAuthorityReceiptSha256: authorityReceiptSha256["clean-client"],
    browserAuthorityReceiptSha256: authorityReceiptSha256.browser,
    secondaryAuthorityReceiptSha256: authorityReceiptSha256.secondary,
    onboardingReceiptSetSha256: sha256(
      canonicalJson(
        surfaceDefinitions.map(({ name }) => ({
          name,
          transcriptSha256:
            state.authHandoff.surfaces[name].onboarding.transcriptSha256,
          receiptSha256:
            state.authHandoff.surfaces[name].onboarding.productReceipt
              .onboardingReceiptSha256,
        })),
      ),
    ),
    onboardingPhaseCount: surfaceDefinitions.reduce(
      (total, { name }) =>
        total +
        state.authHandoff.surfaces[name].onboarding.transcript.phaseCount,
      0,
    ),
    ownerGenerationSha256: sha256(fresh.ownerGeneration),
    onboardingPreferenceAttestationSha256:
      fresh.onboardingPreferenceAttestationSha256,
    onboardingMemoryEnabled: fresh.onboardingMemoryEnabled,
    onboardingMemoryRevision: fresh.onboardingMemoryRevision,
    sameAccountAcrossProfiles: true,
    distinctConnectedSecondaryAccount: true,
    distinctProfileSessions: true,
    callbackStateCleared: true,
    authDialogClosed: true,
    cleanClientInitiallyEmpty: true,
    cleanupEligible: true,
    credentialMaterialReturned: false,
    cookieSetupUseCount: 0,
    freshOwnerConversationCount: fresh.conversationCount,
    freshOwnerResetResidueCount: fresh.resetCoreCount,
    freshOwnerAccountCoreResidueCount: fresh.accountCoreCount,
    freshOwnerCloudProductStateCount: fresh.cloudStoreCount,
    ownerLifecycleState: fresh.ownerLifecycleState,
    secondaryOwnerGenerationSha256: sha256(secondaryFresh.ownerGeneration),
    secondaryOwnerLifecycleState: secondaryFresh.ownerLifecycleState,
    secondaryFreshOwnerConversationCount: secondaryFresh.conversationCount,
    secondaryFreshOwnerResetResidueCount: secondaryFresh.resetCoreCount,
    secondaryFreshOwnerAccountCoreResidueCount: secondaryFresh.accountCoreCount,
    secondaryFreshOwnerCloudProductStateCount: secondaryFresh.cloudStoreCount,
    secondaryOnboardingPreferenceAttestationSha256:
      secondaryFresh.onboardingPreferenceAttestationSha256,
    secondaryOnboardingMemoryEnabled: secondaryFresh.onboardingMemoryEnabled,
    secondaryOnboardingMemoryRevision: secondaryFresh.onboardingMemoryRevision,
    deployment: preChatDeployment,
  };
  await checkpoint({
    identity,
    deployment: preChatDeployment,
    electron: state.electron,
    authCleanElectron: state.authCleanElectron,
    renderedBrowser: state.renderedBrowser,
    secondaryElectron: state.secondaryElectron,
    authHandoff: {
      ...state.authHandoff,
      status: "verified-product-login",
      ownerAccountSha256: sha256(ownerId),
      identitySha256: primaryAuthority.identitySha256,
      ownerGeneration: fresh.ownerGeneration,
      cleanClientInitiallyEmpty: true,
      cleanClientInitialStateSha256:
        state.authHandoff.surfaces["clean-client"].zeroConversation.rowsSha256,
      onboardingPreferenceAttestationSha256:
        fresh.onboardingPreferenceAttestationSha256,
      completionSetSha256: sha256(
        canonicalJson(
          surfaceDefinitions.map(({ name }) => ({
            name,
            completionReceiptSha256: completions[name].completionReceiptSha256,
          })),
        ),
      ),
      cleanupEligible: true,
    },
    secondary: {
      ownerId: secondaryOwnerId,
      ownerIdSha256: sha256(secondaryOwnerId),
      ownerGeneration: secondaryFresh.ownerGeneration,
      identityClass: "connected-secondary",
      emailSha256: state.authHandoff.secondaryEmailSha256,
      sessionSubjectSha256: secondaryAuthority.identitySha256,
      sessionIdSha256: secondaryAuthority.sessionIdSha256,
      conversationId: null,
      title: null,
      canarySha256: null,
      canaryTurnIdSha256: null,
    },
    cleanupOwnerHint: { ownerIdSha256: sha256(ownerId) },
    secondaryCleanupOwnerHint: {
      ownerIdSha256: sha256(secondaryOwnerId),
    },
    resources: {
      ...state.resources,
      ownerGenerations: [
        ...new Set([
          ...(state.resources?.ownerGenerations ?? []),
          fresh.ownerGeneration,
          secondaryFresh.ownerGeneration,
        ]),
      ],
    },
    liveProfileSha256Before: await liveProfileMetadataSha256(),
  });
  return { identity, observations, patch: {} };
};

const verifyPreparedProductLoginChats = async ({
  context,
  secrets,
  state,
  conversationId,
  rawLog,
  checkpoint,
}) => {
  const definitions = [
    {
      name: "primary",
      surface: "electron-cdp",
      processStateKey: "electron",
      processState: currentElectron(state),
      connect: connectElectronRenderedClient,
      configure: true,
    },
    {
      name: "clean-client",
      surface: "electron-cdp",
      processStateKey: "authCleanElectron",
      processState: currentAuthCleanElectron(state),
      connect: connectElectronRenderedClient,
      configure: true,
    },
    {
      name: "browser",
      surface: "browser-cdp",
      processStateKey: "renderedBrowser",
      processState: currentRenderedBrowser(state),
      connect: connectBrowserRenderedClient,
      configure: false,
    },
  ];
  const receipts = [];
  for (const definition of definitions) {
    const authSurface = requireRecord(
      state.authHandoff?.surfaces?.[definition.name],
      `${definition.name} completed login surface`,
    );
    if (definition.configure) {
      await configureElectronSession(
        context,
        secrets,
        definition.processState,
        conversationId,
        rawLog,
      );
    }
    const client = await definition.connect(definition.processState);
    try {
      const chatUrl = new URL("/chat", STRICT_PRODUCT_ORIGIN).href;
      await navigateRenderedProduct(
        client,
        chatUrl,
        `navigate ${definition.name} completed product login to chat`,
      );
      await selectRenderedConversation(client, {
        conversationId,
        timeoutMs: 120_000,
      });
      const receipt = await verifyRenderedProductLoginSameProfileChat(client, {
        completedLoginReceipt: authSurface.completionReceipt,
        profileSha256: authSurface.profileSha256,
        conversationId,
        timeoutMs: 120_000,
      });
      const processState =
        definition.processStateKey === "renderedBrowser"
          ? { ...definition.processState, appUrl: chatUrl }
          : { ...definition.processState, expectedRendererUrl: chatUrl };
      const surfaceState = { ...authSurface, chatReceipt: receipt };
      await checkpoint({
        [definition.processStateKey]: processState,
        authHandoff: authHandoffWithSurface(
          state,
          definition.name,
          surfaceState,
          { status: "verified-product-chat" },
        ),
      });
      rawLog.push(
        rawReceipt(
          definition.surface,
          "rendered.primary-auth.same-profile-chat",
          {
            outcome: receipt.outcome,
            requestIdSha256: receipt.completionReceiptSha256,
            resourceIdSha256: receipt.profileSha256,
            responseSha256: receipt.rowsSha256,
            stateSha256: receipt.chatReceiptSha256,
            count: receipt.rowCount,
          },
        ),
      );
      receipts.push(Object.freeze({ name: definition.name, ...receipt }));
    } finally {
      client.close();
    }
  }
  assert(
    receipts.length === 3 &&
      receipts.every(
        (receipt) =>
          receipt.identitySha256 === receipts[0].identitySha256 &&
          receipt.ownerAccountSha256 === receipts[0].ownerAccountSha256 &&
          receipt.conversationIdSha256 === sha256(conversationId) &&
          receipt.chatSurfaceRendered === true &&
          receipt.composerRendered === true &&
          receipt.crashSurfaceAbsent === true &&
          receipt.sameTarget === true &&
          receipt.sameProfile === true &&
          receipt.credentialMaterialReturned === false,
      ),
    "Completed product logins did not render the same canonical chat in their prepared profiles.",
  );
  return Object.freeze({
    receipts,
    receiptSetSha256: sha256(
      canonicalJson(
        receipts.map(({ name, chatReceiptSha256 }) => ({
          name,
          chatReceiptSha256,
        })),
      ),
    ),
  });
};

const stepDeploymentIdentity = async ({
  context,
  secrets,
  paths,
  state,
  rawLog,
  checkpoint,
}) => {
  const jwtIdentity = parseJwtIdentity(secrets.jwt);
  assert(
    jwtIdentity.issuer === context.target.convexSiteUrl,
    "Disposable JWT issuer does not match the pinned Convex site.",
  );
  const inspected = await inspectReviewedDeploymentIdentity(
    context,
    secrets,
    paths,
    jwtIdentity,
    rawLog,
  );
  const { source, observations: deploymentBase } = inspected;
  const placementIdentity = requireRecord(
    await convexCall(
      context,
      secrets,
      "query",
      "execution_placement:getMyExecutionPlacementIdentity",
      {},
      "resolve primary owner generation",
      rawLog,
    ),
    "Primary execution placement identity",
  );
  const expectedOwnerGeneration = requireString(
    placementIdentity.ownerGeneration,
    "Primary owner generation",
    512,
  );
  const title = `stella-cloud-acceptance:${context.runId}`;
  const conversation = requireRecord(
    await convexCall(
      context,
      secrets,
      "mutation",
      "cloud_apps:createMyConversation",
      {
        clientCreateId: `acceptance-${context.runId}`,
        expectedOwnerGeneration,
        title,
      },
      "create disposable acceptance conversation",
      rawLog,
    ),
    "Created conversation",
  );
  const conversationId = requireUuid(
    conversation.conversationId,
    "Created conversation id",
  );
  const ownerId = requireString(
    conversation.ownerId,
    "Created conversation owner",
    512,
  );
  await checkpoint({
    resources: {
      ...state.resources,
      conversations: [
        ...new Set([...(state.resources?.conversations ?? []), conversationId]),
      ],
    },
    cleanupOwnerHint: {
      ownerIdSha256: sha256(ownerId),
    },
  });
  assert(
    ownerId === jwtIdentity.tokenIdentifier,
    "Convex conversation owner does not match the JWT issuer-qualified token identifier.",
  );
  assert(
    conversation.title === title,
    "Acceptance conversation title was not preserved exactly.",
  );
  const owner = await ownerLookup(context, secrets, conversationId, rawLog);
  assert(
    owner.ownerId === ownerId,
    "Worker owner lookup disagrees with Convex.",
  );
  const probe = await acceptanceProbe(
    context,
    secrets,
    { ownerId, ownerGeneration: owner.ownerGeneration },
    conversationId,
    "status",
    rawLog,
  );
  const renderedLoginChat = await verifyPreparedProductLoginChats({
    context,
    secrets,
    state,
    conversationId,
    rawLog,
    checkpoint,
  });
  const byName = Object.fromEntries(
    renderedLoginChat.receipts.map((receipt) => [receipt.name, receipt]),
  );
  const observations = {
    ...deploymentBase,
    productLoginChatStatus: "verified",
    primaryProductLoginChatReceiptSha256: byName.primary.chatReceiptSha256,
    cleanClientProductLoginChatReceiptSha256:
      byName["clean-client"].chatReceiptSha256,
    browserProductLoginChatReceiptSha256: byName.browser.chatReceiptSha256,
    productLoginChatReceiptSetSha256: renderedLoginChat.receiptSetSha256,
    productLoginChatSameAccount: true,
    productLoginChatCredentialMaterialReturned: false,
  };
  const identity = {
    deploymentFingerprintSha256: deploymentFingerprint(observations),
    sourceTreeSha256: source.sourceTreeSha256,
    ownerIdSha256: sha256(ownerId),
    ownerGeneration: owner.ownerGeneration,
  };
  if (state.identity !== null) {
    assert(
      canonicalJson(identity) === canonicalJson(state.identity),
      "Deployment identity does not match the verified primary auth handoff.",
    );
  }
  return {
    identity,
    observations,
    patch: {
      identity,
      deployment: observations,
      primary: {
        conversationId,
        durableObjectIdSha256: probe.durableObjectIdSha256,
        bootIdSha256: probe.bootIdSha256,
        providerDispatchCount: probe.providerDispatchCount,
      },
      resources: {
        ...state.resources,
        conversations: [conversationId],
      },
      liveProfileSha256Before: await liveProfileMetadataSha256(),
    },
  };
};

const stepLocalRuntimeLifecycle = async ({
  context,
  secrets,
  paths,
  state,
  rawLog,
  checkpoint,
}) => {
  const owner = await recoverOwnerIdentity(context, secrets, state, rawLog);
  let electron = currentElectron(state);
  const vite = {
    pid: electron.vitePid,
    port: electron.devServerPort,
    logFile: path.join(paths.processLogDirectory, "vite.log"),
    dataDir: electron.viteDataDir ?? viteDataPath(paths),
    processFingerprintSha256: electron.viteProcessFingerprintSha256,
    listenerAddressesSha256: electron.viteListenerAddressesSha256,
  };
  await configureElectronSession(
    context,
    secrets,
    electron,
    owner.conversationId,
    rawLog,
  );

  const secondaryElectron = currentSecondaryElectron(state);
  const preparedSecondary = requireRecord(
    state.secondary,
    "Prepared connected-secondary owner",
  );
  assert(
    preparedSecondary.identityClass === "connected-secondary" &&
      preparedSecondary.conversationId === null,
    "Local lifecycle requires the fresh connected-secondary account before its first conversation.",
  );
  const secondaryAuthority = await readElectronSessionAuthority(
    context,
    secrets,
    secondaryElectron,
    null,
    rawLog,
    "connected-secondary disposable",
    {
      expectedIdentitySha256: preparedSecondary.sessionSubjectSha256,
      expectedSessionIdSha256: preparedSecondary.sessionIdSha256,
      expectedOwnerAccountSha256: preparedSecondary.ownerIdSha256,
    },
  );
  const secondarySecrets = ephemeralJwtSecrets(
    secrets,
    secondaryAuthority.token,
    "connected-secondary disposable",
  );
  assert(
    secondaryAuthority.tokenIdentity.subject !== parseJwtSubject(secrets.jwt) &&
      secondaryAuthority.tokenIdentity.tokenIdentifier !== owner.ownerId &&
      secondaryAuthority.tokenIdentity.tokenIdentifier ===
        preparedSecondary.ownerId,
    "The isolated connected-secondary must be distinct from the primary disposable owner.",
  );
  const secondaryTitle = `stella-cloud-acceptance:${context.runId}:secondary`;
  const secondaryPlacementIdentity = requireRecord(
    await convexCall(
      context,
      secondarySecrets,
      "query",
      "execution_placement:getMyExecutionPlacementIdentity",
      {},
      "resolve connected-secondary owner generation",
      rawLog,
    ),
    "Connected-secondary execution placement identity",
  );
  const secondaryExpectedOwnerGeneration = requireString(
    secondaryPlacementIdentity.ownerGeneration,
    "Connected-secondary owner generation",
    512,
  );
  const secondaryConversation = requireRecord(
    await convexCall(
      context,
      secondarySecrets,
      "mutation",
      "cloud_apps:createMyConversation",
      {
        clientCreateId: `acceptance-secondary-${context.runId}`,
        expectedOwnerGeneration: secondaryExpectedOwnerGeneration,
        title: secondaryTitle,
      },
      "create isolated connected-secondary conversation",
      rawLog,
    ),
    "Created isolated connected-secondary conversation",
  );
  const secondaryConversationId = requireUuid(
    secondaryConversation.conversationId,
    "Created secondary conversation id",
  );
  const secondaryOwnerId = requireString(
    secondaryConversation.ownerId,
    "Created secondary conversation owner",
    512,
  );
  assert(
    secondaryOwnerId === secondaryAuthority.tokenIdentity.tokenIdentifier &&
      secondaryConversation.title === secondaryTitle,
    "Secondary conversation is not fenced to the exact isolated connected owner.",
  );
  const secondaryOwner = await ownerLookup(
    context,
    secondarySecrets,
    secondaryConversationId,
    rawLog,
  );
  assert(
    secondaryOwner.ownerId === secondaryOwnerId,
    "Worker secondary-owner lookup disagrees with the isolated connected session.",
  );
  const secondaryCanary = `Connected secondary rendered isolation canary ${context.runId}.`;
  const secondaryCanaryAdmission = requireRecord(
    await convexCall(
      context,
      secondarySecrets,
      "mutation",
      "cloud_apps:startCloudChat",
      {
        conversationId: secondaryConversationId,
        expectedOwnerGeneration: secondaryOwner.ownerGeneration,
        prompt: secondaryCanary,
        clientMsgId: `secondary-canary-${context.runId}`,
      },
      "append isolated connected-secondary canary",
      rawLog,
    ),
    "Connected-secondary canary admission",
  );
  const secondaryCanaryTurnId = requireUuid(
    secondaryCanaryAdmission.turnId,
    "Connected-secondary canary turn id",
  );
  const secondaryCanaryJournal = await waitForTurnTerminal(
    context,
    secondarySecrets,
    secondaryConversationId,
    secondaryCanaryTurnId,
    rawLog,
  );
  assert(
    terminalForTurn(secondaryCanaryJournal, secondaryCanaryTurnId).phase ===
      "completed" &&
      secondaryCanaryJournal.records.some(
        (record) =>
          record?.kind === "message" &&
          record.role === "user" &&
          messageText(record.payload) === secondaryCanary,
      ),
    "Connected-secondary canary did not reach one canonical completed turn.",
  );
  const [
    primaryOwnRead,
    primaryCrossRead,
    primaryList,
    secondaryOwnRead,
    secondaryCrossRead,
    secondaryList,
  ] = await Promise.all([
    convexCall(
      context,
      secrets,
      "query",
      "cloud_apps:getMyConversation",
      { conversationId: owner.conversationId },
      "primary own-conversation isolation read",
      rawLog,
    ),
    convexCall(
      context,
      secrets,
      "query",
      "cloud_apps:getMyConversation",
      { conversationId: secondaryConversationId },
      "primary cross-owner isolation read",
      rawLog,
    ),
    convexCall(
      context,
      secrets,
      "query",
      "cloud_apps:listMyConversations",
      {},
      "primary owner-isolated conversation list",
      rawLog,
    ),
    convexCall(
      context,
      secondarySecrets,
      "query",
      "cloud_apps:getMyConversation",
      { conversationId: secondaryConversationId },
      "secondary own-conversation isolation read",
      rawLog,
    ),
    convexCall(
      context,
      secondarySecrets,
      "query",
      "cloud_apps:getMyConversation",
      { conversationId: owner.conversationId },
      "secondary cross-owner isolation read",
      rawLog,
    ),
    convexCall(
      context,
      secondarySecrets,
      "query",
      "cloud_apps:listMyConversations",
      {},
      "secondary owner-isolated conversation list",
      rawLog,
    ),
  ]);
  const primaryListIds = Array.isArray(primaryList)
    ? primaryList.map((entry) => entry?.conversationId)
    : [];
  const secondaryListIds = Array.isArray(secondaryList)
    ? secondaryList.map((entry) => entry?.conversationId)
    : [];
  assert(
    primaryOwnRead?.conversationId === owner.conversationId &&
      primaryCrossRead === null &&
      primaryListIds.includes(owner.conversationId) &&
      !primaryListIds.includes(secondaryConversationId) &&
      secondaryOwnRead?.conversationId === secondaryConversationId &&
      secondaryCrossRead === null &&
      secondaryListIds.includes(secondaryConversationId) &&
      !secondaryListIds.includes(owner.conversationId),
    "Ordinary Convex conversation APIs did not enforce four-way A/B owner isolation.",
  );
  await checkpoint({
    secondaryElectron,
    secondary: {
      ...preparedSecondary,
      conversationId: secondaryConversationId,
      ownerId: secondaryOwnerId,
      ownerIdSha256: sha256(secondaryOwnerId),
      ownerGeneration: secondaryOwner.ownerGeneration,
      title: secondaryTitle,
      identityClass: "connected-secondary",
      sessionSubjectSha256: secondaryAuthority.identitySha256,
      sessionIdSha256: secondaryAuthority.sessionIdSha256,
      canarySha256: sha256(secondaryCanary),
      canaryTurnIdSha256: sha256(secondaryCanaryTurnId),
    },
    secondaryCleanupOwnerHint: {
      ownerIdSha256: sha256(secondaryOwnerId),
    },
  });

  const initial = await electronLocalTurn(
    electron,
    owner.conversationId,
    "Acceptance lifecycle: use one harmless read-only local tool, spawn exactly one child that reports a short result, then reply with LOCAL-LIFECYCLE-COMPLETE.",
    `local-initial-${context.runId}`,
    rawLog,
  );
  const continuation = await electronLocalTurn(
    electron,
    owner.conversationId,
    "Continue the same local conversation and reply with LOCAL-CONTINUATION-COMPLETE.",
    `local-continuation-${context.runId}`,
    rawLog,
  );
  const interrupted = await electronLocalTurn(
    electron,
    owner.conversationId,
    "Begin a long multi-step local analysis and do not finish immediately.",
    `local-interrupted-${context.runId}`,
    rawLog,
    { cancel: true },
  );
  const completedLifecycle = providerLifecycleFromEvents(
    initial.events,
    "completed",
    "Completed provider lifecycle",
  );
  const interruptedLifecycle = providerLifecycleFromEvents(
    interrupted.events,
    "canceled",
    "Interrupted provider lifecycle",
  );
  const completedRawRequestIdExposed = assertNoRawProviderRequestId(
    initial.events,
    "Completed provider lifecycle",
  );
  const interruptedRawRequestIdExposed = assertNoRawProviderRequestId(
    interrupted.events,
    "Interrupted provider lifecycle",
  );
  assert(
    completedLifecycle.requestIdSha256 !== interruptedLifecycle.requestIdSha256,
    "Completed and interrupted local provider requests reused an identity.",
  );
  const toolStarts = initial.events.filter(
    (event) => event?.type === "tool-start",
  );
  const toolEnds = initial.events.filter((event) => event?.type === "tool-end");
  assert(
    toolStarts.length > 0 && toolEnds.length > 0,
    "Local lifecycle did not execute a real tool.",
  );
  const toolStart = toolStarts.find((entry) =>
    toolEnds.some((end) => end.toolCallId === entry.toolCallId),
  );
  assert(toolStart, "Local lifecycle tool did not return a result.");
  const toolEnd = toolEnds.find(
    (entry) => entry.toolCallId === toolStart.toolCallId,
  );
  const childCompleted = initial.events.find(
    (event) => event?.type === "agent-completed",
  );
  assert(childCompleted, "Local lifecycle child did not complete.");
  assert(
    !initial.events.some((event) =>
      /sandbox/iu.test(String(event?.toolName ?? event?.statusText ?? "")),
    ),
    "Local lifecycle unexpectedly started a cloud sandbox.",
  );
  const beforeRestart = await localHistorySnapshot(
    electron,
    owner.conversationId,
    rawLog,
  );
  const processIdBefore = electron.pid;
  await stopProcess(processIdBefore, "electron.primary", rawLog, {
    expectedProcessFingerprintSha256: electron.processFingerprintSha256,
  });
  electron = await launchElectron(
    context,
    secrets,
    paths,
    "primary",
    vite,
    rawLog,
  );
  await checkpoint({ electron });
  await configureElectronSession(
    context,
    secrets,
    electron,
    owner.conversationId,
    rawLog,
  );
  const afterRestart = await localHistorySnapshot(
    electron,
    owner.conversationId,
    rawLog,
  );
  assert(
    beforeRestart.digest === afterRestart.digest,
    "Local history changed across Electron/runtime restart.",
  );

  const observations = {
    localConversationId: owner.conversationId,
    initialTurnId: initial.runId,
    continuationTurnId: continuation.runId,
    childTurnId: requireString(childCompleted.agentId, "Local child id", 256),
    providerRequestIdSha256: completedLifecycle.requestIdSha256,
    assistantMessageEventCount: initial.events.filter(
      (event) => event?.type === "assistant-message",
    ).length,
    providerLifecyclePhases: completedLifecycle.phases,
    providerPhysicalAttempt: completedLifecycle.physicalAttempt,
    providerStreamOrdinal: completedLifecycle.streamOrdinal,
    providerOutcome: "completed",
    providerRawRequestIdExposed: completedRawRequestIdExposed,
    toolCallId: requireString(toolStart.toolCallId, "Local tool call id", 256),
    toolDispatchCount: toolStarts.length,
    toolResultSha256: sha256(canonicalJson(toolEnd)),
    childCompletionObserved: true,
    interruptionRequested: true,
    interruptedProviderStopped: true,
    interruptedProviderRequestIdSha256: interruptedLifecycle.requestIdSha256,
    interruptedProviderLifecyclePhases: interruptedLifecycle.phases,
    interruptedProviderPhysicalAttempt: interruptedLifecycle.physicalAttempt,
    interruptedProviderStreamOrdinal: interruptedLifecycle.streamOrdinal,
    interruptedProviderOutcome: "canceled",
    interruptedProviderRawRequestIdExposed: interruptedRawRequestIdExposed,
    interruptedProviderStoppedAfterJoin: true,
    continuationObserved: continuation.terminal.outcome === "completed",
    persistenceObserved: true,
    processRestarted: true,
    processIdBefore,
    processIdAfter: electron.pid,
    historySha256BeforeRestart: beforeRestart.digest,
    historySha256AfterRestart: afterRestart.digest,
    profileDir: electron.root,
    cloudSandboxStarted: false,
    secondaryProfileDir: secondaryElectron.root,
    secondaryJwtSubjectSha256: sha256(secondaryAuthority.tokenIdentity.subject),
    secondaryJwtTokenIdentifierSha256: sha256(
      secondaryAuthority.tokenIdentity.tokenIdentifier,
    ),
    secondaryOwnerGenerationSha256: sha256(secondaryOwner.ownerGeneration),
    secondaryConversationIdSha256: sha256(secondaryConversationId),
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
  };
  return {
    observations,
    patch: {
      electron,
      local: {
        conversationId: owner.conversationId,
        initialTurnId: initial.runId,
        continuationTurnId: continuation.runId,
        childTurnId: childCompleted.agentId,
        historySha256: afterRestart.digest,
        profileDir: electron.root,
        initialClientRequestId: `local-initial-${context.runId}`,
        initialProviderLifecycleSha256: sha256(
          canonicalJson(
            initial.events.filter(
              (event) => event?.type === "provider-lifecycle",
            ),
          ),
        ),
      },
    },
  };
};

const exactRenderedTurnForPrompt = (journal, prompt, label) => {
  const prompts = journal.records.filter(
    (record) =>
      record?.kind === "message" &&
      record.role === "user" &&
      messageText(record.payload) === prompt,
  );
  assert(prompts.length === 1, `${label} did not append exactly one prompt.`);
  const promptRow = prompts[0];
  const turnId = requireUuid(promptRow.turnId, `${label} turn id`);
  const terminals = journal.records.filter(
    (record) =>
      record?.kind === "turn" &&
      record.turnId === turnId &&
      ["completed", "failed", "canceled", "timeout"].includes(record.phase),
  );
  assert(
    terminals.length === 1,
    `${label} did not append exactly one terminal.`,
  );
  return Object.freeze({ promptRow, terminal: terminals[0], turnId });
};

const exerciseRenderedConversationCore = async ({
  context,
  secrets,
  owner,
  client,
  processIdentity,
  surface,
  expectedIdentitySha256,
  prompt,
  label,
  rawLog,
}) => {
  const identity = await refreshRenderedClientIdentity(client);
  assert(
    identity.authenticated === true &&
      identity.anonymous === false &&
      identity.identitySha256 === expectedIdentitySha256,
    `${label} is not mounted under the exact primary authority.`,
  );
  const list = await listRenderedConversations(client);
  const selected = await selectRenderedConversation(client, {
    conversationId: owner.conversationId,
  });
  const listOpenObservation = Object.freeze({
    identitySha256: identity.identitySha256,
    identityRevision: requireInteger(
      identity.identityRevision,
      `${label} identity revision`,
      0,
    ),
    conversationIdSha256: sha256(owner.conversationId),
    list,
    selectedStateSha256: sha256(canonicalJson(selected)),
    selectedConversationMatched:
      selected.conversationIdSha256 === sha256(owner.conversationId),
  });
  const entries = [
    renderedProofEntry({
      surface,
      operation: "rendered.list-open",
      processIdentity,
      observation: listOpenObservation,
      rawLog,
    }),
  ];

  const baseline = await snapshotRenderedConversation(client);
  const submission = await sendRenderedPrompt(client, { prompt });
  const streaming = await waitForRenderedStreaming(client, baseline, {
    ...submission,
    timeoutMs: 120_000,
  });
  const terminalView = await waitForRenderedTerminal(client, baseline, {
    ...submission,
    timeoutMs: DEFAULT_TURN_TIMEOUT_MS,
  });
  const terminalProjection = await snapshotFullRenderedConversation(client, {
    timeoutMs: 120_000,
  });
  const journal = await loadWholeJournal(
    context,
    secrets,
    owner.conversationId,
    rawLog,
  );
  const renderedTurn = exactRenderedTurnForPrompt(
    journal,
    prompt,
    `${label} rendered send`,
  );
  assert(
    renderedTurn.terminal.phase === "completed",
    `${label} rendered send did not complete.`,
  );
  const sendObservation = Object.freeze({
    promptSha256: sha256(prompt.trim()),
    submission,
    streamingStateSha256: sha256(canonicalJson(streaming)),
    terminalStateSha256: sha256(canonicalJson(terminalView)),
    terminalProjectionSha256: terminalProjection.rowsSha256,
    terminalProjectionStateSha256: sha256(canonicalJson(terminalProjection)),
    turnIdSha256: sha256(renderedTurn.turnId),
    promptSeq: requireInteger(
      renderedTurn.promptRow.seq,
      `${label} rendered prompt sequence`,
      0,
    ),
    terminalSeq: requireInteger(
      renderedTurn.terminal.seq,
      `${label} rendered terminal sequence`,
      renderedTurn.promptRow.seq + 1,
    ),
    terminalKind: "completed",
    localFallbackCount: 0,
  });
  entries.push(
    renderedProofEntry({
      surface,
      operation: "rendered.send-terminal",
      processIdentity,
      observation: sendObservation,
      rawLog,
    }),
  );

  const failurePrompt = `${label} rendered fail-closed ${context.runId}`;
  const faultArm = await acceptanceProbe(
    context,
    secrets,
    owner,
    owner.conversationId,
    "arm_fault",
    rawLog,
    "canonical_prompt",
  );
  const failureBaseline = await snapshotRenderedConversation(client);
  const failureBaselineProjection = await snapshotFullRenderedConversation(
    client,
    { timeoutMs: 120_000 },
  );
  const failedSubmission = await sendRenderedPrompt(client, {
    prompt: failurePrompt,
  });
  const failedView = await waitForRenderedFailClosed(client, failureBaseline, {
    ...failedSubmission,
    timeoutMs: 120_000,
  });
  const failedProjection = await snapshotFullRenderedConversation(client, {
    timeoutMs: 120_000,
  });
  const failureJournal = await loadWholeJournal(
    context,
    secrets,
    owner.conversationId,
    rawLog,
  );
  const failedTurn = exactRenderedTurnForPrompt(
    failureJournal,
    failurePrompt,
    `${label} rendered failure`,
  );
  assert(
    failedTurn.terminal.phase === "failed",
    `${label} rendered failure did not fail canonically.`,
  );
  const faultStatus = await acceptanceProbe(
    context,
    secrets,
    owner,
    owner.conversationId,
    "status",
    rawLog,
  );
  const newAssistantRows = failedView.assistantRows.filter(
    (row) => !failureBaselineProjection.rowIdHashes.includes(row.idSha256),
  );
  assert(
    newAssistantRows.length === 0 &&
      failedView.streamingRowCount === 0 &&
      failedView.activeWorkingIndicatorCount === 0 &&
      failedView.composerBusy === false &&
      faultStatus.providerDispatchCount === faultArm.providerDispatchCount,
    `${label} visible failure fell back locally or dispatched a provider.`,
  );
  const failClosedObservation = Object.freeze({
    promptSha256: sha256(failurePrompt),
    submission: failedSubmission,
    beforeProjectionSha256: failureBaselineProjection.rowsSha256,
    afterProjectionSha256: failedProjection.rowsSha256,
    failedViewSha256: sha256(canonicalJson(failedView)),
    turnIdSha256: sha256(failedTurn.turnId),
    terminalKind: "failed",
    visibleAlertDelta:
      failedView.visibleAlertCount - failureBaseline.visibleAlertCount,
    newAssistantRowCount: newAssistantRows.length,
    providerDispatchCountBefore: faultArm.providerDispatchCount,
    providerDispatchCountAfter: faultStatus.providerDispatchCount,
    localFallbackCount: 0,
  });
  entries.push(
    renderedProofEntry({
      surface,
      operation: "rendered.fail-closed",
      processIdentity,
      observation: failClosedObservation,
      rawLog,
    }),
  );

  const resumePrompt = `${label} mounted resume ${context.runId}`;
  const mountedResume = await exerciseMountedTransportResume(client, {
    timeoutMs: 120_000,
    whileOffline: async () => {
      const receipt = requireRecord(
        await convexCall(
          context,
          secrets,
          "mutation",
          "cloud_apps:startCloudChat",
          {
            conversationId: owner.conversationId,
            expectedOwnerGeneration: owner.ownerGeneration,
            prompt: resumePrompt,
            clientMsgId: `rendered-resume-${surface}-${context.runId}`,
          },
          `${label} offline canonical append`,
          rawLog,
        ),
        `${label} offline canonical append receipt`,
      );
      const resumedJournal = await waitForTurnTerminal(
        context,
        secrets,
        owner.conversationId,
        requireUuid(receipt.turnId, `${label} offline turn id`),
        rawLog,
      );
      assert(
        terminalForTurn(resumedJournal, receipt.turnId).phase === "completed",
        `${label} offline canonical append did not complete.`,
      );
      return { expectedUserTextHashes: [sha256(resumePrompt)] };
    },
  });
  entries.push(
    renderedProofEntry({
      surface,
      operation: "rendered.mounted-resume",
      processIdentity,
      observation: mountedResume,
      rawLog,
    }),
  );

  const sameTargetReload = await exerciseRenderedTabReload(client, {
    conversationId: owner.conversationId,
    timeoutMs: 120_000,
  });
  entries.push(
    renderedProofEntry({
      surface,
      operation: "rendered.same-target-reload",
      processIdentity,
      observation: sameTargetReload,
      rawLog,
    }),
  );
  const finalProjection = await snapshotFullRenderedConversation(client, {
    timeoutMs: 120_000,
  });
  return Object.freeze({
    identity,
    entries,
    listOpenObservation,
    sendObservation,
    failClosedObservation,
    mountedResume,
    sameTargetReload,
    finalProjection,
    turnId: renderedTurn.turnId,
    promptRow: renderedTurn.promptRow,
    terminal: renderedTurn.terminal,
  });
};

const stepElectronRealStream = async ({ context, secrets, state, rawLog }) => {
  const owner = await recoverOwnerIdentity(context, secrets, state, rawLog);
  const electron = currentElectron(state);
  await configureElectronSession(
    context,
    secrets,
    electron,
    owner.conversationId,
    rawLog,
  );
  const marker = `PRIMARY-${context.runId}`;
  const prompt = `Real Electron acceptance turn. Remember this marker for the next turn and reply naturally: ${marker}`;
  const client = await connectElectronRenderedClient(electron);
  let rendered;
  try {
    rendered = await exerciseRenderedConversationCore({
      context,
      secrets,
      owner,
      client,
      processIdentity: electron.processIdentity,
      surface: "electron-cdp",
      expectedIdentitySha256: requireSha256(
        state.deployment?.jwtSubjectSha256,
        "Primary rendered identity hash",
      ),
      prompt,
      label: "electron",
      rawLog,
    });
  } finally {
    client.close();
  }
  const journal = await waitForTurnTerminal(
    context,
    secrets,
    owner.conversationId,
    rendered.turnId,
    rawLog,
  );
  const terminal = terminalForTurn(journal, rendered.turnId);
  assert(
    terminal.phase === "completed",
    "Primary Electron cloud turn did not complete.",
  );
  const finalText = assistantTextForTurn(journal, rendered.turnId);
  assert(
    finalText.trim(),
    "Primary Electron turn has no durable assistant text.",
  );
  const probe = await acceptanceProbe(
    context,
    secrets,
    owner,
    owner.conversationId,
    "status",
    rawLog,
  );
  assert(
    probe.durableObjectIdSha256 === state.primary.durableObjectIdSha256,
    "Primary conversation resolved to another Durable Object.",
  );
  const observations = {
    conversationId: owner.conversationId,
    durableObjectIdSha256: probe.durableObjectIdSha256,
    journalEpoch: String(journal.head.epoch),
    turnId: rendered.turnId,
    liveEventCount: 2,
    journalHeadSeq: journal.head.headSeq,
    finalTextSha256: sha256(finalText),
    profileDir: electron.root,
    harnessAppNameSha256: requireSha256(
      electron.harnessAppNameSha256,
      "Electron harness app-name hash",
    ),
    harnessAppNameProfileBound:
      electron.harnessAppName ===
      `Stella v2 Harness ${sha256(realpathSync(electron.userData)).slice(0, 12)}`,
    renderedProofs: rendered.entries,
    renderedProofSetSha256: renderedProofSetSha256(rendered.entries),
    renderedCanonicalRowsSha256: rendered.finalProjection.rowsSha256,
    renderedProcessInstanceSha256:
      electron.processIdentity.processInstanceSha256,
    doObserved: true,
  };
  return {
    observations,
    patch: {
      primary: {
        ...state.primary,
        firstTurnId: rendered.turnId,
        firstClientMsgId: requireString(
          rendered.promptRow.clientMsgId,
          "Rendered primary client message id",
          256,
        ),
        firstHeadSeq: journal.head.headSeq,
        journalEpoch: String(journal.head.epoch),
        firstFinalTextSha256: sha256(finalText),
        markerSha256: sha256(marker),
      },
      renderedElectron: {
        processIdentity: electron.processIdentity,
        targetIdSha256: rendered.sameTargetReload.targetIdSha256,
        identitySha256: rendered.identity.identitySha256,
        projectionSha256: rendered.finalProjection.rowsSha256,
        accountACanarySha256: sha256(prompt.trim()),
        proofSetSha256: renderedProofSetSha256(rendered.entries),
      },
    },
  };
};

const secondTurnInputs = (context) => ({
  marker: `PRIMARY-${context.runId}`,
  memoryMarker: `ACCEPTANCE-MEMORY-${context.runId}`,
  clientMsgId: `second-${context.runId}`,
  prompt: `Continue the same canonical conversation. State the exact marker from the preceding turn (${`PRIMARY-${context.runId}`}). Then use Remember exactly once with action add to persist this durable fact verbatim: "The user's cloud acceptance memory marker is ACCEPTANCE-MEMORY-${context.runId}." Only after the Remember tool reports success, reply with SECOND-TURN-COMPLETE and the memory marker.`,
});

const stepConsecutiveDurableTurns = async ({
  context,
  secrets,
  state,
  rawLog,
}) => {
  const owner = await recoverOwnerIdentity(context, secrets, state, rawLog);
  const electron = currentElectron(state);
  const before = await loadWholeJournal(
    context,
    secrets,
    owner.conversationId,
    rawLog,
  );
  assert(
    before.head.headSeq === state.primary.firstHeadSeq,
    "Primary journal advanced before the second-turn step.",
  );
  const inputs = secondTurnInputs(context);
  const result = await electronCloudTurn(
    context,
    electron,
    state.identity,
    owner.conversationId,
    { prompt: inputs.prompt, clientMsgId: inputs.clientMsgId },
    rawLog,
  );
  const after = await waitForTurnTerminal(
    context,
    secrets,
    owner.conversationId,
    result.turnId,
    rawLog,
  );
  const terminal = terminalForTurn(after, result.turnId);
  assert(
    terminal.phase === "completed",
    "Second durable turn did not complete.",
  );
  const text = assistantTextForTurn(after, result.turnId);
  assert(
    text.includes(inputs.marker),
    "Second turn did not observe the first-turn marker.",
  );
  const rows = recordsForTurn(after, result.turnId);
  const prompt = rows.find(
    (record) => record?.kind === "message" && record.role === "user",
  );
  assert(prompt, "Second turn omitted its canonical prompt row.");
  const rememberReceipts = matchedToolReceipts(rows, "Remember");
  assert(
    rememberReceipts.length === 1 &&
      canonicalJson(rememberReceipts[0].block).includes(inputs.memoryMarker) &&
      canonicalJson(rememberReceipts[0].result.payload).includes("Remembered."),
    "Second turn did not durably record exactly one real Remember call and successful matched tool receipt.",
  );
  const rememberResult = rememberReceipts[0].result;
  const observations = {
    conversationId: owner.conversationId,
    durableObjectIdSha256: state.primary.durableObjectIdSha256,
    journalEpoch: state.primary.journalEpoch,
    firstTurnId: state.primary.firstTurnId,
    secondTurnId: result.turnId,
    firstTurnRecordCount: recordsForTurn(after, state.primary.firstTurnId)
      .length,
    secondTurnRecordCount: rows.length,
    journalHeadSeqBeforeSecond: before.head.headSeq,
    secondPromptSeq: prompt.seq,
    secondTerminalSeq: terminal.seq,
    journalHeadSeqAfterSecond: after.head.headSeq,
    secondTurnObservedFirst: true,
    secondResponseSha256: sha256(text),
    historySha256: after.historySha256,
  };
  return {
    observations,
    patch: {
      primary: {
        ...state.primary,
        secondTurnId: result.turnId,
        secondClientMsgId: inputs.clientMsgId,
        secondReceiptSha256: sha256(canonicalJson(result.receipt)),
        secondHeadSeq: after.head.headSeq,
        secondPromptSeq: prompt.seq,
        secondTerminalSeq: terminal.seq,
        historySha256: after.historySha256,
        memoryMarker: inputs.memoryMarker,
        memoryMarkerSha256: sha256(inputs.memoryMarker),
        memoryRememberReceiptSha256: sha256(canonicalJson(rememberResult)),
      },
    },
  };
};

const stepDuplicateDelivery = async ({ context, secrets, state, rawLog }) => {
  const owner = await recoverOwnerIdentity(context, secrets, state, rawLog);
  const before = await loadWholeJournal(
    context,
    secrets,
    owner.conversationId,
    rawLog,
  );
  const inputs = secondTurnInputs(context);
  const replay = requireRecord(
    await convexCall(
      context,
      secrets,
      "mutation",
      "cloud_apps:startCloudChat",
      {
        conversationId: owner.conversationId,
        expectedOwnerGeneration: owner.ownerGeneration,
        prompt: inputs.prompt,
        clientMsgId: inputs.clientMsgId,
      },
      "replay exact second cloud delivery",
      rawLog,
    ),
    "Duplicate delivery receipt",
  );
  assert(
    replay.turnId === state.primary.secondTurnId,
    "Duplicate delivery created another turn.",
  );
  const after = await loadWholeJournal(
    context,
    secrets,
    owner.conversationId,
    rawLog,
  );
  assert(
    before.head.headSeq === after.head.headSeq,
    "Duplicate delivery advanced the journal.",
  );
  assert(
    before.records.length === after.records.length,
    "Duplicate delivery changed journal rows.",
  );
  const rows = recordsForTurn(after, state.primary.secondTurnId);
  const prompts = rows.filter(
    (record) => record?.kind === "message" && record.role === "user",
  );
  const terminals = rows.filter(
    (record) =>
      record?.kind === "turn" &&
      ["completed", "failed", "canceled", "timeout"].includes(record.phase),
  );
  assert(
    prompts.length === 1 && terminals.length === 1,
    "Duplicate delivery changed prompt/terminal cardinality.",
  );
  const receiptSha256 = sha256(canonicalJson(replay));
  assert(
    receiptSha256 === state.primary.secondReceiptSha256,
    "Duplicate delivery did not return the exact receipt.",
  );
  const observations = {
    conversationId: owner.conversationId,
    durableObjectIdSha256: state.primary.durableObjectIdSha256,
    journalEpoch: state.primary.journalEpoch,
    turnId: state.primary.secondTurnId,
    clientMsgIdSha256: sha256(inputs.clientMsgId),
    deliveryFingerprintSha256: sha256(
      canonicalJson({
        conversationId: owner.conversationId,
        turnId: state.primary.secondTurnId,
        clientMsgId: inputs.clientMsgId,
        promptSeq: state.primary.secondPromptSeq,
        terminalSeq: state.primary.secondTerminalSeq,
      }),
    ),
    firstReceiptSha256: state.primary.secondReceiptSha256,
    replayReceiptSha256: receiptSha256,
    journalHeadSeqBeforeReplay: before.head.headSeq,
    journalHeadSeqAfterReplay: after.head.headSeq,
    journalRowCountBeforeReplay: before.records.length,
    journalRowCountAfterReplay: after.records.length,
    promptRecordCount: prompts.length,
    terminalRecordCount: terminals.length,
    terminalKind: terminals[0].phase,
    receiptReplayed: true,
    duplicateAppendPrevented: true,
  };
  return {
    observations,
    patch: {
      primary: { ...state.primary, duplicateHeadSeq: after.head.headSeq },
    },
  };
};

const stepElectronRestartReconnect = async ({
  context,
  secrets,
  paths,
  state,
  rawLog,
  checkpoint,
}) => {
  const owner = await recoverOwnerIdentity(context, secrets, state, rawLog);
  const previous = currentElectron(state);
  const secondary = requireRecord(
    state.secondary,
    "Connected-secondary identity state",
  );
  const secondaryConversationId = requireUuid(
    secondary.conversationId,
    "Connected-secondary conversation id",
  );
  const primaryExpectedAuthority = requireRecord(
    state.authHandoff?.surfaces?.primary?.authorityReceipt,
    "Prepared primary authority receipt",
  );
  const before = await loadWholeJournal(
    context,
    secrets,
    owner.conversationId,
    rawLog,
  );
  const previousClient = await connectElectronRenderedClient(previous);
  let previousProjection;
  let previousIdentity;
  const previousTargetIdSha256 = requireSha256(
    previousClient.targetIdSha256,
    "Prior Electron target hash",
  );
  try {
    previousIdentity = await verifyExistingPrimaryElectronProfile(
      previousClient,
      {
        convexUrl: context.target.convexUrl,
        convexSiteUrl: context.target.convexSiteUrl,
        expectedIdentitySha256: requireSha256(
          primaryExpectedAuthority.identitySha256,
          "Prepared primary identity hash",
        ),
        expectedSessionIdSha256: requireSha256(
          primaryExpectedAuthority.sessionIdSha256,
          "Prepared primary session hash",
        ),
        expectedOwnerAccountSha256: requireSha256(
          primaryExpectedAuthority.ownerAccountSha256,
          "Prepared primary owner hash",
        ),
      },
    );
    assert(
      previousIdentity.authenticated === true &&
        previousIdentity.anonymous === false &&
        previousIdentity.identitySha256 === state.deployment.jwtSubjectSha256,
      "Prior Electron process is not the exact primary authority.",
    );
    await selectRenderedConversation(previousClient, {
      conversationId: owner.conversationId,
    });
    previousProjection = await snapshotFullRenderedConversation(
      previousClient,
      { timeoutMs: 120_000 },
    );
  } finally {
    previousClient.close();
  }

  const secondaryBeforeProcess = currentSecondaryElectron(state);
  await configureElectronSession(
    context,
    secrets,
    secondaryBeforeProcess,
    secondaryConversationId,
    rawLog,
  );
  const secondaryBeforeClient = await connectElectronRenderedClient(
    secondaryBeforeProcess,
  );
  let secondaryBefore;
  try {
    const authority = await verifyExistingPrimaryElectronProfile(
      secondaryBeforeClient,
      {
        convexUrl: context.target.convexUrl,
        convexSiteUrl: context.target.convexSiteUrl,
        expectedIdentitySha256: secondary.sessionSubjectSha256,
        expectedSessionIdSha256: requireSha256(
          secondary.sessionIdSha256,
          "Connected-secondary session hash",
        ),
        expectedOwnerAccountSha256: requireSha256(
          secondary.ownerIdSha256,
          "Connected-secondary owner hash",
        ),
      },
    );
    await selectRenderedConversation(secondaryBeforeClient, {
      conversationId: secondaryConversationId,
      timeoutMs: 120_000,
    });
    const view = await snapshotFullRenderedConversation(secondaryBeforeClient, {
      timeoutMs: 120_000,
    });
    secondaryBefore = Object.freeze({
      authority,
      processIdentity: secondaryBeforeProcess.processIdentity,
      targetIdSha256: requireSha256(
        secondaryBeforeClient.targetIdSha256,
        "Connected-secondary prior target hash",
      ),
      view,
    });
  } finally {
    secondaryBeforeClient.close();
  }
  const secondaryStopReceipt = await stopRenderedElectron(
    secondaryBeforeProcess,
    "electron.secondary",
    rawLog,
  );
  const secondaryAfterProcess = await relaunchElectron(
    context,
    secrets,
    paths,
    state,
    "secondary",
    rawLog,
  );
  await checkpoint({ secondaryElectron: secondaryAfterProcess });
  const secondaryAfterClient = await connectElectronRenderedClient(
    secondaryAfterProcess,
  );
  let secondaryAfter;
  try {
    const authority = await verifyExistingPrimaryElectronProfile(
      secondaryAfterClient,
      {
        convexUrl: context.target.convexUrl,
        convexSiteUrl: context.target.convexSiteUrl,
        expectedIdentitySha256: secondary.sessionSubjectSha256,
        expectedSessionIdSha256: secondary.sessionIdSha256,
        expectedOwnerAccountSha256: secondary.ownerIdSha256,
      },
    );
    await configureElectronSession(
      context,
      secrets,
      secondaryAfterProcess,
      secondaryConversationId,
      rawLog,
    );
    await selectRenderedConversation(secondaryAfterClient, {
      conversationId: secondaryConversationId,
      timeoutMs: 120_000,
    });
    const view = await snapshotFullRenderedConversation(secondaryAfterClient, {
      timeoutMs: 120_000,
    });
    secondaryAfter = Object.freeze({
      authority,
      processIdentity: secondaryAfterProcess.processIdentity,
      targetIdSha256: requireSha256(
        secondaryAfterClient.targetIdSha256,
        "Connected-secondary relaunched target hash",
      ),
      view,
    });
  } finally {
    secondaryAfterClient.close();
  }

  const primaryAfterClient = await connectElectronRenderedClient(previous);
  let primaryAfter;
  try {
    const authority = await verifyExistingPrimaryElectronProfile(
      primaryAfterClient,
      {
        convexUrl: context.target.convexUrl,
        convexSiteUrl: context.target.convexSiteUrl,
        expectedIdentitySha256: previousIdentity.identitySha256,
        expectedSessionIdSha256: previousIdentity.sessionIdSha256,
        expectedOwnerAccountSha256: previousIdentity.ownerAccountSha256,
      },
    );
    await selectRenderedConversation(primaryAfterClient, {
      conversationId: owner.conversationId,
      timeoutMs: 120_000,
    });
    const view = await snapshotFullRenderedConversation(primaryAfterClient, {
      timeoutMs: 120_000,
    });
    primaryAfter = Object.freeze({
      authority,
      processIdentity: previous.processIdentity,
      targetIdSha256: requireSha256(
        primaryAfterClient.targetIdSha256,
        "Primary post-secondary target hash",
      ),
      view,
    });
  } finally {
    primaryAfterClient.close();
  }
  const identityRoundTrip = composeRenderedCrossProcessIdentityRoundTrip({
    primaryBefore: {
      authority: previousIdentity,
      processIdentity: previous.processIdentity,
      targetIdSha256: previousTargetIdSha256,
      view: previousProjection,
    },
    secondaryBefore,
    secondaryStopReceipt,
    secondaryAfter,
    primaryAfter,
    accountACanarySha256: requireSha256(
      state.renderedElectron?.accountACanarySha256,
      "Primary rendered identity canary",
    ),
    accountBCanarySha256: requireSha256(
      secondary.canarySha256,
      "Connected-secondary rendered identity canary",
    ),
  });
  const identityProof = renderedProofEntry({
    surface: "electron-cdp",
    operation: "rendered.identity-round-trip",
    processIdentity: previous.processIdentity,
    observation: identityRoundTrip,
    rawLog,
  });
  const previousStopReceipt = await stopRenderedElectron(
    previous,
    "electron.primary",
    rawLog,
  );
  const electron = await relaunchElectron(
    context,
    secrets,
    paths,
    state,
    "primary",
    rawLog,
  );
  const currentClient = await connectElectronRenderedClient(electron);
  let coldHydration;
  let coldProof;
  try {
    coldHydration = await verifyRenderedColdProcessHydration(currentClient, {
      conversationId: owner.conversationId,
      expectedProjectionSha256: previousProjection.rowsSha256,
      previousProcessIdentity: previous.processIdentity,
      currentProcessIdentity: electron.processIdentity,
      previousStopReceipt,
      previousTargetIdSha256,
      expectedIdentitySha256: previousIdentity.identitySha256,
      timeoutMs: 120_000,
    });
    coldProof = renderedProofEntry({
      surface: "electron-cdp",
      operation: "rendered.cold-process",
      processIdentity: electron.processIdentity,
      observation: coldHydration,
      rawLog,
    });
  } finally {
    currentClient.close();
  }
  await configureElectronSession(
    context,
    secrets,
    electron,
    owner.conversationId,
    rawLog,
  );
  const hydrated = await electronHydrateConversation(
    context,
    electron,
    owner.conversationId,
    rawLog,
  );
  const after = await loadWholeJournal(
    context,
    secrets,
    owner.conversationId,
    rawLog,
  );
  assert(
    before.historySha256 === after.historySha256,
    "Canonical history changed across Electron restart.",
  );
  assert(
    before.head.headSeq === after.head.headSeq,
    "Journal head changed across reconnect.",
  );
  assert(
    hydrated.ready.epoch === before.head.epoch,
    "Electron reconnected to another journal epoch.",
  );
  const observations = {
    conversationId: owner.conversationId,
    durableObjectIdSha256: state.primary.durableObjectIdSha256,
    journalEpoch: state.primary.journalEpoch,
    processRestarted: previous.pid !== electron.pid,
    socketReconnected: true,
    historySha256Before: before.historySha256,
    historySha256After: after.historySha256,
    journalHeadSeqBefore: before.head.headSeq,
    journalHeadSeqAfter: after.head.headSeq,
    renderedProofs: [identityProof, coldProof],
    renderedProofSetSha256: renderedProofSetSha256([identityProof, coldProof]),
    previousProcessInstanceSha256:
      previous.processIdentity.processInstanceSha256,
    currentProcessInstanceSha256:
      electron.processIdentity.processInstanceSha256,
    previousStopReceiptSha256: sha256(canonicalJson(previousStopReceipt)),
    coldProjectionSha256: coldHydration.canonicalRowsSha256,
    identityRoundTripSha256: identityProof.receipt.receiptSha256,
    secondaryProcessBeforeSha256:
      secondaryBeforeProcess.processIdentity.processInstanceSha256,
    secondaryProcessAfterSha256:
      secondaryAfterProcess.processIdentity.processInstanceSha256,
  };
  return {
    observations,
    patch: {
      electron,
      secondaryElectron: secondaryAfterProcess,
      renderedElectron: {
        processIdentity: electron.processIdentity,
        targetIdSha256: coldHydration.currentTargetIdSha256,
        identitySha256: coldHydration.preservedIdentitySha256,
        projectionSha256: coldHydration.canonicalRowsSha256,
        coldProofSha256: coldProof.receipt.receiptSha256,
        accountACanarySha256: state.renderedElectron.accountACanarySha256,
        identityRoundTripSha256: identityProof.receipt.receiptSha256,
      },
    },
  };
};

const stepCleanClientHydration = async ({
  context,
  secrets,
  paths,
  state,
  rawLog,
}) => {
  const owner = await recoverOwnerIdentity(context, secrets, state, rawLog);
  const profileA = electronProfilePaths(paths, "primary").root;
  const preparedClean = currentAuthCleanElectron(state);
  requireBoolean(
    state.authHandoff?.cleanClientInitiallyEmpty,
    true,
    "Prepared clean-client conversation state",
  );
  requireSha256(
    state.authHandoff?.cleanClientInitialStateSha256,
    "Prepared clean-client initial state",
  );
  const previous = currentElectron(state);
  await stopProcess(previous.pid, `electron.${previous.profileName}`, rawLog, {
    expectedProcessFingerprintSha256: previous.processFingerprintSha256,
  });
  const electron = preparedClean;
  await configureElectronSession(
    context,
    secrets,
    electron,
    owner.conversationId,
    rawLog,
  );
  const listed = await convexCall(
    context,
    secrets,
    "query",
    "cloud_apps:listMyConversations",
    {},
    "discover primary conversation from Convex",
    rawLog,
  );
  assert(
    Array.isArray(listed) &&
      listed.some((entry) => entry?.conversationId === owner.conversationId),
    "Clean client did not discover the primary conversation through Convex.",
  );
  await electronHydrateConversation(
    context,
    electron,
    owner.conversationId,
    rawLog,
  );
  const journal = await loadWholeJournal(
    context,
    secrets,
    owner.conversationId,
    rawLog,
  );
  assert(
    journal.historySha256 === state.primary.historySha256,
    "Clean-client history differs from the second-turn history.",
  );
  const observations = {
    conversationId: owner.conversationId,
    profileA,
    profileB: electron.root,
    profileBInitiallyHadConversationState: false,
    profileBHadPreparedAuthOnly: true,
    profileBInitialStateSha256: state.authHandoff.cleanClientInitialStateSha256,
    discoveredFromConvex: true,
    hydratedFromCloud: true,
    historySha256: journal.historySha256,
  };
  return {
    observations,
    patch: {
      electron,
      cleanClient: {
        profileA,
        profileB: electron.root,
        historySha256: journal.historySha256,
      },
    },
  };
};

const selectCachePath = async (electron) => {
  const candidates = [
    path.join(electron.userData, "Cache"),
    path.join(electron.userData, "Default", "Cache"),
    path.join(electron.userData, "Code Cache"),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  throw new CloudProofError(
    "Disposable Electron profile contains no narrow cache directory.",
  );
};

const stepCacheLossRecovery = async ({
  context,
  secrets,
  paths,
  state,
  rawLog,
}) => {
  const owner = await recoverOwnerIdentity(context, secrets, state, rawLog);
  const previous = currentElectron(state);
  assert(
    previous.profileName === "clean-client",
    "Cache-loss step must use the clean-client profile.",
  );
  const before = await loadWholeJournal(
    context,
    secrets,
    owner.conversationId,
    rawLog,
  );
  const cachePath = await selectCachePath(previous);
  assertNarrowIsolatedPath(cachePath, paths.root, "Disposable Electron cache");
  await stopProcess(previous.pid, "electron.clean-client", rawLog, {
    expectedProcessFingerprintSha256: previous.processFingerprintSha256,
  });
  await rm(cachePath, { recursive: true, force: false });
  assert(
    !(await pathExists(cachePath)),
    "Disposable Electron cache was not removed.",
  );
  rawLog.push(
    rawReceipt("electron-cdp", "electron.cache.delete", {
      outcome: "deleted",
      resourceIdSha256: sha256(cachePath),
    }),
  );
  const electron = await relaunchElectron(
    context,
    secrets,
    paths,
    state,
    "clean-client",
    rawLog,
  );
  await configureElectronSession(
    context,
    secrets,
    electron,
    owner.conversationId,
    rawLog,
  );
  await electronHydrateConversation(
    context,
    electron,
    owner.conversationId,
    rawLog,
  );
  const after = await loadWholeJournal(
    context,
    secrets,
    owner.conversationId,
    rawLog,
  );
  assert(
    before.historySha256 === after.historySha256,
    "History changed after cache deletion.",
  );
  return {
    observations: {
      conversationId: owner.conversationId,
      cachePath,
      cacheDeleted: true,
      hydratedFromCloud: true,
      historySha256Before: before.historySha256,
      historySha256After: after.historySha256,
    },
    patch: { electron, cleanClient: { ...state.cleanClient, cachePath } },
  };
};

const extractR2Objects = (value, objects = []) => {
  if (Array.isArray(value)) {
    for (const entry of value) extractR2Objects(entry, objects);
    return objects;
  }
  if (!isRecord(value)) return objects;
  const key = value.key ?? value.objectKey ?? value.name;
  if (typeof key === "string") {
    const etag = value.etag ?? value.eTag ?? value.httpEtag;
    const size = value.size ?? value.bytes;
    if (typeof etag === "string" && Number.isSafeInteger(size) && size >= 0) {
      objects.push({ key, etag, size });
    }
  }
  for (const entry of Object.values(value)) extractR2Objects(entry, objects);
  return objects;
};

const r2ListObjects = async (secrets, bucket, prefix, rawLog) => {
  assert(
    secrets.cloudflareAccountId && secrets.cloudflareApiToken,
    "Cloudflare credentials are required for R2 inspection.",
  );
  const account = encodeURIComponent(secrets.cloudflareAccountId);
  const started = Date.now();
  const response = await requestJson(
    `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${encodeURIComponent(bucket)}/objects?prefix=${encodeURIComponent(prefix)}&per_page=1000`,
    {
      label: `R2 list ${bucket}`,
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      method: "GET",
      headers: { authorization: `Bearer ${secrets.cloudflareApiToken}` },
      maxResponseBytes: 4_000_000,
    },
  );
  const envelope = requireRecord(response.body, "R2 object listing");
  requireBoolean(envelope.success, true, "R2 object listing success");
  const objects = extractR2Objects(envelope.result).filter((entry) =>
    entry.key.startsWith(prefix),
  );
  rawLog.push(
    rawReceipt("r2", "r2.objects.list", {
      status: response.status,
      durationMs: Date.now() - started,
      objectKeySha256: sha256(prefix),
      responseSha256: sha256(canonicalJson(objects)),
      count: objects.length,
    }),
  );
  return objects;
};

const r2DeleteObject = async (secrets, bucket, key, rawLog) => {
  const account = encodeURIComponent(secrets.cloudflareAccountId ?? "");
  const started = Date.now();
  const response = await boundedFetchBytes(
    `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${encodeURIComponent(bucket)}/objects/${key.split("/").map(encodeURIComponent).join("/")}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${secrets.cloudflareApiToken}` },
    },
    "R2 object delete",
    256_000,
  );
  assert([200, 204].includes(response.status), "R2 object delete failed.", {
    status: response.status,
  });
  rawLog.push(
    rawReceipt("r2", "r2.object.delete", {
      status: response.status,
      durationMs: Date.now() - started,
      objectKeySha256: sha256(key),
    }),
  );
};

const verifyStaleProjectionFence = async (
  context,
  secrets,
  owner,
  journal,
  rawLog,
) => {
  assert(
    journal.head.headSeq > 0,
    "Projection fence needs a non-empty journal.",
  );
  const started = Date.now();
  const response = await requestJson(
    `${context.target.convexSiteUrl}/api/cloud/index`,
    {
      label: "stale projection fence",
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      method: "POST",
      headers: serviceHeaders(secrets),
      body: JSON.stringify({
        conversationId: owner.conversationId,
        ownerId: owner.ownerId,
        ownerGeneration: owner.ownerGeneration,
        epoch: journal.head.epoch,
        lastSeq: journal.head.headSeq - 1,
        updatedAt: Date.now() + 60_000,
        lastPreview: `stale-${sha256(owner.conversationId).slice(0, 16)}`,
        lastRole: "assistant",
        activity: "running",
      }),
    },
  );
  rawLog.push(
    requestReceipt("convex", "projection.stale.write", response, started),
  );
  const body = requireRecord(response.body, "Stale projection response");
  assert(
    body.accepted === false && body.reason === "stale",
    "Stale Convex projection was not rejected.",
  );
  assert(
    body.lastSeq === journal.head.headSeq,
    "Stale projection did not return the current fence.",
  );
  return true;
};

const stepProjectionAndR2 = async ({ context, secrets, state, rawLog }) => {
  const owner = await recoverOwnerIdentity(context, secrets, state, rawLog);
  let first = await loadWholeJournal(
    context,
    secrets,
    owner.conversationId,
    rawLog,
  );
  const initialWindowStartSeq = requireInteger(
    first.head.windowStartSeq,
    "Initial journal resident window start",
  );
  const rolloverDeadline = Date.now() + 8 * 60_000;
  const canceledTurnHash = createHash("sha256");
  let rolloverTurnCount = 0;
  let lastCanceledTurnId = null;
  while (
    first.head.windowStartSeq <= first.head.floorSeq &&
    rolloverTurnCount < 760 &&
    Date.now() < rolloverDeadline
  ) {
    const clientMsgId = `rollover:${context.runId}:${rolloverTurnCount}`;
    const receipt = requireRecord(
      await convexCall(
        context,
        secrets,
        "mutation",
        "cloud_apps:startCloudChat",
        {
          conversationId: owner.conversationId,
          expectedOwnerGeneration: owner.ownerGeneration,
          prompt: `Disposable real-product rollover record ${context.runId} ${rolloverTurnCount}.`,
          clientMsgId,
        },
        "enqueue real rollover turn",
        rawLog,
      ),
      "Rollover turn admission",
    );
    const turnId = requireUuid(receipt.turnId, "Rollover turn id");
    const canceled = requireRecord(
      (
        await workerRequest(
          context,
          secrets,
          `/conversations/${encodeURIComponent(owner.conversationId)}/cancel`,
          {
            method: "POST",
            body: JSON.stringify({
              turnId,
              cancelRequestId:
                `rollover-cancel:${context.runId}:${rolloverTurnCount}`.slice(
                  0,
                  128,
                ),
              ownerId: owner.ownerId,
              ownerGeneration: owner.ownerGeneration,
            }),
          },
          "conversation.rollover-turn.cancel",
          rawLog,
        )
      ).body,
      "Rollover cancellation receipt",
    );
    requireBoolean(canceled.canceled, true, "Rollover exact-turn cancellation");
    assert(
      canceled.turnId === turnId,
      "Rollover cancellation joined another turn.",
    );
    assert(
      canceled.joined === true ||
        (canceled.pending === true && canceled.durable === true),
      "Rollover cancellation was neither joined nor durably staged before provider admission.",
    );
    const terminal = await waitForTailTurnTerminal(
      context,
      secrets,
      owner.conversationId,
      turnId,
      rawLog,
    );
    assert(
      terminal.phase === "canceled",
      "Rollover traffic produced a non-canceled terminal.",
    );
    canceledTurnHash.update(`${turnId}\n`);
    lastCanceledTurnId = turnId;
    rolloverTurnCount += 1;
    if (rolloverTurnCount % 20 === 0) {
      first = await loadWholeJournal(
        context,
        secrets,
        owner.conversationId,
        rawLog,
      );
    }
  }
  first = await loadWholeJournal(
    context,
    secrets,
    owner.conversationId,
    rawLog,
  );
  assert(
    first.head.windowStartSeq > first.head.floorSeq &&
      first.head.windowStartSeq > initialWindowStartSeq,
    "Bounded real prompt/cancel traffic did not cross the production canonical rollover threshold.",
    { rolloverTurnCount, headSeq: first.head.headSeq },
  );
  assert(lastCanceledTurnId, "Rollover proof admitted no real product turns.");
  const lastTerminal = terminalForTurn(first, lastCanceledTurnId);
  assert(
    lastTerminal.phase === "canceled" && first.head.activity === "idle",
    "Rollover left queued work or a non-canceled exact turn behind.",
  );
  rawLog.push(
    rawReceipt("worker", "journal.real-rollover-traffic", {
      outcome: "rolled",
      stateSha256: canceledTurnHash.digest("hex"),
      count: rolloverTurnCount,
      seq: first.head.windowStartSeq,
    }),
  );
  const second = await loadWholeJournal(
    context,
    secrets,
    owner.conversationId,
    rawLog,
  );
  assert(
    first.historySha256 === second.historySha256,
    "Two independent archive reads disagreed.",
  );
  const windowStartSeq = requireInteger(
    first.head.windowStartSeq,
    "Journal resident window start",
  );
  const coldRows = Math.max(0, windowStartSeq - first.head.floorSeq);
  const hot = requireRecord(first.probe.hot, "Journal hot SQLite stats");
  const hotRows = requireInteger(hot.rows, "Journal hot rows", 1);
  assert(
    coldRows > 0,
    "Primary real conversation has not rolled any canonical rows to R2; refusing to invent cold evidence.",
  );
  assert(
    first.probe.indexSyncedSeq === first.head.headSeq,
    "Convex projection is behind the DO journal.",
  );
  await verifyStaleProjectionFence(context, secrets, owner, first, rawLog);
  const prefix = `conversations/${state.identity.ownerIdSha256}/${owner.conversationId}/seg/`;
  const objects = await r2ListObjects(
    secrets,
    REQUIRED_CONVERSATION_ARCHIVE_BUCKET_NAME,
    prefix,
    rawLog,
  );
  assert(
    objects.length > 0,
    "No real owner-bound conversation archive object exists in R2.",
  );
  const object = objects.sort((left, right) =>
    left.key.localeCompare(right.key),
  )[0];
  assert(
    /^conversations\/[a-f0-9]{64}\/[0-9a-f-]{36}\/seg\/.+\.jsonl\.gz$/u.test(
      object.key,
    ),
    "R2 segment key is malformed.",
  );
  const observations = {
    conversationId: owner.conversationId,
    journalEpoch: state.primary.journalEpoch,
    doSqliteCanonical: true,
    journalGapless: true,
    journalHeadSeq: first.head.headSeq,
    indexSyncedSeq: first.probe.indexSyncedSeq,
    staleProjectionRejected: true,
    r2HotRows: hotRows,
    r2ColdRows: coldRows,
    r2ObjectKey: object.key,
    r2Etag: object.etag,
    r2Bytes: object.size,
    coldHistorySha256: first.historySha256,
    hotHistorySha256: second.historySha256,
    coldHistoryRead: true,
  };
  return {
    observations,
    patch: {
      primary: {
        ...state.primary,
        projectionHeadSeq: first.head.headSeq,
        archivePrefix: prefix,
      },
      resources: {
        ...state.resources,
        r2Prefixes: [...new Set([...state.resources.r2Prefixes, prefix])],
      },
    },
  };
};

const electronCancelCloudTurn = async (
  context,
  secrets,
  owner,
  electron,
  conversationId,
  prompt,
  clientMsgId,
  rawLog,
) => {
  const result = await cdpEvaluate(
    electron,
    `(async () => {
      const { convexClient } = await import("/src/platform/convex/convex-client.ts");
      const { cloudApi } = await import("/src/features/cloud/cloud-api.ts");
      const { ConversationSocket } = await import("/src/features/cloud/conversation-socket.ts");
      const token = await window.electronAPI.system.getConvexAuthToken();
      if (!token) throw new Error("Electron has no Convex token");
      convexClient.setAuth(async () => token);
      const events = [];
      const socket = new ConversationSocket({
        conversationId: ${JSON.stringify(conversationId)},
        baseUrl: ${JSON.stringify(context.target.cloudBuilderUrl)},
        getToken: async () => token,
        onEvent: (event) => { if (events.length < 5000) events.push(event); }
      });
      socket.start();
      const deadline = Date.now() + ${DEFAULT_TURN_TIMEOUT_MS};
      while (!events.some((event) => event.type === "ready") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const receipt = await convexClient.mutation(cloudApi.startCloudChat, {
        conversationId: ${JSON.stringify(conversationId)},
        expectedOwnerGeneration: ${JSON.stringify(owner.ownerGeneration)},
        prompt: ${JSON.stringify(prompt)},
        clientMsgId: ${JSON.stringify(clientMsgId)}
      });
      while (Date.now() < deadline) {
        const records = events.filter((event) => event.type === "records").flatMap((event) => event.records);
        const streamActivity = events.filter((event) =>
          event.turnId === receipt.turnId && event.type === "tool"
        ).concat(
          records.filter((record) => record.turnId === receipt.turnId)
        );
        if (streamActivity.length > 0) {
          socket.stop();
          return {
            receipt,
            records,
            streamActivity,
            events: events.map((event) => event.type)
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      socket.stop();
      throw new Error("cloud turn produced no provider-backed stream activity before cancellation");
    })()`,
    "observe real Electron cloud turn before cancellation",
    DEFAULT_TURN_TIMEOUT_MS + 60_000,
  );
  const turnId = requireUuid(result?.receipt?.turnId, "Cancellation turn id");
  assert(
    Array.isArray(result.streamActivity) && result.streamActivity.length > 0,
    "Cloud turn exposed no exact-turn provider-backed stream activity.",
  );
  rawLog.push(
    rawReceipt("electron-cdp", "electron.cloud.stream-before-cancel", {
      outcome: "streaming",
      resourceIdSha256: sha256(turnId),
      responseSha256: sha256(canonicalJson(result.streamActivity)),
      count: result.streamActivity.length,
    }),
  );
  const cancellation = await workerRequest(
    context,
    secrets,
    `/conversations/${encodeURIComponent(conversationId)}/cancel`,
    {
      method: "POST",
      body: JSON.stringify({
        turnId,
        cancelRequestId: `acceptance-cancel-${context.runId}`.slice(0, 128),
        ownerId: owner.ownerId,
        ownerGeneration: owner.ownerGeneration,
      }),
    },
    "conversation.turn.cancel",
    rawLog,
  );
  const cancelReceipt = requireRecord(
    cancellation.body,
    "Exact-turn cancellation receipt",
  );
  requireBoolean(
    cancelReceipt.canceled,
    true,
    "Exact-turn cancellation result",
  );
  requireBoolean(cancelReceipt.joined, true, "Exact-turn provider join");
  assert(cancelReceipt.turnId === turnId, "Cancellation joined another turn.");
  return { ...result, turnId, cancelReceipt };
};

const stepCancellation = async ({ context, secrets, state, rawLog }) => {
  const owner = await recoverOwnerIdentity(context, secrets, state, rawLog);
  const electron = currentElectron(state);
  const before = await acceptanceProbe(
    context,
    secrets,
    owner,
    owner.conversationId,
    "status",
    rawLog,
  );
  const result = await electronCancelCloudTurn(
    context,
    secrets,
    owner,
    electron,
    owner.conversationId,
    "Acceptance cancellation: begin a long cloud task with several tool operations and do not finish immediately.",
    `cancel-${context.runId}`,
    rawLog,
  );
  const turnId = requireUuid(result.turnId, "Canceled turn id");
  const journal = await waitForTurnTerminal(
    context,
    secrets,
    owner.conversationId,
    turnId,
    rawLog,
  );
  const terminal = terminalForTurn(journal, turnId);
  assert(terminal.phase === "canceled", "Canonical terminal is not canceled.");
  const probe = await acceptanceProbe(
    context,
    secrets,
    owner,
    owner.conversationId,
    "status",
    rawLog,
  );
  const providerStopped =
    result.cancelReceipt.joined === true &&
    terminal.phase === "canceled" &&
    probe.providerDispatchCount > before.providerDispatchCount;
  assert(
    providerStopped,
    "Cancellation did not prove a dispatched provider execution was physically joined.",
  );
  return {
    observations: {
      conversationId: owner.conversationId,
      turnId,
      cancelRequested: true,
      providerStopped,
      terminalKind: "canceled",
      terminalRecordCount: 1,
      reconnectIdle: journal.head.activity === "idle" && probe.fault === null,
    },
    patch: { primary: { ...state.primary, cancellationTurnId: turnId } },
  };
};

const convexInternalRun = async (secrets, functionPath, args, rawLog) => {
  assert(
    secrets.convexDeployKey,
    "CONVEX_DEPLOY_KEY is required for internal preview acceptance inspection.",
  );
  const executable = path.join(REPO_ROOT, "node_modules/.bin/convex");
  const result = await commandResult(
    executable,
    [
      "run",
      functionPath,
      JSON.stringify(args),
      "--deployment",
      REQUIRED_CONVEX.deploymentName,
    ],
    {
      cwd: path.join(REPO_ROOT, "packages/backend"),
      env: { ...process.env, CONVEX_DEPLOY_KEY: secrets.convexDeployKey },
      timeoutMs: 120_000,
    },
  );
  const value = parseJsonOutput(
    result.output,
    `Convex internal ${functionPath}`,
  );
  rawLog.push(
    rawReceipt(
      "convex",
      `internal.${functionPath.replaceAll(":", ".")}`.toLowerCase(),
      {
        outcome: "completed",
        processOutputSha256: result.outputSha256,
        responseSha256: sha256(canonicalJson(value)),
        durationMs: result.durationMs,
      },
    ),
  );
  return value;
};

const findObjectWithFields = (value, fields) => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findObjectWithFields(entry, fields);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) {
    if (typeof value === "string" && value.startsWith("{")) {
      try {
        return findObjectWithFields(JSON.parse(value), fields);
      } catch {
        return null;
      }
    }
    return null;
  }
  if (fields.every((field) => Object.hasOwn(value, field))) return value;
  for (const entry of Object.values(value)) {
    const found = findObjectWithFields(entry, fields);
    if (found) return found;
  }
  return null;
};

const findObjectsWithFields = (value, fields, found = []) => {
  if (Array.isArray(value)) {
    for (const entry of value) findObjectsWithFields(entry, fields, found);
    return found;
  }
  if (!isRecord(value)) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          findObjectsWithFields(JSON.parse(trimmed), fields, found);
        } catch {
          // A tool may return ordinary prose. Only complete JSON values are
          // traversed as structured proof; prose is never interpreted.
        }
      }
    }
    return found;
  }
  if (fields.every((field) => Object.hasOwn(value, field))) found.push(value);
  for (const entry of Object.values(value)) {
    findObjectsWithFields(entry, fields, found);
  }
  return found;
};

const collectStringValues = (value, found = []) => {
  if (typeof value === "string") {
    found.push(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStringValues(entry, found);
    return found;
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) collectStringValues(entry, found);
  }
  return found;
};

const localAuthoritySnapshot = async (electron, conversationId, rawLog) => {
  const value = await cdpEvaluate(
    electron,
    `(async () => {
      const messages = await window.electronAPI.localChat.listMessages({ conversationId: ${JSON.stringify(conversationId)}, limit: 1000 });
      const activity = await window.electronAPI.localChat.listActivity({ conversationId: ${JSON.stringify(conversationId)}, limit: 1000 });
      return { messages, activity };
    })()`,
    "local authority snapshot",
  );
  const rows =
    (Array.isArray(value?.messages) ? value.messages.length : 0) +
    (Array.isArray(value?.activity) ? value.activity.length : 0);
  const digest = sha256(canonicalJson(value));
  rawLog.push(
    rawReceipt("electron-cdp", "electron.local-authority.snapshot", {
      count: rows,
      stateSha256: digest,
    }),
  );
  return { rows, digest, value };
};

const startFailureTurn = async (
  context,
  secrets,
  owner,
  prompt,
  clientMsgId,
  rawLog,
) => {
  const receipt = requireRecord(
    await convexCall(
      context,
      secrets,
      "mutation",
      "cloud_apps:startCloudChat",
      {
        conversationId: owner.conversationId,
        expectedOwnerGeneration: owner.ownerGeneration,
        prompt,
        clientMsgId,
      },
      "start fail-closed context turn",
      rawLog,
    ),
    "Context failure turn receipt",
  );
  const turnId = requireUuid(receipt.turnId, "Context failure turn id");
  const journal = await waitForTurnTerminal(
    context,
    secrets,
    owner.conversationId,
    turnId,
    rawLog,
  );
  const terminal = terminalForTurn(journal, turnId);
  assert(
    terminal.phase === "failed",
    "Context fault did not create a failed terminal.",
  );
  const probe = await convexInternalRun(
    secrets,
    "cloud_apps:getTurnProbeInternal",
    { turnId },
    rawLog,
  );
  const failure = findObjectWithFields(probe, ["code", "component"]);
  assert(
    failure,
    "Context failure did not expose a typed code/component payload.",
  );
  return { turnId, journal, terminal, failure, probe };
};

const stepCloudFailureNoLocalFallback = async ({
  context,
  secrets,
  paths,
  state,
  rawLog,
}) => {
  const owner = await recoverOwnerIdentity(context, secrets, state, rawLog);
  let electron = currentElectron(state);
  const historyFaultPrompt =
    "Acceptance prompt-context failure must fail visibly.";
  const localBefore = await localAuthoritySnapshot(
    electron,
    owner.conversationId,
    rawLog,
  );
  const promptArm = await acceptanceProbe(
    context,
    secrets,
    owner,
    owner.conversationId,
    "arm_fault",
    rawLog,
    "canonical_prompt",
  );
  const promptFailure = await startFailureTurn(
    context,
    secrets,
    owner,
    historyFaultPrompt,
    `context-prompt-${context.runId}`,
    rawLog,
  );
  assert(
    promptFailure.failure.code === "CLOUD_CONTEXT_UNAVAILABLE" &&
      promptFailure.failure.component === "canonical_prompt",
    "Cold prompt failure used the wrong typed error.",
  );
  const promptStatus = await acceptanceProbe(
    context,
    secrets,
    owner,
    owner.conversationId,
    "status",
    rawLog,
  );
  assert(
    promptStatus.providerDispatchCount === promptArm.providerDispatchCount,
    "Cold prompt failure dispatched the provider.",
  );
  await electronHydrateConversation(
    context,
    electron,
    owner.conversationId,
    rawLog,
  );

  const beforeHistory = await loadWholeJournal(
    context,
    secrets,
    owner.conversationId,
    rawLog,
  );
  const historyArm = await acceptanceProbe(
    context,
    secrets,
    owner,
    owner.conversationId,
    "arm_fault",
    rawLog,
    "canonical_history",
  );
  const historyFault = requireRecord(historyArm.fault, "Armed history fault");
  const historyFailure = await startFailureTurn(
    context,
    secrets,
    owner,
    "Acceptance malformed canonical history must fail visibly.",
    `context-history-${context.runId}`,
    rawLog,
  );
  assert(
    historyFailure.failure.code === "CLOUD_CONTEXT_UNAVAILABLE" &&
      historyFailure.failure.component === "canonical_history",
    "Malformed history failure used the wrong typed error.",
  );
  const afterFirstFailure = await acceptanceProbe(
    context,
    secrets,
    owner,
    owner.conversationId,
    "status",
    rawLog,
  );
  assert(
    afterFirstFailure.providerDispatchCount ===
      historyArm.providerDispatchCount,
    "Malformed history dispatched the provider.",
  );
  const persistedFault = requireRecord(
    afterFirstFailure.fault,
    "Persisted history fault",
  );
  assert(
    persistedFault.kind === "canonical_history" &&
      persistedFault.corruptSeq === historyFault.corruptSeq &&
      persistedFault.corruptPayloadSha256 === historyFault.corruptPayloadSha256,
    "Malformed history row was skipped, deleted, or changed after failure.",
  );
  await electronHydrateConversation(
    context,
    electron,
    owner.conversationId,
    rawLog,
  );
  const aborted = await acceptanceProbe(
    context,
    secrets,
    owner,
    owner.conversationId,
    "self_abort",
    rawLog,
  );
  const restarted = await poll(
    async () =>
      await acceptanceProbe(
        context,
        secrets,
        owner,
        owner.conversationId,
        "status",
        rawLog,
      ),
    (receipt) => receipt.bootIdSha256 !== aborted.bootIdSha256,
    {
      timeoutMs: 60_000,
      intervalMs: 500,
      label: "acceptance Durable Object restart",
    },
  );
  assert(
    restarted.fault?.kind === "canonical_history",
    "Malformed history did not survive Worker restart.",
  );
  const secondBlocked = await startFailureTurn(
    context,
    secrets,
    owner,
    "Acceptance malformed canonical history second blocked turn.",
    `context-history-restart-${context.runId}`,
    rawLog,
  );
  assert(
    secondBlocked.failure.component === "canonical_history",
    "Restarted malformed history did not fail closed.",
  );
  const repairedStatus = await acceptanceProbe(
    context,
    secrets,
    owner,
    owner.conversationId,
    "status",
    rawLog,
  );
  assert(
    repairedStatus.providerDispatchCount === historyArm.providerDispatchCount,
    "Blocked history turns changed provider dispatch accounting.",
  );
  assert(
    repairedStatus.fault === null,
    "Canonical history fault metadata remained armed after its second observed failure.",
  );
  const repairedJournal = await loadWholeJournal(
    context,
    secrets,
    owner.conversationId,
    rawLog,
  );
  const repairedRow = repairedJournal.records.find(
    (record) => record?.seq === historyFault.corruptSeq,
  );
  assert(
    repairedRow?.kind === "message" &&
      repairedRow.role === "user" &&
      repairedRow.modelSkip !== true &&
      messageText(repairedRow.payload) === historyFaultPrompt,
    "Canonical history repair did not restore the exact active user row.",
  );
  const repairedPayloadSha256 = sha256(JSON.stringify(repairedRow.payload));
  assert(
    repairedPayloadSha256 === historyFault.originalPayloadSha256,
    "Canonical history repair was not byte-identical to the armed original payload.",
  );
  const repairTurn = requireRecord(
    await convexCall(
      context,
      secrets,
      "mutation",
      "cloud_apps:startCloudChat",
      {
        conversationId: owner.conversationId,
        expectedOwnerGeneration: owner.ownerGeneration,
        prompt: `Canonical history repair acceptance: reply exactly HISTORY-REPAIRED-${context.runId}.`,
        clientMsgId: `context-history-repaired-${context.runId}`,
      },
      "start post-repair canonical history turn",
      rawLog,
    ),
    "Post-repair canonical history turn receipt",
  );
  const repairTurnId = requireUuid(
    repairTurn.turnId,
    "Post-repair canonical history turn id",
  );
  const repairJournal = await waitForTurnTerminal(
    context,
    secrets,
    owner.conversationId,
    repairTurnId,
    rawLog,
  );
  const repairTerminal = terminalForTurn(repairJournal, repairTurnId);
  assert(
    repairTerminal.phase === "completed" &&
      assistantTextForTurn(repairJournal, repairTurnId).includes(
        `HISTORY-REPAIRED-${context.runId}`,
      ),
    "Canonical history did not resume normal provider-backed execution after repair.",
  );
  const postRepairStatus = await acceptanceProbe(
    context,
    secrets,
    owner,
    owner.conversationId,
    "status",
    rawLog,
  );
  assert(
    postRepairStatus.providerDispatchCount >
      repairedStatus.providerDispatchCount,
    "Post-repair canonical history turn did not dispatch the provider.",
  );
  const localAfter = await localAuthoritySnapshot(
    electron,
    owner.conversationId,
    rawLog,
  );
  assert(
    localBefore.rows === localAfter.rows &&
      localBefore.digest === localAfter.digest,
    "Cloud context faults changed local-authoritative state.",
  );
  const contextLastSeq = beforeHistory.head.headSeq;
  const contextFirstSeq = beforeHistory.head.floorSeq;
  return {
    observations: {
      conversationId: owner.conversationId,
      turnId: promptFailure.turnId,
      cloudFailureInjected: true,
      userVisibleFailure: true,
      localAuthorityRowsBefore: localBefore.rows,
      localAuthorityRowsAfter: localAfter.rows,
      localAuthoritySha256Before: localBefore.digest,
      localAuthoritySha256After: localAfter.digest,
      localExecutionStarted: false,
      canonicalContextFailureExplicit: true,
      canonicalContextFailureCode: "CLOUD_CONTEXT_UNAVAILABLE",
      canonicalContextFailureComponent: "canonical_prompt",
      canonicalContextTerminalKind: "failed",
      canonicalFallbackPromptUsed: false,
      providerDispatchCountBefore: promptArm.providerDispatchCount,
      providerDispatchCountAfter: promptStatus.providerDispatchCount,
      canonicalHistoryTurnId: historyFailure.turnId,
      canonicalHistoryFailureInjected: true,
      canonicalHistoryUserVisibleFailure: true,
      canonicalHistoryFailureExplicit: true,
      canonicalHistoryFailureCode: "CLOUD_CONTEXT_UNAVAILABLE",
      canonicalHistoryFailureComponent: "canonical_history",
      canonicalHistoryTerminalKind: "failed",
      canonicalHistoryFallbackUsed: false,
      canonicalHistoryProviderDispatchCountBefore:
        historyArm.providerDispatchCount,
      canonicalHistoryProviderDispatchCountAfter:
        repairedStatus.providerDispatchCount,
      canonicalHistoryContextFirstSeq: contextFirstSeq,
      canonicalHistoryContextLastSeq: contextLastSeq,
      canonicalHistoryCorruptSeq: historyFault.corruptSeq,
      canonicalHistoryFailedEventSeq: historyFailure.terminal.seq,
      canonicalHistoryCorruptPayloadSha256Before:
        historyFault.corruptPayloadSha256,
      canonicalHistoryCorruptPayloadSha256After:
        persistedFault.corruptPayloadSha256,
      canonicalHistoryCorruptRowModelSkip: false,
      canonicalHistoryCorruptRowPreserved: true,
      canonicalHistoryReconnectObservedFailure: true,
      canonicalHistoryRestartObservedFailure: true,
      canonicalHistoryRepairObserved: repairedStatus.fault === null,
      canonicalHistoryOriginalPayloadSha256: historyFault.originalPayloadSha256,
      canonicalHistoryRepairedPayloadSha256: repairedPayloadSha256,
      canonicalHistoryRepairTurnId: repairTurnId,
      canonicalHistoryRepairTerminalKind: repairTerminal.phase,
      canonicalHistoryProviderDispatchCountAfterRepair:
        postRepairStatus.providerDispatchCount,
    },
    patch: {
      electron,
      primary: {
        ...state.primary,
        promptFailureTurnId: promptFailure.turnId,
        historyFailureTurnId: historyFailure.turnId,
        historyRepairTurnId: repairTurnId,
      },
    },
  };
};

const productHttpRequest = async (
  url,
  init,
  label,
  rawLog,
  { surface, expectedStatuses = [200], maxResponseBytes = 2_000_000 } = {},
) => {
  const started = Date.now();
  const response = await requestJson(url, {
    label,
    timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    expectedStatuses,
    maxResponseBytes,
    ...init,
  });
  rawLog.push(
    requestReceipt(
      requireString(surface, `${label} raw surface`, 64),
      label.toLowerCase().replace(/[^a-z0-9._:-]+/gu, "."),
      response,
      started,
    ),
  );
  return response;
};

const pairAcceptanceMobile = async (
  context,
  secrets,
  electron,
  rawLog,
  suffix,
) => {
  const desktopDeviceId = requireString(
    await cdpEvaluate(
      electron,
      `(async () => await window.electronAPI.system.getDeviceId())()`,
      "read isolated desktop device identity",
    ),
    "Desktop device id",
    128,
  );
  const pairing = requireRecord(
    await convexCall(
      context,
      secrets,
      "mutation",
      "mobile_access:createPairingSession",
      { desktopDeviceId },
      "create disposable mobile pairing session",
      rawLog,
    ),
    "Mobile pairing session",
  );
  const mobileDeviceId = `acceptance-mobile-${sha256(`${context.runId}\n${suffix}`).slice(0, 24)}`;
  const completed = requireRecord(
    (
      await productHttpRequest(
        `${context.target.convexSiteUrl}/api/mobile/pairing/complete`,
        {
          method: "POST",
          headers: userHeaders(secrets),
          body: JSON.stringify({
            pairingCode: requireString(pairing.pairingCode, "Pairing code", 16),
            mobileDeviceId,
            displayName: `Acceptance ${suffix}`.slice(0, 64),
            platform: "acceptance-driver",
          }),
        },
        "mobile.pairing.complete",
        rawLog,
        { surface: "mobile-http" },
      )
    ).body,
    "Completed mobile pairing",
  );
  assert(
    completed.desktopDeviceId === desktopDeviceId,
    "Mobile pairing completed against another desktop.",
  );
  return {
    desktopDeviceId,
    mobileDeviceId,
    pairSecret: requireString(completed.pairSecret, "Mobile pair secret", 512),
    approvedAt: requireInteger(
      completed.approvedAt,
      "Mobile pairing approval time",
      1,
    ),
  };
};

const executionAdmission = ({
  context,
  suffix,
  conversationId,
  expectedOwnerGeneration,
  kind,
  prompt,
  description,
  workspace,
  subject: requestedSubject,
  parentTurnId,
  threadId,
  requiredCapabilities = [],
}) => {
  assert(kind === "chat" || kind === "agent", "Execution kind is invalid.");
  const normalizedPrompt = requireString(prompt, "Execution prompt", 32_000);
  const ownerGeneration = requireString(
    expectedOwnerGeneration,
    "Expected execution owner generation",
    512,
  );
  const derivedSubject = !workspace
    ? "portable"
    : workspace === "computer"
      ? "computer"
      : "cloud";
  const subject = requestedSubject ?? derivedSubject;
  assert(
    ["portable", "computer", "cloud"].includes(subject),
    "Execution subject is invalid.",
  );
  const payloadJson = JSON.stringify({
    prompt: normalizedPrompt,
    expectedOwnerGeneration: ownerGeneration,
    ...(kind === "agent"
      ? {
          description: requireString(
            description ?? normalizedPrompt.slice(0, 160),
            "Execution description",
            512,
          ),
        }
      : {}),
  });
  const idempotencyKey = `acceptance:${suffix}:${context.runId}`.slice(0, 128);
  const payloadHash = sha256(payloadJson);
  const challenge = [
    "execution-placement-v1",
    idempotencyKey,
    conversationId,
    payloadHash,
    kind,
    subject,
  ].join(":");
  return {
    challenge,
    body: {
      idempotencyKey,
      expectedOwnerGeneration: ownerGeneration,
      payloadJson,
      payloadHash,
      kind,
      subject,
      conversationId,
      ...(parentTurnId ? { parentTurnId } : {}),
      ...(threadId ? { threadId } : {}),
      ...(workspace ? { workspace } : {}),
      requiredCapabilities: [...new Set([kind, ...requiredCapabilities])],
    },
  };
};

const mobileProofHeaders = (pairing, challenge) => {
  const issuedAt = Date.now();
  const pairSecretHash = sha256(pairing.pairSecret);
  const message = [
    "stella-mobile-bridge-pair-proof-v1",
    pairing.desktopDeviceId,
    pairing.mobileDeviceId,
    challenge,
    "",
    String(issuedAt),
  ].join("\n");
  return {
    "X-Stella-Mobile-Device-Id": pairing.mobileDeviceId,
    "X-Stella-Mobile-Pair-Proof": createHmac("sha256", pairSecretHash)
      .update(message, "utf8")
      .digest("hex"),
    "X-Stella-Mobile-Pair-Proof-Issued-At": String(issuedAt),
    "X-Stella-Mobile-Pair-Proof-Challenge": challenge,
  };
};

const submitMobileExecution = async (
  context,
  secrets,
  admission,
  rawLog,
  pairing,
) => {
  const body = {
    ...admission.body,
    ...(pairing ? { desktopDeviceId: pairing.desktopDeviceId } : {}),
  };
  const response = await productHttpRequest(
    `${context.target.convexSiteUrl}/api/mobile/execution/submit`,
    {
      method: "POST",
      headers: {
        ...userHeaders(secrets),
        ...(pairing ? mobileProofHeaders(pairing, admission.challenge) : {}),
      },
      body: JSON.stringify(body),
    },
    "mobile.execution.submit",
    rawLog,
    { surface: "mobile-http", expectedStatuses: [202] },
  );
  const dispatch = requireRecord(response.body, "Mobile execution admission");
  requireString(dispatch.dispatchId, "Mobile execution dispatch id", 128);
  assert(
    dispatch.idempotencyKey === admission.body.idempotencyKey &&
      dispatch.conversationId === admission.body.conversationId,
    "Mobile execution admission changed request identity.",
  );
  return dispatch;
};

const readMobileExecutionStatus = async (context, secrets, dispatchId) => {
  const response = await requestJson(
    `${context.target.convexSiteUrl}/api/mobile/execution/status?dispatchId=${encodeURIComponent(dispatchId)}`,
    {
      label: "mobile execution status",
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      method: "GET",
      headers: userHeaders(secrets),
      maxResponseBytes: 512_000,
    },
  );
  return requireRecord(response.body, "Mobile execution status");
};

const waitForExecutionTerminal = async (
  context,
  secrets,
  dispatchId,
  rawLog,
) => {
  const status = await poll(
    async () => await readMobileExecutionStatus(context, secrets, dispatchId),
    (value) => ["completed", "failed", "canceled"].includes(value.state),
    {
      timeoutMs: DEFAULT_TURN_TIMEOUT_MS,
      intervalMs: 1_000,
      label: `execution dispatch ${dispatchId}`,
    },
  );
  rawLog.push(
    rawReceipt("convex", "execution.placement.terminal", {
      outcome: requireString(status.state, "Execution terminal state", 32),
      resourceIdSha256: sha256(dispatchId),
      responseSha256: sha256(canonicalJson(status)),
    }),
  );
  return status;
};

const localPlacementRunId = (dispatchId) =>
  `placement-chat:${sha256(dispatchId).slice(0, 32)}`;

const electronPairedPlacementTurn = async (
  context,
  secrets,
  electron,
  admission,
  pairing,
  rawLog,
) => {
  const pairHeaders = mobileProofHeaders(pairing, admission.challenge);
  const result = await cdpEvaluate(
    electron,
    `(async () => {
      const events = [];
      const off = window.electronAPI.agent.onStream((event) => {
        if (events.length < 10000) events.push(event);
      });
      const response = await fetch(${JSON.stringify(`${context.target.convexSiteUrl}/api/mobile/execution/submit`)}, {
        method: "POST",
        headers: ${JSON.stringify({ ...userHeaders(secrets), ...pairHeaders })},
        body: ${JSON.stringify(JSON.stringify({ ...admission.body, desktopDeviceId: pairing.desktopDeviceId }))}
      });
      const admissionText = await response.text();
      if (response.status !== 202) throw new Error("mobile placement admission failed: " + response.status);
      const dispatch = JSON.parse(admissionText);
      const deadline = Date.now() + ${DEFAULT_TURN_TIMEOUT_MS};
      let status = dispatch;
      while (Date.now() < deadline) {
        const statusResponse = await fetch(${JSON.stringify(`${context.target.convexSiteUrl}/api/mobile/execution/status`)} + "?dispatchId=" + encodeURIComponent(dispatch.dispatchId), {
          headers: ${JSON.stringify(userHeaders(secrets))}
        });
        if (!statusResponse.ok) throw new Error("mobile placement status failed: " + statusResponse.status);
        status = await statusResponse.json();
        const terminal = events.find((event) =>
          event.type === "run-finished" &&
          typeof event.runId === "string" &&
          event.runId.startsWith("placement-chat:")
        );
        if (["completed", "failed", "canceled"].includes(status.state) && terminal) {
          off();
          return { dispatch, status, runId: terminal.runId, terminal, events: events.filter((event) => event.runId === terminal.runId) };
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      off();
      throw new Error("paired desktop placement did not reach joined terminal");
    })()`,
    "paired mobile to local-runtime execution",
    DEFAULT_TURN_TIMEOUT_MS + 60_000,
  );
  const dispatch = requireRecord(result?.dispatch, "Paired dispatch admission");
  const status = requireRecord(result?.status, "Paired dispatch status");
  const expectedRunId = localPlacementRunId(
    requireString(dispatch.dispatchId, "Paired dispatch id", 128),
  );
  assert(
    result.runId === expectedRunId,
    "Local runtime used a non-canonical placement run identity.",
  );
  assert(
    status.state === "completed" && status.placement === "computer",
    "Paired execution did not complete on the computer.",
  );
  assert(
    status.executorDeviceId === pairing.desktopDeviceId,
    "Paired execution ran on another desktop.",
  );
  assert(
    Array.isArray(result.events) && result.events.length > 0,
    "Paired execution emitted no exact-run local events.",
  );
  rawLog.push(
    rawReceipt("mobile-http", "mobile.execution.paired-terminal", {
      outcome: "completed",
      resourceIdSha256: sha256(dispatch.dispatchId),
      responseSha256: sha256(canonicalJson(status)),
    }),
    rawReceipt("local-runtime", "placement.paired.local-turn", {
      outcome: "completed",
      resourceIdSha256: sha256(expectedRunId),
      responseSha256: sha256(canonicalJson(result.events)),
      count: result.events.length,
    }),
  );
  return { ...result, dispatch, status, runId: expectedRunId };
};

const stepDesktopLocalRouting = async ({ context, secrets, state, rawLog }) => {
  const local = requireRecord(state.local, "Local lifecycle state");
  const electron = currentElectron(state);
  const localAuthority = await localAuthoritySnapshot(
    electron,
    local.conversationId,
    rawLog,
  );
  const placementIdentity = requireRecord(
    await convexCall(
      context,
      secrets,
      "query",
      "execution_placement:getMyExecutionPlacementIdentity",
      {},
      "read desktop execution placement identity",
      rawLog,
    ),
    "Desktop execution placement identity",
  );
  assert(
    Object.keys(placementIdentity).length > 0,
    "Convex did not return a fenced execution-placement identity.",
  );
  assert(
    canonicalJson(localAuthority.value).includes(local.initialTurnId),
    "Desktop local authority does not contain the exact lifecycle turn.",
  );
  assert(
    placementIdentity.ownerId === parseJwtTokenIdentifier(secrets.jwt) &&
      placementIdentity.ownerGeneration === state.identity.ownerGeneration,
    "Desktop runtime identity is not bound to the authenticated owner generation.",
  );
  assert(
    local.initialClientRequestId === `local-initial-${context.runId}` &&
      requireSha256(
        local.initialProviderLifecycleSha256,
        "Desktop local provider lifecycle hash",
      ),
    "Desktop local run is not bound to the reviewed direct Electron request.",
  );
  rawLog.push(
    rawReceipt("local-runtime", "placement.desktop.local", {
      outcome: "computer",
      resourceIdSha256: sha256(local.initialTurnId),
      stateSha256: sha256(
        canonicalJson({
          placementIdentity,
          localAuthoritySha256: localAuthority.digest,
          providerLifecycleSha256: local.initialProviderLifecycleSha256,
        }),
      ),
    }),
  );
  return {
    observations: {
      conversationId: local.conversationId,
      turnId: local.initialTurnId,
      subject: "computer",
      workspace: "computer",
      chosenLocation: canonicalJson(localAuthority.value).includes(
        local.initialTurnId,
      )
        ? "computer"
        : "unverified",
      executedBy: canonicalJson(localAuthority.value).includes(
        local.initialTurnId,
      )
        ? "local-runtime"
        : "unverified",
      cloudSandboxStarted: canonicalJson(localAuthority.value).includes(
        "sandbox_ready",
      ),
      fenceVerified:
        placementIdentity.ownerGeneration === state.identity.ownerGeneration,
    },
    patch: {
      placement: {
        ...(state.placement ?? {}),
        desktop: {
          conversationId: local.conversationId,
          turnId: local.initialTurnId,
          localAuthoritySha256: localAuthority.digest,
        },
      },
    },
  };
};

const waitForConvexDispatchTerminal = async (
  context,
  secrets,
  dispatchId,
  rawLog,
) => {
  const status = await poll(
    async () =>
      requireRecord(
        await convexCall(
          context,
          secrets,
          "query",
          "execution_placement:getMyExecutionDispatchStatus",
          { dispatchId },
          "poll browser execution terminal",
          [],
        ),
        "Browser execution status",
      ),
    (value) => ["completed", "failed", "canceled"].includes(value.state),
    {
      timeoutMs: DEFAULT_TURN_TIMEOUT_MS,
      intervalMs: 1_000,
      label: `browser dispatch ${dispatchId}`,
    },
  );
  rawLog.push(
    rawReceipt("convex", "execution.browser.terminal", {
      outcome: requireString(status.state, "Browser dispatch state", 32),
      resourceIdSha256: sha256(dispatchId),
      responseSha256: sha256(canonicalJson(status)),
    }),
  );
  return status;
};

const threadProbeFor = async (
  secrets,
  ownerId,
  rawLog,
  { threadId, descriptionMarker },
) =>
  await poll(
    async () => {
      const probe = await convexInternalRun(
        secrets,
        "cloud_apps:getAgentThreadProbeInternal",
        { ownerId, limit: 30 },
        [],
      );
      assert(Array.isArray(probe), "Agent thread probe is invalid.");
      return (
        probe.find(
          (entry) =>
            entry?.threadId === threadId ||
            (descriptionMarker &&
              typeof entry?.description === "string" &&
              entry.description.includes(descriptionMarker)),
        ) ?? null
      );
    },
    (entry) =>
      isRecord(entry) &&
      ["completed", "failed", "canceled"].includes(
        String(entry.status ?? entry.turnStatus),
      ),
    {
      timeoutMs: DEFAULT_TURN_TIMEOUT_MS,
      intervalMs: 1_000,
      label: `cloud agent thread ${threadId ?? descriptionMarker}`,
    },
  ).then((entry) => {
    rawLog.push(
      rawReceipt("sandbox", "sandbox.agent.thread-terminal", {
        outcome: requireString(
          entry.status ?? entry.turnStatus,
          "Agent thread terminal state",
          32,
        ),
        resourceIdSha256: sha256(
          requireString(entry.threadId, "Agent thread id", 256),
        ),
        responseSha256: sha256(canonicalJson(entry)),
        count: Array.isArray(entry.events) ? entry.events.length : 0,
      }),
    );
    return entry;
  });

const requireRealSandboxEvents = (probe, marker) => {
  const events = Array.isArray(probe.events) ? probe.events : [];
  const ready = events.find((event) => event?.kind === "sandbox_ready");
  const command = events.find(
    (event) =>
      /(?:exec_command|command|tool)/u.test(String(event?.kind ?? "")) &&
      canonicalJson(event).includes(marker),
  );
  const completed = events.find(
    (event) =>
      ["completed", "terminal", "result"].includes(String(event?.kind ?? "")) ||
      /completed/u.test(canonicalJson(event)),
  );
  assert(ready, "Cloud agent never emitted a real sandbox_ready event.");
  assert(
    command,
    "Cloud agent never durably recorded the requested sandbox command and nonce.",
  );
  assert(
    completed ||
      probe.status === "completed" ||
      probe.turnStatus === "completed",
    "Cloud sandbox did not complete.",
  );
  return { events, ready, command, completed };
};

const completionJournalEvidence = async (
  context,
  secrets,
  conversationId,
  threadId,
  rawLog,
) => {
  const journal = await poll(
    async () =>
      await loadWholeJournal(context, secrets, conversationId, rawLog),
    (candidate) =>
      candidate.records.some(
        (record) =>
          record?.kind === "message" &&
          record.role === "user" &&
          messageText(record.payload).includes("[Agent completed]") &&
          messageText(record.payload).includes(`(thread ${threadId})`),
      ),
    {
      timeoutMs: DEFAULT_TURN_TIMEOUT_MS,
      intervalMs: 1_000,
      label: `agent completion journal ${threadId}`,
    },
  );
  const rows = journal.records.filter(
    (record) =>
      record?.kind === "message" &&
      record.role === "user" &&
      messageText(record.payload).includes("[Agent completed]") &&
      messageText(record.payload).includes(`(thread ${threadId})`),
  );
  assert(
    rows.length === 1,
    "Agent completion was not delivered exactly once to the canonical journal.",
  );
  return { journal, row: rows[0], count: rows.length };
};

const stepMobileReachableComputerRouting = async ({
  context,
  secrets,
  state,
  rawLog,
}) => {
  const owner = await recoverOwnerIdentity(context, secrets, state, rawLog);
  const electron = currentElectron(state);
  await configureElectronSession(
    context,
    secrets,
    electron,
    owner.conversationId,
    rawLog,
  );
  const pairing = await pairAcceptanceMobile(
    context,
    secrets,
    electron,
    rawLog,
    "mobile-reachable",
  );
  const admission = executionAdmission({
    context,
    suffix: "mobile-reachable",
    conversationId: owner.conversationId,
    expectedOwnerGeneration: owner.ownerGeneration,
    kind: "chat",
    workspace: "computer",
    requiredCapabilities: ["chat"],
    prompt: `Run on the paired computer and reply exactly MOBILE-PAIRED-${context.runId}.`,
  });
  const execution = await electronPairedPlacementTurn(
    context,
    secrets,
    electron,
    admission,
    pairing,
    rawLog,
  );
  const dispatchId = requireString(
    execution.dispatch.dispatchId,
    "Paired mobile dispatch id",
    128,
  );
  const activity = await convexCall(
    context,
    secrets,
    "query",
    "execution_placement:listMyExecutionActivity",
    { limit: 100 },
    "read paired mobile execution activity",
    rawLog,
  );
  assert(
    Array.isArray(activity),
    "Paired mobile execution activity is invalid.",
  );
  const activityRow = activity.find(
    (entry) => entry?.dispatch?.dispatchId === dispatchId,
  );
  assert(
    activityRow?.placementLabel === "computer",
    "Paired mobile activity did not record computer placement.",
  );
  const presenceSessionId = requireString(
    execution.status.executorPresenceSessionId,
    "Paired executor presence session",
    256,
  );
  const claimId = `claim:${presenceSessionId}:${dispatchId}`;
  return {
    observations: {
      conversationId: owner.conversationId,
      turnId: execution.runId,
      deviceClaimId: claimId,
      subject: execution.status.subject,
      workspace: execution.status.workspace,
      chosenLocation: execution.status.placement,
      executedBy:
        execution.status.executorDeviceId === pairing.desktopDeviceId
          ? "paired-computer"
          : "unknown",
      cloudSandboxStarted: execution.status.cloudTurnId !== undefined,
      fenceVerified:
        execution.status.state === "completed" &&
        execution.status.revision > 0 &&
        activityRow.dispatch.revision === execution.status.revision,
    },
    patch: {
      placement: {
        ...(state.placement ?? {}),
        mobileReachable: {
          conversationId: owner.conversationId,
          turnId: execution.runId,
          dispatchId,
          claimIdSha256: sha256(claimId),
        },
      },
    },
  };
};

const stepMobileUnreachableCloudRouting = async ({
  context,
  secrets,
  state,
  rawLog,
}) => {
  const owner = await recoverOwnerIdentity(context, secrets, state, rawLog);
  const marker = `MOBILE-CLOUD-SANDBOX-${context.runId}`;
  const admission = executionAdmission({
    context,
    suffix: "mobile-unreachable",
    conversationId: owner.conversationId,
    expectedOwnerGeneration: owner.ownerGeneration,
    kind: "chat",
    workspace: "computer",
    requiredCapabilities: ["chat"],
    prompt: `Use spawn_agent exactly once with workspace cloud and description ${marker}. Tell it to run exec_command to print ${marker}, read /opt/stella/interior-seed.json, and report both results. Wait for [Agent completed] before replying.`,
  });
  const dispatch = await submitMobileExecution(
    context,
    secrets,
    admission,
    rawLog,
  );
  const status = await waitForExecutionTerminal(
    context,
    secrets,
    requireString(dispatch.dispatchId, "Unreachable mobile dispatch id", 128),
    rawLog,
  );
  assert(
    status.state === "completed" &&
      status.placement === "cloud" &&
      status.executorDeviceId === undefined,
    "Unpaired mobile computer request did not complete through cloud fallback.",
  );
  const threads = await convexCall(
    context,
    secrets,
    "query",
    "cloud_apps:listMyAgentThreads",
    { conversationId: owner.conversationId },
    "read unreachable-mobile cloud child",
    rawLog,
  );
  assert(Array.isArray(threads), "Unreachable-mobile thread list is invalid.");
  const listed = threads.find(
    (thread) =>
      typeof thread?.description === "string" &&
      thread.description.includes(marker),
  );
  assert(
    listed,
    "Unreachable mobile fallback parent did not spawn the real cloud child.",
  );
  const threadId = requireString(
    listed.threadId,
    "Unreachable mobile cloud thread id",
    256,
  );
  const probe = await threadProbeFor(secrets, owner.ownerId, rawLog, {
    threadId,
    descriptionMarker: marker,
  });
  const sandbox = requireRealSandboxEvents(probe, marker);
  return {
    observations: {
      conversationId: owner.conversationId,
      turnId: requireString(
        status.cloudTurnId,
        "Unreachable mobile cloud turn id",
        256,
      ),
      subject: status.subject,
      workspace: status.workspace,
      chosenLocation: status.placement,
      realSandboxStarted: Boolean(sandbox.ready),
      localRuntimeStarted: status.executorDeviceId !== undefined,
      fenceVerified:
        status.state === "completed" && probe.threadId === threadId,
    },
    patch: {
      placement: {
        ...(state.placement ?? {}),
        mobileUnreachable: {
          conversationId: owner.conversationId,
          turnId: status.cloudTurnId,
          dispatchId: status.dispatchId,
          threadId,
        },
      },
    },
  };
};

const MOBILE_RN_ACCEPTANCE_CONTRACT = "stella-mobile-rn-canonical-v2";
const MOBILE_RN_PHASE_TIMEOUT_MS = 8 * 60_000;
export const MOBILE_RN_GENERATION_PHASE_TIMEOUT_MS = 15 * 60_000;
export const MOBILE_RN_CHILD_TIMEOUT_OVERHEAD_MS = 3 * 60_000;
export const MOBILE_RN_ORCHESTRATOR_EXIT_OVERHEAD_MS = 60_000;
export const MOBILE_RN_PHASE_MAX_NO_REFRESH_WINDOW_MS =
  MOBILE_RN_PHASE_TIMEOUT_MS +
  MOBILE_RN_CHILD_TIMEOUT_OVERHEAD_MS +
  MOBILE_RN_ORCHESTRATOR_EXIT_OVERHEAD_MS;
export const MOBILE_RN_GENERATION_MAX_NO_REFRESH_WINDOW_MS =
  MOBILE_RN_GENERATION_PHASE_TIMEOUT_MS +
  MOBILE_RN_CHILD_TIMEOUT_OVERHEAD_MS +
  MOBILE_RN_ORCHESTRATOR_EXIT_OVERHEAD_MS;
export const OWNER_RESET_CONTINUATION_RESERVE_MS = 12 * 60_000;
const MOBILE_RN_PRODUCT_MODULES = Object.freeze([
  "packages/mobile/src/lib/use-cloud-canonical-chat-thread.ts",
  "packages/mobile/src/lib/use-chat-thread.ts",
  "packages/mobile/src/lib/desktop-chat-outbox.ts",
  "packages/mobile/src/lib/cloud-conversation-store.ts",
  "packages/mobile/src/lib/cloud-conversation-socket.ts",
  "packages/mobile/src/lib/http.ts",
]);
const MOBILE_RN_FULL_RECEIPTS = Object.freeze([
  Object.freeze(["mobile-client", "mobile.rn.ui-send", "accepted", undefined]),
  Object.freeze([
    "mobile-http",
    "mobile.execution.submit.response-loss",
    "committed-response-withheld",
    202,
  ]),
  Object.freeze([
    "mobile-http",
    "mobile.execution.submit.replay",
    "idempotent-replay",
    202,
  ]),
  Object.freeze([
    "mobile-client",
    "mobile.rn.websocket.cursor-reconnect",
    "gapless",
    undefined,
  ]),
  Object.freeze([
    "mobile-client",
    "mobile.rn.app-state",
    "background-active",
    undefined,
  ]),
  Object.freeze([
    "mobile-client",
    "mobile.rn.identity-switch",
    "a-b-a",
    undefined,
  ]),
  Object.freeze([
    "mobile-client",
    "mobile.rn.no-local-fallback",
    "explicit-error",
    undefined,
  ]),
  Object.freeze([
    "mobile-client",
    "mobile.rn.clean-hydration",
    "canonical",
    undefined,
  ]),
  Object.freeze([
    "mobile-client",
    "mobile.rn.generation-canary",
    "durable",
    undefined,
  ]),
]);
const MOBILE_RN_RECEIPT_KEYS = new Set([
  "surface",
  "operation",
  "status",
  "outcome",
  "requestIdSha256",
  "resourceIdSha256",
  "responseSha256",
  "stateSha256",
  "bytes",
  "count",
  "durationMs",
  "seq",
]);

const assertExactObjectKeys = (value, expectedKeys, label) => {
  const record = requireRecord(value, label);
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  assert(
    canonicalJson(actual) === canonicalJson(expected),
    `${label} has an unreviewed field set.`,
  );
  return record;
};

const readElectronSessionAuthority = async (
  context,
  secrets,
  electron,
  conversationId,
  rawLog,
  label,
  {
    expectedIdentitySha256 = null,
    expectedSessionIdSha256 = null,
    expectedOwnerAccountSha256 = null,
    minimumRunwayMs = REFRESHED_JWT_MINIMUM_RUNWAY_MS,
  } = {},
) => {
  if (conversationId !== null) {
    await configureElectronSession(
      context,
      secrets,
      electron,
      conversationId,
      rawLog,
    );
  }
  const value = requireRecord(
    await cdpEvaluate(
      electron,
      `(async () => {
        await window.electronAPI.system.configurePiRuntime({
          convexUrl: ${JSON.stringify(context.target.convexUrl)},
          convexSiteUrl: ${JSON.stringify(context.target.convexSiteUrl)}
        });
        const auth = await import("/src/global/auth/services/auth-session.ts");
        const { router } = await import("/src/router.tsx");
        await auth.refreshAuthSession();
        const snapshot = auth.getAuthSessionSnapshot();
        const session = snapshot.data;
        const token = await window.electronAPI.system.getConvexAuthToken();
        const routePathname = router.state.location.pathname;
        const routeSearch =
          router.state.location.search &&
          typeof router.state.location.search === "object"
            ? router.state.location.search
            : {};
        const routeSearchKeys = Object.keys(routeSearch);
        const cleanLocation =
          ((routePathname === "/" || routePathname === "/settings") &&
            routeSearchKeys.length === 0) ||
          (routePathname === "/chat" &&
            (routeSearchKeys.length === 0 ||
              (routeSearchKeys.length === 1 &&
                routeSearchKeys[0] === "c" &&
                /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(routeSearch.c))));
        return {
          subject: session?.user?.id ?? null,
          sessionId: session?.session?.id ?? null,
          anonymous: session?.user?.isAnonymous === true,
          pending: snapshot.isPending === true,
          identityRevision: snapshot.identityRevision,
          cleanLocation,
          pathnameSha256: await (async (value) => {
            const bytes = new TextEncoder().encode(value);
            const digest = await crypto.subtle.digest("SHA-256", bytes);
            return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
          })(routePathname),
          authDialogOpen: Boolean(document.querySelector(".auth-dialog-content")),
          token
        };
      })()`,
      `read ${label} Electron session authority`,
      60_000,
    ),
    `${label} Electron session authority`,
  );
  const subject = requireString(
    value.subject,
    `${label} Electron session subject`,
    512,
  );
  const sessionId = requireString(
    value.sessionId,
    `${label} Electron session id`,
    512,
  );
  const token = requireString(
    value.token,
    `${label} Electron Convex token`,
    16 * 1_024,
  );
  requireBoolean(value.anonymous, false, `${label} nonanonymous identity`);
  requireBoolean(value.pending, false, `${label} pending identity`);
  requireBoolean(value.cleanLocation, true, `${label} clean callback URL`);
  requireBoolean(value.authDialogOpen, false, `${label} closed auth dialog`);
  requireInteger(value.identityRevision, `${label} identity revision`, 0);
  const tokenIdentity = assertRefreshedJwtRunway(
    parseJwtIdentity(token),
    label,
    { minimumRunwayMs },
  );
  assert(
    tokenIdentity.issuer === context.target.convexSiteUrl &&
      tokenIdentity.subject === subject,
    `${label} Electron session and Convex token do not identify the same reviewed dev principal.`,
  );
  const identitySha256 = sha256(subject);
  const sessionIdSha256 = sha256(sessionId);
  const ownerAccountSha256 = sha256(tokenIdentity.tokenIdentifier);
  const expected = [
    expectedIdentitySha256,
    expectedSessionIdSha256,
    expectedOwnerAccountSha256,
  ];
  assert(
    expected.every((entry) => entry === null) ||
      expected.every((entry) => typeof entry === "string"),
    `${label} authority continuity expectations are incomplete.`,
  );
  if (expectedIdentitySha256 !== null) {
    assert(
      identitySha256 ===
        requireSha256(expectedIdentitySha256, `${label} expected identity`) &&
        sessionIdSha256 ===
          requireSha256(expectedSessionIdSha256, `${label} expected session`) &&
        ownerAccountSha256 ===
          requireSha256(
            expectedOwnerAccountSha256,
            `${label} expected owner account`,
          ),
      `${label} did not preserve the checkpointed product authority.`,
    );
  }
  rawLog.push(
    rawReceipt("electron-cdp", "electron.session.mobile-authority", {
      outcome: "authenticated",
      resourceIdSha256: sha256(sessionId),
      responseSha256: sha256(
        canonicalJson({
          label,
          subjectSha256: identitySha256,
          sessionIdSha256,
          tokenSubjectSha256: sha256(tokenIdentity.subject),
          tokenIdentifierSha256: ownerAccountSha256,
          cleanLocation: true,
          authDialogOpen: false,
          pathnameSha256: requireSha256(
            value.pathnameSha256,
            `${label} clean pathname`,
          ),
        }),
      ),
    }),
  );
  return {
    subject,
    sessionId,
    token,
    tokenIdentity,
    identitySha256,
    sessionIdSha256,
    ownerAccountSha256,
    identityRevision: value.identityRevision,
  };
};

const refreshPrimaryStepSecrets = async (
  context,
  secrets,
  state,
  rawLog,
  label,
) => {
  const electron = currentElectron(state);
  await verifyTrustedViteOwnership({
    pid: electron.vitePid,
    port: electron.devServerPort,
    processFingerprintSha256: electron.viteProcessFingerprintSha256,
    listenerAddressesSha256: electron.viteListenerAddressesSha256,
  });
  const recordedConversation =
    state.ownerReset?.newConversationId ??
    state.primary?.conversationId ??
    null;
  const conversationId =
    recordedConversation === null
      ? null
      : requireUuid(recordedConversation, `${label} primary conversation`);
  const authority = await readElectronSessionAuthority(
    context,
    secrets,
    electron,
    conversationId,
    rawLog,
    label,
  );
  const jwtIdentity = authority.tokenIdentity;
  const checkpointedOwnerSha256 = requireSha256(
    state.identity?.ownerIdSha256 ?? state.authHandoff?.ownerAccountSha256,
    `${label} checkpointed primary owner`,
  );
  assert(
    jwtIdentity.subject === authority.subject &&
      sha256(jwtIdentity.tokenIdentifier) === checkpointedOwnerSha256,
    `${label} refreshed token does not match the checkpointed primary owner.`,
  );
  return Object.freeze({
    ...secrets,
    jwt: authority.token,
  });
};

const mobileAuthorityHashes = ({
  subject,
  sessionId,
  ownerGeneration,
  conversationId,
  socketOrigin,
}) => ({
  identityKeySha256: sha256(`account:${subject}:session:${sessionId}`),
  accountScopeSha256: sha256(`account:${subject}`),
  ownerGenerationSha256: sha256(ownerGeneration),
  conversationIdSha256: sha256(conversationId),
  socketOriginSha256: sha256(socketOrigin),
});

const validateMobileAuthorityHashes = (value, expected, label) => {
  const authority = assertExactObjectKeys(
    value,
    [
      "identityKeySha256",
      "accountScopeSha256",
      "ownerGenerationSha256",
      "conversationIdSha256",
      "socketOriginSha256",
    ],
    label,
  );
  for (const [field, digest] of Object.entries(expected)) {
    requireSha256(authority[field], `${label}.${field}`);
    assert(
      authority[field] === digest,
      `${label}.${field} is not bound to the exact authenticated authority.`,
    );
  }
  return authority;
};

const validateMobileRuntime = async (value, bunVersion, label) => {
  const runtime = assertExactObjectKeys(
    value,
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
    label,
  );
  assert(
    runtime.bunVersion === bunVersion &&
      runtime.executor === "bun-jsdom-react-native-web" &&
      runtime.renderer === "react-dom-react-native-web",
    `${label} used another JavaScript/runtime boundary.`,
  );
  for (const field of [
    "actualSignedInChatHookMounted",
    "actualAsyncStoragePackage",
    "actualAsyncStorageWrapper",
    "actualAppStateSubscription",
    "realHttp",
    "realWebSocket",
  ]) {
    requireBoolean(runtime[field], true, `${label}.${field}`);
  }
  requireBoolean(
    runtime.actualProductScreenMounted,
    false,
    `${label}.actualProductScreenMounted`,
  );
  const expectedModuleNames = MOBILE_RN_PRODUCT_MODULES.map((relative) =>
    path.basename(relative),
  );
  const moduleHashes = assertExactObjectKeys(
    runtime.productModuleSha256,
    expectedModuleNames,
    `${label}.productModuleSha256`,
  );
  for (const relative of MOBILE_RN_PRODUCT_MODULES) {
    const moduleName = path.basename(relative);
    const absolute = realpathSync(path.join(REPO_ROOT, relative));
    assert(
      inside(absolute, REPO_ROOT) && statSync(absolute).isFile(),
      `Reviewed mobile module ${moduleName} is unavailable.`,
    );
    const expectedDigest = sha256(await readFile(absolute));
    requireSha256(
      moduleHashes[moduleName],
      `${label}.productModuleSha256.${moduleName}`,
    );
    assert(
      moduleHashes[moduleName] === expectedDigest,
      `Mounted mobile proof used different ${moduleName} bytes.`,
    );
  }
  return runtime;
};

const validateMobileBoundary = (value, label) => {
  const boundary = assertExactObjectKeys(
    value,
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
    label,
  );
  for (const field of [
    "javascriptProcessRestartProved",
    "reactNativeWebUiInteractionProved",
    "asyncStorageWebAdapterProved",
    "appStateVisibilityLifecycleProved",
    "realDevHttpAndWebSocketProved",
  ]) {
    requireBoolean(boundary[field], true, `${label}.${field}`);
  }
  for (const field of [
    "expoNativeBinaryProved",
    "nativeAsyncStorageBackendProved",
    "osProcessDeathProved",
    "nativeAppStateDeliveryProved",
    "nativeLayoutAndTouchProved",
  ]) {
    requireBoolean(boundary[field], false, `${label}.${field}`);
  }
  return boundary;
};

const validateMobileHarnessReceipts = (receipts, expectedReceipts, label) => {
  assert(
    Array.isArray(receipts) && receipts.length === expectedReceipts.length,
    `${label} must contain exactly ${expectedReceipts.length} receipts.`,
  );
  for (const [index, expected] of expectedReceipts.entries()) {
    const receipt = requireRecord(receipts[index], `${label}[${index}]`);
    for (const key of Object.keys(receipt)) {
      assert(
        MOBILE_RN_RECEIPT_KEYS.has(key),
        `${label}[${index}] contains an unreviewed receipt field.`,
      );
    }
    const [surface, operation, outcome, status] = expected;
    assert(
      receipt.surface === surface &&
        receipt.operation === operation &&
        receipt.outcome === outcome,
      `${label}[${index}] does not match the fixed mobile receipt contract.`,
    );
    if (status === undefined) {
      assert(
        receipt.status === undefined,
        `${label}[${index}] unexpectedly reports an HTTP status.`,
      );
    } else {
      assert(
        receipt.status === status,
        `${label}[${index}] must report HTTP ${status}.`,
      );
    }
    for (const field of [
      "requestIdSha256",
      "resourceIdSha256",
      "responseSha256",
      "stateSha256",
    ]) {
      if (receipt[field] !== undefined) {
        requireSha256(receipt[field], `${label}[${index}].${field}`);
      }
    }
    for (const field of ["bytes", "count", "durationMs", "seq"]) {
      if (receipt[field] !== undefined) {
        requireInteger(receipt[field], `${label}[${index}].${field}`, 0);
      }
    }
  }
  return receipts;
};

const validateMountedRnPhaseResult = async ({
  value,
  phase,
  bunVersion,
  sensitiveValues,
}) => {
  const envelope = assertExactObjectKeys(
    value,
    [
      "version",
      "contract",
      "mode",
      "phase",
      "passed",
      "runtime",
      "boundary",
      "result",
      "receipts",
      "summarySha256",
    ],
    `Mounted RN ${phase} envelope`,
  );
  assert(
    envelope.version === 2 &&
      envelope.contract === MOBILE_RN_ACCEPTANCE_CONTRACT &&
      envelope.mode === "phase" &&
      envelope.phase === phase &&
      envelope.passed === true,
    `Mounted RN ${phase} envelope has another contract identity.`,
  );
  await validateMobileRuntime(
    envelope.runtime,
    bunVersion,
    `Mounted RN ${phase} runtime`,
  );
  validateMobileBoundary(envelope.boundary, `Mounted RN ${phase} boundary`);
  const result = requireRecord(envelope.result, `Mounted RN ${phase} result`);
  assert(
    result.phase === phase && result.passed === true,
    `Mounted RN ${phase} child did not pass the requested phase.`,
  );
  assert(
    canonicalJson(envelope.receipts) === canonicalJson(result.receipts),
    `Mounted RN ${phase} envelope changed its child receipts.`,
  );
  assert(
    requireSha256(envelope.summarySha256, `Mounted RN ${phase} summary`) ===
      sha256(canonicalJson(result)),
    `Mounted RN ${phase} envelope summary does not cover its child result.`,
  );
  const serialized = canonicalJson(envelope);
  for (const sensitive of sensitiveValues) {
    if (typeof sensitive !== "string" || sensitive.length < 8) continue;
    assert(
      !serialized.includes(sensitive),
      `Mounted RN ${phase} hash-only envelope exposed raw authority material.`,
    );
  }
  return envelope;
};

const validateMountedRnFullResult = async ({
  value,
  bunVersion,
  primaryAuthority,
  secondaryAuthority,
  sensitiveValues,
}) => {
  const mobile = assertExactObjectKeys(
    value,
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
    "Mounted RN full result",
  );
  assert(
    mobile.version === 2 &&
      mobile.contract === MOBILE_RN_ACCEPTANCE_CONTRACT &&
      mobile.mode === "full" &&
      mobile.passed === true,
    "Mounted RN full result has another contract identity.",
  );
  await validateMobileRuntime(mobile.runtime, bunVersion, "Mounted RN runtime");
  validateMobileBoundary(mobile.boundary, "Mounted RN boundary");
  validateMobileAuthorityHashes(
    mobile.authority,
    primaryAuthority,
    "Mounted RN authority",
  );

  const enqueue = assertExactObjectKeys(
    mobile.enqueue,
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
    "Mounted RN enqueue",
  );
  assert(
    enqueue.phase === "enqueue_response_loss" && enqueue.passed === true,
    "Mounted RN enqueue phase failed.",
  );
  for (const field of [
    "processIdSha256",
    "mountIdSha256",
    "storageStateSha256",
    "promptSha256",
    "sendIdSha256",
    "dispatchIdSha256",
  ]) {
    requireSha256(enqueue[field], `Mounted RN enqueue.${field}`);
  }
  validateMobileAuthorityHashes(
    enqueue.authority,
    primaryAuthority,
    "Mounted RN enqueue.authority",
  );
  for (const field of [
    "uiSendAccepted",
    "asyncStorageWriteCompletedBeforeNetwork",
    "serverCommittedBeforeResponseLoss",
    "responseWithheldFromHook",
    "processExitsWithPendingOutbox",
  ]) {
    requireBoolean(enqueue[field], true, `Mounted RN enqueue.${field}`);
  }
  const ordering = assertExactObjectKeys(
    enqueue.ordering,
    [
      "asyncStorageWriteCompletion",
      "submitStart",
      "serverResponse",
      "responseWithheld",
    ],
    "Mounted RN enqueue ordering",
  );
  const writeOrdinal = requireInteger(
    ordering.asyncStorageWriteCompletion,
    "Mounted RN AsyncStorage completion ordinal",
    1,
  );
  const submitOrdinal = requireInteger(
    ordering.submitStart,
    "Mounted RN submit ordinal",
    writeOrdinal + 1,
  );
  const responseOrdinal = requireInteger(
    ordering.serverResponse,
    "Mounted RN server response ordinal",
    submitOrdinal + 1,
  );
  const withheldOrdinal = requireInteger(
    ordering.responseWithheld,
    "Mounted RN response withheld ordinal",
    responseOrdinal + 1,
  );
  assert(
    writeOrdinal < submitOrdinal &&
      submitOrdinal < responseOrdinal &&
      responseOrdinal < withheldOrdinal,
    "Mounted RN response-loss ordering is not write-before-network then commit-before-loss.",
  );

  const replay = assertExactObjectKeys(
    mobile.replay,
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
    "Mounted RN replay",
  );
  assert(
    replay.phase === "replay_reconnect_switch" && replay.passed === true,
    "Mounted RN replay phase failed.",
  );
  for (const field of [
    "processIdSha256",
    "mountIdSha256",
    "storageStateSha256",
    "sendIdSha256",
    "dispatchIdSha256",
    "priorStateSha256",
    "messageStateSha256",
  ]) {
    requireSha256(replay[field], `Mounted RN replay.${field}`);
  }
  validateMobileAuthorityHashes(
    replay.authority,
    primaryAuthority,
    "Mounted RN replay.authority",
  );
  validateMobileAuthorityHashes(
    replay.secondaryAuthority,
    secondaryAuthority,
    "Mounted RN replay.secondaryAuthority",
  );
  assert(
    replay.priorStateSha256 === enqueue.storageStateSha256 &&
      replay.sendIdSha256 === enqueue.sendIdSha256 &&
      replay.dispatchIdSha256 === enqueue.dispatchIdSha256,
    "Mounted RN replay changed its durable bytes, idempotency key, or committed dispatch.",
  );
  for (const field of [
    "restoredQueuedMessage",
    "replayCollapsedToCommittedDispatch",
    "acknowledgedAfterTerminal",
  ]) {
    requireBoolean(replay[field], true, `Mounted RN replay.${field}`);
  }
  const acknowledgementOrdering = assertExactObjectKeys(
    replay.terminalAcknowledgementOrdering,
    ["serverTerminalStatus", "asyncStorageOutboxRemoval"],
    "Mounted RN terminal acknowledgement ordering",
  );
  const terminalOrdinal = requireInteger(
    acknowledgementOrdering.serverTerminalStatus,
    "Mounted RN terminal status ordinal",
    1,
  );
  const removalOrdinal = requireInteger(
    acknowledgementOrdering.asyncStorageOutboxRemoval,
    "Mounted RN outbox removal ordinal",
    terminalOrdinal + 1,
  );
  assert(
    terminalOrdinal < removalOrdinal,
    "Mounted RN outbox was removed before canonical terminal status.",
  );

  const reconnect = assertExactObjectKeys(
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
    "Mounted RN cursor reconnect",
  );
  for (const field of [
    "sameMountedClient",
    "resumedWithCursor",
    "resumedWithEpoch",
    "epochStable",
  ]) {
    requireBoolean(reconnect[field], true, `Mounted RN reconnect.${field}`);
  }
  assert(
    reconnect.gapCount === 0 &&
      reconnect.duplicateCount === 0 &&
      requireInteger(
        reconnect.recoveredRecordCount,
        "Mounted RN recovered record count",
        1,
      ) > 0,
    "Mounted RN same-client reconnect was not gapless, duplicate-free, and nonempty.",
  );
  const appState = assertExactObjectKeys(
    replay.appState,
    ["backgroundCallbacks", "activeCallbacks", "foregroundWakeObserved"],
    "Mounted RN AppState",
  );
  requireInteger(
    appState.backgroundCallbacks,
    "Mounted RN background callback count",
    1,
  );
  requireInteger(
    appState.activeCallbacks,
    "Mounted RN active callback count",
    1,
  );
  requireBoolean(
    appState.foregroundWakeObserved,
    true,
    "Mounted RN foreground wake",
  );
  const identitySwitch = assertExactObjectKeys(
    replay.identitySwitch,
    [
      "actualHookRerendered",
      "accountsDiffer",
      "aToBToA",
      "outboxIsolated",
      "aAcknowledgementPreserved",
      "serverAuthorityFenceProved",
    ],
    "Mounted RN identity switch",
  );
  for (const field of [
    "actualHookRerendered",
    "accountsDiffer",
    "aToBToA",
    "outboxIsolated",
    "aAcknowledgementPreserved",
  ]) {
    requireBoolean(
      identitySwitch[field],
      true,
      `Mounted RN identity switch.${field}`,
    );
  }
  requireBoolean(
    identitySwitch.serverAuthorityFenceProved,
    false,
    "Mounted RN local identity switch server-authority claim",
  );
  const noFallback = assertExactObjectKeys(
    replay.noLocalFallback,
    [
      "explicitIssueSha256",
      "attemptedPromptSha256",
      "blockedSendPreservedDraft",
      "localFallbackCount",
      "fallbackNetworkCount",
    ],
    "Mounted RN no-local-fallback",
  );
  requireSha256(
    noFallback.explicitIssueSha256,
    "Mounted RN explicit issue hash",
  );
  requireSha256(
    noFallback.attemptedPromptSha256,
    "Mounted RN attempted outage prompt hash",
  );
  requireBoolean(
    noFallback.blockedSendPreservedDraft,
    true,
    "Mounted RN blocked send preserved draft",
  );
  assert(
    noFallback.localFallbackCount === 0 &&
      noFallback.fallbackNetworkCount === 0,
    "Mounted RN cloud failure used a local or fallback network transport.",
  );

  const clean = assertExactObjectKeys(
    mobile.clean,
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
    "Mounted RN clean hydration",
  );
  assert(
    clean.phase === "clean_hydrate" && clean.passed === true,
    "Mounted RN clean hydration phase failed.",
  );
  for (const field of [
    "processIdSha256",
    "mountIdSha256",
    "messageStateSha256",
    "generationCanaryOutboxStateSha256",
    "generationCanarySendIdSha256",
  ]) {
    requireSha256(clean[field], `Mounted RN clean.${field}`);
  }
  validateMobileAuthorityHashes(
    clean.authority,
    primaryAuthority,
    "Mounted RN clean.authority",
  );
  for (const field of [
    "cleanNamespaceStartedEmpty",
    "canonicalUserProjected",
    "canonicalAssistantProjected",
  ]) {
    requireBoolean(clean[field], true, `Mounted RN clean.${field}`);
  }
  assert(
    clean.localFallbackCount === 0 &&
      mobile.generationCanaryOutboxStateSha256 ===
        clean.generationCanaryOutboxStateSha256,
    "Mounted RN clean hydration used fallback or did not seal its generation canary.",
  );
  requireSha256(
    mobile.generationCanaryOutboxStateSha256,
    "Mounted RN generation canary state hash",
  );
  assert(
    new Set([
      enqueue.processIdSha256,
      replay.processIdSha256,
      clean.processIdSha256,
    ]).size === 3 &&
      new Set([
        enqueue.mountIdSha256,
        replay.mountIdSha256,
        clean.mountIdSha256,
      ]).size === 3,
    "Mounted RN phases did not cross three distinct process and mount identities.",
  );

  const receipts = validateMobileHarnessReceipts(
    mobile.receipts,
    MOBILE_RN_FULL_RECEIPTS,
    "Mounted RN receipts",
  );
  assert(
    canonicalJson(receipts) ===
      canonicalJson([
        ...enqueue.receipts,
        ...replay.receipts,
        ...clean.receipts,
      ]),
    "Mounted RN top-level receipts do not exactly flatten its three child phases.",
  );
  assert(
    enqueue.receipts.length === 2 &&
      replay.receipts.length === 5 &&
      clean.receipts.length === 2,
    "Mounted RN child receipt partition changed.",
  );
  const expectedSummarySha256 = sha256(
    canonicalJson({
      enqueue: enqueue.storageStateSha256,
      replay: replay.messageStateSha256,
      clean: clean.messageStateSha256,
    }),
  );
  assert(
    requireSha256(mobile.summarySha256, "Mounted RN summary hash") ===
      expectedSummarySha256,
    "Mounted RN summary hash does not cover the three reviewed phase states.",
  );
  const serialized = canonicalJson(mobile);
  for (const sensitive of sensitiveValues) {
    if (typeof sensitive !== "string" || sensitive.length < 8) continue;
    assert(
      !serialized.includes(sensitive),
      "Mounted RN hash-only result exposed a raw authority, credential, endpoint, or conversation value.",
    );
  }
  return mobile;
};

const validateMountedRnGenerationResult = async ({
  value,
  bunVersion,
  ready,
  priorMobile,
  oldConversationId,
  newConversationId,
  oldOwnerGeneration,
  newOwnerGeneration,
  sensitiveValues,
}) => {
  const result = assertExactObjectKeys(
    value,
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
    "Mounted RN generation result",
  );
  assert(
    result.version === 2 &&
      result.contract === MOBILE_RN_ACCEPTANCE_CONTRACT &&
      result.mode === "post_reset_generation" &&
      result.passed === true,
    "Mounted RN generation result has another contract identity.",
  );
  const runtime = await validateMobileRuntime(
    result.runtime,
    bunVersion,
    "Mounted RN post-reset runtime",
  );
  validateMobileBoundary(result.boundary, "Mounted RN post-reset boundary");
  assert(
    canonicalJson(runtime.productModuleSha256) ===
      canonicalJson(priorMobile.productModuleSha256),
    "Mounted RN product module bytes changed between full and live reset proofs.",
  );
  const rotation = assertExactObjectKeys(
    result.generationRotation,
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
    "Mounted RN generation rotation",
  );
  assert(
    rotation.phase === "generation_rotation" && rotation.passed === true,
    "Mounted RN generation rotation phase failed.",
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
    requireSha256(rotation[field], `Mounted RN generation.${field}`);
  }
  assert(
    rotation.processIdSha256 === ready.processIdSha256 &&
      rotation.mountIdSha256 === ready.mountIdSha256 &&
      rotation.accountScopeSha256 === priorMobile.accountScopeSha256 &&
      rotation.oldConversationIdSha256 === sha256(oldConversationId) &&
      rotation.conversationIdSha256 === sha256(newConversationId) &&
      rotation.oldGenerationSha256 === sha256(oldOwnerGeneration) &&
      rotation.newGenerationSha256 === sha256(newOwnerGeneration) &&
      rotation.priorStateSha256 ===
        priorMobile.generationCanaryOutboxStateSha256,
    "Mounted RN generation rotation is not bound to the exact live barrier and old/new authorities.",
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
    requireBoolean(rotation[field], true, `Mounted RN generation.${field}`);
  }
  assert(
    rotation.staleCallbackDropCount === 1 && rotation.localFallbackCount === 0,
    "Mounted RN generation rotation did not drop exactly one old callback without fallback.",
  );
  const expectedReceipt = Object.freeze([
    Object.freeze([
      "mobile-client",
      "mobile.rn.owner-generation-rotation",
      "retired-and-purged",
      undefined,
    ]),
  ]);
  validateMobileHarnessReceipts(
    result.receipts,
    expectedReceipt,
    "Mounted RN post-reset receipts",
  );
  assert(
    canonicalJson(result.receipts) === canonicalJson(rotation.receipts) &&
      result.receipts[0].requestIdSha256 ===
        priorMobile.generationCanarySendIdSha256 &&
      result.receipts[0].stateSha256 === rotation.finalStateSha256 &&
      result.receipts[0].count === 1,
    "Mounted RN generation receipt is not the exact sealed old-generation canary lifecycle.",
  );
  assert(
    requireSha256(
      result.summarySha256,
      "Mounted RN post-reset summary hash",
    ) === sha256(canonicalJson(rotation)),
    "Mounted RN post-reset summary does not cover the full generation result.",
  );
  const serialized = canonicalJson(result);
  for (const sensitive of sensitiveValues) {
    if (typeof sensitive !== "string" || sensitive.length < 8) continue;
    assert(
      !serialized.includes(sensitive),
      "Mounted RN post-reset hash-only result exposed a raw authority, credential, endpoint, or conversation value.",
    );
  }
  return result;
};

const startMountedRnGenerationRotation = async ({
  context,
  secrets,
  paths,
  state,
  owner,
  electron,
  rawLog,
}) => {
  const priorMobile = requireRecord(
    state.placement?.mobileSignedInCanonical,
    "Pre-reset mounted RN acceptance state",
  );
  assert(
    priorMobile.conversationId === owner.conversationId &&
      priorMobile.ownerGeneration === owner.ownerGeneration,
    "Mounted RN generation canary belongs to another pre-reset authority.",
  );
  const generationCanaryOutboxStateSha256 = requireSha256(
    priorMobile.generationCanaryOutboxStateSha256,
    "Mounted RN generation canary state",
  );
  const generationCanarySendIdSha256 = requireSha256(
    priorMobile.generationCanarySendIdSha256,
    "Mounted RN generation canary send id",
  );
  const accountScopeSha256 = requireSha256(
    priorMobile.accountScopeSha256,
    "Mounted RN account scope",
  );
  const productModuleSha256 = requireRecord(
    priorMobile.productModuleSha256,
    "Mounted RN product-module state",
  );
  const barrierDirectory = assertNarrowIsolatedPath(
    path.join(paths.stateDirectory, "mobile-generation-rotation-barrier"),
    paths.root,
    "Mounted RN generation barrier",
  );
  assert(
    !(await pathExists(barrierDirectory)),
    "A prior mounted RN generation barrier remains in the harness.",
  );
  await mkdir(barrierDirectory, { recursive: false, mode: 0o700 });
  const readyFile = assertNarrowIsolatedPath(
    path.join(barrierDirectory, "ready.json"),
    paths.root,
    "Mounted RN generation ready file",
  );
  const continueFile = assertNarrowIsolatedPath(
    path.join(barrierDirectory, "continue.json"),
    paths.root,
    "Mounted RN generation continuation file",
  );
  const bunBinary = realpathSync(
    requiredEnv("STELLA_CLOUD_ACCEPTANCE_BUN_1_4_BINARY"),
  );
  const bunVersionResult = await commandResult(bunBinary, ["--version"], {
    cwd: REPO_ROOT,
    timeoutMs: 30_000,
    env: isolatedElectronEnvironment(),
  });
  const bunVersion = requireString(
    bunVersionResult.output,
    "Post-reset mounted RN Bun version",
    64,
  );
  assert(
    /^1\.4\.[0-9]+(?:[-+].*)?$/u.test(bunVersion),
    "Post-reset mounted RN proof requires Bun 1.4.x.",
  );
  const harnessFile = realpathSync(
    path.join(
      REPO_ROOT,
      "packages/mobile/scripts/cloud-canonical-rn-acceptance.mjs",
    ),
  );
  const session = await readElectronSessionAuthority(
    context,
    secrets,
    electron,
    owner.conversationId,
    rawLog,
    "pre-reset mounted RN",
    { minimumRunwayMs: MOBILE_RN_GENERATION_MAX_NO_REFRESH_WINDOW_MS },
  );
  assert(
    accountScopeSha256 === sha256(`account:${session.subject}`),
    "Mounted RN generation canary account scope does not match the live session.",
  );
  const command = startBoundedCommand(bunBinary, [harnessFile], {
    cwd: REPO_ROOT,
    timeoutMs: MOBILE_RN_GENERATION_MAX_NO_REFRESH_WINDOW_MS,
    authorityIdentities: [
      {
        identity: session.tokenIdentity,
        label: "pre-reset mounted RN generation",
      },
    ],
    env: {
      ...isolatedElectronEnvironment(),
      STELLA_MOBILE_RN_ACCEPTANCE_MODE: "post_reset_generation",
      STELLA_MOBILE_ACCEPTANCE_RUN_ID: context.runId,
      STELLA_MOBILE_ACCEPTANCE_HARNESS_ROOT: paths.root,
      STELLA_MOBILE_ACCEPTANCE_CONVEX_ORIGIN: context.target.convexUrl,
      STELLA_MOBILE_ACCEPTANCE_CONVEX_SITE_ORIGIN: context.target.convexSiteUrl,
      STELLA_MOBILE_ACCEPTANCE_BUILDER_ORIGIN: context.target.cloudBuilderUrl,
      STELLA_MOBILE_ACCEPTANCE_TIMEOUT_MS: String(
        MOBILE_RN_GENERATION_PHASE_TIMEOUT_MS,
      ),
      STELLA_MOBILE_ACCEPTANCE_JWT: session.token,
      STELLA_MOBILE_ACCEPTANCE_SESSION_SUBJECT: session.subject,
      STELLA_MOBILE_ACCEPTANCE_SESSION_ID: session.sessionId,
      STELLA_MOBILE_ACCEPTANCE_OWNER_GENERATION: owner.ownerGeneration,
      STELLA_MOBILE_ACCEPTANCE_CONVERSATION_ID: owner.conversationId,
      EXPECTED_PRIOR_STATE_SHA256: generationCanaryOutboxStateSha256,
      STELLA_MOBILE_ACCEPTANCE_ROTATION_BARRIER_DIR: barrierDirectory,
    },
  });
  const proofDeadlineAt =
    command.startedAt + MOBILE_RN_GENERATION_PHASE_TIMEOUT_MS;
  const ready = await poll(
    async () => {
      if (!(await pathExists(readyFile))) {
        assert(
          processAlive(command.child.pid),
          "Mounted RN generation child exited before its ready barrier.",
        );
        return null;
      }
      const metadata = await stat(readyFile);
      assert(
        metadata.isFile() && (metadata.mode & 0o777) === 0o600,
        "Mounted RN ready barrier is not a private regular file.",
      );
      return requireRecord(
        parseJsonOutput(
          await readFile(readyFile, "utf8"),
          "Mounted RN ready barrier",
        ),
        "Mounted RN ready barrier",
      );
    },
    (value) => isRecord(value),
    {
      timeoutMs: MOBILE_RN_GENERATION_PHASE_TIMEOUT_MS,
      intervalMs: 50,
      label: "mounted RN live generation ready barrier",
    },
  );
  assertExactObjectKeys(
    ready,
    [
      "version",
      "processIdSha256",
      "mountIdSha256",
      "accountScopeSha256",
      "ownerGenerationSha256",
      "conversationIdSha256",
      "canarySendIdSha256",
      "serverAdmissionResponseHeld",
      "staleSocketLive",
    ],
    "Mounted RN ready barrier",
  );
  assert(
    ready.version === 1 &&
      requireSha256(ready.processIdSha256, "Mounted RN ready process") &&
      requireSha256(ready.mountIdSha256, "Mounted RN ready mount") &&
      ready.accountScopeSha256 === accountScopeSha256 &&
      ready.ownerGenerationSha256 === sha256(owner.ownerGeneration) &&
      ready.conversationIdSha256 === sha256(owner.conversationId) &&
      ready.canarySendIdSha256 === generationCanarySendIdSha256 &&
      ready.serverAdmissionResponseHeld === true &&
      ready.staleSocketLive === true,
    "Mounted RN ready barrier is not the exact live old-generation canary.",
  );
  rawLog.push(
    rawReceipt("mobile-client", "mobile.rn.generation-barrier.ready", {
      outcome: "held-across-reset",
      requestIdSha256: generationCanarySendIdSha256,
      resourceIdSha256: sha256(owner.conversationId),
      responseSha256: sha256(canonicalJson(ready)),
    }),
  );
  return {
    command,
    proofDeadlineAt,
    bunVersion,
    ready,
    readyFile,
    continueFile,
    barrierDirectory,
    session,
    priorMobile: {
      accountScopeSha256,
      generationCanaryOutboxStateSha256,
      generationCanarySendIdSha256,
      productModuleSha256,
    },
  };
};

const waitForConversationSocketClose = async ({
  baseUrl,
  conversationId,
  jwt,
  refreshJwt,
  expectedCloseCode,
  label,
  timeoutMs = 30_000,
}) => {
  assert(
    typeof WebSocket === "function",
    "The strict driver runtime has no real WebSocket implementation.",
  );
  const url = new URL(
    `/conversations/${encodeURIComponent(conversationId)}/socket`,
    baseUrl,
  );
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  url.searchParams.set("protocol", "1");
  return await new Promise((resolve, reject) => {
    const frames = [];
    let refreshSent = false;
    const socket = new WebSocket(url.toString(), [
      "stella.v1",
      `stella.token.${jwt}`,
    ]);
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        // Timeout owns the failure below.
      }
      reject(new CloudProofError(`${label} timed out.`));
    }, timeoutMs);
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      if (frames.length < 32) frames.push(event.data);
      if (!refreshJwt || refreshSent) return;
      try {
        const frame = JSON.parse(event.data);
        if (frame?.type !== "ready") return;
      } catch {
        return;
      }
      refreshSent = true;
      socket.send(JSON.stringify({ type: "auth", token: refreshJwt }));
    });
    socket.addEventListener("close", (event) => {
      clearTimeout(timer);
      try {
        assert(
          event.code === expectedCloseCode,
          `${label} closed with ${event.code}, expected ${expectedCloseCode}.`,
        );
        if (refreshJwt) {
          assert(refreshSent, `${label} closed before the auth refresh.`);
        }
        resolve({
          closeCode: event.code,
          refreshSent,
          frameSetSha256: sha256(canonicalJson(frames)),
          frameCount: frames.length,
        });
      } catch (error) {
        reject(error);
      }
    });
    socket.addEventListener("error", () => {
      // Refusal handshakes deliberately surface as close events; the exact
      // close code, rather than an opaque browser error, is the contract.
    });
  });
};

const proveMobileServerAuthorityFences = async ({
  context,
  secrets,
  secondarySecrets,
  anonymousSecrets,
  primaryOwner,
  secondaryOwner,
  primaryConversationId,
  rawLog,
}) => {
  const admission = executionAdmission({
    context,
    suffix: "mobile-cross-owner-fence",
    conversationId: primaryConversationId,
    expectedOwnerGeneration: secondaryOwner.ownerGeneration,
    kind: "chat",
    subject: "portable",
    prompt: `MOBILE-CROSS-OWNER-FENCE-${context.runId}`,
  });
  const started = Date.now();
  const response = await requestJson(
    `${context.target.convexSiteUrl}/api/mobile/execution/submit`,
    {
      label: "cross-owner mobile execution admission fence",
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      method: "POST",
      headers: userHeaders(anonymousSecrets),
      body: JSON.stringify(admission.body),
      expectedStatuses: [403],
      maxResponseBytes: 64_000,
    },
  );
  assert(
    response.status === 403 &&
      String(response.body?.error ?? response.body?.message ?? "") ===
        "Sign in with an account to use Stella mobile.",
    "Isolated anonymous mobile execution did not fail at the exact account-policy fence.",
  );
  rawLog.push(
    requestReceipt(
      "mobile-http",
      "mobile.anonymous-policy-rejection.submit",
      response,
      started,
      primaryConversationId,
    ),
  );
  const anonymousPolicyReason = "Sign in with an account to use Stella mobile.";
  const policyProbes = await Promise.all([
    requestJson(
      `${context.target.convexSiteUrl}/api/mobile/execution/status?dispatchId=anonymous-policy-probe`,
      {
        label: "anonymous mobile execution status policy fence",
        timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        method: "GET",
        headers: userHeaders(anonymousSecrets),
        expectedStatuses: [403],
        maxResponseBytes: 64_000,
      },
    ),
    requestJson(`${context.target.convexSiteUrl}/api/mobile/execution/cancel`, {
      label: "anonymous mobile execution cancel policy fence",
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      method: "POST",
      headers: userHeaders(anonymousSecrets),
      body: JSON.stringify({}),
      expectedStatuses: [403],
      maxResponseBytes: 64_000,
    }),
  ]);
  for (const [index, policyResponse] of policyProbes.entries()) {
    assert(
      policyResponse.status === 403 &&
        String(
          policyResponse.body?.error ?? policyResponse.body?.message ?? "",
        ) === anonymousPolicyReason,
      "Anonymous mobile status/cancel did not fail at the exact account-policy fence.",
    );
    rawLog.push(
      requestReceipt(
        "mobile-http",
        index === 0
          ? "mobile.anonymous-policy-rejection.status"
          : "mobile.anonymous-policy-rejection.cancel",
        policyResponse,
        started,
        primaryConversationId,
      ),
    );
  }

  const initialCrossOwner = await waitForConversationSocketClose({
    baseUrl: context.target.cloudBuilderUrl,
    conversationId: primaryConversationId,
    jwt: secondarySecrets.jwt,
    expectedCloseCode: 4404,
    label: "Initial cross-owner conversation socket",
  });
  rawLog.push(
    rawReceipt("worker", "mobile.server-fence.cross-owner-socket", {
      outcome: "not-found-private",
      resourceIdSha256: sha256(primaryConversationId),
      responseSha256: initialCrossOwner.frameSetSha256,
      count: initialCrossOwner.closeCode,
    }),
  );

  const liveIdentitySwitch = await waitForConversationSocketClose({
    baseUrl: context.target.cloudBuilderUrl,
    conversationId: primaryConversationId,
    jwt: secrets.jwt,
    refreshJwt: secondarySecrets.jwt,
    expectedCloseCode: 4403,
    label: "Live conversation socket identity switch",
  });
  rawLog.push(
    rawReceipt("worker", "mobile.server-fence.live-socket-reauth", {
      outcome: "forbidden",
      resourceIdSha256: sha256(primaryConversationId),
      responseSha256: liveIdentitySwitch.frameSetSha256,
      count: liveIdentitySwitch.closeCode,
    }),
  );
  assert(
    primaryOwner.ownerId !== secondaryOwner.ownerId &&
      primaryOwner.ownerGeneration !== undefined &&
      secondaryOwner.ownerGeneration !== undefined,
    "Mobile server-fence proof did not use two distinct authenticated owners.",
  );
  return {
    anonymousAccountAdmissionStatus: response.status,
    anonymousAccountStatusProbeStatus: policyProbes[0].status,
    anonymousAccountCancelProbeStatus: policyProbes[1].status,
    anonymousAccountPolicyReasonSha256: sha256(anonymousPolicyReason),
    initialCrossOwnerSocketCloseCode: initialCrossOwner.closeCode,
    liveSocketIdentitySwitchCloseCode: liveIdentitySwitch.closeCode,
    anonymousAccountAdmissionRejected: true,
    initialCrossOwnerSocketPrivateNotFound: true,
    liveSocketIdentitySwitchRejected: true,
  };
};

const stepMobileMountedRnCanonicalSync = async ({
  context,
  secrets,
  paths,
  state,
  rawLog,
  checkpoint,
}) => {
  const owner = await recoverOwnerIdentity(context, secrets, state, rawLog);
  const secondary = requireRecord(
    state.secondary,
    "Secondary mobile acceptance owner",
  );
  const secondaryConversationId = requireUuid(
    secondary.conversationId,
    "Secondary mobile acceptance conversation",
  );
  const secondaryOwnerGeneration = requireString(
    secondary.ownerGeneration,
    "Secondary mobile acceptance owner generation",
    512,
  );
  assert(
    secondary.identityClass === "connected-secondary",
    "Secondary mobile authority is not the isolated connected acceptance identity.",
  );
  const secondaryElectron = currentSecondaryElectron(state);
  let secondaryAuthoritySession = await readElectronSessionAuthority(
    context,
    secrets,
    secondaryElectron,
    secondaryConversationId,
    rawLog,
    "connected-secondary mobile",
    {
      expectedIdentitySha256: secondary.sessionSubjectSha256,
      expectedSessionIdSha256: secondary.sessionIdSha256,
      expectedOwnerAccountSha256: secondary.ownerIdSha256,
    },
  );
  let secondarySecrets = ephemeralJwtSecrets(
    secrets,
    secondaryAuthoritySession.token,
    "connected-secondary mobile",
  );
  const secondaryOwner = await ownerLookup(
    context,
    secondarySecrets,
    secondaryConversationId,
    rawLog,
  );
  assert(
    sha256(secondaryOwner.ownerId) === secondary.ownerIdSha256 &&
      secondaryOwner.ownerGeneration === secondaryOwnerGeneration &&
      secondaryOwner.ownerId !== owner.ownerId,
    "Secondary mobile authority does not match the deployed distinct-owner fence.",
  );

  const electron = currentElectron(state);
  const initialPrimarySession = await readElectronSessionAuthority(
    context,
    secrets,
    electron,
    owner.conversationId,
    rawLog,
    "primary mobile",
  );
  const initialSecondarySession = {
    subject: secondaryAuthoritySession.subject,
    sessionId: secondaryAuthoritySession.sessionId,
    token: secondaryAuthoritySession.token,
  };
  assert(
    initialPrimarySession.subject !== initialSecondarySession.subject &&
      initialPrimarySession.sessionId !== initialSecondarySession.sessionId,
    "Mounted mobile A/B proof did not use distinct authenticated sessions.",
  );
  const primarySessionAfterSecondaryRead = await readElectronSessionAuthority(
    context,
    secrets,
    electron,
    owner.conversationId,
    rawLog,
    "primary mobile after isolated secondary read",
  );
  assert(
    primarySessionAfterSecondaryRead.subject ===
      initialPrimarySession.subject &&
      primarySessionAfterSecondaryRead.sessionId ===
        initialPrimarySession.sessionId,
    "The isolated secondary profile mutated the primary Electron authority.",
  );

  const bunDeclared = requiredEnv("STELLA_CLOUD_ACCEPTANCE_BUN_1_4_BINARY");
  assert(
    path.isAbsolute(bunDeclared),
    "STELLA_CLOUD_ACCEPTANCE_BUN_1_4_BINARY must be absolute.",
  );
  const bunBinary = realpathSync(bunDeclared);
  assert(
    statSync(bunBinary).isFile(),
    "STELLA_CLOUD_ACCEPTANCE_BUN_1_4_BINARY is not a file.",
  );
  const bunVersionResult = await commandResult(bunBinary, ["--version"], {
    cwd: REPO_ROOT,
    timeoutMs: 30_000,
    env: isolatedElectronEnvironment(),
  });
  const bunVersion = requireString(
    bunVersionResult.output,
    "Mounted RN acceptance Bun version",
    64,
  );
  assert(
    /^1\.4\.[0-9]+(?:[-+].*)?$/u.test(bunVersion),
    "The mounted RN real-product harness requires Bun 1.4.x.",
  );
  rawLog.push(
    rawReceipt("mobile-client", "mobile.runtime.bun-version", {
      outcome: "verified",
      responseSha256: sha256(bunVersion),
      processOutputSha256: bunVersionResult.outputSha256,
      durationMs: bunVersionResult.durationMs,
    }),
  );

  const harnessFile = realpathSync(
    path.join(
      REPO_ROOT,
      "packages/mobile/scripts/cloud-canonical-rn-acceptance.mjs",
    ),
  );
  assert(
    inside(harnessFile, REPO_ROOT) && statSync(harnessFile).isFile(),
    "The fixed mounted RN acceptance harness is unavailable.",
  );
  let latestPrimarySession = initialPrimarySession;
  let latestSecondarySession = initialSecondarySession;
  const phaseCommandResults = [];
  const phaseSensitiveValues = [];
  const runMountedRnPhase = async (
    phase,
    { expectedPriorStateSha256 = null, needsSecondary = false } = {},
  ) => {
    const primaryPhaseSession = await readElectronSessionAuthority(
      context,
      secrets,
      electron,
      owner.conversationId,
      rawLog,
      `mounted RN ${phase} primary`,
      { minimumRunwayMs: MOBILE_RN_PHASE_MAX_NO_REFRESH_WINDOW_MS },
    );
    assert(
      primaryPhaseSession.subject === initialPrimarySession.subject &&
        primaryPhaseSession.sessionId === initialPrimarySession.sessionId,
      `Mounted RN ${phase} primary authority changed between phases.`,
    );
    secrets = ephemeralJwtSecrets(
      secrets,
      primaryPhaseSession.token,
      `mounted RN ${phase} primary`,
    );
    latestPrimarySession = primaryPhaseSession;

    let secondaryPhaseSession = null;
    if (needsSecondary) {
      secondaryPhaseSession = await readElectronSessionAuthority(
        context,
        secrets,
        secondaryElectron,
        secondaryConversationId,
        rawLog,
        `mounted RN ${phase} secondary`,
        {
          expectedIdentitySha256: secondary.sessionSubjectSha256,
          expectedSessionIdSha256: secondary.sessionIdSha256,
          expectedOwnerAccountSha256: secondary.ownerIdSha256,
          minimumRunwayMs: MOBILE_RN_PHASE_MAX_NO_REFRESH_WINDOW_MS,
        },
      );
      secondarySecrets = ephemeralJwtSecrets(
        secondarySecrets,
        secondaryPhaseSession.token,
        `mounted RN ${phase} secondary`,
      );
      latestSecondarySession = secondaryPhaseSession;
    }

    const phaseEnvironment = {
      ...isolatedElectronEnvironment(),
      STELLA_MOBILE_RN_ACCEPTANCE_MODE: "phase",
      STELLA_MOBILE_RN_ACCEPTANCE_PHASE: phase,
      STELLA_MOBILE_ACCEPTANCE_RUN_ID: context.runId,
      STELLA_MOBILE_ACCEPTANCE_HARNESS_ROOT: paths.root,
      STELLA_MOBILE_ACCEPTANCE_CONVEX_ORIGIN: context.target.convexUrl,
      STELLA_MOBILE_ACCEPTANCE_CONVEX_SITE_ORIGIN: context.target.convexSiteUrl,
      STELLA_MOBILE_ACCEPTANCE_BUILDER_ORIGIN: context.target.cloudBuilderUrl,
      STELLA_MOBILE_ACCEPTANCE_TIMEOUT_MS: String(MOBILE_RN_PHASE_TIMEOUT_MS),
      STELLA_MOBILE_ACCEPTANCE_JWT: primaryPhaseSession.token,
      STELLA_MOBILE_ACCEPTANCE_SESSION_SUBJECT: primaryPhaseSession.subject,
      STELLA_MOBILE_ACCEPTANCE_SESSION_ID: primaryPhaseSession.sessionId,
      STELLA_MOBILE_ACCEPTANCE_OWNER_GENERATION: owner.ownerGeneration,
      STELLA_MOBILE_ACCEPTANCE_CONVERSATION_ID: owner.conversationId,
      ...(expectedPriorStateSha256 === null
        ? {}
        : {
            STELLA_MOBILE_RN_EXPECTED_PRIOR_STATE_SHA256:
              expectedPriorStateSha256,
          }),
      ...(secondaryPhaseSession === null
        ? {}
        : {
            STELLA_MOBILE_ACCEPTANCE_SECONDARY_JWT: secondaryPhaseSession.token,
            STELLA_MOBILE_ACCEPTANCE_SECONDARY_SESSION_SUBJECT:
              secondaryPhaseSession.subject,
            STELLA_MOBILE_ACCEPTANCE_SECONDARY_SESSION_ID:
              secondaryPhaseSession.sessionId,
            STELLA_MOBILE_ACCEPTANCE_SECONDARY_OWNER_GENERATION:
              secondaryOwnerGeneration,
            STELLA_MOBILE_ACCEPTANCE_SECONDARY_CONVERSATION_ID:
              secondaryConversationId,
          }),
    };
    const authorityIdentities = [
      {
        identity: primaryPhaseSession.tokenIdentity,
        label: `mounted RN ${phase} primary`,
      },
      ...(secondaryPhaseSession === null
        ? []
        : [
            {
              identity: secondaryPhaseSession.tokenIdentity,
              label: `mounted RN ${phase} secondary`,
            },
          ]),
    ];
    const command = await commandResult(bunBinary, [harnessFile], {
      cwd: REPO_ROOT,
      timeoutMs: MOBILE_RN_PHASE_MAX_NO_REFRESH_WINDOW_MS,
      env: phaseEnvironment,
      authorityIdentities,
    });
    const sensitiveValues = [
      context.runId,
      primaryPhaseSession.token,
      primaryPhaseSession.subject,
      primaryPhaseSession.sessionId,
      secondaryPhaseSession?.token,
      secondaryPhaseSession?.subject,
      secondaryPhaseSession?.sessionId,
      owner.ownerGeneration,
      secondaryOwnerGeneration,
      owner.conversationId,
      secondaryConversationId,
      context.target.convexUrl,
      context.target.convexSiteUrl,
      context.target.cloudBuilderUrl,
    ];
    const envelope = await validateMountedRnPhaseResult({
      value: parseJsonOutput(
        command.output,
        `Mounted RN ${phase} canonical acceptance`,
      ),
      phase,
      bunVersion,
      sensitiveValues,
    });
    phaseCommandResults.push({
      phase,
      outputSha256: command.outputSha256,
      durationMs: command.durationMs,
    });
    phaseSensitiveValues.push(...sensitiveValues);
    return envelope;
  };

  const enqueueEnvelope = await runMountedRnPhase("enqueue_response_loss");
  const replayEnvelope = await runMountedRnPhase("replay_reconnect_switch", {
    expectedPriorStateSha256: requireSha256(
      enqueueEnvelope.result.storageStateSha256,
      "Mounted RN enqueue state for replay",
    ),
    needsSecondary: true,
  });
  const cleanEnvelope = await runMountedRnPhase("clean_hydrate");
  assert(
    canonicalJson(enqueueEnvelope.runtime) ===
      canonicalJson(replayEnvelope.runtime) &&
      canonicalJson(replayEnvelope.runtime) ===
        canonicalJson(cleanEnvelope.runtime) &&
      canonicalJson(enqueueEnvelope.boundary) ===
        canonicalJson(replayEnvelope.boundary) &&
      canonicalJson(replayEnvelope.boundary) ===
        canonicalJson(cleanEnvelope.boundary),
    "Mounted RN phase processes did not report one reviewed runtime boundary.",
  );
  const assembledMountedRn = {
    version: 2,
    contract: MOBILE_RN_ACCEPTANCE_CONTRACT,
    mode: "full",
    passed: true,
    runtime: enqueueEnvelope.runtime,
    boundary: enqueueEnvelope.boundary,
    authority: enqueueEnvelope.result.authority,
    enqueue: enqueueEnvelope.result,
    replay: replayEnvelope.result,
    clean: cleanEnvelope.result,
    generationCanaryOutboxStateSha256:
      cleanEnvelope.result.generationCanaryOutboxStateSha256,
    receipts: [
      ...enqueueEnvelope.receipts,
      ...replayEnvelope.receipts,
      ...cleanEnvelope.receipts,
    ],
    summarySha256: sha256(
      canonicalJson({
        enqueue: enqueueEnvelope.result.storageStateSha256,
        replay: replayEnvelope.result.messageStateSha256,
        clean: cleanEnvelope.result.messageStateSha256,
      }),
    ),
  };
  const primaryAuthority = mobileAuthorityHashes({
    subject: latestPrimarySession.subject,
    sessionId: latestPrimarySession.sessionId,
    ownerGeneration: owner.ownerGeneration,
    conversationId: owner.conversationId,
    socketOrigin: context.target.cloudBuilderUrl,
  });
  const secondaryAuthority = mobileAuthorityHashes({
    subject: latestSecondarySession.subject,
    sessionId: latestSecondarySession.sessionId,
    ownerGeneration: secondaryOwnerGeneration,
    conversationId: secondaryConversationId,
    socketOrigin: context.target.cloudBuilderUrl,
  });
  const mountedRn = await validateMountedRnFullResult({
    value: assembledMountedRn,
    bunVersion,
    primaryAuthority,
    secondaryAuthority,
    sensitiveValues: phaseSensitiveValues,
  });
  const mountedRnResultSha256 = sha256(canonicalJson(mountedRn));
  const receiptSetSha256 = sha256(canonicalJson(mountedRn.receipts));
  for (const receipt of mountedRn.receipts) {
    const fields = {};
    for (const field of [
      "status",
      "outcome",
      "requestIdSha256",
      "resourceIdSha256",
      "responseSha256",
      "stateSha256",
      "bytes",
      "count",
      "durationMs",
      "seq",
    ]) {
      if (receipt[field] !== undefined) fields[field] = receipt[field];
    }
    rawLog.push(rawReceipt(receipt.surface, receipt.operation, fields));
  }
  rawLog.push(
    rawReceipt("mobile-client", "mobile.rn.acceptance.full-process", {
      outcome: "completed",
      processOutputSha256: sha256(
        canonicalJson(
          phaseCommandResults.map(({ phase, outputSha256 }) => ({
            phase,
            outputSha256,
          })),
        ),
      ),
      responseSha256: mountedRnResultSha256,
      stateSha256: receiptSetSha256,
      durationMs: phaseCommandResults.reduce(
        (total, phase) => total + phase.durationMs,
        0,
      ),
      count: phaseCommandResults.length,
    }),
  );

  const marker = `MOBILE-RN-RESPONSE-LOSS-${context.runId}`;
  assert(
    mountedRn.enqueue.promptSha256 === sha256(marker),
    "Mounted RN enqueue prompt hash is not the deterministic reviewed marker.",
  );
  const journal = await loadWholeJournal(
    context,
    secrets,
    owner.conversationId,
    rawLog,
  );
  const promptRows = journal.records.filter(
    (record) =>
      record?.kind === "message" &&
      record.role === "user" &&
      messageText(record.payload) === marker,
  );
  assert(
    promptRows.length === 1,
    "Driver reread did not find exactly one mounted RN prompt in the canonical journal.",
  );
  const promptRow = promptRows[0];
  const dispatchId = requireString(
    promptRow.clientMsgId,
    "Mounted RN canonical dispatch id",
    128,
  );
  assert(
    sha256(dispatchId) === mountedRn.enqueue.dispatchIdSha256 &&
      sha256(dispatchId) === mountedRn.replay.dispatchIdSha256,
    "Mounted RN receipt and canonical journal disagree on the committed dispatch.",
  );
  const turnId = requireUuid(
    promptRow.turnId,
    "Mounted RN canonical cloud turn id",
  );
  const terminal = terminalForTurn(journal, turnId);
  assert(
    terminal.phase === "completed" && terminal.seq > promptRow.seq,
    "Mounted RN canonical turn is not one ordered completed journal span.",
  );
  const dispatchStatus = requireRecord(
    await convexCall(
      context,
      secrets,
      "query",
      "execution_placement:getMyExecutionDispatchStatus",
      { dispatchId },
      "read mounted RN execution dispatch",
      rawLog,
    ),
    "Mounted RN execution dispatch",
  );
  assert(
    dispatchStatus.dispatchId === dispatchId &&
      dispatchStatus.cloudTurnId === turnId &&
      dispatchStatus.state === "completed" &&
      dispatchStatus.placement === "cloud",
    "Mounted RN dispatch status is not the exact completed cloud journal turn.",
  );
  const mobileOwner = await ownerLookup(
    context,
    secrets,
    owner.conversationId,
    rawLog,
  );
  assert(
    mobileOwner.ownerId === owner.ownerId &&
      mobileOwner.ownerGeneration === owner.ownerGeneration,
    "Mounted RN canonical conversation crossed its owner-generation fence.",
  );
  const probe = await acceptanceProbe(
    context,
    secrets,
    mobileOwner,
    owner.conversationId,
    "status",
    rawLog,
  );
  const anonymousPolicyVite = {
    pid: electron.vitePid,
    port: electron.devServerPort,
    logFile: path.join(paths.processLogDirectory, "vite.log"),
    dataDir: electron.viteDataDir ?? viteDataPath(paths),
    processFingerprintSha256: electron.viteProcessFingerprintSha256,
    listenerAddressesSha256: electron.viteListenerAddressesSha256,
  };
  const anonymousPolicyElectron = await launchElectron(
    context,
    secrets,
    paths,
    "anonymous-mobile-policy",
    anonymousPolicyVite,
    rawLog,
  );
  await checkpoint({ anonymousPolicyElectron });
  const anonymousPolicyAuthority = await readAnonymousElectronAuthority(
    context,
    secrets,
    anonymousPolicyElectron,
    rawLog,
    "anonymous mobile policy",
  );
  const anonymousPolicyOwnerId =
    anonymousPolicyAuthority.jwtIdentity.tokenIdentifier;
  const anonymousMobilePolicy = {
    ownerId: anonymousPolicyOwnerId,
    ownerIdSha256: sha256(anonymousPolicyOwnerId),
    ownerGeneration: requireString(
      (
        await convexInternalRun(
          secrets,
          "owner_lifecycle:getOwnerDataAccessStateInternal",
          { ownerId: anonymousPolicyOwnerId },
          rawLog,
        )
      )?.generation,
      "Anonymous mobile policy owner generation",
      512,
    ),
    sessionSubjectSha256: sha256(anonymousPolicyAuthority.subject),
    sessionIdSha256: sha256(anonymousPolicyAuthority.sessionId),
    revocationRequested: false,
  };
  await checkpoint({ anonymousMobilePolicy });
  let serverAuthorityFence;
  try {
    const fencePrimarySession = await readElectronSessionAuthority(
      context,
      secrets,
      electron,
      owner.conversationId,
      rawLog,
      "mobile server-fence primary",
    );
    assert(
      fencePrimarySession.subject === initialPrimarySession.subject &&
        fencePrimarySession.sessionId === initialPrimarySession.sessionId,
      "Mobile server-fence primary authority changed after mounted phases.",
    );
    secrets = ephemeralJwtSecrets(
      secrets,
      fencePrimarySession.token,
      "mobile server-fence primary",
    );
    secondaryAuthoritySession = await readElectronSessionAuthority(
      context,
      secrets,
      secondaryElectron,
      secondaryConversationId,
      rawLog,
      "mobile server-fence secondary",
      {
        expectedIdentitySha256: secondary.sessionSubjectSha256,
        expectedSessionIdSha256: secondary.sessionIdSha256,
        expectedOwnerAccountSha256: secondary.ownerIdSha256,
      },
    );
    secondarySecrets = ephemeralJwtSecrets(
      secondarySecrets,
      secondaryAuthoritySession.token,
      "mobile server-fence secondary",
    );
    serverAuthorityFence = await proveMobileServerAuthorityFences({
      context,
      secrets,
      secondarySecrets,
      anonymousSecrets: anonymousPolicyAuthority.secrets,
      primaryOwner: owner,
      secondaryOwner,
      primaryConversationId: owner.conversationId,
      rawLog,
    });
  } finally {
    try {
      const revoked = await cdpEvaluate(
        anonymousPolicyElectron,
        `(async () => await window.electronAPI.system.deleteAuthUser())()`,
        "delete anonymous mobile policy acceptance account",
        120_000,
      );
      assert(
        revoked?.ok === true,
        "Electron did not revoke the anonymous mobile policy account.",
      );
      rawLog.push(
        rawReceipt(
          "electron-process",
          "electron.anonymous-mobile-policy.revoke",
          {
            outcome: "revoked",
            responseSha256: sha256(canonicalJson(revoked)),
            resourceIdSha256: sha256(anonymousPolicyOwnerId),
          },
        ),
      );
      await checkpoint({
        anonymousMobilePolicy: {
          ...anonymousMobilePolicy,
          revocationRequested: true,
        },
      });
    } finally {
      if (processAlive(anonymousPolicyElectron.pid)) {
        await stopProcess(
          anonymousPolicyElectron.pid,
          "electron.anonymous-mobile-policy",
          rawLog,
          {
            expectedProcessFingerprintSha256:
              anonymousPolicyElectron.processFingerprintSha256,
          },
        );
      }
    }
  }

  return {
    observations: {
      conversationId: owner.conversationId,
      turnId,
      dispatchId,
      ownerGeneration: owner.ownerGeneration,
      chosenLocation: dispatchStatus.placement,
      terminalState: dispatchStatus.state,
      terminalRevision: requireInteger(
        dispatchStatus.revision,
        "Mounted RN terminal revision",
        1,
      ),
      journalEpoch: requireInteger(
        journal.head.epoch,
        "Mounted RN journal epoch",
        0,
      ),
      promptSeq: requireInteger(promptRow.seq, "Mounted RN prompt sequence", 0),
      terminalSeq: requireInteger(
        terminal.seq,
        "Mounted RN terminal sequence",
        promptRow.seq + 1,
      ),
      durableObjectIdSha256: probe.durableObjectIdSha256,
      serverAuthorityFence,
      mountedRn,
      mountedRnResultSha256,
      receiptSetSha256,
      fenceVerified: true,
    },
    patch: {
      placement: {
        ...(state.placement ?? {}),
        mobileSignedInCanonical: {
          conversationId: owner.conversationId,
          turnId,
          dispatchId,
          ownerGeneration: owner.ownerGeneration,
          journalEpoch: journal.head.epoch,
          promptSeq: promptRow.seq,
          terminalSeq: terminal.seq,
          durableObjectIdSha256: probe.durableObjectIdSha256,
          mountedRnResultSha256,
          receiptSetSha256,
          accountScopeSha256: mountedRn.authority.accountScopeSha256,
          generationCanaryOutboxStateSha256:
            mountedRn.generationCanaryOutboxStateSha256,
          generationCanarySendIdSha256:
            mountedRn.clean.generationCanarySendIdSha256,
          productModuleSha256: mountedRn.runtime.productModuleSha256,
        },
      },
    },
  };
};

const browserRoutingResultFromRecovery = ({
  state,
  browser,
  pending,
  storageProof,
}) => {
  const baseObservations = requireRecord(
    pending.baseObservations,
    "Pending browser routing observations",
  );
  const placement = requireRecord(
    pending.placement,
    "Pending browser placement state",
  );
  assert(
    Array.isArray(pending.renderedProofs) &&
      pending.renderedProofs.length === 6,
    "Pending browser proof roster is incomplete before storage recovery.",
  );
  const renderedProofs = [...pending.renderedProofs, storageProof];
  return {
    startedAt: requireString(
      pending.startedAt,
      "Browser routing original start timestamp",
      64,
    ),
    observations: {
      ...baseObservations,
      renderedProofs,
      renderedProofSetSha256: renderedProofSetSha256(renderedProofs),
      renderedStorageRecoverySha256: storageProof.receipt.receiptSha256,
      renderedStorageRecoveryCheckpointSha256:
        storageProof.observation.checkpointSha256,
      renderedStorageRecoveryRequiredHumanAction: true,
      renderedStorageRecoveryCredentialMaterialReturned: false,
    },
    patch: {
      placement: {
        ...(state.placement ?? {}),
        browser: {
          ...placement,
          renderedProofSetSha256: renderedProofSetSha256(renderedProofs),
          renderedStorageRecoverySha256: storageProof.receipt.receiptSha256,
        },
      },
      renderedBrowser: browser,
      browserRecovery: null,
    },
  };
};

const resumeBrowserStorageRecovery = async ({
  context,
  state,
  rawLog,
  checkpoint,
}) => {
  const pending = requireRecord(
    state.browserRecovery,
    "Pending browser storage recovery",
  );
  assert(
    [
      "awaiting-external-inbox-completion",
      "login-completed",
      "recovery-completed",
    ].includes(pending.status),
    "Browser storage recovery checkpoint has an invalid phase.",
  );
  assert(
    Array.isArray(pending.pendingRawLog),
    "Browser storage recovery omitted its pre-handoff receipt ledger.",
  );
  rawLog.unshift(...pending.pendingRawLog);
  const browser = currentRenderedBrowser(state);
  if (pending.status === "recovery-completed") {
    const storageProof = requireRecord(
      pending.storageProof,
      "Completed browser storage proof",
    );
    return browserRoutingResultFromRecovery({
      state,
      browser,
      pending,
      storageProof,
    });
  }
  const client =
    pending.status === "awaiting-external-inbox-completion"
      ? await connectPreparedAuthSurface(
          browser,
          "browser-cdp",
          requireSha256(
            pending.recoveryCheckpoint.targetIdSha256,
            "Browser storage recovery target hash",
          ),
        )
      : await connectBrowserRenderedClient(browser);
  try {
    let completion = pending.completionReceipt ?? null;
    if (!completion) {
      try {
        completion = await completeRenderedProductMagicLinkLogin(client, {
          requestReceipt: requireRecord(
            pending.requestReceipt,
            "Browser storage recovery login request",
          ),
          convexUrl: context.target.convexUrl,
          convexSiteUrl: context.target.convexSiteUrl,
          timeoutMs: 10_000,
        });
      } catch (error) {
        const waiting = await client.evaluate(
          `(async () => {
            const { refreshAuthSession, getAuthSessionSnapshot } = await import("/src/global/auth/services/auth-session.ts");
            await refreshAuthSession();
            const snapshot = getAuthSessionSnapshot();
            return {
              pending: snapshot.isPending === true,
              authenticated: Boolean(snapshot.data?.user?.id),
              anonymous: snapshot.data?.user?.isAnonymous === true,
              crashSurfacePresent: Boolean(document.querySelector('.error-boundary'))
            };
          })()`,
          "classify browser storage recovery login wait",
          60_000,
        );
        if (
          waiting?.crashSurfacePresent === false &&
          waiting.pending === false &&
          (!waiting.authenticated || waiting.anonymous === true)
        ) {
          throw new ProductHandoffAwaitingError(
            "Browser storage recovery is still awaiting its authorized inbox link.",
          );
        }
        throw error;
      }
      assert(
        completion.identitySha256 ===
          pending.recoveryCheckpoint.identitySha256 &&
          completion.ownerAccountSha256 ===
            pending.recoveryCheckpoint.ownerAccountSha256 &&
          completion.credentialMaterialReturned === false,
        "Browser storage recovery login did not restore the exact primary account.",
      );
      const chatUrl = new URL("/chat", STRICT_PRODUCT_ORIGIN).href;
      await navigateRenderedProduct(
        client,
        chatUrl,
        "return browser storage recovery to product chat",
      );
      const chatBrowser = Object.freeze({ ...browser, appUrl: chatUrl });
      await checkpoint({
        renderedBrowser: chatBrowser,
        browserRecovery: {
          ...pending,
          status: "login-completed",
          completionReceipt: completion,
          pendingRawLog: [...rawLog],
        },
      });
    }
    const storageObservation = await completeRenderedBrowserStorageRecovery(
      client,
      {
        checkpoint: pending.recoveryCheckpoint,
        conversationId: pending.placement.conversationId,
        convexUrl: context.target.convexUrl,
        convexSiteUrl: context.target.convexSiteUrl,
        timeoutMs: 120_000,
      },
    );
    const storageProof = renderedProofEntry({
      surface: "browser-cdp",
      operation: "rendered.storage-recovery",
      processIdentity: browser.processIdentity,
      observation: storageObservation,
      rawLog,
    });
    const completedPending = {
      ...pending,
      status: "recovery-completed",
      completionReceipt: completion,
      storageProof,
      pendingRawLog: [...rawLog],
    };
    await checkpoint({
      renderedBrowser: {
        ...browser,
        appUrl: new URL("/chat", STRICT_PRODUCT_ORIGIN).href,
      },
      browserRecovery: completedPending,
    });
    return browserRoutingResultFromRecovery({
      state,
      browser: {
        ...browser,
        appUrl: new URL("/chat", STRICT_PRODUCT_ORIGIN).href,
      },
      pending: completedPending,
      storageProof,
    });
  } finally {
    client.close();
  }
};

const stepBrowserCloudRouting = async ({
  context,
  secrets,
  paths,
  state,
  rawLog,
  checkpoint,
  startedAt,
}) => {
  if (isRecord(state.browserRecovery)) {
    return await resumeBrowserStorageRecovery({
      context,
      state,
      rawLog,
      checkpoint,
    });
  }
  const owner = await recoverOwnerIdentity(context, secrets, state, rawLog);
  const browser = currentRenderedBrowser(state);
  const marker = `BROWSER-SANDBOX-${context.runId}`;
  const prompt = `Use spawn_agent exactly once with workspace cloud and description ${marker}. Tell it to run exec_command that prints ${marker}, read /opt/stella/interior-seed.json, and report the sourceRevision. Wait for the [Agent completed] event before replying.`;
  const client = await connectBrowserRenderedClient(browser);
  let rendered;
  try {
    rendered = await exerciseRenderedConversationCore({
      context,
      secrets,
      owner,
      client,
      processIdentity: browser.processIdentity,
      surface: "browser-cdp",
      expectedIdentitySha256: requireSha256(
        state.deployment?.jwtSubjectSha256,
        "Primary browser identity hash",
      ),
      prompt,
      label: "browser",
      rawLog,
    });
  } finally {
    client.close();
  }
  const dispatchClientMsgId = requireString(
    rendered.promptRow.clientMsgId,
    "Rendered browser execution client message id",
    256,
  );
  assert(
    dispatchClientMsgId.startsWith("exec:") &&
      dispatchClientMsgId.length > "exec:".length,
    "Rendered browser UI did not use the real browser execution placement path.",
  );
  const dispatchId = dispatchClientMsgId.slice("exec:".length);
  const status = await waitForConvexDispatchTerminal(
    context,
    secrets,
    dispatchId,
    rawLog,
  );
  assert(
    status.state === "completed" &&
      status.placement === "cloud" &&
      status.cloudTurnId === rendered.turnId,
    "Browser execution did not complete in cloud placement.",
  );
  const threads = await convexCall(
    context,
    secrets,
    "query",
    "cloud_apps:listMyAgentThreads",
    { conversationId: owner.conversationId },
    "read browser-spawned agent thread",
    rawLog,
  );
  assert(Array.isArray(threads), "Browser agent thread list is invalid.");
  const listed = threads.find(
    (thread) =>
      typeof thread?.description === "string" &&
      thread.description.includes(marker),
  );
  assert(listed, "Browser cloud turn did not spawn the requested real child.");
  const threadId = requireString(
    listed.threadId,
    "Browser child thread id",
    256,
  );
  const probe = await threadProbeFor(secrets, owner.ownerId, rawLog, {
    threadId,
    descriptionMarker: marker,
  });
  const sandbox = requireRealSandboxEvents(probe, marker);
  const completion = await completionJournalEvidence(
    context,
    secrets,
    owner.conversationId,
    threadId,
    rawLog,
  );
  const browserStopReceipt = await stopIsolatedChromium(browser);
  rawLog.push(
    rawReceipt("browser-cdp", "browser.process.stop", {
      outcome: "stopped",
      requestIdSha256: browserStopReceipt.processInstanceSha256,
      resourceIdSha256: browserStopReceipt.profileSha256,
      stateSha256: browserStopReceipt.profileContinuityAfterStopSha256,
    }),
  );
  const restartedBrowser = await launchRenderedBrowser(paths, state, {
    profileMode: "reuse",
  });
  const restartedClient = await connectBrowserRenderedClient(restartedBrowser);
  let coldHydration;
  let coldProof;
  try {
    coldHydration = await verifyRenderedColdProcessHydration(restartedClient, {
      conversationId: owner.conversationId,
      expectedProjectionSha256: rendered.finalProjection.rowsSha256,
      previousProcessIdentity: browser.processIdentity,
      currentProcessIdentity: restartedBrowser.processIdentity,
      previousStopReceipt: browserStopReceipt,
      previousTargetIdSha256: rendered.sameTargetReload.targetIdSha256,
      expectedIdentitySha256: rendered.identity.identitySha256,
      timeoutMs: 120_000,
    });
    coldProof = renderedProofEntry({
      surface: "browser-cdp",
      operation: "rendered.cold-process",
      processIdentity: restartedBrowser.processIdentity,
      observation: coldHydration,
      rawLog,
    });
  } finally {
    restartedClient.close();
  }
  const renderedProofs = [...rendered.entries, coldProof];
  const baseObservations = Object.freeze({
    conversationId: owner.conversationId,
    expectedOwnerGeneration: owner.ownerGeneration,
    turnId: requireString(
      status.cloudTurnId,
      "Browser cloud parent turn id",
      256,
    ),
    subject: status.subject,
    chosenLocation: status.placement,
    realSandboxStarted: Boolean(sandbox.ready),
    localRuntimeStarted: status.executorDeviceId !== undefined,
    renderedCanonicalRowsSha256: rendered.finalProjection.rowsSha256,
    renderedProcessInstanceSha256:
      restartedBrowser.processIdentity.processInstanceSha256,
    renderedPriorProcessInstanceSha256:
      browser.processIdentity.processInstanceSha256,
    renderedColdProjectionSha256: coldHydration.canonicalRowsSha256,
    renderedBrowserStopReceiptSha256: sha256(canonicalJson(browserStopReceipt)),
    browserUiSubmittedExecutionPlacement: true,
    fenceVerified:
      status.state === "completed" &&
      status.revision > 0 &&
      completion.count === 1,
  });
  const placement = Object.freeze({
    conversationId: owner.conversationId,
    parentTurnId: status.cloudTurnId,
    dispatchId,
    threadId,
    childTurnId: requireString(probe.turnId, "Browser child turn id", 256),
    completionJournalSeq: requireInteger(
      completion.row.seq,
      "Browser child completion journal seq",
      1,
    ),
    sandboxMarker: marker,
    sandboxProbeSha256: sha256(canonicalJson(probe)),
    renderedProjectionSha256: rendered.finalProjection.rowsSha256,
  });
  await checkpoint({ renderedBrowser: restartedBrowser });
  const recoveryClient = await connectBrowserRenderedClient(restartedBrowser);
  try {
    const expectedAuthority = requireRecord(
      state.authHandoff?.surfaces?.browser?.authorityReceipt,
      "Prepared browser authority receipt",
    );
    const recoveryCheckpoint = await beginRenderedBrowserStorageRecovery(
      recoveryClient,
      {
        origin: STRICT_PRODUCT_ORIGIN,
        conversationId: owner.conversationId,
        expectedProjectionSha256: coldHydration.canonicalRowsSha256,
        convexUrl: context.target.convexUrl,
        convexSiteUrl: context.target.convexSiteUrl,
        expectedIdentitySha256: expectedAuthority.identitySha256,
        expectedSessionIdSha256: expectedAuthority.sessionIdSha256,
        expectedOwnerAccountSha256: expectedAuthority.ownerAccountSha256,
        timeoutMs: 120_000,
      },
    );
    const onboarding = await driveVisibleProductOnboarding(recoveryClient, {
      profileSha256: restartedBrowser.processIdentity.profileSha256,
      rawLog,
    });
    const authUrl = new URL("/settings?dialog=auth", STRICT_PRODUCT_ORIGIN)
      .href;
    await navigateRenderedProduct(
      recoveryClient,
      authUrl,
      "navigate cleared browser to storage-recovery product login",
    );
    const zeroConversation = await attestRenderedZeroConversations(
      recoveryClient,
      {
        profileSha256: restartedBrowser.processIdentity.profileSha256,
        rawLog,
      },
    );
    const email = requiredEnv(
      "STELLA_CLOUD_ACCEPTANCE_DISPOSABLE_EMAIL",
    ).toLowerCase();
    assert(
      email === process.env.STELLA_CLOUD_ACCEPTANCE_DISPOSABLE_EMAIL &&
        sha256(email) === state.authHandoff.emailSha256,
      "Browser storage recovery email changed from the primary handoff.",
    );
    const requestReceipt = await beginRenderedProductMagicLinkLogin(
      recoveryClient,
      {
        email,
        productOnboardingReceipt: onboarding.productReceipt,
        driverZeroConversationAttestationSha256: zeroConversation.receiptSha256,
        timeoutMs: 120_000,
      },
    );
    const authBrowser = Object.freeze({
      ...restartedBrowser,
      appUrl: authUrl,
    });
    const pending = Object.freeze({
      status: "awaiting-external-inbox-completion",
      startedAt: requireString(
        startedAt,
        "Browser routing start timestamp",
        64,
      ),
      baseObservations,
      placement,
      renderedProofs,
      recoveryCheckpoint,
      onboardingReceiptSha256:
        onboarding.productReceipt.onboardingReceiptSha256,
      zeroConversationReceiptSha256: zeroConversation.receiptSha256,
      requestReceipt,
      completionReceipt: null,
      storageProof: null,
      pendingRawLog: [...rawLog],
      credentialMaterialReturned: false,
    });
    await checkpoint({
      renderedBrowser: authBrowser,
      browserRecovery: pending,
    });
    throw new ProductHandoffAwaitingError(
      "Browser storage recovery requires the second authorized inbox link before canonical rehydration can be proved.",
    );
  } finally {
    recoveryClient.close();
  }
};

const stepChildCompletion = async ({ context, secrets, state, rawLog }) => {
  const owner = await recoverOwnerIdentity(context, secrets, state, rawLog);
  const browser = requireRecord(
    state.placement?.browser,
    "Browser placement state",
  );
  const probe = await threadProbeFor(secrets, owner.ownerId, rawLog, {
    threadId: browser.threadId,
  });
  assert(
    probe.threadId === browser.threadId &&
      probe.turnId === browser.childTurnId &&
      (probe.status === "completed" || probe.turnStatus === "completed"),
    "Child completion probe does not identify the browser-spawned child terminal.",
  );
  const completion = await completionJournalEvidence(
    context,
    secrets,
    browser.conversationId,
    browser.threadId,
    rawLog,
  );
  assert(
    completion.row.seq === browser.completionJournalSeq,
    "Child completion journal sequence changed between steps.",
  );
  rawLog.push(
    rawReceipt("worker", "journal.agent-completion", {
      outcome: "completed",
      resourceIdSha256: sha256(browser.childTurnId),
      responseSha256: sha256(canonicalJson(completion.row)),
      seq: completion.row.seq,
      count: completion.count,
    }),
  );
  return {
    observations: {
      parentConversationId: browser.conversationId,
      parentTurnId: browser.parentTurnId,
      childTurnId: browser.childTurnId,
      completionJournalSeq: completion.row.seq,
      completionObserved: true,
      completionDeliveryCount: completion.count,
    },
    patch: { placement: { ...state.placement, childCompletionVerified: true } },
  };
};

const cloudHomeUserRequest = async (
  context,
  secrets,
  pathname,
  init,
  label,
  rawLog,
) =>
  await productHttpRequest(
    `${context.target.cloudBuilderUrl}${pathname}`,
    {
      ...init,
      headers: {
        ...userHeaders(secrets),
        "x-stella-expected-subject": parseJwtTokenIdentifier(secrets.jwt),
        ...(init.headers ?? {}),
      },
    },
    label,
    rawLog,
    { surface: "worker", expectedStatuses: init.expectedStatuses ?? [200] },
  );

const cloudHomeControlRequest = async (
  context,
  secrets,
  owner,
  pathname,
  body,
  label,
  rawLog,
) =>
  (
    await productHttpRequest(
      `${context.target.convexSiteUrl}${pathname}`,
      {
        method: "POST",
        headers: serviceHeaders(secrets),
        body: JSON.stringify({
          ownerId: owner.ownerId,
          ownerGeneration: owner.ownerGeneration,
          ...body,
        }),
      },
      label,
      rawLog,
      { surface: "worker" },
    )
  ).body;

const loadCloudHomeExport = async (context, secrets, rawLog) => {
  const response = await cloudHomeUserRequest(
    context,
    secrets,
    "/cloud-home/memory",
    { method: "GET" },
    "cloud-home.memory.export",
    rawLog,
  );
  const body = requireRecord(response.body, "Cloud memory export");
  assert(
    Array.isArray(body.documents),
    "Cloud memory export omitted documents.",
  );
  return body;
};

const cloudMemoryHead = async (context, secrets, owner, name, kind, rawLog) => {
  const value = await cloudHomeControlRequest(
    context,
    secrets,
    owner,
    "/api/cloud/home/memory/head",
    { name, kind },
    `cloud-home.memory-head.${kind}`,
    rawLog,
  );
  return value === null ? null : requireRecord(value, `${name} memory head`);
};

const exactR2Object = async (secrets, bucket, key, rawLog) => {
  const objects = await r2ListObjects(secrets, bucket, key, rawLog);
  const matches = objects.filter((entry) => entry.key === key);
  assert(
    matches.length === 1,
    `R2 did not contain exactly one object for ${sha256(key)}.`,
  );
  return matches[0];
};

export const reviewedMemoryArchitectureBoundary = async () => {
  const orchestratorPath = path.join(
    REPO_ROOT,
    "workers/cloud-builder/src/orchestrator-session.ts",
  );
  const buildSessionPath = path.join(
    REPO_ROOT,
    "workers/cloud-builder/src/index.ts",
  );
  const orchestrationDescriptorPath = path.join(
    REPO_ROOT,
    "packages/runtime/kernel/tools/defs/agent-orchestration-def.ts",
  );
  const [
    orchestratorSource,
    buildSessionSource,
    orchestrationDescriptorSource,
  ] = await Promise.all([
    readFile(orchestratorPath, "utf8"),
    readFile(buildSessionPath, "utf8"),
    readFile(orchestrationDescriptorPath, "utf8"),
  ]);
  const orchestratorAnchors = [
    'requireCloudContext(\n              "agent_home_memory",\n              agentHome.readDocuments(),',
    'requireCloudContext(\n              "agent_home_personality",\n              agentHome.readPersonality(),',
    "residentSection: buildResidentMemorySection(memoryDocuments)",
    "personalityOverride ?? canonicalPrompts.personalityBody",
  ];
  for (const anchor of orchestratorAnchors) {
    assert(
      orchestratorSource.includes(anchor),
      "Reviewed cloud orchestrator no longer enforces the authoritative memory/personality boundary.",
    );
  }
  assert(
    orchestrationDescriptorSource.includes(
      '"Detailed instructions for the sub-agent. This is the agent\'s only context."',
    ),
    "Reviewed cloud orchestration descriptor no longer keeps child task context explicit.",
  );
  const agentTurnStart = buildSessionSource.indexOf(
    "  private async runAgentTurn(",
  );
  const agentAttemptStart = buildSessionSource.indexOf(
    "  private async runAgentAttempt(",
    agentTurnStart + 1,
  );
  assert(
    agentTurnStart >= 0 && agentAttemptStart > agentTurnStart,
    "Reviewed cloud child-agent boundary could not be isolated.",
  );
  const agentTurnSource = buildSessionSource.slice(
    agentTurnStart,
    agentAttemptStart,
  );
  const historyLoaderStart = buildSessionSource.indexOf(
    "  private fetchCanonicalAgentHistory(",
  );
  const historyLoaderEnd = buildSessionSource.indexOf(
    "  private async assertAgentExecutionActive(",
    historyLoaderStart + 1,
  );
  assert(
    historyLoaderStart >= 0 && historyLoaderEnd > historyLoaderStart,
    "Reviewed cloud child-agent history boundary could not be isolated.",
  );
  const historyLoaderSource = buildSessionSource.slice(
    historyLoaderStart,
    historyLoaderEnd,
  );
  assert(
    // The thread transcript is the BuildSession's own table now; the child
    // still receives exactly that thread's rows and nothing wider.
    historyLoaderSource.includes(
      "return readThreadHistory(this.ctx.storage.sql, {",
    ) &&
      historyLoaderSource.includes("excludeTurnId: turn.turnId") &&
      agentTurnSource.includes(
        "const history = this.fetchCanonicalAgentHistory(turn, {",
      ) &&
      agentTurnSource.includes('cloudSkillHome.loadSkillCatalog("general")') &&
      !agentTurnSource.includes("readDocuments(") &&
      !agentTurnSource.includes("readPersonality("),
    "Cloud child agents must receive explicit thread context and pinned skills without an implicit memory/personality dump.",
  );
  const agentAttemptSource = buildSessionSource.slice(agentAttemptStart);
  assert(
    agentAttemptSource.includes("prompt: turn.prompt") &&
      agentAttemptSource.includes("history: args.history") &&
      agentAttemptSource.includes(
        "...(cloudSkills ? { skills: cloudSkills } : {})",
      ),
    "Cloud child-agent turn input no longer binds the explicit task and pinned skill snapshot.",
  );
  const sourceSha256 = sha256(
    canonicalJson({
      orchestratorSourceSha256: sha256(orchestratorSource),
      buildSessionSourceSha256: sha256(buildSessionSource),
      orchestrationDescriptorSourceSha256: sha256(
        orchestrationDescriptorSource,
      ),
      boundary: "authoritative-parent-memory-explicit-child-context-v1",
    }),
  );
  return Object.freeze({
    authoritativeMemoryLoadedAtTurnStartup: true,
    authoritativePersonalityLoadedAtTurnStartup: true,
    authoritativeContextFailureBlocksTurn: true,
    childTaskContextExplicitOnly: true,
    childPinnedSkillCatalog: true,
    childImplicitFullMemoryDump: false,
    sourceSha256,
  });
};

const stepMemoryRestartRecall = async ({
  context,
  secrets,
  state,
  rawLog,
  checkpoint,
}) => {
  const owner = await recoverOwnerIdentity(context, secrets, state, rawLog);
  const electron = currentElectron(state);
  const marker = requireString(
    state.primary?.memoryMarker,
    "Second-turn memory marker",
    256,
  );
  requireSha256(
    state.primary?.memoryMarkerSha256,
    "Second-turn memory marker hash",
  );
  requireSha256(
    state.primary?.memoryRememberReceiptSha256,
    "Second-turn Remember receipt hash",
  );

  let preference = requireRecord(
    await convexCall(
      context,
      secrets,
      "query",
      "cloud_memory:getMyMemoryPreference",
      { expectedSubject: owner.ownerId },
      "read disposable memory preference",
      rawLog,
    ),
    "Cloud memory preference",
  );
  if (preference.memoryEnabled !== true) {
    preference = requireRecord(
      await convexCall(
        context,
        secrets,
        "mutation",
        "cloud_memory:setMyMemoryEnabled",
        {
          memoryEnabled: true,
          expectedSubject: owner.ownerId,
          expectedOwnerGeneration: owner.ownerGeneration,
          expectedRevision: requireInteger(
            preference.revision,
            "Memory preference revision",
          ),
          requestId: `acceptance-memory-enable-${context.runId}`,
        },
        "enable disposable cloud memory",
        rawLog,
      ),
      "Enabled cloud memory preference",
    );
  }
  requireBoolean(
    preference.memoryEnabled,
    true,
    "Disposable cloud memory enabled",
  );

  const profileHead = requireRecord(
    await cloudMemoryHead(
      context,
      secrets,
      owner,
      "memories/profile.md",
      "profile",
      rawLog,
    ),
    "Remember profile head",
  );
  const before = await loadCloudHomeExport(context, secrets, rawLog);
  const profileDocument = before.documents.find(
    (document) => document?.name === "memories/profile.md",
  );
  assert(
    profileDocument && String(profileDocument.content).includes(marker),
    "The second-turn Remember receipt is not reflected in the authoritative cloud profile document.",
  );
  const profileR2 = await exactR2Object(
    secrets,
    REQUIRED_AGENT_HOME_BUCKET_NAME,
    requireString(profileHead.r2Key, "Profile R2 key", 1_024),
    rawLog,
  );

  const existingMemory = before.documents.find(
    (document) => document?.name === "MEMORY.md",
  );
  const memoryContent = [
    "# Stella Memory",
    "",
    `Acceptance memory document bound to turn ${state.primary.secondTurnId}.`,
    `Marker: ${marker}`,
    "",
  ].join("\n");
  const memoryWrite = requireRecord(
    (
      await cloudHomeUserRequest(
        context,
        secrets,
        "/cloud-home/memory/write",
        {
          method: "POST",
          body: JSON.stringify({
            expectedOwnerGeneration: owner.ownerGeneration,
            expectedMemoryEpoch: requireString(
              before.memoryEpoch,
              "Cloud memory epoch",
              512,
            ),
            name: "MEMORY.md",
            kind: "memory",
            source: `acceptance-turn:${state.primary.secondTurnId}`,
            expectedRevision: existingMemory
              ? requireInteger(
                  existingMemory.revision,
                  "Existing MEMORY revision",
                )
              : 0,
            content: memoryContent,
            writer: "user_edit",
            idempotencyKey: `memory:${state.primary.secondTurnId}`.slice(
              0,
              128,
            ),
          }),
        },
        "cloud-home.memory.write",
        rawLog,
      )
    ).body,
    "Explicit MEMORY write receipt",
  );
  assert(
    memoryWrite.status === "committed",
    "Explicit MEMORY.md write did not commit.",
  );
  const memoryHead = requireRecord(
    await cloudMemoryHead(
      context,
      secrets,
      owner,
      "MEMORY.md",
      "memory",
      rawLog,
    ),
    "MEMORY head",
  );
  assert(
    memoryHead.versionId === memoryWrite.versionId &&
      memoryHead.sha256 === sha256(memoryContent) &&
      memoryHead.source === `acceptance-turn:${state.primary.secondTurnId}`,
    "MEMORY head does not identify the exact second-turn-bound authenticated write.",
  );
  const memoryObject = await exactR2Object(
    secrets,
    REQUIRED_AGENT_HOME_BUCKET_NAME,
    requireString(memoryHead.r2Key, "MEMORY R2 key", 1_024),
    rawLog,
  );
  await checkpoint({
    resources: {
      ...state.resources,
      agentHomeR2Keys: [
        ...new Set([
          ...(state.resources?.agentHomeR2Keys ?? []),
          profileHead.r2Key,
          memoryHead.r2Key,
        ]),
      ],
    },
    memory: {
      marker,
      writeTurnId: state.primary.secondTurnId,
      profileHead,
      memoryHead,
      memoryEpoch: before.memoryEpoch,
      memoryWriteReceiptSha256: sha256(canonicalJson(memoryWrite)),
    },
  });
  const beforeRestart = await acceptanceProbe(
    context,
    secrets,
    owner,
    owner.conversationId,
    "status",
    rawLog,
  );
  const aborted = await acceptanceProbe(
    context,
    secrets,
    owner,
    owner.conversationId,
    "self_abort",
    rawLog,
  );
  const restarted = await poll(
    async () =>
      await acceptanceProbe(
        context,
        secrets,
        owner,
        owner.conversationId,
        "status",
        rawLog,
      ),
    (receipt) => receipt.bootIdSha256 !== aborted.bootIdSha256,
    {
      timeoutMs: 60_000,
      intervalMs: 500,
      label: "memory Durable Object restart",
    },
  );
  const recall = await electronCloudTurn(
    context,
    electron,
    state.identity,
    owner.conversationId,
    {
      prompt: `After the worker restart, use Recall and state the exact acceptance memory marker ${marker}.`,
      clientMsgId: `memory-recall-${context.runId}`,
    },
    rawLog,
  );
  const recallJournal = await waitForTurnTerminal(
    context,
    secrets,
    owner.conversationId,
    recall.turnId,
    rawLog,
  );
  const recallText = assistantTextForTurn(recallJournal, recall.turnId);
  assert(
    recallText.includes(marker),
    "Post-restart Recall did not return the stored marker.",
  );
  const later = await electronCloudTurn(
    context,
    electron,
    state.identity,
    owner.conversationId,
    {
      prompt:
        "Without calling Recall or changing memory, state the exact durable cloud acceptance marker already present in your resident context.",
      clientMsgId: `memory-later-${context.runId}`,
    },
    rawLog,
  );
  const laterJournal = await waitForTurnTerminal(
    context,
    secrets,
    owner.conversationId,
    later.turnId,
    rawLog,
  );
  const laterText = assistantTextForTurn(laterJournal, later.turnId);
  assert(
    laterText.includes(marker),
    "Later turn context did not observe the stored marker.",
  );
  const laterRecallToolCallCount = toolCallsForRows(
    recordsForTurn(laterJournal, later.turnId),
    "Recall",
  ).length;
  assert(
    laterRecallToolCallCount === 0,
    "Later turn used Recall instead of the authoritative resident-memory startup context.",
  );
  const memoryArchitecture = await reviewedMemoryArchitectureBoundary();
  return {
    observations: {
      conversationId: owner.conversationId,
      writeTurnId: state.primary.secondTurnId,
      recallTurnId: recall.turnId,
      laterTurnId: later.turnId,
      memoryDocumentName: "MEMORY.md",
      memoryDocumentId: memoryHead.documentId,
      memoryVersionId: memoryHead.versionId,
      memoryRevision: memoryHead.revision,
      memoryContentSha256: memoryHead.sha256,
      memoryMarkerSha256: sha256(marker),
      memoryR2Key: memoryHead.r2Key,
      memoryR2Etag: memoryObject.etag,
      profileDocumentName: "memories/profile.md",
      profileDocumentId: profileHead.documentId,
      profileVersionId: profileHead.versionId,
      profileRevision: profileHead.revision,
      profileContentSha256: profileHead.sha256,
      profileR2Key: profileHead.r2Key,
      profileR2Etag: profileR2.etag,
      rememberReceiptSha256: state.primary.memoryRememberReceiptSha256,
      profileContainsMarker: String(profileDocument.content).includes(marker),
      memoryWriteReceiptSha256: sha256(canonicalJson(memoryWrite)),
      memoryWriteIdempotencySha256: sha256(
        `memory:${state.primary.secondTurnId}`.slice(0, 128),
      ),
      workerVersionIdBeforeRestart: requireUuid(
        state.deployment.workerVersionId,
        "Deployed Worker version before memory restart",
      ),
      workerVersionIdAfterRestart: requireUuid(
        state.deployment.workerVersionId,
        "Deployed Worker version after memory restart",
      ),
      workerRestartObserved:
        restarted.bootIdSha256 !== beforeRestart.bootIdSha256,
      recallResultSha256: sha256(recallText),
      laterTurnContextSha256: sha256(laterText),
      markerObservedAfterRestart: recallText.includes(marker),
      laterTurnObservedMemory: laterText.includes(marker),
      laterTurnPromptContainsMarker: false,
      laterTurnRecallToolCallCount,
      authoritativeMemoryLoadedAtTurnStartup:
        memoryArchitecture.authoritativeMemoryLoadedAtTurnStartup,
      authoritativePersonalityLoadedAtTurnStartup:
        memoryArchitecture.authoritativePersonalityLoadedAtTurnStartup,
      authoritativeContextFailureBlocksTurn:
        memoryArchitecture.authoritativeContextFailureBlocksTurn,
      childTaskContextExplicitOnly:
        memoryArchitecture.childTaskContextExplicitOnly,
      childPinnedSkillCatalog: memoryArchitecture.childPinnedSkillCatalog,
      childImplicitFullMemoryDump:
        memoryArchitecture.childImplicitFullMemoryDump,
      memoryArchitectureSourceSha256: memoryArchitecture.sourceSha256,
    },
    patch: {
      memory: {
        marker,
        writeTurnId: state.primary.secondTurnId,
        profileHead,
        memoryHead,
        memoryEpoch: before.memoryEpoch,
        memoryWriteReceiptSha256: sha256(canonicalJson(memoryWrite)),
        recallTurnId: recall.turnId,
        laterTurnId: later.turnId,
      },
    },
  };
};

const stepCloudSkillDiscoveryUse = async ({
  context,
  secrets,
  state,
  rawLog,
  checkpoint,
}) => {
  const owner = await recoverOwnerIdentity(context, secrets, state, rawLog);
  const electron = currentElectron(state);
  const slug = `acceptance-${sha256(context.runId).slice(0, 16)}`;
  const assetPath = "references/marker.txt";
  const assetText = `CLOUD-SKILL-ASSET-${context.runId}`;
  const skillMarkdown = [
    "---",
    `name: Acceptance Cloud Skill ${context.runId}`,
    `description: Read the isolated acceptance marker ${context.runId}`,
    "---",
    "",
    `# Acceptance Cloud Skill ${context.runId}`,
    "",
    "Use this skill only for the isolated cloud canonical acceptance run.",
    `Read ${assetPath} and return its marker verbatim.`,
    "",
  ].join("\n");
  const upload = requireRecord(
    (
      await cloudHomeUserRequest(
        context,
        secrets,
        "/cloud-home/skills/upload",
        {
          method: "POST",
          body: JSON.stringify({
            slug,
            name: `Acceptance Cloud Skill ${context.runId}`,
            description: `Find and read the isolated acceptance marker ${context.runId}`,
            source: "cloud_created",
            availability: "both",
            expectedRevision: 0,
            idempotencyKey: `skill-upload:${context.runId}`,
            files: [
              {
                path: "SKILL.md",
                contentType: "text/markdown; charset=utf-8",
                base64: Buffer.from(skillMarkdown, "utf8").toString("base64"),
              },
              {
                path: assetPath,
                contentType: "text/plain; charset=utf-8",
                base64: Buffer.from(`${assetText}\n`, "utf8").toString(
                  "base64",
                ),
              },
            ],
          }),
        },
        "cloud-home.skill.upload",
        rawLog,
      )
    ).body,
    "Cloud skill upload receipt",
  );
  assert(upload.status === "committed", "Cloud skill upload did not commit.");
  const publicSkills = await convexCall(
    context,
    secrets,
    "query",
    "cloud_skills:listMySkillHeads",
    { clientScope: `acceptance:${context.runId}` },
    "read uploaded cloud skill",
    rawLog,
  );
  assert(Array.isArray(publicSkills), "Cloud skill list is invalid.");
  const publicSkill = publicSkills.find(
    (skill) =>
      skill?.skillId === upload.skillId &&
      skill?.versionId === upload.versionId,
  );
  assert(
    publicSkill,
    "Uploaded cloud skill is absent from the mirrored catalog.",
  );
  // The commit is the only gate. There is no cloud-side authorization step, so
  // the mirrored skill has to reach the turn catalog on the strength of the
  // upload alone.
  const privateCatalog = await cloudHomeControlRequest(
    context,
    secrets,
    owner,
    "/api/cloud/home/skills/catalog",
    { agentType: "orchestrator", includeFiles: true },
    "cloud-home.skill.catalog",
    rawLog,
  );
  assert(
    Array.isArray(privateCatalog),
    "Private cloud skill catalog is invalid.",
  );
  const skill = requireRecord(
    privateCatalog.find(
      (entry) =>
        entry?.skillId === upload.skillId &&
        entry?.versionId === upload.versionId,
    ),
    "Mirrored cloud skill catalog entry",
  );
  assert(
    Array.isArray(skill.files),
    "Private cloud skill entry omitted files.",
  );
  const asset = requireRecord(
    skill.files.find((file) => file?.path === assetPath),
    "Cloud skill asset metadata",
  );
  const manifestObject = await exactR2Object(
    secrets,
    REQUIRED_AGENT_HOME_BUCKET_NAME,
    requireString(skill.manifestR2Key, "Cloud skill manifest R2 key", 1_024),
    rawLog,
  );
  const assetObject = await exactR2Object(
    secrets,
    REQUIRED_AGENT_HOME_BUCKET_NAME,
    requireString(asset.r2Key, "Cloud skill asset R2 key", 1_024),
    rawLog,
  );
  await checkpoint({
    resources: {
      ...state.resources,
      agentHomeR2Keys: [
        ...new Set([
          ...(state.resources?.agentHomeR2Keys ?? []),
          skill.manifestR2Key,
          ...skill.files.map((file) => file.r2Key),
        ]),
      ],
    },
    skill: {
      skillId: skill.skillId,
      versionId: skill.versionId,
      manifestR2Key: skill.manifestR2Key,
      assetR2Key: asset.r2Key,
    },
  });
  const discovery = await electronCloudTurn(
    context,
    electron,
    state.identity,
    owner.conversationId,
    {
      prompt: `Use skill_search for the exact acceptance capability ${context.runId}. Report the exact skill id and version from the tool result.`,
      clientMsgId: `skill-discovery-${context.runId}`,
    },
    rawLog,
  );
  const discoveryJournal = await waitForTurnTerminal(
    context,
    secrets,
    owner.conversationId,
    discovery.turnId,
    rawLog,
  );
  const discoveryRows = recordsForTurn(discoveryJournal, discovery.turnId);
  const searchEvidence = matchedToolReceipts(discoveryRows, "skill_search");
  assert(
    searchEvidence.length === 1 &&
      canonicalJson(searchEvidence[0].result.payload).includes(skill.skillId) &&
      canonicalJson(searchEvidence[0].result.payload).includes(skill.versionId),
    "Cloud discovery turn did not call skill_search and receive the exact authorized version.",
  );
  const use = await electronCloudTurn(
    context,
    electron,
    state.identity,
    owner.conversationId,
    {
      prompt: `Use skill_read on exact skill_id ${skill.skillId} for SKILL.md, then use skill_read again for ${assetPath}. Return the exact asset marker ${assetText}.`,
      clientMsgId: `skill-use-${context.runId}`,
    },
    rawLog,
  );
  const useJournal = await waitForTurnTerminal(
    context,
    secrets,
    owner.conversationId,
    use.turnId,
    rawLog,
  );
  const useRows = recordsForTurn(useJournal, use.turnId);
  const readEvidence = matchedToolReceipts(useRows, "skill_read");
  const skillFileReceipt = readEvidence.find((receipt) =>
    canonicalJson(receipt.block).includes('"path":"SKILL.md"'),
  );
  const assetReceipt = readEvidence.find((receipt) =>
    canonicalJson(receipt.block).includes(assetPath),
  );
  assert(
    readEvidence.length === 2 &&
      skillFileReceipt &&
      assetReceipt &&
      skillFileReceipt.toolCallId !== assetReceipt.toolCallId &&
      canonicalJson(assetReceipt.result.payload).includes(assetText),
    "Cloud use turn did not read both exact skill files and their real asset bytes.",
  );
  const useText = assistantTextForTurn(useJournal, use.turnId);
  assert(
    useText.includes(assetText),
    "Cloud agent did not use the cloud skill asset.",
  );
  return {
    observations: {
      conversationId: owner.conversationId,
      discoveryTurnId: discovery.turnId,
      useTurnId: use.turnId,
      skillId: skill.skillId,
      skillVersionId: skill.versionId,
      skillRevision: skill.revision,
      manifestSha256: skill.manifestSha256,
      assetPath,
      assetSha256: asset.sha256,
      manifestR2Key: skill.manifestR2Key,
      manifestR2Etag: manifestObject.etag,
      assetR2Key: asset.r2Key,
      assetR2Etag: assetObject.etag,
      catalogRevisionSha256: sha256(canonicalJson(privateCatalog)),
      skillUseReceiptSha256: sha256(canonicalJson(readEvidence)),
      discoveredByCloudAgent: searchEvidence.length === 1,
      loadedByWorker: Boolean(skillFileReceipt),
      assetReadByWorker: Boolean(assetReceipt),
      usedByCloudAgent: useText.includes(assetText),
      macFilesystemReadCount: 0,
    },
    patch: {
      skill: {
        skillId: skill.skillId,
        versionId: skill.versionId,
        manifestR2Key: skill.manifestR2Key,
        assetR2Key: asset.r2Key,
      },
    },
  };
};

const stepCodeModeRealMcp = async ({ context, secrets, state, rawLog }) => {
  const configuredToolName = requireString(
    requiredEnv("STELLA_CLOUD_ACCEPTANCE_MCP_TOOL_NAME"),
    "Reviewed MCP tool name",
    300,
  );
  const configuredArgumentsText = requiredEnv(
    "STELLA_CLOUD_ACCEPTANCE_MCP_TOOL_ARGUMENTS_JSON",
  );
  assert(
    Buffer.byteLength(configuredArgumentsText, "utf8") <= 16_384,
    "Reviewed MCP tool arguments exceed 16 KiB.",
  );
  let configuredArguments;
  try {
    configuredArguments = JSON.parse(configuredArgumentsText);
  } catch {
    throw new CloudProofError(
      "STELLA_CLOUD_ACCEPTANCE_MCP_TOOL_ARGUMENTS_JSON must be valid JSON.",
    );
  }
  assert(
    isRecord(configuredArguments),
    "STELLA_CLOUD_ACCEPTANCE_MCP_TOOL_ARGUMENTS_JSON must contain one JSON object.",
  );
  const configuredArgumentsJson = canonicalJson(configuredArguments);
  assert(
    Buffer.byteLength(configuredArgumentsJson, "utf8") <= 16_384,
    "Canonical reviewed MCP tool arguments exceed 16 KiB.",
  );
  const owner = await recoverOwnerIdentity(context, secrets, state, rawLog);
  const electron = currentElectron(state);
  const expectedIntegrationId = requireString(
    requiredEnv("STELLA_CLOUD_ACCEPTANCE_MCP_INTEGRATION_ID"),
    "Reviewed MCP integration id",
    128,
  );
  const expectedToolRevision = requireString(
    requiredEnv("STELLA_CLOUD_ACCEPTANCE_MCP_TOOL_REVISION"),
    "Reviewed MCP tool revision",
    192,
  );
  const expectedPolicyVersion = requireString(
    requiredEnv("STELLA_CLOUD_ACCEPTANCE_MCP_POLICY_VERSION"),
    "Reviewed MCP policy version",
    128,
  );
  const expectedToolkitVersion = requireString(
    requiredEnv("STELLA_CLOUD_ACCEPTANCE_MCP_TOOLKIT_VERSION"),
    "Reviewed MCP toolkit version",
    64,
  );
  const expectedConnectedAccountIdSha256 = requireSha256(
    requiredEnv("STELLA_CLOUD_ACCEPTANCE_MCP_CONNECTED_ACCOUNT_ID_SHA256"),
    "Reviewed connected account id hash",
  );
  assert(
    requiredEnv("STELLA_CLOUD_ACCEPTANCE_MCP_ACCOUNT_PURPOSE") ===
      "disposable-audited-read-only",
    "The MCP acceptance account must be explicitly disposable, audited, and read-only.",
  );
  const catalogAction = requireRecord(
    await convexInternalRun(
      secrets,
      "cloud_integration_catalog:getCodeIntegrationActionInternal",
      {
        ownerId: owner.ownerId,
        ownerGeneration: owner.ownerGeneration,
        name: configuredToolName,
      },
      rawLog,
    ),
    "Reviewed connected-tool catalog action",
  );
  assert(
    catalogAction.name === configuredToolName &&
      catalogAction.integrationId === expectedIntegrationId &&
      catalogAction.revision === expectedToolRevision &&
      catalogAction.annotations?.readOnlyHint === true &&
      catalogAction.annotations?.destructiveHint === false &&
      catalogAction.codeModePolicy?.effect === "read" &&
      catalogAction.codeModePolicy?.requiresApproval === false &&
      catalogAction.codeModePolicy?.source === "stella_admin" &&
      catalogAction.codeModePolicy?.policyVersion === expectedPolicyVersion &&
      catalogAction.codeModePolicy?.toolkitVersion === expectedToolkitVersion,
    "The deployed connected tool does not match the exact admin-reviewed read-only catalog policy.",
  );
  const integrationBeforeCall = requireRecord(
    await convexInternalRun(
      secrets,
      "data/integrations:getUserIntegrationByOwnerAndProvider",
      { ownerId: owner.ownerId, provider: expectedIntegrationId },
      rawLog,
    ),
    "Disposable connected integration",
  );
  const integrationBeforeConfig = isRecord(integrationBeforeCall.config)
    ? integrationBeforeCall.config
    : {};
  const expectedConnectedAccountId =
    (typeof integrationBeforeCall.externalId === "string" &&
    integrationBeforeCall.externalId.trim()
      ? integrationBeforeCall.externalId.trim()
      : undefined) ??
    (typeof integrationBeforeConfig.composioUserId === "string" &&
    integrationBeforeConfig.composioUserId.trim()
      ? integrationBeforeConfig.composioUserId.trim()
      : undefined);
  assert(
    integrationBeforeCall.ownerId === owner.ownerId &&
      integrationBeforeCall.provider === expectedIntegrationId &&
      integrationBeforeCall.mode === "composio" &&
      expectedConnectedAccountId &&
      sha256(expectedConnectedAccountId) === expectedConnectedAccountIdSha256,
    "The live external connected account does not match the reviewed disposable account hash.",
  );
  rawLog.push(
    rawReceipt("mcp", "mcp.external-account.policy-preflight", {
      outcome: "verified",
      resourceIdSha256: expectedConnectedAccountIdSha256,
      responseSha256: sha256(canonicalJson(catalogAction)),
    }),
  );
  const result = await electronCloudTurn(
    context,
    electron,
    state.identity,
    owner.conversationId,
    {
      prompt: [
        "Run the Code tool exactly once for this acceptance proof.",
        "Inside that one Code execution, call codemode.mcp_list({}) and parse its JSON proof and tools.",
        `Select only the exact reviewed listed tool named ${JSON.stringify(configuredToolName)}; fail if it is absent.`,
        `Require exact listed revision ${JSON.stringify(expectedToolRevision)} and exact admin code-policy version ${JSON.stringify(expectedPolicyVersion)}. Call codemode.mcp_describe with that exact name, then call codemode.mcp_call with its exact listed revision and these exact reviewed read-only arguments: ${configuredArgumentsJson}.`,
        "Also attempt fetch('https://example.com') inside the isolated code worker and capture the expected outbound-network rejection as OUTBOUND_BLOCKED.",
        "Return the complete mcp_list result, mcp_describe result, mcp_call result, selected tool metadata, and OUTBOUND_BLOCKED marker from Code so all hash-only receipts are durable in the canonical tool-result row. Do not print raw JSON-RPC ids, credentials, endpoints, or account identifiers.",
      ].join(" "),
      clientMsgId: `mcp-code-${context.runId}`,
    },
    rawLog,
  );
  const journal = await waitForTurnTerminal(
    context,
    secrets,
    owner.conversationId,
    result.turnId,
    rawLog,
  );
  const rows = recordsForTurn(journal, result.turnId);
  const codeReceipts = matchedToolReceipts(rows, "code");
  assert(
    codeReceipts.length === 1,
    "MCP proof did not use exactly one isolated Code execution.",
  );
  const codeReceipt = codeReceipts[0];
  const listProof = findObjectWithFields(codeReceipt.result.payload, [
    "initializeRequestIdSha256",
    "initializationReceiptSha256",
    "initializedNotificationReceiptSha256",
    "toolsListRequestIdSha256s",
    "toolsListPageCount",
    "toolsListCompleted",
    "catalogSha256",
    "serverIdSha256",
    "protocolVersion",
  ]);
  const describeProof = findObjectWithFields(codeReceipt.result.payload, [
    "describeRequestIdSha256",
    "toolIdSha256",
    "describeReceiptSha256",
    "describeCompleted",
  ]);
  const callProof = findObjectWithFields(codeReceipt.result.payload, [
    "initializeRequestIdSha256",
    "callRequestIdSha256",
    "toolIdSha256",
    "resultReceiptSha256",
    "callCompleted",
  ]);
  assert(
    listProof && describeProof && callProof,
    "Code result omitted hash-only MCP list/describe/call protocol receipts.",
  );
  requireSha256(
    listProof.initializeRequestIdSha256,
    "MCP initialize request hash",
  );
  requireSha256(
    listProof.initializationReceiptSha256,
    "MCP initialization receipt hash",
  );
  requireSha256(
    listProof.initializedNotificationReceiptSha256,
    "MCP initialized notification receipt hash",
  );
  assert(
    Array.isArray(listProof.toolsListRequestIdSha256s) &&
      listProof.toolsListRequestIdSha256s.length ===
        listProof.toolsListPageCount &&
      listProof.toolsListRequestIdSha256s.every((entry) =>
        /^[a-f0-9]{64}$/u.test(entry),
      ),
    "MCP tools/list page hashes are invalid or incomplete.",
  );
  requireSha256(
    describeProof.describeRequestIdSha256,
    "MCP describe request hash",
  );
  requireSha256(
    describeProof.describeReceiptSha256,
    "MCP describe receipt hash",
  );
  requireSha256(callProof.callRequestIdSha256, "MCP tools/call request hash");
  requireSha256(listProof.serverIdSha256, "MCP server id hash");
  assert(
    listProof.protocolVersion === "2025-03-26",
    "MCP server negotiated an unreviewed protocol version.",
  );
  const requestHashes = [
    listProof.initializeRequestIdSha256,
    ...listProof.toolsListRequestIdSha256s,
    describeProof.describeRequestIdSha256,
    callProof.callRequestIdSha256,
  ];
  assert(
    requestHashes.every((entry) => /^[a-f0-9]{64}$/u.test(entry)) &&
      new Set(requestHashes).size === requestHashes.length,
    "MCP initialize, list, describe, and call reused a request identity.",
  );
  assert(
    callProof.initializeRequestIdSha256 === listProof.initializeRequestIdSha256,
    "MCP call did not reuse the exact initialized server session.",
  );
  const listedCandidates = findObjectsWithFields(codeReceipt.result.payload, [
    "name",
    "integration",
    "revision",
    "toolIdSha256",
  ]).filter((candidate) => candidate.name === configuredToolName);
  const uniqueListedCandidates = new Map(
    listedCandidates.map((candidate) => [
      canonicalJson({
        name: candidate.name,
        integration: candidate.integration,
        revision: candidate.revision,
        toolIdSha256: candidate.toolIdSha256,
      }),
      candidate,
    ]),
  );
  assert(
    uniqueListedCandidates.size === 1,
    "Code result did not identify exactly one reviewed listed connected tool.",
  );
  const listedTool = [...uniqueListedCandidates.values()][0];
  assert(
    listedTool.integration === expectedIntegrationId &&
      listedTool.revision === expectedToolRevision &&
      listedTool.codePolicyVersion === expectedPolicyVersion,
    "MCP tools/list did not return the exact reviewed integration revision and policy.",
  );
  const listedToolIdSha256 = requireSha256(
    listedTool.toolIdSha256,
    "Listed MCP tool id hash",
  );
  const describedToolIdSha256 = requireSha256(
    describeProof.toolIdSha256,
    "Described MCP tool id hash",
  );
  const calledToolIdSha256 = requireSha256(
    callProof.toolIdSha256,
    "Called MCP tool id hash",
  );
  assert(
    listedToolIdSha256 === describedToolIdSha256 &&
      describedToolIdSha256 === calledToolIdSha256,
    "MCP list, describe, and call proofs do not identify the same tool revision.",
  );
  assert(
    describeProof.describeCompleted === true &&
      callProof.callCompleted === true,
    "MCP describe or tools/call did not complete.",
  );
  const integrationId = requireString(
    listedTool.integration,
    "MCP integration id",
    128,
  );
  const integration = requireRecord(
    await convexInternalRun(
      secrets,
      "data/integrations:getUserIntegrationByOwnerAndProvider",
      { ownerId: owner.ownerId, provider: integrationId },
      rawLog,
    ),
    "Selected connected integration",
  );
  assert(
    integration.ownerId === owner.ownerId &&
      integration.provider === integrationId &&
      integration.mode === "composio",
    "Selected MCP tool is not bound to the exact owner's live Composio integration.",
  );
  const integrationConfig = isRecord(integration.config)
    ? integration.config
    : {};
  const connectedAccountId =
    (typeof integration.externalId === "string" && integration.externalId.trim()
      ? integration.externalId.trim()
      : undefined) ??
    (typeof integrationConfig.composioUserId === "string" &&
    integrationConfig.composioUserId.trim()
      ? integrationConfig.composioUserId.trim()
      : undefined);
  assert(
    connectedAccountId && connectedAccountId.length <= 512,
    "Selected connected integration has no bounded provider account identity.",
  );
  const connectedAccountIdSha256 = sha256(connectedAccountId);
  assert(
    connectedAccountIdSha256 === expectedConnectedAccountIdSha256,
    "The connected account changed between catalog preflight and MCP dispatch.",
  );
  const serializedResult = canonicalJson(codeReceipt.result.payload);
  assert(
    serializedResult.includes("OUTBOUND_BLOCKED"),
    "Code execution did not prove global outbound network access was blocked.",
  );
  const codeExecutionId = `code:${sha256(
    `${owner.ownerGeneration}:${owner.conversationId}:${result.turnId}\0${codeReceipt.toolCallId}`,
  )}`;
  rawLog.push(
    rawReceipt("mcp", "mcp.code.real-read", {
      outcome: "completed",
      requestIdSha256: callProof.callRequestIdSha256,
      resourceIdSha256: callProof.toolIdSha256,
      responseSha256: callProof.resultReceiptSha256,
      count: listProof.toolsListPageCount,
    }),
  );
  return {
    observations: {
      conversationId: owner.conversationId,
      turnId: result.turnId,
      workerVersionId: requireUuid(
        state.deployment.workerVersionId,
        "MCP Worker version",
      ),
      codeExecutionId,
      mcpServerIdSha256: listProof.serverIdSha256,
      connectedAccountIdSha256,
      protocolVersion: listProof.protocolVersion,
      integrationId,
      toolName: requireString(listedTool.name, "MCP selected tool name", 300),
      toolRevision: requireString(
        listedTool.revision,
        "MCP selected tool revision",
        192,
      ),
      codePolicyVersion: expectedPolicyVersion,
      toolkitVersion: expectedToolkitVersion,
      catalogRevisionSha256: sha256(canonicalJson(catalogAction)),
      reviewedInputSchemaSha256: sha256(
        requireString(
          catalogAction.reviewedInputSchemaJson,
          "Reviewed MCP input schema",
          256 * 1_024,
        ),
      ),
      initializeRequestIdSha256: listProof.initializeRequestIdSha256,
      toolsListRequestIdSha256s: listProof.toolsListRequestIdSha256s,
      describeRequestIdSha256: describeProof.describeRequestIdSha256,
      toolsCallRequestIdSha256: callProof.callRequestIdSha256,
      initializationReceiptSha256: listProof.initializationReceiptSha256,
      initializedNotificationReceiptSha256:
        listProof.initializedNotificationReceiptSha256,
      describeReceiptSha256: describeProof.describeReceiptSha256,
      listedToolIdSha256,
      describedToolIdSha256,
      calledToolIdSha256,
      toolsListPageCount: listProof.toolsListPageCount,
      providerReceiptSha256: callProof.resultReceiptSha256,
      toolResultSha256: sha256(canonicalJson(codeReceipt.result)),
      initializeCompleted: Boolean(listProof.initializationReceiptSha256),
      initializedNotificationSent:
        listProof.initializedNotificationSent === true,
      toolsListCompleted: listProof.toolsListCompleted === true,
      toolDescribed: describeProof.describeCompleted === true,
      toolsCallCompleted: callProof.callCompleted === true,
      realConnectedService: Boolean(connectedAccountIdSha256),
      externalTransport: "composio",
      disposableConnectedAccount: true,
      externalAccountHashMatched:
        connectedAccountIdSha256 === expectedConnectedAccountIdSha256,
      catalogPolicyVerifiedBeforeCall: true,
      annotationsReadOnly: catalogAction.annotations.readOnlyHint === true,
      annotationsDestructive:
        catalogAction.annotations.destructiveHint === true,
      inProcessFixture: false,
      readOnlyTool:
        listedTool.name === configuredToolName &&
        listedToolIdSha256 === calledToolIdSha256,
      serverPolicyRechecked:
        callProof.callCompleted === true &&
        calledToolIdSha256 === listedToolIdSha256,
      childGlobalOutboundBlocked: serializedResult.includes("OUTBOUND_BLOCKED"),
    },
    patch: {
      mcp: {
        turnId: result.turnId,
        codeExecutionId,
        integrationId,
        toolName: configuredToolName,
        toolRevision: expectedToolRevision,
        codePolicyVersion: expectedPolicyVersion,
        connectedAccountIdSha256,
        toolIdSha256: callProof.toolIdSha256,
        callRequestIdSha256: callProof.callRequestIdSha256,
        receiptSha256: callProof.resultReceiptSha256,
      },
    },
  };
};

const stepGeneralAgentRealSandbox = async ({
  context,
  secrets,
  state,
  rawLog,
}) => {
  const owner = await recoverOwnerIdentity(context, secrets, state, rawLog);
  const browser = requireRecord(
    state.placement?.browser,
    "Browser sandbox placement state",
  );
  const dispatchStatus = requireRecord(
    await convexCall(
      context,
      secrets,
      "query",
      "execution_placement:getMyExecutionDispatchStatus",
      { dispatchId: browser.dispatchId },
      "re-read browser sandbox dispatch",
      rawLog,
    ),
    "Browser sandbox dispatch status",
  );
  const placementIdentity = requireRecord(
    await convexCall(
      context,
      secrets,
      "query",
      "execution_placement:getMyExecutionPlacementIdentity",
      {},
      "re-read browser sandbox placement identity",
      rawLog,
    ),
    "Browser sandbox placement identity",
  );
  assert(
    dispatchStatus.dispatchId === browser.dispatchId &&
      dispatchStatus.conversationId === browser.conversationId &&
      dispatchStatus.state === "completed" &&
      dispatchStatus.placement === "cloud" &&
      dispatchStatus.cloudTurnId === browser.parentTurnId &&
      dispatchStatus.executorDeviceId === undefined &&
      dispatchStatus.executorPresenceSessionId === undefined,
    "General sandbox is not the exact completed browser cloud dispatch without a computer executor.",
  );
  assert(
    placementIdentity.ownerId === owner.ownerId &&
      placementIdentity.ownerGeneration === state.identity.ownerGeneration,
    "General sandbox placement identity is not bound to the exact owner generation.",
  );
  const probe = await threadProbeFor(secrets, owner.ownerId, rawLog, {
    threadId: browser.threadId,
  });
  assert(
    probe.turnId === browser.childTurnId &&
      probe.threadId === browser.threadId &&
      (probe.status === "completed" || probe.turnStatus === "completed"),
    "General sandbox terminal does not identify the exact browser-routed child.",
  );
  const sandbox = requireRealSandboxEvents(probe, browser.sandboxMarker);
  const completion = await completionJournalEvidence(
    context,
    secrets,
    browser.conversationId,
    browser.threadId,
    rawLog,
  );
  assert(
    completion.row.seq === browser.completionJournalSeq &&
      completion.count === 1,
    "General sandbox completion is not the exact once-delivered browser child receipt.",
  );
  const threadJournal = await loadWholeJournal(
    context,
    secrets,
    browser.threadId,
    rawLog,
  );
  const execReceipts = matchedToolReceipts(
    recordsForTurn(threadJournal, browser.childTurnId),
    "exec_command",
  );
  const matchedExecReceipts = execReceipts
    .map((receipt) => {
      const text = collectStringValues(receipt.result.payload).join("\n");
      const structuredSeed = findObjectWithFields(receipt.result.payload, [
        "sourceRevision",
      ]);
      const textMatch = text.match(
        /["']?sourceRevision["']?\s*:\s*["']([^"'\r\n]{1,256})["']/u,
      );
      const sourceRevision =
        typeof structuredSeed?.sourceRevision === "string"
          ? structuredSeed.sourceRevision.trim()
          : textMatch?.[1]?.trim();
      return { receipt, text, sourceRevision };
    })
    .filter(
      (candidate) =>
        candidate.text.includes(browser.sandboxMarker) &&
        typeof candidate.sourceRevision === "string" &&
        candidate.sourceRevision.length > 0,
    );
  assert(
    matchedExecReceipts.length === 1,
    "General sandbox lacks exactly one matched exec_command result containing the nonce and image sourceRevision.",
  );
  const execEvidence = matchedExecReceipts[0];
  const resizedEvents = sandbox.events.filter(
    (event) => event?.kind === "resized",
  );
  assert(
    resizedEvents.length <= 1 &&
      resizedEvents.every(
        (event) =>
          event?.payload?.reason === "out_of_memory" &&
          typeof event?.payload?.instanceType === "string",
      ),
    "General sandbox emitted an unrecognized resize event.",
  );
  const sessionId =
    `agent-${browser.childTurnId}${resizedEvents.length === 1 ? "-lg" : ""}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 56);
  rawLog.push(
    rawReceipt("worker", "journal.sandbox-completion", {
      outcome: "completed",
      resourceIdSha256: sha256(browser.childTurnId),
      responseSha256: sha256(canonicalJson(completion.row)),
      seq: completion.row.seq,
    }),
  );
  return {
    observations: {
      conversationId: browser.conversationId,
      parentTurnId: browser.parentTurnId,
      childTurnId: browser.childTurnId,
      agentId: browser.childTurnId,
      threadId: browser.threadId,
      sandboxIdSha256: sha256(sessionId),
      sandboxProvider: "cloudflare",
      sandboxImageRevision: requireString(
        execEvidence.sourceRevision,
        "Sandbox image source revision",
        256,
      ),
      sandboxOutputSha256: sha256(canonicalJson(execEvidence.receipt.result)),
      completionJournalSeq: completion.row.seq,
      realSandboxStarted: Boolean(sandbox.ready),
      sandboxCommandExecuted: Boolean(execEvidence.receipt.result),
      placementFenceVerified:
        dispatchStatus.cloudTurnId === browser.parentTurnId &&
        dispatchStatus.placement === "cloud" &&
        dispatchStatus.executorDeviceId === undefined &&
        dispatchStatus.executorPresenceSessionId === undefined,
      ownerGenerationVerified:
        placementIdentity.ownerId === owner.ownerId &&
        placementIdentity.ownerGeneration === state.identity.ownerGeneration,
      completionObserved: completion.count === 1,
      completionDeliveryCount: completion.count,
      localRuntimeStarted:
        dispatchStatus.executorDeviceId !== undefined ||
        dispatchStatus.executorPresenceSessionId !== undefined,
      terminalKind: "completed",
    },
    patch: {
      sandbox: {
        threadId: browser.threadId,
        turnId: browser.childTurnId,
        sessionIdSha256: sha256(sessionId),
        terminalProbeSha256: sha256(canonicalJson(probe)),
      },
    },
  };
};

const electronCloudHomeSync = async (
  context,
  electron,
  ownerId,
  accountScope,
  rawLog,
) => {
  const result = await cdpEvaluate(
    electron,
    `(async () => {
      const { convexClient } = await import("/src/platform/convex/convex-client.ts");
      const { cloudHomeApi } = await import("/src/features/cloud/cloud-home-api.ts");
      const { runCloudHomeSync } = await import("/src/features/cloud/cloud-home-sync.ts");
      const { uiState } = await import("/src/platform/ui-state/index.ts");
      const token = await window.electronAPI.system.getConvexAuthToken();
      if (!token) throw new Error("Electron has no Convex token");
      convexClient.setAuth(async () => token);
      const accountScope = ${JSON.stringify(accountScope)};
      const expectedSubject = ${JSON.stringify(ownerId)};
      const ownership = await window.electronAPI.cloudHome.getImportOwnership(accountScope);
      const scan = await window.electronAPI.cloudHome.scanLocal(accountScope);
      const status = await runCloudHomeSync({
        accountScope,
        expectedSubject,
        builderOrigin: ${JSON.stringify(context.target.cloudBuilderUrl)},
        token,
        scanLocal: () => window.electronAPI.cloudHome.scanLocal(accountScope),
        readImportOwnership: window.electronAPI.cloudHome.getImportOwnership,
        readSkillHeads: () => convexClient.query(cloudHomeApi.listMySkillHeads, { clientScope: accountScope }),
        cursorStore: uiState,
      });
      return {
        ownership,
        status: {
          phase: status.phase,
          memoryUploaded: status.memoryUploaded,
          memoryCloudWins: status.memoryCloudWins,
          skipped: status.skipped,
          issueCodes: status.issues.map((issue) => issue.code),
        },
        memories: scan.memories.map((document) => ({
          name: document.name,
          sha256: document.sha256,
          kind: document.kind,
          source: document.source,
          sizeBytes: document.sizeBytes,
        })),
      };
    })()`,
    "run product Cloud Home synchronization",
    120_000,
  );
  rawLog.push(
    rawReceipt("electron-cdp", "electron.cloud-home.sync", {
      outcome: result?.status?.phase === "complete" ? "completed" : "observed",
      responseSha256: sha256(canonicalJson(result)),
      count: Array.isArray(result?.memories) ? result.memories.length : 0,
    }),
  );
  return requireRecord(result, "Electron Cloud Home synchronization");
};

const exactCloudMemoryDocument = (snapshot, name, expectedSha256) => {
  const matches = snapshot.documents.filter(
    (document) =>
      document?.name === name && document?.sha256 === expectedSha256,
  );
  assert(
    matches.length === 1,
    `Cloud Home did not contain exactly one expected ${name} document.`,
  );
  return requireRecord(matches[0], `${name} cloud document`);
};

const startRenderedGenerationRotation = async ({
  context,
  paths,
  state,
  owner,
  accountScope,
  rawLog,
}) => {
  const electron = currentElectron(state);
  const browser = currentRenderedBrowser(state);
  const [electronClient, browserClient] = await Promise.all([
    connectElectronRenderedClient(electron),
    connectBrowserRenderedClient(browser),
  ]);
  let clientsClosed = false;
  const closeClients = () => {
    if (clientsClosed) return;
    clientsClosed = true;
    electronClient.close();
    browserClient.close();
  };
  let resolveRotation;
  let rejectRotation;
  const rotation = new Promise((resolve, reject) => {
    resolveRotation = resolve;
    rejectRotation = reject;
  });
  // A helper may fail before the reset barrier is released. Attach a handler
  // immediately so the driver can fail closed without an unhandled rejection.
  void rotation.catch(() => undefined);
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const readyBySurface = new Map();
  const markReady = (observation) => {
    readyBySurface.set(observation.surface, observation);
    if (
      readyBySurface.has("electron-cdp") &&
      readyBySurface.has("browser-cdp")
    ) {
      resolveReady(
        Object.freeze({
          electron: readyBySurface.get("electron-cdp"),
          browser: readyBySurface.get("browser-cdp"),
        }),
      );
    }
  };
  try {
    await Promise.all([
      selectRenderedConversation(electronClient, {
        conversationId: owner.conversationId,
        timeoutMs: 120_000,
      }),
      selectRenderedConversation(browserClient, {
        conversationId: owner.conversationId,
        timeoutMs: 120_000,
      }),
    ]);
    const browserPromise = exerciseRenderedBrowserGenerationRotation(
      browserClient,
      {
        oldAccountScope: accountScope,
        oldOwnerGeneration: owner.ownerGeneration,
        stalePrompt: `BROWSER-STALE-GENERATION-${context.runId}`,
        rotateGeneration: async () => await rotation,
        onOldGenerationReady: async (observation) => markReady(observation),
        timeoutMs: 180_000,
      },
    );
    const electronPromise = exerciseRenderedElectronGenerationRotation(
      electronClient,
      {
        oldAccountScope: accountScope,
        oldOwnerGeneration: owner.ownerGeneration,
        rotateGeneration: async () => await rotation,
        onOldGenerationReady: async (observation) => markReady(observation),
        timeoutMs: 180_000,
      },
    );
    const failBeforeReady = Promise.all([browserPromise, electronPromise])
      .then(() => {
        throw new CloudProofError(
          "Rendered generation helpers completed before the reset barrier.",
        );
      })
      .catch((error) => {
        rejectReady(error);
        throw error;
      });
    void failBeforeReady.catch(() => undefined);
    const readyObservation = await ready;
    rawLog.push(
      rawReceipt("electron-cdp", "electron.generation-barrier.ready", {
        outcome: "old-authority-mounted",
        stateSha256: sha256(canonicalJson(readyObservation.electron)),
      }),
      rawReceipt("browser-cdp", "browser.generation-barrier.ready", {
        outcome: "old-authority-mounted",
        stateSha256: sha256(canonicalJson(readyObservation.browser)),
      }),
    );
    let settled = false;
    return Object.freeze({
      ready: readyObservation,
      async complete({ ownerGeneration, conversationId }) {
        assert(!settled, "Rendered generation barrier was already settled.");
        settled = true;
        resolveRotation({
          ownerGeneration: requireString(
            ownerGeneration,
            "Rendered replacement owner generation",
            512,
          ),
          replacementConversationId: requireUuid(
            conversationId,
            "Rendered replacement conversation",
          ),
        });
        try {
          const [browserObservation, electronObservation] = await Promise.all([
            browserPromise,
            electronPromise,
          ]);
          const browserProof = renderedProofEntry({
            surface: "browser-cdp",
            operation: "rendered.generation-rotation",
            processIdentity: browser.processIdentity,
            observation: browserObservation,
            rawLog,
          });
          const electronProof = renderedProofEntry({
            surface: "electron-cdp",
            operation: "rendered.generation-rotation",
            processIdentity: electron.processIdentity,
            observation: electronObservation,
            rawLog,
          });
          return Object.freeze({
            browserProof,
            electronProof,
            proofSetSha256: renderedProofSetSha256([
              browserProof,
              electronProof,
            ]),
          });
        } finally {
          closeClients();
        }
      },
      async abort(error) {
        if (!settled) {
          settled = true;
          rejectRotation(error);
        }
        await Promise.allSettled([browserPromise, electronPromise]);
        closeClients();
      },
    });
  } catch (error) {
    rejectRotation(error);
    rejectReady(error);
    closeClients();
    throw error;
  }
};

const stepOwnerResetMemoryReimport = async ({
  context,
  secrets,
  paths,
  state,
  rawLog,
  checkpoint,
}) => {
  const owner = await recoverOwnerIdentity(context, secrets, state, rawLog);
  const electron = currentElectron(state);
  const jwtSubject = parseJwtSubject(secrets.jwt);
  const accountScope = `account:${jwtSubject}`;
  const sandbox = requireRecord(state.sandbox, "Pre-reset sandbox state");
  const sandboxProbe = await threadProbeFor(secrets, owner.ownerId, rawLog, {
    threadId: sandbox.threadId,
  });
  const preResetSandboxTerminalVerified = Boolean(
    sandboxProbe.turnId === sandbox.turnId &&
    (sandboxProbe.status === "completed" ||
      sandboxProbe.turnStatus === "completed"),
  );
  assert(
    preResetSandboxTerminalVerified,
    "Full owner reset refused to erase an unverified sandbox terminal.",
  );

  const localLeaf = `acceptance-${sha256(context.runId).slice(0, 24)}.md`;
  const localRelativePath = `memories/imports/${localLeaf}`;
  const cloudDocumentName = `imports/local/${localLeaf}`;
  const localFile = assertNarrowIsolatedPath(
    path.join(electron.data, ...localRelativePath.split("/")),
    paths.root,
    "Preserved local memory fixture",
  );
  const localContent = [
    "# Stella acceptance local memory",
    "",
    `Durable local marker ${sha256(`local-memory\0${context.runId}`)}.`,
    "",
  ].join("\n");
  const localContentSha256 = sha256(localContent);
  await mkdir(path.dirname(localFile), { recursive: true, mode: 0o700 });
  await writeFile(localFile, localContent, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });

  const ownership = await cdpEvaluate(
    electron,
    `(async () => {
      const session = await window.electronAPI.system.getAuthSession();
      const subject = session?.user?.id ?? null;
      const scope = ${JSON.stringify(accountScope)};
      const before = await window.electronAPI.cloudHome.getImportOwnership(scope);
      const confirmed = await window.electronAPI.cloudHome.confirmImportOwnership(scope);
      const after = await window.electronAPI.cloudHome.getImportOwnership(scope);
      return { subjectMatches: subject === ${JSON.stringify(jwtSubject)}, before, confirmed, after };
    })()`,
    "confirm product local-import ownership",
    60_000,
  );
  assert(
    ownership?.subjectMatches === true &&
      ownership?.confirmed === true &&
      ownership?.after === "owned",
    "Electron did not bind the exact signed-in account to the local import corpus.",
  );
  rawLog.push(
    rawReceipt("electron-cdp", "electron.cloud-home.owner-confirm", {
      outcome: "owned",
      responseSha256: sha256(canonicalJson(ownership)),
    }),
  );

  const initialSync = await electronCloudHomeSync(
    context,
    electron,
    owner.ownerId,
    accountScope,
    rawLog,
  );
  const initialLocal = initialSync.memories?.find(
    (document) => document?.name === cloudDocumentName,
  );
  assert(
    initialSync.ownership === "owned" &&
      initialLocal?.sha256 === localContentSha256,
    "The product scanner did not return the exact local memory fixture.",
  );
  const initialExport = await loadCloudHomeExport(context, secrets, rawLog);
  const initialDocument = exactCloudMemoryDocument(
    initialExport,
    cloudDocumentName,
    localContentSha256,
  );
  const initialHead = requireRecord(
    await cloudMemoryHead(
      context,
      secrets,
      owner,
      cloudDocumentName,
      "imported_markdown",
      rawLog,
    ),
    "Initial imported-memory head",
  );
  await exactR2Object(
    secrets,
    REQUIRED_AGENT_HOME_BUCKET_NAME,
    requireString(initialHead.r2Key, "Initial imported-memory R2 key", 1_024),
    rawLog,
  );
  const oldMemoryEpoch = requireString(
    initialExport.memoryEpoch,
    "Initial memory epoch",
    512,
  );

  await convexCall(
    context,
    secrets,
    "mutation",
    "cloud_memory_lifecycle:startMyMemoryWipe",
    {
      expectedSubject: owner.ownerId,
      expectedOwnerGeneration: owner.ownerGeneration,
      expectedMemoryEpoch: oldMemoryEpoch,
      requestId: `acceptance-memory-wipe-${context.runId}`,
    },
    "start disposable memory-only wipe",
    rawLog,
  );
  const wiped = await poll(
    async () =>
      await convexCall(
        context,
        secrets,
        "query",
        "cloud_memory_lifecycle:getMyMemoryWipeStatus",
        { expectedSubject: owner.ownerId },
        "poll disposable memory-only wipe",
        rawLog,
      ),
    (status) =>
      status?.state === "open" &&
      status?.job?.stage === "completed" &&
      status?.importDisposition === "explicit_required" &&
      status?.memoryEpoch !== oldMemoryEpoch,
    {
      timeoutMs: DEFAULT_TURN_TIMEOUT_MS,
      intervalMs: 1_000,
      label: "memory-only wipe completion",
    },
  );
  const newMemoryEpoch = requireString(
    wiped.memoryEpoch,
    "Post-wipe memory epoch",
    512,
  );
  const emptyAfterWipe = await loadCloudHomeExport(context, secrets, rawLog);
  assert(
    !emptyAfterWipe.documents.some(
      (document) => document?.name === cloudDocumentName,
    ),
    "Memory-only wipe retained the exact imported local document.",
  );
  const oldObjectAfterWipe = await r2ListObjects(
    secrets,
    REQUIRED_AGENT_HOME_BUCKET_NAME,
    initialHead.r2Key,
    rawLog,
  );
  assert(
    oldObjectAfterWipe.length === 0,
    "Memory-only wipe retained its old R2 object.",
  );

  const blockedSync = await electronCloudHomeSync(
    context,
    electron,
    owner.ownerId,
    accountScope,
    rawLog,
  );
  assert(
    blockedSync.status?.issueCodes?.includes(
      "memory_reimport_confirmation_required",
    ) && blockedSync.status?.memoryUploaded === 0,
    "Cloud Home did not block implicit local-memory reimport after a wipe.",
  );
  const blockedExport = await loadCloudHomeExport(context, secrets, rawLog);
  assert(
    !blockedExport.documents.some(
      (document) => document?.name === cloudDocumentName,
    ),
    "Blocked reimport wrote the local memory document.",
  );

  const authorized = await convexCall(
    context,
    secrets,
    "mutation",
    "cloud_memory_lifecycle:authorizeMyMemoryReimport",
    {
      expectedSubject: owner.ownerId,
      expectedOwnerGeneration: owner.ownerGeneration,
      expectedMemoryEpoch: newMemoryEpoch,
      requestId: `acceptance-memory-reimport-${context.runId}`,
    },
    "authorize explicit local-memory reimport",
    rawLog,
  );
  assert(
    authorized?.importDisposition === "explicit_allowed",
    "Explicit local-memory reimport authorization did not open the new epoch.",
  );
  const authorizedSync = await electronCloudHomeSync(
    context,
    electron,
    owner.ownerId,
    accountScope,
    rawLog,
  );
  assert(
    authorizedSync.status?.memoryUploaded >= 1,
    "Authorized Cloud Home synchronization did not upload local memory.",
  );
  const reimportExport = await loadCloudHomeExport(context, secrets, rawLog);
  exactCloudMemoryDocument(
    reimportExport,
    cloudDocumentName,
    localContentSha256,
  );
  const reimportHead = requireRecord(
    await cloudMemoryHead(
      context,
      secrets,
      owner,
      cloudDocumentName,
      "imported_markdown",
      rawLog,
    ),
    "Explicit reimport head",
  );
  const reimportObject = await exactR2Object(
    secrets,
    REQUIRED_AGENT_HOME_BUCKET_NAME,
    requireString(reimportHead.r2Key, "Explicit reimport R2 key", 1_024),
    rawLog,
  );

  await checkpoint({
    ownerReset: {
      phase: "reset_pending",
      oldOwnerGeneration: owner.ownerGeneration,
      oldMemoryEpoch,
      newMemoryEpoch,
      localRelativePath,
      cloudDocumentName,
      localContentSha256,
      preResetSandboxTerminalVerified,
    },
    resources: {
      ...state.resources,
      ownerGenerations: [
        ...new Set([
          ...(state.resources?.ownerGenerations ?? []),
          owner.ownerGeneration,
        ]),
      ],
      agentHomeR2Keys: [
        ...new Set([
          ...(state.resources?.agentHomeR2Keys ?? []),
          initialHead.r2Key,
          reimportHead.r2Key,
        ]),
      ],
    },
  });

  const preservedIntegrationId = requireString(
    state.mcp?.integrationId,
    "Connected integration id before owner reset",
    128,
  );
  const integrationBeforeReset = requireRecord(
    await convexInternalRun(
      secrets,
      "data/integrations:getUserIntegrationByOwnerAndProvider",
      { ownerId: owner.ownerId, provider: preservedIntegrationId },
      rawLog,
    ),
    "Connected integration before owner reset",
  );
  assert(
    integrationBeforeReset.ownerId === owner.ownerId &&
      integrationBeforeReset.provider === preservedIntegrationId &&
      integrationBeforeReset.mode === "composio",
    "Owner reset preflight did not resolve the reviewed connected integration.",
  );
  const integrationBeforeResetSha256 = sha256(
    canonicalJson(integrationBeforeReset),
  );

  const mobileGeneration = await startMountedRnGenerationRotation({
    context,
    secrets,
    paths,
    state,
    owner,
    electron,
    rawLog,
  });
  secrets = ephemeralJwtSecrets(
    secrets,
    mobileGeneration.session.token,
    "owner reset generation barrier",
  );
  assertJwtAuthorityThroughDeadline(
    mobileGeneration.session.tokenIdentity,
    "owner reset generation barrier",
    { deadlineMs: mobileGeneration.command.deadlineAt },
  );
  let renderedGeneration = null;
  try {
    renderedGeneration = await startRenderedGenerationRotation({
      context,
      paths,
      state,
      owner,
      accountScope,
      rawLog,
    });
    await checkpoint({
      ownerReset: {
        ...state.ownerReset,
        phase: "generation_barriers_ready",
        oldOwnerGeneration: owner.ownerGeneration,
        oldMemoryEpoch,
        newMemoryEpoch,
        localRelativePath,
        cloudDocumentName,
        localContentSha256,
        preResetSandboxTerminalVerified,
        mobileGenerationReadySha256: sha256(
          canonicalJson(mobileGeneration.ready),
        ),
        mobileGenerationBarrierDirectorySha256: sha256(
          mobileGeneration.barrierDirectory,
        ),
        renderedGenerationReadySha256: sha256(
          canonicalJson(renderedGeneration.ready),
        ),
      },
    });
    assertJwtAuthorityThroughDeadline(
      mobileGeneration.session.tokenIdentity,
      "owner reset execution",
      { deadlineMs: mobileGeneration.command.deadlineAt },
    );
    assertJwtAuthorityThroughDeadline(
      mobileGeneration.session.tokenIdentity,
      "owner reset continuation reserve",
      {
        deadlineMs:
          mobileGeneration.proofDeadlineAt -
          OWNER_RESET_CONTINUATION_RESERVE_MS,
      },
    );
    const resetResult = await convexCall(
      context,
      secrets,
      "action",
      "reset:resetAllUserData",
      {},
      "execute complete disposable owner reset",
      rawLog,
    );
    assert(resetResult === null, "Full owner reset did not complete.");
    const postResetSessionAuthority = await readElectronSessionAuthority(
      context,
      secrets,
      electron,
      null,
      rawLog,
      "immediate post-reset session",
    );
    assert(
      postResetSessionAuthority.subject === mobileGeneration.session.subject &&
        postResetSessionAuthority.sessionId ===
          mobileGeneration.session.sessionId,
      "Immediate post-reset product-profile refresh changed the authenticated account.",
    );
    secrets = ephemeralJwtSecrets(
      secrets,
      postResetSessionAuthority.token,
      "immediate post-reset session",
    );
    const lifecycle = requireRecord(
      await convexInternalRun(
        secrets,
        "owner_lifecycle:getOwnerDataAccessStateInternal",
        { ownerId: owner.ownerId },
        rawLog,
      ),
      "Post-reset owner lifecycle",
    );
    const newOwnerGeneration = requireString(
      lifecycle.generation,
      "Rotated owner generation",
      512,
    );
    assert(
      lifecycle.allowed === true &&
        lifecycle.state === "open" &&
        newOwnerGeneration !== owner.ownerGeneration,
      "Full owner reset did not atomically reopen on a new generation.",
    );
    const purgeJob = requireRecord(
      await convexInternalRun(
        secrets,
        "owner_lifecycle:getOwnerPurgeJobInternal",
        { ownerId: owner.ownerId },
        rawLog,
      ),
      "Completed owner reset job",
    );
    assert(
      purgeJob.mode === "reset" && purgeJob.stage === "complete",
      "Owner reset job is not durably complete.",
    );
    const resetResidue = await convexInternalRun(
      secrets,
      "reset:remainingOwnerResetStoresInternal",
      { ownerId: owner.ownerId },
      rawLog,
    );
    assert(
      Array.isArray(resetResidue) && resetResidue.length === 0,
      "Full reset left old-owner Convex residue before reconstitution.",
    );
    const integrationAfterReset = requireRecord(
      await convexInternalRun(
        secrets,
        "data/integrations:getUserIntegrationByOwnerAndProvider",
        { ownerId: owner.ownerId, provider: preservedIntegrationId },
        rawLog,
      ),
      "Connected integration after owner reset",
    );
    const integrationAfterResetSha256 = sha256(
      canonicalJson(integrationAfterReset),
    );
    const connectedIntegrationPreservedByReset =
      integrationAfterResetSha256 === integrationBeforeResetSha256 &&
      integrationAfterReset.ownerId === owner.ownerId &&
      integrationAfterReset.provider === preservedIntegrationId &&
      integrationAfterReset.mode === "composio";
    assert(
      connectedIntegrationPreservedByReset,
      "Full owner reset did not preserve the reviewed connected integration exactly.",
    );
    const oldGenerationPrefix = `agent-home/${state.identity.ownerIdSha256}/generations/${sha256(owner.ownerGeneration)}/`;
    const oldGenerationObjects = await r2ListObjects(
      secrets,
      REQUIRED_AGENT_HOME_BUCKET_NAME,
      oldGenerationPrefix,
      rawLog,
    );
    assert(
      oldGenerationObjects.length === 0,
      "Full reset retained old-generation Agent Home objects.",
    );
    const newConversation = requireRecord(
      await convexCall(
        context,
        secrets,
        "mutation",
        "cloud_apps:createMyConversation",
        {
          clientCreateId: `acceptance-post-reset:${context.runId}`,
          expectedOwnerGeneration: newOwnerGeneration,
          title: `stella-cloud-acceptance:${context.runId}`,
        },
        "create post-reset acceptance conversation",
        rawLog,
      ),
      "Post-reset conversation",
    );
    const newConversationId = requireUuid(
      newConversation.conversationId,
      "Post-reset conversation id",
    );
    const postResetConversationAuthority = await readElectronSessionAuthority(
      context,
      secrets,
      electron,
      newConversationId,
      rawLog,
      "post-reset replacement conversation",
    );
    assert(
      postResetConversationAuthority.subject ===
        mobileGeneration.session.subject &&
        postResetConversationAuthority.sessionId ===
          mobileGeneration.session.sessionId,
      "Post-reset product-profile refresh changed the authenticated account.",
    );
    secrets = ephemeralJwtSecrets(
      secrets,
      postResetConversationAuthority.token,
      "post-reset replacement conversation",
    );
    const newOwner = await ownerLookup(
      context,
      secrets,
      newConversationId,
      rawLog,
    );
    assert(
      newOwner.ownerId === owner.ownerId &&
        newOwner.ownerGeneration === newOwnerGeneration,
      "Post-reset conversation was not created under the rotated owner generation.",
    );
    await checkpoint({
      ownerReset: {
        ...state.ownerReset,
        phase: "replacement_conversation_created",
        newOwnerGeneration,
        newConversationId,
        integrationBeforeResetSha256,
        integrationAfterResetSha256,
        connectedIntegrationPreservedByReset,
      },
      resources: {
        ...state.resources,
        conversations: [newConversationId],
        ownerGenerations: [
          ...new Set([
            ...(state.resources?.ownerGenerations ?? []),
            owner.ownerGeneration,
            newOwnerGeneration,
          ]),
        ],
      },
    });
    const renderedGenerationCompletion = renderedGeneration.complete({
      ownerGeneration: newOwnerGeneration,
      conversationId: newConversationId,
    });
    void renderedGenerationCompletion.catch(() => undefined);
    assertJwtAuthorityThroughDeadline(
      mobileGeneration.session.tokenIdentity,
      "mounted RN generation continuation",
      { deadlineMs: mobileGeneration.proofDeadlineAt },
    );
    await atomicWritePrivateJson(mobileGeneration.continueFile, {
      ownerGeneration: newOwnerGeneration,
      conversationId: newConversationId,
    });
    const continueMetadata = await stat(mobileGeneration.continueFile);
    assert(
      continueMetadata.isFile() && (continueMetadata.mode & 0o777) === 0o600,
      "Mounted RN generation continuation is not a private regular file.",
    );
    rawLog.push(
      rawReceipt("mobile-client", "mobile.rn.generation-barrier.continue", {
        outcome: "rotated-authority-released",
        resourceIdSha256: sha256(newConversationId),
        responseSha256: sha256(
          canonicalJson({
            ownerGenerationSha256: sha256(newOwnerGeneration),
            conversationIdSha256: sha256(newConversationId),
          }),
        ),
      }),
    );
    const [mobileGenerationCommandResult, renderedGenerationProof] =
      await Promise.all([
        mobileGeneration.command.completion,
        renderedGenerationCompletion,
      ]);
    assertJwtAuthorityThroughDeadline(
      mobileGeneration.session.tokenIdentity,
      "mounted RN generation completion",
      { deadlineMs: mobileGeneration.proofDeadlineAt },
    );
    const mobileGenerationRotation = await validateMountedRnGenerationResult({
      value: parseJsonOutput(
        mobileGenerationCommandResult.output,
        "Mounted RN post-reset generation acceptance",
      ),
      bunVersion: mobileGeneration.bunVersion,
      ready: mobileGeneration.ready,
      priorMobile: mobileGeneration.priorMobile,
      oldConversationId: owner.conversationId,
      newConversationId,
      oldOwnerGeneration: owner.ownerGeneration,
      newOwnerGeneration,
      sensitiveValues: [
        context.runId,
        mobileGeneration.session.token,
        postResetSessionAuthority.token,
        postResetConversationAuthority.token,
        mobileGeneration.session.subject,
        mobileGeneration.session.sessionId,
        owner.ownerGeneration,
        newOwnerGeneration,
        owner.conversationId,
        newConversationId,
        context.target.convexUrl,
        context.target.convexSiteUrl,
        context.target.cloudBuilderUrl,
      ],
    });
    const mobileGenerationResultSha256 = sha256(
      canonicalJson(mobileGenerationRotation),
    );
    const mobileGenerationReadySha256 = sha256(
      canonicalJson(mobileGeneration.ready),
    );
    for (const receipt of mobileGenerationRotation.receipts) {
      rawLog.push(
        rawReceipt(receipt.surface, receipt.operation, {
          outcome: receipt.outcome,
          requestIdSha256: receipt.requestIdSha256,
          stateSha256: receipt.stateSha256,
          count: receipt.count,
        }),
      );
    }
    rawLog.push(
      rawReceipt("mobile-client", "mobile.rn.acceptance.post-reset-process", {
        outcome: "completed",
        processOutputSha256: mobileGenerationCommandResult.outputSha256,
        responseSha256: mobileGenerationResultSha256,
        stateSha256: mobileGenerationReadySha256,
        durationMs: mobileGenerationCommandResult.durationMs,
      }),
    );
    assert(
      !(await pathExists(mobileGeneration.continueFile)),
      "Mounted RN generation child did not consume its continuation barrier.",
    );
    await rm(mobileGeneration.barrierDirectory, {
      recursive: true,
      force: false,
    });
    assert(
      !(await pathExists(mobileGeneration.barrierDirectory)),
      "Mounted RN generation barrier directory was not removed.",
    );
    const hardReset = await cdpEvaluate(
      electron,
      `(async () => await window.electronAPI.ui.hardReset())()`,
      "hard reset isolated Electron product state",
      120_000,
    );
    assert(hardReset?.ok === true, "Electron hard reset failed.");
    rawLog.push(
      rawReceipt("electron-cdp", "electron.local-state.hard-reset", {
        outcome: "completed",
        responseSha256: sha256(canonicalJson(hardReset)),
      }),
    );
    assert(
      (await readFile(localFile, "utf8")) === localContent,
      "Electron hard reset erased explicitly retained local memory.",
    );
    await configureElectronSession(
      context,
      secrets,
      electron,
      newConversationId,
      rawLog,
    );
    const postResetCatalogAction = requireRecord(
      await convexInternalRun(
        secrets,
        "cloud_integration_catalog:getCodeIntegrationActionInternal",
        {
          ownerId: newOwner.ownerId,
          ownerGeneration: newOwner.ownerGeneration,
          name: requireString(
            state.mcp?.toolName,
            "Reviewed MCP tool name after reset",
            300,
          ),
        },
        rawLog,
      ),
      "Reviewed connected-tool catalog action after reset",
    );
    const connectedIntegrationRoutedAfterReset =
      postResetCatalogAction.integrationId === preservedIntegrationId &&
      postResetCatalogAction.revision === state.mcp?.toolRevision &&
      postResetCatalogAction.codeModePolicy?.policyVersion ===
        state.mcp?.codePolicyVersion &&
      postResetCatalogAction.annotations?.readOnlyHint === true &&
      postResetCatalogAction.annotations?.destructiveHint === false;
    assert(
      connectedIntegrationRoutedAfterReset,
      "The preserved connected integration was not routable under the rotated owner generation.",
    );

    const postResetArgumentsText = requiredEnv(
      "STELLA_CLOUD_ACCEPTANCE_MCP_TOOL_ARGUMENTS_JSON",
    );
    let postResetArguments;
    try {
      postResetArguments = JSON.parse(postResetArgumentsText);
    } catch {
      throw new CloudProofError(
        "STELLA_CLOUD_ACCEPTANCE_MCP_TOOL_ARGUMENTS_JSON must remain valid JSON after reset.",
      );
    }
    assert(
      isRecord(postResetArguments),
      "Post-reset reviewed MCP tool arguments must remain one JSON object.",
    );
    const postResetArgumentsJson = canonicalJson(postResetArguments);
    const postResetMcpTurn = await electronCloudTurn(
      context,
      electron,
      newOwner,
      newConversationId,
      {
        prompt: [
          "Run the Code tool exactly once for this post-reset connected-account proof.",
          "Inside that one Code execution, call codemode.mcp_list({}) and parse its JSON proof and tools.",
          `Select only the exact reviewed listed tool named ${JSON.stringify(state.mcp.toolName)} and require exact revision ${JSON.stringify(state.mcp.toolRevision)}; fail if either differs.`,
          `Call codemode.mcp_call with that exact listed revision and these exact reviewed read-only arguments: ${postResetArgumentsJson}.`,
          "Return the complete mcp_list and mcp_call results plus selected tool metadata so the second external read is durable. Do not print raw credentials, endpoints, or account identifiers.",
        ].join(" "),
        clientMsgId: `mcp-post-reset-${context.runId}`,
      },
      rawLog,
    );
    const postResetMcpJournal = await waitForTurnTerminal(
      context,
      secrets,
      newConversationId,
      postResetMcpTurn.turnId,
      rawLog,
    );
    const postResetMcpRows = recordsForTurn(
      postResetMcpJournal,
      postResetMcpTurn.turnId,
    );
    const postResetCodeReceipts = matchedToolReceipts(postResetMcpRows, "code");
    assert(
      postResetCodeReceipts.length === 1,
      "Post-reset connected-account proof did not use exactly one Code execution.",
    );
    const postResetCallProof = requireRecord(
      findObjectWithFields(postResetCodeReceipts[0].result.payload, [
        "callRequestIdSha256",
        "toolIdSha256",
        "resultReceiptSha256",
        "callCompleted",
      ]),
      "Post-reset MCP call proof",
    );
    const postResetMcpProviderReceiptSha256 = requireSha256(
      postResetCallProof.resultReceiptSha256,
      "Post-reset MCP provider receipt",
    );
    const postResetMcpCallRequestIdSha256 = requireSha256(
      postResetCallProof.callRequestIdSha256,
      "Post-reset MCP call request",
    );
    const postResetMcpToolIdSha256 = requireSha256(
      postResetCallProof.toolIdSha256,
      "Post-reset MCP tool id",
    );
    assert(
      postResetCallProof.callCompleted === true &&
        postResetMcpToolIdSha256 === state.mcp.toolIdSha256 &&
        postResetMcpCallRequestIdSha256 !== state.mcp.callRequestIdSha256,
      "The rotated owner generation did not reuse the exact reviewed connected tool.",
    );
    rawLog.push(
      rawReceipt("mcp", "mcp.post-reset.real-read", {
        outcome: "completed",
        requestIdSha256: postResetMcpCallRequestIdSha256,
        resourceIdSha256: state.mcp.toolIdSha256,
        responseSha256: postResetMcpProviderReceiptSha256,
      }),
    );
    const preserved = await cdpEvaluate(
      electron,
      `(async () => {
      const scope = ${JSON.stringify(accountScope)};
      const ownership = await window.electronAPI.cloudHome.getImportOwnership(scope);
      const scan = await window.electronAPI.cloudHome.scanLocal(scope);
      const document = scan.memories.find((entry) => entry.name === ${JSON.stringify(cloudDocumentName)});
      return { ownership, sha256: document?.sha256 ?? null };
    })()`,
      "verify post-reset local-memory preservation",
      60_000,
    );
    assert(
      preserved?.ownership === "owned" &&
        preserved?.sha256 === localContentSha256,
      "Hard reset did not preserve the owned local memory corpus exactly.",
    );
    const postResetSync = await electronCloudHomeSync(
      context,
      electron,
      owner.ownerId,
      accountScope,
      rawLog,
    );
    assert(
      postResetSync.status?.memoryUploaded >= 1,
      "Rotated generation did not reimport explicitly retained local memory.",
    );
    const postResetExport = await loadCloudHomeExport(context, secrets, rawLog);
    assert(
      postResetExport.ownerGeneration === newOwnerGeneration,
      "Post-reset Cloud Home export used the old owner generation.",
    );
    const postResetDocument = exactCloudMemoryDocument(
      postResetExport,
      cloudDocumentName,
      localContentSha256,
    );
    const postResetHead = requireRecord(
      await cloudMemoryHead(
        context,
        secrets,
        newOwner,
        cloudDocumentName,
        "imported_markdown",
        rawLog,
      ),
      "Post-reset imported-memory head",
    );
    const postResetObject = await exactR2Object(
      secrets,
      REQUIRED_AGENT_HOME_BUCKET_NAME,
      requireString(
        postResetHead.r2Key,
        "Post-reset imported-memory R2 key",
        1_024,
      ),
      rawLog,
    );

    return {
      observations: {
        oldConversationId: owner.conversationId,
        newConversationId,
        oldOwnerGenerationSha256: sha256(owner.ownerGeneration),
        newOwnerGenerationSha256: sha256(newOwnerGeneration),
        oldMemoryEpochSha256: sha256(oldMemoryEpoch),
        wipedMemoryEpochSha256: sha256(newMemoryEpoch),
        postResetMemoryEpochSha256: sha256(
          requireString(
            postResetExport.memoryEpoch,
            "Post-reset memory epoch",
            512,
          ),
        ),
        localDocumentName: cloudDocumentName,
        localDocumentSha256: localContentSha256,
        initialVersionId: initialDocument.versionId,
        explicitReimportVersionId: reimportHead.versionId,
        explicitReimportR2KeySha256: sha256(reimportHead.r2Key),
        explicitReimportR2Etag: reimportObject.etag,
        postResetVersionId: postResetDocument.versionId,
        postResetR2KeySha256: sha256(postResetHead.r2Key),
        postResetR2Etag: postResetObject.etag,
        signedInOwnershipConfirmed: true,
        initialLocalImportObserved: true,
        memoryWipeCompleted: true,
        implicitReimportBlocked: true,
        explicitReimportAuthorized: true,
        explicitReimportExact: true,
        ownerGenerationRotated: true,
        resetJobCompleted: true,
        remainingResetOwnedCoreStoreCount: resetResidue.length,
        oldGenerationR2ObjectCount: oldGenerationObjects.length,
        integrationBeforeResetSha256,
        integrationAfterResetSha256,
        connectedIntegrationPreservedByReset,
        connectedIntegrationRoutedAfterReset,
        connectedIntegrationUsedAfterReset:
          postResetCallProof.callCompleted === true,
        postResetMcpCallRequestIdSha256,
        postResetMcpToolIdSha256,
        postResetMcpProviderReceiptSha256,
        mobileGenerationRotation,
        mobileGenerationResultSha256,
        mobileGenerationReadySha256,
        mobileGenerationBarrierRemoved: true,
        renderedGenerationProofs: [
          renderedGenerationProof.browserProof,
          renderedGenerationProof.electronProof,
        ],
        renderedGenerationProofSetSha256:
          renderedGenerationProof.proofSetSha256,
        renderedGenerationReadySha256: sha256(
          canonicalJson(renderedGeneration.ready),
        ),
        preResetSandboxTerminalVerified,
        localMemoryPreservedByHardReset: true,
        localOwnershipMarkerPreserved: preserved.ownership === "owned",
        postResetReimportExact: postResetHead.sha256 === localContentSha256,
      },
      patch: {
        ownerReset: {
          phase: "reconstituted",
          oldOwnerGeneration: owner.ownerGeneration,
          newOwnerGeneration,
          oldMemoryEpoch,
          wipedMemoryEpoch: newMemoryEpoch,
          localRelativePath,
          cloudDocumentName,
          localContentSha256,
          newConversationId,
          postResetR2Key: postResetHead.r2Key,
          preResetSandboxTerminalVerified,
          remainingResetOwnedCoreStoreCount: resetResidue.length,
          oldGenerationR2ObjectCount: oldGenerationObjects.length,
          integrationBeforeResetSha256,
          integrationAfterResetSha256,
          connectedIntegrationPreservedByReset,
          connectedIntegrationRoutedAfterReset,
          connectedIntegrationUsedAfterReset:
            postResetCallProof.callCompleted === true,
          postResetMcpCallRequestIdSha256,
          postResetMcpToolIdSha256,
          postResetMcpProviderReceiptSha256,
          mobileGenerationResultSha256,
          mobileGenerationReadySha256,
          mobileGenerationBarrierRemoved: true,
          renderedGenerationProofSetSha256:
            renderedGenerationProof.proofSetSha256,
          renderedGenerationReadySha256: sha256(
            canonicalJson(renderedGeneration.ready),
          ),
        },
        primary: { ...state.primary, conversationId: newConversationId },
        resources: {
          ...state.resources,
          conversations: [newConversationId],
          ownerGenerations: [
            ...new Set([
              ...(state.resources?.ownerGenerations ?? []),
              owner.ownerGeneration,
              newOwnerGeneration,
            ]),
          ],
          agentHomeR2Keys: [
            ...new Set([
              ...(state.resources?.agentHomeR2Keys ?? []),
              postResetHead.r2Key,
            ]),
          ],
        },
      },
    };
  } catch (error) {
    if (renderedGeneration !== null) {
      await renderedGeneration.abort(error).catch(() => undefined);
    }
    await mobileGeneration.command.terminate().catch(() => undefined);
    throw error;
  }
};

const stepAppsHostWorkerdRuntime = async ({
  context,
  paths,
  rawLog,
  checkpoint,
}) => {
  const stateDirectory = assertNarrowIsolatedPath(
    path.join(paths.stateDirectory, "apps-host-workerd"),
    paths.root,
    "Apps Host workerd state",
  );
  await checkpoint({
    appsHostWorkerd: {
      stateDirectorySha256: sha256(stateDirectory),
      cleanupPending: true,
    },
  });
  const result = requireRecord(
    await runAppsHostWorkerdAcceptance({
      stateDirectory,
      runId: context.runId,
    }),
    "Apps Host Workerd acceptance result",
  );
  const observations = requireRecord(
    result.observations,
    "Apps Host Workerd observations",
  );
  assert(
    Array.isArray(result.receipts) && result.receipts.length >= 12,
    "Apps Host Workerd acceptance omitted required raw runtime receipts.",
  );
  for (const entry of result.receipts) {
    const checked = requireRecord(entry, "Apps Host Workerd raw receipt");
    assert(
      checked.surface === "apps-host-workerd" &&
        checked.mocked === false &&
        checked.synthetic === false,
      "Apps Host Workerd receipt did not attest to the real runtime surface.",
    );
    rawLog.push(checked);
  }
  assert(
    observations.workerName === REQUIRED_APPS_HOST_WORKER_NAME &&
      observations.deploymentIdentity === REQUIRED_CONVEX.deployment &&
      observations.runtimeEngine === "workerd" &&
      observations.wranglerVersion === "4.127.1",
    "Apps Host Workerd acceptance used an unreviewed runtime identity.",
  );
  for (const field of [
    "bundleSha256",
    "routeSetSha256",
    "appAssetSha256",
    "interiorManifestSha256",
    "interiorAssetsSha256",
    "authHandoffSha256",
    "blockedProxyResponseSha256",
    "receiptChainSha256",
  ]) {
    requireSha256(observations[field], `Apps Host ${field}`);
  }
  requireInteger(observations.bundleBytes, "Apps Host bundle bytes", 1);
  for (const [field, expected] of [
    ["healthStatus", 200],
    ["appAssetStatus", 200],
    ["appHeadStatus", 200],
    ["interiorManifestStatus", 200],
    ["interiorAssetStatus", 200],
    ["interiorBundleStatus", 200],
    ["authHandoffStatus", 200],
    ["blockedProxyStatus", 400],
    ["invalidConfigStatus", 503],
  ]) {
    assert(
      observations[field] === expected,
      `Apps Host ${field} must be ${expected}.`,
    );
  }
  for (const field of [
    "productionBundleBuilt",
    "workerdRuntimeStarted",
    "realKvBindingUsed",
    "realR2BindingUsed",
    "sameOriginInteriorManifest",
    "strictHostedContentSecurityPolicy",
    "authHandoffNoStore",
    "privateProxyTargetBlockedBeforeFetch",
    "invalidConfigurationFailedClosed",
    "runtimeDisposed",
    "isolatedStateRemoved",
  ]) {
    requireBoolean(observations[field], true, `Apps Host ${field}`);
  }
  assert(
    !(await pathExists(stateDirectory)),
    "Apps Host Workerd acceptance left local runtime state behind.",
  );
  return {
    observations,
    patch: {
      appsHostWorkerd: {
        stateDirectorySha256: sha256(stateDirectory),
        bundleSha256: observations.bundleSha256,
        receiptChainSha256: observations.receiptChainSha256,
        cleanupPending: false,
        isolatedStateRemoved: true,
      },
    },
  };
};

const deleteConversation = async (context, secrets, conversationId, rawLog) => {
  const value = await convexCall(
    context,
    secrets,
    "action",
    "cloud_apps:deleteMyConversation",
    { conversationId },
    "delete disposable acceptance conversation",
    rawLog,
  );
  assert(value?.ok === true, "Convex did not confirm conversation deletion.");
  const response = await workerRequest(
    context,
    secrets,
    `/conversations/${encodeURIComponent(conversationId)}/purge`,
    { method: "POST", body: "{}" },
    "worker.conversation.purge",
    rawLog,
    { expectedStatuses: [200, 410] },
  );
  assert(
    response.status === 410 ||
      response.body?.purged === true ||
      response.body?.ok === true,
    "Worker did not confirm conversation purge.",
  );
};

const purgeR2Prefix = async (secrets, bucket, prefix, rawLog) => {
  let total = 0;
  for (let pass = 0; pass < 8; pass += 1) {
    const objects = await r2ListObjects(secrets, bucket, prefix, rawLog);
    if (objects.length === 0) return total;
    for (const object of objects) {
      await r2DeleteObject(secrets, bucket, object.key, rawLog);
      total += 1;
    }
  }
  throw new CloudProofError(
    `R2 prefix ${sha256(prefix)} did not drain within eight bounded passes.`,
  );
};

const disposeAnonymousMobilePolicyAccount = async ({
  context,
  secrets,
  paths,
  state,
  rawLog,
  checkpoint,
  primaryElectron,
}) => {
  if (!isRecord(state.anonymousMobilePolicy)) {
    return Object.freeze({
      accountDisposed: true,
      sessionRevoked: true,
      ownerResidueRemoved: true,
    });
  }
  const policy = state.anonymousMobilePolicy;
  const ownerId = requireString(
    policy.ownerId,
    "Anonymous mobile policy cleanup owner",
    512,
  );
  assert(
    policy.ownerIdSha256 === sha256(ownerId),
    "Anonymous mobile policy cleanup owner hash changed.",
  );
  const ownerGeneration = requireString(
    policy.ownerGeneration,
    "Anonymous mobile policy cleanup generation",
    512,
  );
  let policyElectron = isRecord(state.anonymousPolicyElectron)
    ? state.anonymousPolicyElectron
    : null;
  const lifecycleBefore = await convexInternalRun(
    secrets,
    "owner_lifecycle:getOwnerDataAccessStateInternal",
    { ownerId },
    rawLog,
  );
  if (
    lifecycleBefore?.state === "open" &&
    policy.revocationRequested !== true
  ) {
    if (!policyElectron || !processAlive(policyElectron.pid)) {
      const vite = {
        pid: requireInteger(primaryElectron.vitePid, "Cleanup Vite pid", 1),
        port: requireInteger(
          primaryElectron.devServerPort,
          "Cleanup Vite port",
          1,
        ),
        logFile: path.join(paths.processLogDirectory, "vite.log"),
        dataDir: viteDataPath(paths),
        processFingerprintSha256: requireSha256(
          primaryElectron.viteProcessFingerprintSha256,
          "Anonymous-policy cleanup Vite process fingerprint",
        ),
        listenerAddressesSha256: requireSha256(
          primaryElectron.viteListenerAddressesSha256,
          "Anonymous-policy cleanup Vite listener-address set",
        ),
      };
      policyElectron = await launchElectron(
        context,
        secrets,
        paths,
        "anonymous-mobile-policy",
        vite,
        rawLog,
      );
      await checkpoint({ anonymousPolicyElectron: policyElectron });
    }
    const authority = await readAnonymousElectronAuthority(
      context,
      secrets,
      policyElectron,
      rawLog,
      "anonymous mobile policy cleanup",
      { createIfMissing: false },
    );
    assert(
      authority.jwtIdentity.tokenIdentifier === ownerId &&
        sha256(authority.subject) === policy.sessionSubjectSha256 &&
        sha256(authority.sessionId) === policy.sessionIdSha256,
      "Anonymous mobile policy profile did not resume the checkpointed authority.",
    );
    const revoked = await cdpEvaluate(
      policyElectron,
      `(async () => await window.electronAPI.system.deleteAuthUser())()`,
      "delete anonymous mobile policy acceptance account during cleanup",
      120_000,
    );
    assert(
      revoked?.ok === true,
      "Cleanup did not revoke the anonymous mobile policy account.",
    );
    rawLog.push(
      rawReceipt(
        "electron-process",
        "electron.anonymous-mobile-policy.cleanup-revoke",
        {
          outcome: "revoked",
          responseSha256: sha256(canonicalJson(revoked)),
          resourceIdSha256: sha256(ownerId),
        },
      ),
    );
  } else {
    assert(
      (lifecycleBefore?.state === "deleting" &&
        lifecycleBefore?.allowed === false) ||
        (lifecycleBefore?.state === "open" &&
          policy.revocationRequested === true),
      "Anonymous mobile policy lifecycle is neither deletion-requested nor deleting.",
    );
  }
  const terminal = await poll(
    async () => {
      const [lifecycle, job] = await Promise.all([
        convexInternalRun(
          secrets,
          "owner_lifecycle:getOwnerDataAccessStateInternal",
          { ownerId },
          [],
        ),
        convexInternalRun(
          secrets,
          "owner_lifecycle:getOwnerPurgeJobInternal",
          { ownerId },
          [],
        ),
      ]);
      return { lifecycle, job };
    },
    (value) =>
      value.lifecycle?.allowed === false &&
      value.lifecycle?.state === "deleting" &&
      value.lifecycle?.generation === ownerGeneration &&
      value.job?.mode === "delete" &&
      value.job?.stage === "complete" &&
      value.job?.generation === ownerGeneration,
    {
      timeoutMs: DEFAULT_TURN_TIMEOUT_MS,
      intervalMs: 1_000,
      label: "anonymous mobile policy account deletion terminal",
    },
  );
  const [conversations, resetCore, accountCore, cloudStores] =
    await Promise.all([
      convexInternalRun(
        secrets,
        "cloud_purge:listOwnerConversationsInternal",
        { ownerId },
        rawLog,
      ),
      convexInternalRun(
        secrets,
        "reset:remainingOwnerResetStoresInternal",
        { ownerId },
        rawLog,
      ),
      convexInternalRun(
        secrets,
        "account_deletion:remainingOwnerAccountCoreStoresInternal",
        { ownerId },
        rawLog,
      ),
      convexInternalRun(
        secrets,
        "cloud_purge:remainingOwnerStoresInternal",
        { ownerId },
        rawLog,
      ),
    ]);
  const ownerResidueRemoved = [
    conversations,
    resetCore,
    accountCore,
    cloudStores,
  ].every((rows) => Array.isArray(rows) && rows.length === 0);
  assert(
    ownerResidueRemoved,
    "Anonymous mobile policy account deletion left owner-scoped residue.",
  );
  if (policyElectron && processAlive(policyElectron.pid)) {
    await stopProcess(
      policyElectron.pid,
      "electron.anonymous-mobile-policy.cleanup",
      rawLog,
      {
        expectedProcessFingerprintSha256:
          policyElectron.processFingerprintSha256,
      },
    );
  }
  rawLog.push(
    rawReceipt("convex", "convex.anonymous-mobile-policy.disposed", {
      outcome: "completed",
      resourceIdSha256: sha256(ownerId),
      responseSha256: sha256(canonicalJson(terminal)),
      count: 0,
    }),
  );
  return Object.freeze({
    accountDisposed: true,
    sessionRevoked: true,
    ownerResidueRemoved: true,
  });
};

const stepCleanup = async ({
  context,
  secrets,
  paths,
  state,
  rawLog,
  checkpoint,
}) => {
  const failures = [];
  const attempt = async (label, operation) => {
    try {
      return await operation();
    } catch (error) {
      failures.push({
        label,
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  };
  const liveBefore =
    typeof state.liveProfileSha256Before === "string"
      ? state.liveProfileSha256Before
      : null;
  if (liveBefore !== null)
    requireSha256(liveBefore, "Pre-run live profile metadata hash");
  let electron = isRecord(state.electron) ? state.electron : null;
  if (
    (!electron || !processAlive(electron.pid)) &&
    (state.identity || state.cleanupOwnerHint || state.secondary)
  ) {
    await attempt(
      "isolated Electron relaunch for account revocation",
      async () => {
        let vite;
        const candidateVitePid =
          electron?.vitePid ?? state.secondaryElectron?.vitePid;
        const candidateVitePort =
          electron?.devServerPort ?? state.secondaryElectron?.devServerPort;
        if (candidateVitePid && processAlive(candidateVitePid)) {
          const candidateViteState =
            electron?.vitePid === candidateVitePid
              ? electron
              : requireRecord(
                  state.secondaryElectron,
                  "Recorded secondary Vite state",
                );
          vite = {
            pid: candidateVitePid,
            port: requireInteger(
              candidateVitePort,
              "Recorded isolated Vite port",
              1,
            ),
            logFile: path.join(paths.processLogDirectory, "vite.log"),
            dataDir: viteDataPath(paths),
            processFingerprintSha256: requireSha256(
              candidateViteState.viteProcessFingerprintSha256,
              "Cleanup Vite process fingerprint",
            ),
            listenerAddressesSha256: requireSha256(
              candidateViteState.viteListenerAddressesSha256,
              "Cleanup Vite listener-address set",
            ),
          };
        } else {
          vite = await launchVite(context, paths);
        }
        electron = await launchElectron(
          context,
          secrets,
          paths,
          electron?.profileName ?? "primary",
          vite,
          rawLog,
        );
        await checkpoint({ electron });
      },
    );
  }
  assert(
    electron && processAlive(electron.pid),
    "Cleanup cannot continue without the isolated primary session authority.",
  );
  secrets = await refreshPrimaryStepSecrets(
    context,
    secrets,
    state,
    rawLog,
    "cleanup primary authority refresh",
  );
  const recordedConversations = Array.isArray(state.resources?.conversations)
    ? [...new Set(state.resources.conversations)]
    : [];
  const markerTitle = `stella-cloud-acceptance:${context.runId}`;
  const listed = await attempt(
    "acceptance conversation discovery",
    async () =>
      await convexCall(
        context,
        secrets,
        "query",
        "cloud_apps:listMyConversations",
        {},
        "discover acceptance conversation for cleanup",
        rawLog,
      ),
  );
  const discoveredConversations = Array.isArray(listed)
    ? listed
        .filter((entry) => isRecord(entry) && entry.title === markerTitle)
        .map((entry) =>
          requireUuid(
            entry.conversationId,
            "Discovered cleanup conversation id",
          ),
        )
    : [];
  const conversations = [
    ...new Set([...recordedConversations, ...discoveredConversations]),
  ];
  const secondaryOwnerId = isRecord(state.secondary)
    ? requireString(
        state.secondary.ownerId,
        "Recorded secondary cleanup owner",
        512,
      )
    : null;
  const secondaryOwnerConversationRows = await attempt(
    "secondary owner conversation discovery",
    async () =>
      secondaryOwnerId
        ? await convexInternalRun(
            secrets,
            "cloud_purge:listOwnerConversationsInternal",
            { ownerId: secondaryOwnerId },
            rawLog,
          )
        : [],
  );
  const discoveredSecondaryConversations = Array.isArray(
    secondaryOwnerConversationRows,
  )
    ? secondaryOwnerConversationRows.map((entry) =>
        requireUuid(
          entry?.conversationId,
          "Discovered secondary cleanup conversation id",
        ),
      )
    : [];
  const recordedSecondaryConversationId =
    isRecord(state.secondary) && state.secondary.conversationId !== null
      ? requireUuid(
          state.secondary.conversationId,
          "Recorded secondary cleanup conversation id",
        )
      : undefined;
  const secondaryConversations = [
    ...new Set(
      [
        recordedSecondaryConversationId,
        ...discoveredSecondaryConversations,
      ].filter((value) => typeof value === "string"),
    ),
  ];
  if (secondaryConversations.length > 1) {
    failures.push({
      label: "secondary acceptance conversation discovery",
      message: "Secondary cleanup found conflicting exact-run conversations.",
    });
  }
  let recoveredOwner;
  const jwtOwnerId = parseJwtTokenIdentifier(secrets.jwt);
  const sandboxState = isRecord(state.sandbox) ? state.sandbox : null;
  let sandboxTerminalBeforePurge = false;
  if (sandboxState) {
    const beforeSandbox = await attempt(
      "sandbox terminal verification",
      async () =>
        await convexInternalRun(
          secrets,
          "cloud_apps:getAgentThreadProbeInternal",
          { ownerId: jwtOwnerId, limit: 30 },
          rawLog,
        ),
    );
    const exact = Array.isArray(beforeSandbox)
      ? beforeSandbox.find(
          (entry) =>
            entry?.threadId === sandboxState.threadId &&
            entry?.turnId === sandboxState.turnId,
        )
      : null;
    sandboxTerminalBeforePurge = Boolean(
      (exact &&
        (exact.status === "completed" || exact.turnStatus === "completed")) ||
      (!exact && state.ownerReset?.preResetSandboxTerminalVerified === true),
    );
    if (!sandboxTerminalBeforePurge) {
      failures.push({
        label: "sandbox terminal verification",
        message: "Recorded sandbox execution was not terminal before cleanup.",
      });
    }
  }
  for (const conversationId of conversations) {
    requireUuid(conversationId, "Disposable cleanup conversation id");
    const owner = await attempt(
      `owner lookup ${sha256(conversationId)}`,
      async () => await ownerLookup(context, secrets, conversationId, rawLog),
    );
    if (owner && owner.ownerId !== jwtOwnerId) {
      failures.push({
        label: `owner lookup ${sha256(conversationId)}`,
        message:
          "Discovered acceptance conversation is not owned by the disposable JWT subject.",
      });
      continue;
    }
    if (owner && !recoveredOwner) recoveredOwner = owner;
    await attempt(
      `conversation purge ${sha256(conversationId)}`,
      async () =>
        await deleteConversation(context, secrets, conversationId, rawLog),
    );
  }
  const listedAfterConversationPurge = await attempt(
    "acceptance conversation purge verification",
    async () =>
      await convexCall(
        context,
        secrets,
        "query",
        "cloud_apps:listMyConversations",
        {},
        "verify acceptance conversation cleanup",
        rawLog,
      ),
  );
  const conversationPurged =
    Array.isArray(listedAfterConversationPurge) &&
    !listedAfterConversationPurge.some(
      (entry) => isRecord(entry) && entry.title === markerTitle,
    );
  if (!conversationPurged) {
    failures.push({
      label: "acceptance conversation purge verification",
      message: "The exact disposable acceptance conversation remains listed.",
    });
  }
  let sandboxResourcesPurged = false;
  if (sandboxState) {
    const afterSandbox = await attempt(
      "sandbox resource purge verification",
      async () =>
        await convexInternalRun(
          secrets,
          "cloud_apps:getAgentThreadProbeInternal",
          { ownerId: jwtOwnerId, limit: 30 },
          rawLog,
        ),
    );
    const exact = Array.isArray(afterSandbox)
      ? afterSandbox.find(
          (entry) =>
            entry?.threadId === sandboxState.threadId ||
            entry?.turnId === sandboxState.turnId,
        )
      : null;
    sandboxResourcesPurged =
      sandboxTerminalBeforePurge &&
      (!exact ||
        (exact.status === "completed" && exact.turnStatus === "completed"));
    if (!sandboxResourcesPurged) {
      failures.push({
        label: "sandbox resource purge verification",
        message:
          "The exact sandbox turn is still live after conversation cleanup.",
      });
    }
  } else if (state.identity) {
    failures.push({
      label: "sandbox resource purge verification",
      message: "No checkpointed real sandbox resource identity was available.",
    });
  }

  const ownerIdSha256 =
    state.identity?.ownerIdSha256 ??
    (recoveredOwner ? sha256(recoveredOwner.ownerId) : undefined) ??
    state.cleanupOwnerHint?.ownerIdSha256;
  const ownerGenerations = [
    ...new Set(
      [
        ...(Array.isArray(state.resources?.ownerGenerations)
          ? state.resources.ownerGenerations
          : []),
        state.identity?.ownerGeneration,
        state.ownerReset?.oldOwnerGeneration,
        state.ownerReset?.newOwnerGeneration,
        recoveredOwner?.ownerGeneration,
      ].filter((value) => typeof value === "string" && value.trim()),
    ),
  ];
  if (
    state.cleanupOwnerHint?.ownerIdSha256 &&
    ownerIdSha256 &&
    state.cleanupOwnerHint.ownerIdSha256 !== ownerIdSha256
  ) {
    failures.push({
      label: "cleanup owner",
      message: "Recorded cleanup owner identities disagree.",
    });
  }

  const conversationPrefixes = Array.isArray(state.resources?.r2Prefixes)
    ? [...new Set(state.resources.r2Prefixes)]
    : [];
  for (const prefix of conversationPrefixes) {
    await attempt(`conversation archive purge ${sha256(prefix)}`, async () => {
      assert(
        ownerIdSha256,
        "Cleanup has no verified disposable owner hash for R2.",
      );
      assert(
        prefix.startsWith(`conversations/${ownerIdSha256}/`),
        "Cleanup refused an R2 prefix outside the disposable owner.",
      );
      await purgeR2Prefix(
        secrets,
        REQUIRED_CONVERSATION_ARCHIVE_BUCKET_NAME,
        prefix,
        rawLog,
      );
    });
  }
  const agentHomePrefixes = ownerIdSha256
    ? ownerGenerations.map(
        (generation) =>
          `agent-home/${ownerIdSha256}/generations/${sha256(generation)}/`,
      )
    : [];
  let agentHomePurged = agentHomePrefixes.length > 0;
  if (agentHomePrefixes.length > 0) {
    for (const prefix of agentHomePrefixes) {
      await attempt(
        `agent home purge ${sha256(prefix)}`,
        async () =>
          await purgeR2Prefix(
            secrets,
            REQUIRED_AGENT_HOME_BUCKET_NAME,
            prefix,
            rawLog,
          ),
      );
      const remaining = await attempt(
        `agent home immediate purge verification ${sha256(prefix)}`,
        async () =>
          await r2ListObjects(
            secrets,
            REQUIRED_AGENT_HOME_BUCKET_NAME,
            prefix,
            rawLog,
          ),
      );
      if (!Array.isArray(remaining) || remaining.length !== 0) {
        agentHomePurged = false;
        failures.push({
          label: `agent home immediate purge verification ${sha256(prefix)}`,
          message: "Agent Home still contains disposable generation objects.",
        });
      }
    }
  } else if (conversations.length > 0 || state.cleanupOwnerHint) {
    failures.push({
      label: "agent home purge",
      message: "Cleanup could not recover the disposable owner generation.",
    });
  }

  let connectedTestAccountRevoked = false;
  let primarySessionRevoked = false;
  let primaryOwnerResidueRemoved = false;
  let primaryLifecycleTombstoned = false;
  let primaryPurgeJobCompleted = false;
  let primaryConversationResidueCount = -1;
  let primaryResetCoreResidueCount = -1;
  let primaryAccountCoreResidueCount = -1;
  let primaryCloudStoreResidueCount = -1;
  let secondaryTestAccountRevoked = false;
  let secondarySessionRevoked = false;
  let secondaryOwnerResidueRemoved = false;
  let secondaryConversationPurged = false;
  let secondaryResetCorePurged = false;
  let secondaryAccountCorePurged = false;
  let secondaryCloudStoresPurged = false;
  let secondaryLifecycleTombstoned = false;
  let secondaryPurgeJobCompleted = false;
  let primarySessionRestoredAfterSecondaryRevocation = false;
  let secondaryRevocationPrecededPrimaryRevocation = false;
  let secondaryConversationResidueCount = -1;
  let secondaryResetCoreResidueCount = -1;
  let secondaryAccountCoreResidueCount = -1;
  let secondaryCloudStoreResidueCount = -1;
  let connectedIntegrationRemovedAfterAccountDeletion =
    typeof state.mcp?.integrationId !== "string";
  let anonymousMobilePolicyAccountDisposed = !isRecord(
    state.anonymousMobilePolicy,
  );
  let anonymousMobilePolicySessionRevoked =
    anonymousMobilePolicyAccountDisposed;
  let anonymousMobilePolicyOwnerResidueRemoved =
    anonymousMobilePolicyAccountDisposed;
  if (isRecord(state.anonymousMobilePolicy)) {
    const disposition = await attempt(
      "anonymous mobile policy account disposal",
      async () =>
        await disposeAnonymousMobilePolicyAccount({
          context,
          secrets,
          paths,
          state,
          rawLog,
          checkpoint,
          primaryElectron: electron,
        }),
    );
    anonymousMobilePolicyAccountDisposed =
      disposition?.accountDisposed === true;
    anonymousMobilePolicySessionRevoked = disposition?.sessionRevoked === true;
    anonymousMobilePolicyOwnerResidueRemoved =
      disposition?.ownerResidueRemoved === true;
  }
  let secondaryElectron = isRecord(state.secondaryElectron)
    ? state.secondaryElectron
    : null;
  if (electron && processAlive(electron.pid)) {
    const expectedSecondaryOwnerId = isRecord(state.secondary)
      ? requireString(
          state.secondary.ownerId,
          "Recorded secondary cleanup owner",
          512,
        )
      : secondaryOwnerId;
    if (
      secondaryOwnerId !== expectedSecondaryOwnerId ||
      (state.secondary &&
        state.secondary.ownerIdSha256 !== sha256(secondaryOwnerId)) ||
      (state.secondaryCleanupOwnerHint?.ownerIdSha256 &&
        state.secondaryCleanupOwnerHint.ownerIdSha256 !==
          sha256(secondaryOwnerId))
    ) {
      failures.push({
        label: "secondary cleanup owner",
        message: "Recorded secondary cleanup owner identities disagree.",
      });
    }
    const secondaryConversationId = secondaryConversations[0];
    const recordedSecondaryGeneration = requireString(
      state.secondary?.ownerGeneration,
      "Recorded secondary cleanup owner generation",
      512,
    );
    const secondaryLifecycleBefore = await attempt(
      "secondary lifecycle preflight",
      async () =>
        await convexInternalRun(
          secrets,
          "owner_lifecycle:getOwnerDataAccessStateInternal",
          { ownerId: secondaryOwnerId },
          rawLog,
        ),
    );
    let secondaryAuthorityResumed = false;
    if (secondaryLifecycleBefore?.state === "open") {
      if (!secondaryElectron || !processAlive(secondaryElectron.pid)) {
        await attempt(
          "isolated secondary Electron cleanup relaunch",
          async () => {
            const vite = {
              pid: requireInteger(electron.vitePid, "Cleanup Vite pid", 1),
              port: requireInteger(
                electron.devServerPort,
                "Cleanup Vite port",
                1,
              ),
              logFile: path.join(paths.processLogDirectory, "vite.log"),
              dataDir: viteDataPath(paths),
              processFingerprintSha256: requireSha256(
                electron.viteProcessFingerprintSha256,
                "Cleanup Vite process fingerprint",
              ),
              listenerAddressesSha256: requireSha256(
                electron.viteListenerAddressesSha256,
                "Cleanup Vite listener-address set",
              ),
            };
            assert(
              processAlive(vite.pid),
              "Cleanup cannot relaunch secondary Electron without its owned Vite boundary.",
            );
            secondaryElectron = await launchElectron(
              context,
              secrets,
              paths,
              "secondary",
              vite,
              rawLog,
            );
            await checkpoint({ secondaryElectron });
          },
        );
      }
      await attempt("secondary disposable account session", async () => {
        assert(
          secondaryElectron && processAlive(secondaryElectron.pid),
          "The isolated secondary Electron profile is unavailable.",
        );
        const authority = await readElectronSessionAuthority(
          context,
          secrets,
          secondaryElectron,
          secondaryConversationId ?? null,
          rawLog,
          "secondary cleanup",
          {
            expectedIdentitySha256: state.secondary.sessionSubjectSha256,
            expectedSessionIdSha256: state.secondary.sessionIdSha256,
            expectedOwnerAccountSha256: state.secondary.ownerIdSha256,
          },
        );
        assert(
          authority.tokenIdentity.tokenIdentifier === secondaryOwnerId &&
            authority.identitySha256 === state.secondary.sessionSubjectSha256 &&
            authority.sessionIdSha256 === state.secondary.sessionIdSha256,
          "Secondary Electron profile did not resume the checkpointed connected authority.",
        );
        secondaryAuthorityResumed = true;
      });
      if (secondaryAuthorityResumed)
        await attempt("secondary disposable account revocation", async () => {
          const revoked = await cdpEvaluate(
            secondaryElectron,
            `(async () => await window.electronAPI.system.deleteAuthUser())()`,
            "delete secondary disposable acceptance account",
            120_000,
          );
          assert(
            revoked?.ok === true,
            "Electron did not revoke the secondary disposable test account.",
          );
          rawLog.push(
            rawReceipt(
              "electron-process",
              "electron.secondary-test-account.revoke",
              {
                outcome: "revoked",
                responseSha256: sha256(canonicalJson(revoked)),
                resourceIdSha256: sha256(secondaryOwnerId),
              },
            ),
          );
        });
      else
        failures.push({
          label: "secondary disposable account revocation",
          message:
            "Secondary revocation was not attempted without the exact resumed authority.",
        });
    } else if (secondaryLifecycleBefore?.state !== "deleting") {
      failures.push({
        label: "secondary lifecycle preflight",
        message: "Secondary lifecycle is neither open nor deleting.",
      });
    }
    const secondaryTerminal = await attempt(
      "secondary deletion terminal",
      async () =>
        await poll(
          async () => {
            const [lifecycle, job] = await Promise.all([
              convexInternalRun(
                secrets,
                "owner_lifecycle:getOwnerDataAccessStateInternal",
                { ownerId: secondaryOwnerId },
                [],
              ),
              convexInternalRun(
                secrets,
                "owner_lifecycle:getOwnerPurgeJobInternal",
                { ownerId: secondaryOwnerId },
                [],
              ),
            ]);
            return { lifecycle, job };
          },
          (value) =>
            value.lifecycle?.allowed === false &&
            value.lifecycle?.state === "deleting" &&
            value.job?.mode === "delete" &&
            value.job?.stage === "complete",
          {
            timeoutMs: DEFAULT_TURN_TIMEOUT_MS,
            intervalMs: 1_000,
            label: "secondary account deletion terminal",
          },
        ),
    );
    if (secondaryTerminal) {
      secondaryLifecycleTombstoned =
        secondaryTerminal.lifecycle.generation ===
          recordedSecondaryGeneration &&
        secondaryTerminal.lifecycle.allowed === false &&
        secondaryTerminal.lifecycle.state === "deleting";
      secondaryPurgeJobCompleted =
        secondaryTerminal.job?.mode === "delete" &&
        secondaryTerminal.job?.stage === "complete" &&
        secondaryTerminal.job?.generation === recordedSecondaryGeneration;
      secondaryTestAccountRevoked =
        secondaryLifecycleTombstoned && secondaryPurgeJobCompleted;
      assert(
        secondaryTestAccountRevoked,
        "Secondary lifecycle tombstone or purge job is not exact-generation complete.",
      );
      rawLog.push(
        rawReceipt(
          "convex",
          "convex.secondary-test-account.deletion-confirmed",
          {
            outcome: "completed",
            resourceIdSha256: sha256(secondaryOwnerId),
            responseSha256: sha256(canonicalJson(secondaryTerminal)),
          },
        ),
      );
    }
    if (secondaryElectron && processAlive(secondaryElectron.pid))
      await attempt("secondary session revocation verification", async () => {
        assert(
          secondaryElectron && processAlive(secondaryElectron.pid),
          "The isolated secondary profile is unavailable for revocation verification.",
        );
        const staleSession = await cdpEvaluate(
          secondaryElectron,
          `(async () => {
          const first = await window.electronAPI.system.getAuthSession();
          const second = await window.electronAPI.system.getAuthSession();
          const token = await window.electronAPI.system.getConvexAuthToken();
          return { first, second, token };
        })()`,
          "verify secondary disposable session revocation",
          60_000,
        );
        secondarySessionRevoked =
          staleSession?.first == null &&
          staleSession?.second == null &&
          staleSession?.token == null;
        assert(
          secondarySessionRevoked,
          "Deleted secondary credentials still produced an authenticated session.",
        );
        rawLog.push(
          rawReceipt(
            "electron-process",
            "electron.secondary-test-account.session-rejected",
            {
              outcome: "rejected",
              responseSha256: sha256(canonicalJson(staleSession)),
              resourceIdSha256: sha256(secondaryOwnerId),
            },
          ),
        );
      });
    else {
      secondarySessionRevoked = secondaryTestAccountRevoked;
      rawLog.push(
        rawReceipt(
          "convex",
          "convex.secondary-session.server-revocation-confirmed",
          {
            outcome: secondarySessionRevoked ? "revoked" : "unconfirmed",
            resourceIdSha256: sha256(secondaryOwnerId),
            responseSha256: secondaryTerminal
              ? sha256(canonicalJson(secondaryTerminal))
              : sha256("missing-secondary-terminal"),
          },
        ),
      );
    }
    await attempt("secondary owner residue verification", async () => {
      const [
        conversationRows,
        conversationOwner,
        remainingResetCore,
        remainingAccountCore,
        remainingCloud,
      ] = await Promise.all([
        convexInternalRun(
          secrets,
          "cloud_purge:listOwnerConversationsInternal",
          { ownerId: secondaryOwnerId },
          rawLog,
        ),
        secondaryConversationId
          ? convexInternalRun(
              secrets,
              "cloud_apps:getConversationOwnerInternal",
              { conversationId: secondaryConversationId },
              rawLog,
            )
          : Promise.resolve(null),
        convexInternalRun(
          secrets,
          "reset:remainingOwnerResetStoresInternal",
          { ownerId: secondaryOwnerId },
          rawLog,
        ),
        convexInternalRun(
          secrets,
          "account_deletion:remainingOwnerAccountCoreStoresInternal",
          { ownerId: secondaryOwnerId },
          rawLog,
        ),
        convexInternalRun(
          secrets,
          "cloud_purge:remainingOwnerStoresInternal",
          { ownerId: secondaryOwnerId },
          rawLog,
        ),
      ]);
      secondaryConversationResidueCount = Array.isArray(conversationRows)
        ? conversationRows.length
        : -1;
      secondaryResetCoreResidueCount = Array.isArray(remainingResetCore)
        ? remainingResetCore.length
        : -1;
      secondaryAccountCoreResidueCount = Array.isArray(remainingAccountCore)
        ? remainingAccountCore.length
        : -1;
      secondaryCloudStoreResidueCount = Array.isArray(remainingCloud)
        ? remainingCloud.length
        : -1;
      secondaryConversationPurged =
        secondaryConversationResidueCount === 0 && conversationOwner === null;
      secondaryResetCorePurged = secondaryResetCoreResidueCount === 0;
      secondaryAccountCorePurged = secondaryAccountCoreResidueCount === 0;
      secondaryCloudStoresPurged = secondaryCloudStoreResidueCount === 0;
      secondaryOwnerResidueRemoved =
        secondaryConversationPurged &&
        secondaryResetCorePurged &&
        secondaryAccountCorePurged &&
        secondaryCloudStoresPurged;
      assert(
        secondaryOwnerResidueRemoved,
        "Secondary account deletion left conversation or owner-scoped core residue.",
      );
    });
    await attempt("restore primary disposable account session", async () => {
      const primaryAuthority = requireRecord(
        await cdpEvaluate(
          electron,
          `(async () => {
            const first = await window.electronAPI.system.getAuthSession();
            const second = await window.electronAPI.system.getAuthSession();
            const token = await window.electronAPI.system.getConvexAuthToken();
            return { first, second, token };
          })()`,
          "restore primary disposable account session",
          60_000,
        ),
        "Restored primary disposable account session",
      );
      const primarySubject = parseJwtSubject(secrets.jwt);
      primarySessionRestoredAfterSecondaryRevocation =
        (primaryAuthority.second?.user?.id ??
          primaryAuthority.first?.user?.id) === primarySubject &&
        parseJwtSubject(
          requireString(
            primaryAuthority.token,
            "Restored primary Convex token",
            16 * 1_024,
          ),
        ) === primarySubject;
      assert(
        primarySessionRestoredAfterSecondaryRevocation,
        "Primary disposable session was not restored exactly after secondary revocation.",
      );
      rawLog.push(
        rawReceipt(
          "electron-process",
          "electron.primary-session.restored-after-secondary-revoke",
          {
            outcome: "authenticated",
            resourceIdSha256: sha256(jwtOwnerId),
            responseSha256: sha256(canonicalJson(primaryAuthority)),
          },
        ),
      );
    });
    secondaryRevocationPrecededPrimaryRevocation =
      secondaryTestAccountRevoked &&
      secondarySessionRevoked &&
      secondaryOwnerResidueRemoved &&
      primarySessionRestoredAfterSecondaryRevocation;
    await attempt("disposable account revocation", async () => {
      assert(
        secondaryRevocationPrecededPrimaryRevocation,
        "Primary account revocation started before secondary cleanup completed.",
      );
      const revoked = await cdpEvaluate(
        electron,
        `(async () => await window.electronAPI.system.deleteAuthUser())()`,
        "delete disposable acceptance account",
        120_000,
      );
      connectedTestAccountRevoked = revoked?.ok === true;
      assert(
        connectedTestAccountRevoked,
        "Electron did not revoke the disposable connected test account.",
      );
      rawLog.push(
        rawReceipt("electron-process", "electron.test-account.revoke", {
          outcome: "revoked",
          responseSha256: sha256(canonicalJson(revoked)),
        }),
      );
      const recordedPrimaryGeneration = requireString(
        state.ownerReset?.newOwnerGeneration ?? state.identity?.ownerGeneration,
        "Recorded primary cleanup owner generation",
        512,
      );
      const primaryTerminal = await poll(
        async () => {
          const [lifecycle, job] = await Promise.all([
            convexInternalRun(
              secrets,
              "owner_lifecycle:getOwnerDataAccessStateInternal",
              { ownerId: jwtOwnerId },
              [],
            ),
            convexInternalRun(
              secrets,
              "owner_lifecycle:getOwnerPurgeJobInternal",
              { ownerId: jwtOwnerId },
              [],
            ),
          ]);
          return { lifecycle, job };
        },
        (value) =>
          value.lifecycle?.allowed === false &&
          value.lifecycle?.state === "deleting" &&
          value.job?.mode === "delete" &&
          value.job?.stage === "complete",
        {
          timeoutMs: DEFAULT_TURN_TIMEOUT_MS,
          intervalMs: 1_000,
          label: "primary account deletion terminal",
        },
      );
      primaryLifecycleTombstoned =
        primaryTerminal.lifecycle.generation === recordedPrimaryGeneration &&
        primaryTerminal.lifecycle.allowed === false &&
        primaryTerminal.lifecycle.state === "deleting";
      primaryPurgeJobCompleted =
        primaryTerminal.job?.mode === "delete" &&
        primaryTerminal.job?.stage === "complete" &&
        primaryTerminal.job?.generation === recordedPrimaryGeneration;
      assert(
        primaryLifecycleTombstoned && primaryPurgeJobCompleted,
        "Primary lifecycle tombstone or purge job is not exact-generation complete.",
      );
      rawLog.push(
        rawReceipt("convex", "convex.test-account.deletion-confirmed", {
          outcome: "completed",
          resourceIdSha256: sha256(jwtOwnerId),
          responseSha256: sha256(canonicalJson(primaryTerminal)),
        }),
      );

      const stalePrimarySession = await cdpEvaluate(
        electron,
        `(async () => {
          const first = await window.electronAPI.system.getAuthSession();
          const second = await window.electronAPI.system.getAuthSession();
          const token = await window.electronAPI.system.getConvexAuthToken();
          return { first, second, token };
        })()`,
        "verify primary disposable session revocation",
        60_000,
      );
      primarySessionRevoked =
        stalePrimarySession?.first == null &&
        stalePrimarySession?.second == null &&
        stalePrimarySession?.token == null;
      assert(
        primarySessionRevoked,
        "Deleted primary credentials still produced an authenticated session.",
      );
      rawLog.push(
        rawReceipt(
          "electron-process",
          "electron.test-account.session-rejected",
          {
            outcome: "rejected",
            responseSha256: sha256(canonicalJson(stalePrimarySession)),
            resourceIdSha256: sha256(jwtOwnerId),
          },
        ),
      );

      const [
        primaryConversationRows,
        primaryConversationOwner,
        primaryResetCore,
        primaryAccountCore,
        primaryCloudStores,
      ] = await Promise.all([
        convexInternalRun(
          secrets,
          "cloud_purge:listOwnerConversationsInternal",
          { ownerId: jwtOwnerId },
          rawLog,
        ),
        state.ownerReset?.newConversationId
          ? convexInternalRun(
              secrets,
              "cloud_apps:getConversationOwnerInternal",
              { conversationId: state.ownerReset.newConversationId },
              rawLog,
            )
          : Promise.resolve(null),
        convexInternalRun(
          secrets,
          "reset:remainingOwnerResetStoresInternal",
          { ownerId: jwtOwnerId },
          rawLog,
        ),
        convexInternalRun(
          secrets,
          "account_deletion:remainingOwnerAccountCoreStoresInternal",
          { ownerId: jwtOwnerId },
          rawLog,
        ),
        convexInternalRun(
          secrets,
          "cloud_purge:remainingOwnerStoresInternal",
          { ownerId: jwtOwnerId },
          rawLog,
        ),
      ]);
      primaryConversationResidueCount = Array.isArray(primaryConversationRows)
        ? primaryConversationRows.length
        : -1;
      primaryResetCoreResidueCount = Array.isArray(primaryResetCore)
        ? primaryResetCore.length
        : -1;
      primaryAccountCoreResidueCount = Array.isArray(primaryAccountCore)
        ? primaryAccountCore.length
        : -1;
      primaryCloudStoreResidueCount = Array.isArray(primaryCloudStores)
        ? primaryCloudStores.length
        : -1;
      primaryOwnerResidueRemoved =
        primaryConversationResidueCount === 0 &&
        primaryConversationOwner === null &&
        primaryResetCoreResidueCount === 0 &&
        primaryAccountCoreResidueCount === 0 &&
        primaryCloudStoreResidueCount === 0;
      assert(
        primaryOwnerResidueRemoved,
        "Primary account deletion left conversation or owner-scoped core residue.",
      );
      if (typeof state.mcp?.integrationId === "string") {
        const remainingComposio = await convexInternalRun(
          secrets,
          "composio_purge:remainingOwnerComposioSessionsInternal",
          { ownerId: jwtOwnerId },
          rawLog,
        );
        const integrationAfterAccountDeletion = await convexInternalRun(
          secrets,
          "data/integrations:getUserIntegrationByOwnerAndProvider",
          { ownerId: jwtOwnerId, provider: state.mcp.integrationId },
          rawLog,
        );
        connectedIntegrationRemovedAfterAccountDeletion =
          Array.isArray(remainingComposio) &&
          remainingComposio.length === 0 &&
          integrationAfterAccountDeletion === null;
        assert(
          connectedIntegrationRemovedAfterAccountDeletion,
          "Account deletion did not confirm external Composio revocation and local integration-row removal.",
        );
      }
      connectedTestAccountRevoked =
        connectedTestAccountRevoked &&
        primarySessionRevoked &&
        primaryLifecycleTombstoned &&
        primaryPurgeJobCompleted &&
        primaryOwnerResidueRemoved;
    });
  } else if (state.identity || state.cleanupOwnerHint) {
    failures.push({
      label: "disposable account revocation",
      message: "Recorded isolated Electron process is unavailable.",
    });
  }

  const recordedCleanupProcessGroups = [
    secondaryElectron?.pid,
    state.anonymousPolicyElectron?.pid,
    electron?.pid,
    state.authCleanElectron?.pid,
    state.renderedBrowser?.pid,
    electron?.vitePid,
  ].filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  if (secondaryElectron?.pid) {
    await attempt(
      "Secondary Electron stop",
      async () =>
        await stopProcess(secondaryElectron.pid, "electron.secondary", rawLog, {
          expectedProcessFingerprintSha256:
            secondaryElectron.processFingerprintSha256,
        }),
    );
  }
  if (electron?.pid) {
    await attempt(
      "Electron stop",
      async () =>
        await stopProcess(
          electron.pid,
          `electron.${electron.profileName ?? "acceptance"}`,
          rawLog,
          {
            expectedProcessFingerprintSha256: electron.processFingerprintSha256,
          },
        ),
    );
  }
  const preparedCleanPid = state.authCleanElectron?.pid;
  if (
    Number.isSafeInteger(preparedCleanPid) &&
    preparedCleanPid !== electron?.pid &&
    processAlive(preparedCleanPid)
  ) {
    await attempt(
      "Prepared clean-client Electron stop",
      async () =>
        await stopProcess(
          preparedCleanPid,
          "electron.clean-client-prepared",
          rawLog,
          {
            expectedProcessFingerprintSha256:
              state.authCleanElectron.processFingerprintSha256,
          },
        ),
    );
  }
  if (
    isRecord(state.renderedBrowser) &&
    processAlive(state.renderedBrowser.pid)
  ) {
    await attempt("Rendered browser stop", async () => {
      const stopped = await stopIsolatedChromium(state.renderedBrowser);
      rawLog.push(
        rawReceipt("electron-process", "browser.process.stop", {
          outcome: stopped.stopped ? "stopped" : "failed",
          resourceIdSha256: stopped.processInstanceSha256,
          responseSha256: sha256(canonicalJson(stopped)),
        }),
      );
      assert(stopped.stopped === true, "Rendered browser did not stop.");
    });
  }
  if (electron?.vitePid && processAlive(electron.vitePid)) {
    await attempt(
      "Vite stop",
      async () =>
        await stopProcess(electron.vitePid, "vite", rawLog, {
          expectedProcessFingerprintSha256:
            electron.viteProcessFingerprintSha256,
        }),
    );
  }
  let trustedLoopbackPortReleased = false;
  await attempt("trusted Vite port release", async () => {
    trustedLoopbackPortReleased = await verifyTrustedVitePortReleased(
      vitePortForRun(context.runId),
    );
    rawLog.push(
      rawReceipt("electron-process", "vite.port.release", {
        outcome: "released",
        resourceIdSha256: sha256(String(vitePortForRun(context.runId))),
      }),
    );
  });
  const remainingProcessGroups = [
    ...new Set(recordedCleanupProcessGroups),
  ].filter((pid) => detachedProcessGroupAlive(pid));
  const harnessProcessGroupsStopped = remainingProcessGroups.length === 0;
  if (!harnessProcessGroupsStopped) {
    failures.push({
      label: "detached acceptance process groups",
      message: "One or more recorded acceptance process groups remain alive.",
    });
  }
  rawLog.push(
    rawReceipt("electron-process", "acceptance.process-groups.final", {
      outcome: harnessProcessGroupsStopped ? "stopped" : "retained",
      count: remainingProcessGroups.length,
      responseSha256: sha256(
        canonicalJson(
          remainingProcessGroups.map((pid) => sha256(String(pid))).sort(),
        ),
      ),
    }),
  );
  let processLogsPromptRedacted = false;
  let processLogsRemoved = false;
  await attempt("acceptance process log privacy scan", async () => {
    const entries = await readdir(paths.processLogDirectory, {
      withFileTypes: true,
    });
    const promptNeedles = [
      `MOBILE-RN-RESPONSE-LOSS-${context.runId}`,
      `BROWSER-SANDBOX-${context.runId}`,
      `MOBILE-CLOUD-SANDBOX-${context.runId}`,
      `HISTORY-REPAIRED-${context.runId}`,
      state.primary?.memoryMarker,
      state.sandbox?.sandboxMarker,
    ].filter((value) => typeof value === "string" && value.length > 0);
    const digests = [];
    for (const entry of entries) {
      assert(entry.isFile(), "Acceptance process log directory is not flat.");
      const logFile = assertNarrowIsolatedPath(
        path.join(paths.processLogDirectory, entry.name),
        paths.root,
        "Acceptance process log",
      );
      const metadata = await stat(logFile);
      assert(
        metadata.size <= MAX_COMMAND_BYTES,
        "Acceptance process log exceeded the reviewable privacy-scan limit.",
      );
      const text = await readFile(logFile, "utf8");
      assert(
        !/\[stella:trace\][^\n]*\|\s*text=/u.test(text) &&
          promptNeedles.every((needle) => !text.includes(needle)),
        "Acceptance process log retained raw prompt content.",
      );
      digests.push({ nameSha256: sha256(entry.name), sha256: sha256(text) });
    }
    processLogsPromptRedacted = entries.length > 0;
    assert(
      processLogsPromptRedacted,
      "Acceptance produced no process logs for the runtime privacy scan.",
    );
    rawLog.push(
      rawReceipt("electron-process", "electron.process-logs.privacy-scan", {
        outcome: "redacted",
        count: entries.length,
        responseSha256: sha256(canonicalJson(digests)),
      }),
    );
    await rm(paths.processLogDirectory, { recursive: true, force: false });
    processLogsRemoved = !(await pathExists(paths.processLogDirectory));
    assert(processLogsRemoved, "Acceptance process logs were not removed.");
  });
  const appsHostWorkerdStateDirectory = assertNarrowIsolatedPath(
    path.join(paths.stateDirectory, "apps-host-workerd"),
    paths.root,
    "Apps Host workerd cleanup target",
  );
  if (await pathExists(appsHostWorkerdStateDirectory)) {
    await attempt("Apps Host workerd state removal", async () => {
      await rm(appsHostWorkerdStateDirectory, {
        recursive: true,
        force: false,
      });
    });
  }
  const appsHostWorkerdStateRemoved = !(await pathExists(
    appsHostWorkerdStateDirectory,
  ));
  if (!appsHostWorkerdStateRemoved) {
    failures.push({
      label: "Apps Host workerd state removal",
      message: "Disposable Apps Host Workerd state remains after cleanup.",
    });
  }
  rawLog.push(
    rawReceipt("apps-host-workerd", "apps-host.workerd.final-cleanup", {
      outcome: appsHostWorkerdStateRemoved ? "removed" : "retained",
      resourceIdSha256: sha256(appsHostWorkerdStateDirectory),
    }),
  );
  let isolatedProfilesRemoved = false;

  const remainingResources = [];
  for (const prefix of conversationPrefixes) {
    const remaining = await attempt(
      `conversation archive verify ${sha256(prefix)}`,
      async () =>
        await r2ListObjects(
          secrets,
          REQUIRED_CONVERSATION_ARCHIVE_BUCKET_NAME,
          prefix,
          rawLog,
        ),
    );
    if (remaining?.length > 0) remainingResources.push(`r2:${sha256(prefix)}`);
  }
  for (const prefix of agentHomePrefixes) {
    const homeRemaining = await attempt(
      `agent home verify ${sha256(prefix)}`,
      async () =>
        await r2ListObjects(
          secrets,
          REQUIRED_AGENT_HOME_BUCKET_NAME,
          prefix,
          rawLog,
        ),
    );
    if (homeRemaining?.length > 0) {
      remainingResources.push(`agent-home:${sha256(prefix)}`);
    }
  }
  const liveAfter = await liveProfileMetadataSha256();
  const liveProfileUntouched = liveBefore !== null && liveAfter === liveBefore;
  if (!liveProfileUntouched) {
    failures.push({
      label: "live profile",
      message: "Live ~/.stella metadata could not be attested unchanged.",
    });
  }
  if (remainingResources.length > 0) {
    failures.push({
      label: "remote resources",
      message: "Disposable remote resources remain after cleanup.",
    });
  }
  const recordedAgentHomeKeys = Array.isArray(state.resources?.agentHomeR2Keys)
    ? state.resources.agentHomeR2Keys
    : [];
  const memoryKeysRecorded = recordedAgentHomeKeys.some((key) =>
    String(key).includes("/memory-versions/"),
  );
  const skillKeysRecorded = recordedAgentHomeKeys.some((key) =>
    String(key).includes("/skills/"),
  );
  const r2ObjectsPurged = remainingResources.length === 0 && agentHomePurged;
  const cloudMemoryPurged = agentHomePurged && memoryKeysRecorded;
  const cloudSkillsPurged = agentHomePurged && skillKeysRecorded;
  if (!cloudMemoryPurged || !cloudSkillsPurged) {
    failures.push({
      label: "agent home product cleanup",
      message: "Cleanup lacked verified memory or skill object checkpoints.",
    });
  }
  const profileRemovalAuthorized =
    failures.length === 0 &&
    connectedTestAccountRevoked &&
    primarySessionRevoked &&
    primaryOwnerResidueRemoved &&
    secondaryTestAccountRevoked &&
    secondarySessionRevoked &&
    secondaryOwnerResidueRemoved &&
    anonymousMobilePolicyAccountDisposed &&
    anonymousMobilePolicySessionRevoked &&
    anonymousMobilePolicyOwnerResidueRemoved &&
    remainingResources.length === 0 &&
    r2ObjectsPurged &&
    cloudMemoryPurged &&
    cloudSkillsPurged;
  if (profileRemovalAuthorized) {
    for (const entry of await readdir(paths.profileDirectory, {
      withFileTypes: true,
    })) {
      const target = assertNarrowIsolatedPath(
        path.join(paths.profileDirectory, entry.name),
        paths.root,
        "Disposable profile cleanup target",
      );
      await attempt(
        `profile removal ${sha256(entry.name)}`,
        async () => await rm(target, { recursive: true, force: false }),
      );
    }
    isolatedProfilesRemoved =
      (await readdir(paths.profileDirectory)).length === 0;
    if (!isolatedProfilesRemoved) {
      failures.push({
        label: "profile removal",
        message: "Disposable profiles remain after cleanup.",
      });
    }
  } else {
    failures.push({
      label: "profile preservation",
      message:
        "Remote cleanup is incomplete; isolated profiles were retained for restart-safe retry.",
    });
  }
  await checkpoint({
    cleanup: {
      attemptedAt: new Date().toISOString(),
      identityComplete: Boolean(state.identity),
      failureCount: failures.length,
      remainingResources,
      isolatedProfilesRemoved,
    },
  });
  assert(
    state.identity,
    "Cleanup completed its recorded attempts but deployment identity was never attested.",
  );
  assert(
    failures.length === 0,
    "One or more fail-closed cleanup operations did not complete.",
    {
      failureCount: failures.length,
      failureSetSha256: sha256(canonicalJson(failures)),
      remainingResources,
    },
  );
  return {
    observations: {
      conversationPurged,
      r2ObjectsPurged,
      cloudMemoryPurged,
      cloudSkillsPurged,
      sandboxResourcesPurged,
      appsHostWorkerdStateRemoved,
      ownerGenerationsPurged: agentHomePurged && ownerGenerations.length >= 2,
      oldOwnerResetCorePurged:
        state.ownerReset?.phase === "reconstituted" &&
        state.ownerReset?.remainingResetOwnedCoreStoreCount === 0 &&
        state.ownerReset?.oldGenerationR2ObjectCount === 0 &&
        state.ownerReset?.connectedIntegrationPreservedByReset === true,
      connectedTestAccountRevoked,
      primarySessionRevoked,
      primaryOwnerResidueRemoved,
      primaryLifecycleTombstoned,
      primaryPurgeJobCompleted,
      primaryConversationResidueCount,
      primaryResetCoreResidueCount,
      primaryAccountCoreResidueCount,
      primaryCloudStoreResidueCount,
      secondaryTestAccountRevoked,
      secondarySessionRevoked,
      secondaryOwnerResidueRemoved,
      secondaryConversationPurged,
      secondaryResetCorePurged,
      secondaryAccountCorePurged,
      secondaryCloudStoresPurged,
      secondaryLifecycleTombstoned,
      secondaryPurgeJobCompleted,
      primarySessionRestoredAfterSecondaryRevocation,
      secondaryRevocationPrecededPrimaryRevocation,
      secondaryConversationResidueCount,
      secondaryResetCoreResidueCount,
      secondaryAccountCoreResidueCount,
      secondaryCloudStoreResidueCount,
      anonymousMobilePolicyAccountDisposed,
      anonymousMobilePolicySessionRevoked,
      anonymousMobilePolicyOwnerResidueRemoved,
      connectedIntegrationRemovedAfterAccountDeletion,
      processLogsPromptRedacted,
      processLogsRemoved,
      harnessProcessGroupsStopped,
      trustedLoopbackPortReleased,
      isolatedProfilesRemoved,
      liveProfileUntouched,
      liveProfileSha256Before: liveBefore,
      liveProfileSha256After: liveAfter,
      remainingResources,
    },
    patch: {
      cleanup: {
        completedAt: new Date().toISOString(),
        liveProfileSha256: liveAfter,
        remainingResources,
      },
    },
  };
};

const STEP_HANDLERS = Object.freeze({
  primary_auth_handoff: stepPrimaryAuthHandoff,
  deployment_identity: stepDeploymentIdentity,
  local_runtime_lifecycle: stepLocalRuntimeLifecycle,
  electron_real_stream: stepElectronRealStream,
  consecutive_durable_turns: stepConsecutiveDurableTurns,
  duplicate_delivery_idempotency: stepDuplicateDelivery,
  electron_restart_reconnect: stepElectronRestartReconnect,
  clean_client_hydration: stepCleanClientHydration,
  cache_loss_recovery: stepCacheLossRecovery,
  projection_and_r2: stepProjectionAndR2,
  cancellation: stepCancellation,
  cloud_failure_no_local_fallback: stepCloudFailureNoLocalFallback,
  desktop_local_routing: stepDesktopLocalRouting,
  mobile_reachable_computer_routing: stepMobileReachableComputerRouting,
  mobile_unreachable_cloud_routing: stepMobileUnreachableCloudRouting,
  mobile_signed_in_canonical_sync: stepMobileMountedRnCanonicalSync,
  browser_cloud_routing: stepBrowserCloudRouting,
  child_completion: stepChildCompletion,
  memory_restart_recall: stepMemoryRestartRecall,
  cloud_skill_discovery_use: stepCloudSkillDiscoveryUse,
  code_mode_real_mcp: stepCodeModeRealMcp,
  general_agent_real_sandbox: stepGeneralAgentRealSandbox,
  owner_reset_memory_reimport: stepOwnerResetMemoryReimport,
  apps_host_workerd_runtime: stepAppsHostWorkerdRuntime,
  cleanup: stepCleanup,
});

/**
 * Small, reviewed reuse surface for the focused cloud-canonical product smoke.
 *
 * Keep this separate from the 26-step driver contract: the core smoke owns its
 * own four-scenario state and evidence, but it must exercise the same Electron,
 * authentication, and canonical-journal paths as the exhaustive harness.
 */
export const CORE_PRODUCT_SMOKE_DRIVER_PRIMITIVES = Object.freeze({
  buildElectron,
  configureElectronSession,
  connectElectronRenderedClient,
  convexCall,
  driveVisibleProductOnboarding,
  electronLocalTurn,
  ephemeralJwtSecrets,
  launchElectron,
  launchVite,
  loadSecrets,
  loadWholeJournal,
  navigateRenderedProduct,
  rawReceipt,
  readAnonymousElectronAuthority,
  readElectronSessionAuthority,
  relaunchElectron,
  stopProcess,
  stopRenderedElectron,
  trustedRenderedClick,
});

export const parseRealProductDriverArguments = (argv) => {
  assert(
    Array.isArray(argv) && argv.length === 1,
    "Use cloud-canonical-real-product-driver.mjs <exact-step-id>.",
  );
  const step = argv[0];
  assert(
    REAL_PRODUCT_DRIVER_STEP_IDS.includes(step),
    `Unknown real-product acceptance step: ${String(step)}.`,
  );
  return step;
};

const commitCleanupState = async (context, paths, state, patch) => {
  const evidenceSha256 = await fileSha256(context.evidenceFile);
  const rawLogSha256 = await fileSha256(context.rawLogFile);
  const previousChainSha256 =
    state.completedSteps.at(-1)?.chainSha256 ??
    sha256(`${ACCEPTANCE_DRIVER_CONTRACT}\n${context.runId}`);
  const cleanupChainSha256 = sha256(
    canonicalJson({
      step: "cleanup",
      evidenceSha256,
      rawLogSha256,
      previousChainSha256,
    }),
  );
  await atomicWritePrivateJson(
    paths.stateFile,
    sealState({
      ...stateBody(state),
      ...patch,
      cleanupReceipt: {
        evidenceSha256,
        rawLogSha256,
        previousChainSha256,
        cleanupChainSha256,
      },
      updatedAt: new Date().toISOString(),
    }),
  );
};

export const runRealProductDriverStep = async (
  step,
  { env = process.env, cwd = process.cwd() } = {},
) => {
  assert(
    env === process.env,
    "The executable driver does not accept injected environment objects.",
  );
  const context = loadAcceptanceDriverContext(step, env);
  const paths = resolveRealProductHarnessPaths(context, cwd);
  const releaseLock = await acquireLock(paths, context);
  const startedAt = new Date().toISOString();
  try {
    assert(
      !(await pathExists(context.evidenceFile)) &&
        !(await pathExists(context.rawLogFile)),
      "Runner-selected evidence and raw-log files must be fresh.",
    );
    const state = await loadState(context, paths);
    if (!(await pathExists(paths.stateFile))) {
      // Persist the cleanup ledger before the first remote mutation. A crash
      // during deployment identity must still leave cleanup a durable root to
      // inspect instead of orphaning the just-created acceptance owner state.
      await atomicWritePrivateJson(paths.stateFile, state);
    }
    assertStepOrder(context, state);
    let secrets = loadSecrets();
    const rawLog = [];
    if (
      step !== "primary_auth_handoff" &&
      step !== "deployment_identity" &&
      step !== "cleanup"
    ) {
      const currentSource = await sourceTreeIdentity(rawLog);
      assert(
        currentSource.repoCommitSha === state.deployment?.repoCommitSha &&
          currentSource.repoTreeSha === state.deployment?.repoTreeSha &&
          currentSource.sourceTreeSha256 === state.deployment?.sourceTreeSha256,
        "Reviewed source tree changed after deployment identity was attested.",
      );
    }
    if (
      step !== "primary_auth_handoff" &&
      step !== "cleanup" &&
      STEP_INDEX.get(step) >= STEP_INDEX.get("deployment_identity") &&
      isRecord(state.electron) &&
      processAlive(state.electron.pid)
    ) {
      secrets = await refreshPrimaryStepSecrets(
        context,
        secrets,
        state,
        rawLog,
        `${step} primary authority refresh`,
      );
    }
    const handler = STEP_HANDLERS[step];
    assert(
      typeof handler === "function",
      `No reviewed handler exists for ${step}.`,
    );
    const result = await handler({
      context,
      secrets,
      paths,
      state,
      rawLog,
      startedAt,
      checkpoint: async (patch) =>
        await checkpointState(
          paths,
          state,
          requireRecord(patch, "State checkpoint"),
        ),
    });
    assert(rawLog.length > 0, `${step} produced no real product receipts.`);
    const identity =
      step === "primary_auth_handoff" || step === "deployment_identity"
        ? requireRecord(result.identity, "Deployment acceptance identity")
        : requireRecord(state.identity, "Persisted acceptance identity");
    const finishedAt = new Date().toISOString();
    await writeAcceptanceDriverEvidence(context, {
      startedAt: result.startedAt ?? startedAt,
      finishedAt,
      attestations: ATTESTATIONS,
      identity,
      observations: requireRecord(result.observations, `${step} observations`),
      rawLog,
    });
    if (step === "cleanup") {
      await commitCleanupState(context, paths, state, result.patch ?? {});
    } else {
      await commitCompletedStep(context, paths, state, result.patch ?? {});
    }
    return {
      step,
      evidenceFile: context.evidenceFile,
      rawLogFile: context.rawLogFile,
    };
  } finally {
    await terminateBoundedCommands();
    await releaseLock();
  }
};

export const runRealProductDriverCli = async (argv = process.argv.slice(2)) => {
  if (
    Array.isArray(argv) &&
    argv.length === 1 &&
    argv[0] === "--prepare-auth"
  ) {
    const receipt = await runPrimaryAuthPreparation();
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    return;
  }
  const step = parseRealProductDriverArguments(argv);
  await runRealProductDriverStep(step);
  process.stdout.write(`REAL PRODUCT STEP PASSED: ${step}\n`);
};

const invokedDirectly = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === SCRIPT_FILE;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  let terminatingFromSignal = false;
  const terminateFromSignal = (exitCode) => {
    if (terminatingFromSignal) return;
    terminatingFromSignal = true;
    void terminateCommandChildrenForSignal().finally(() => {
      process.exit(exitCode);
    });
  };
  process.once("SIGTERM", () => terminateFromSignal(143));
  process.once("SIGINT", () => terminateFromSignal(130));
  runRealProductDriverCli().catch((error) => {
    const message =
      error instanceof Error
        ? error.message
        : "Unknown real-product driver failure.";
    process.stderr.write(
      `REAL PRODUCT STEP FAILED: ${sanitizeEvidence(message)}\n`,
    );
    process.exitCode =
      error instanceof ProductHandoffAwaitingError
        ? PRIMARY_AUTH_AWAITING_EXIT_CODE
        : error instanceof CloudProofError &&
            error.details?.code === AUTHORITY_RUNWAY_EXHAUSTED
          ? AUTHORITY_RUNWAY_EXHAUSTED_EXIT_CODE
          : 1;
  });
}
