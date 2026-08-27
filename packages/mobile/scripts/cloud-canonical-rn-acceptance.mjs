#!/usr/bin/env bun

/**
 * Fixed orchestrator for the mounted mobile cloud-canonical acceptance.
 *
 * Phase mode owns exactly one fresh Bun process. The outer real-product driver
 * obtains a new product-profile JWT immediately before every phase, then
 * assembles the three hash-only receipts. Post-reset mode owns the bounded
 * generation-rotation child while the outer driver performs the real account
 * reset through a private file barrier.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONTRACT = "stella-mobile-rn-canonical-v2";
const RECEIPT_MARKER = "STELLA_MOBILE_RN_ACCEPTANCE_RECEIPT=";
const MAX_CHILD_OUTPUT_BYTES = 4 * 1024 * 1024;
export const MOBILE_RN_CHILD_TIMEOUT_OVERHEAD_MS = 3 * 60_000;
const CHILD_TERMINATION_GRACE_MS = 5_000;
const activeChildren = new Set();
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RAW_RECEIPT_KEYS = new Set([
  "accountscope",
  "barrierdirectory",
  "conversationid",
  "harnessroot",
  "identitykey",
  "jwt",
  "ownergeneration",
  "sessionid",
  "sessionsubject",
  "socketorigin",
  "storagedirectory",
  "token",
]);
const ALLOWED_CHILD_EXTRA_ENV = new Set([
  "EXPECTED_PRIOR_STATE_SHA256",
  "STELLA_MOBILE_ACCEPTANCE_ROTATION_BARRIER_DIR",
  "STELLA_MOBILE_RN_EXPECTED_PRIOR_STATE_SHA256",
]);
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD_FILE = path.join(
  SCRIPT_DIRECTORY,
  "cloud-canonical-rn-acceptance.preload.ts",
);
const LIVE_TEST_FILE = path.join(
  SCRIPT_DIRECTORY,
  "cloud-canonical-rn-acceptance.live.test.tsx",
);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const required = (key) => {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key} is required.`);
  return value;
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const signalChildProcessTree = (child, signal) => {
  try {
    child.kill(signal);
  } catch {
    // A concurrently exited child is already terminated.
  }
};

export const stableJson = (value) => {
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

export const assertBun14 = (version) => {
  const checked = version?.trim() ?? "";
  assert(/^1\.4\.[0-9]+(?:[-+].*)?$/u.test(checked), "Bun 1.4.x is required.");
  return checked;
};

/**
 * @param {unknown} value
 * @param {{ sensitiveValues?: Array<string | undefined> }} [options]
 * @returns {unknown}
 */
export const assertHashOnlyAcceptanceResult = (
  value,
  { sensitiveValues = [] } = {},
) => {
  const secrets = sensitiveValues.filter(
    (sensitive) => typeof sensitive === "string" && sensitive.length > 0,
  );
  const visit = (current, key = "root") => {
    if (typeof current === "string") {
      if (key.toLowerCase().endsWith("sha256")) {
        assert(SHA256_PATTERN.test(current), `${key} is not a SHA-256 digest.`);
      }
      for (const sensitive of secrets) {
        assert(
          current !== sensitive &&
            (sensitive.length < 8 || !current.includes(sensitive)),
          `${key} exposed a raw acceptance authority value.`,
        );
      }
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((child, index) => visit(child, `${key}[${index}]`));
      return;
    }
    if (!current || typeof current !== "object") return;
    for (const [childKey, child] of Object.entries(current)) {
      const normalized = childKey.toLowerCase();
      assert(
        !RAW_RECEIPT_KEYS.has(normalized),
        `${childKey} is forbidden in a hash-only acceptance result.`,
      );
      visit(child, childKey);
    }
  };
  visit(value);
  return value;
};

/**
 * @param {Record<string, string | undefined>} [source]
 * @returns {Record<string, string>}
 */
export const minimalChildSystemEnvironment = (source = process.env) => ({
  PATH: source.PATH || "/usr/bin:/bin",
  TMPDIR: source.TMPDIR || "/tmp",
  LANG: source.LANG || "C",
  TZ: source.TZ || "UTC",
  NODE_ENV: "test",
  NO_COLOR: "1",
});

const ensureInside = (root, candidate, label) => {
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  assert(
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative),
    `${label} must be inside the isolated harness root.`,
  );
  return resolved;
};

const childResult = async ({ phase, storageDirectory, extraEnv = {} }) => {
  const timeoutMs = Math.max(
    30_000,
    Math.min(
      15 * 60_000,
      Number(process.env.STELLA_MOBILE_ACCEPTANCE_TIMEOUT_MS) || 12 * 60_000,
    ),
  );
  for (const key of Object.keys(extraEnv)) {
    assert(
      ALLOWED_CHILD_EXTRA_ENV.has(key),
      `Mounted RN child extra environment key is not allowed: ${key}.`,
    );
  }
  const primaryIdentityEnv = Object.fromEntries(
    [
      "JWT",
      "SESSION_SUBJECT",
      "SESSION_ID",
      "OWNER_GENERATION",
      "CONVERSATION_ID",
    ].map((suffix) => [
      `STELLA_MOBILE_ACCEPTANCE_${suffix}`,
      required(`STELLA_MOBILE_ACCEPTANCE_${suffix}`),
    ]),
  );
  const secondaryIdentityEnv =
    phase === "replay_reconnect_switch"
      ? Object.fromEntries(
          [
            "JWT",
            "SESSION_SUBJECT",
            "SESSION_ID",
            "OWNER_GENERATION",
            "CONVERSATION_ID",
          ].map((suffix) => [
            `STELLA_MOBILE_ACCEPTANCE_SECONDARY_${suffix}`,
            required(`STELLA_MOBILE_ACCEPTANCE_SECONDARY_${suffix}`),
          ]),
        )
      : {};
  const startedAt = Date.now();
  const deadlineAt =
    startedAt + timeoutMs + MOBILE_RN_CHILD_TIMEOUT_OVERHEAD_MS;
  const child = spawn(
    process.execPath,
    ["test", "--preload", PRELOAD_FILE, LIVE_TEST_FILE],
    {
      cwd: path.resolve(SCRIPT_DIRECTORY, "../../.."),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...minimalChildSystemEnvironment(),
        ...primaryIdentityEnv,
        ...secondaryIdentityEnv,
        STELLA_MOBILE_ACCEPTANCE_RUN_ID: required(
          "STELLA_MOBILE_ACCEPTANCE_RUN_ID",
        ),
        STELLA_MOBILE_ACCEPTANCE_HARNESS_ROOT: required(
          "STELLA_MOBILE_ACCEPTANCE_HARNESS_ROOT",
        ),
        STELLA_MOBILE_ACCEPTANCE_TIMEOUT_MS: String(timeoutMs),
        STELLA_MOBILE_ACCEPTANCE_BUILDER_ORIGIN: required(
          "STELLA_MOBILE_ACCEPTANCE_BUILDER_ORIGIN",
        ),
        STELLA_MOBILE_ACCEPTANCE_CONVEX_ORIGIN: required(
          "STELLA_MOBILE_ACCEPTANCE_CONVEX_ORIGIN",
        ),
        STELLA_MOBILE_ACCEPTANCE_CONVEX_SITE_ORIGIN: required(
          "STELLA_MOBILE_ACCEPTANCE_CONVEX_SITE_ORIGIN",
        ),
        EXPO_PUBLIC_CONVEX_SITE_URL: required(
          "STELLA_MOBILE_ACCEPTANCE_CONVEX_SITE_ORIGIN",
        ),
        EXPO_PUBLIC_CONVEX_URL: required(
          "STELLA_MOBILE_ACCEPTANCE_CONVEX_ORIGIN",
        ),
        STELLA_MOBILE_RN_ACCEPTANCE_PHASE: phase,
        STELLA_MOBILE_RN_ACCEPTANCE_STORAGE_DIRECTORY: storageDirectory,
        STELLA_MOBILE_RN_ACCEPTANCE_JWT: required(
          "STELLA_MOBILE_ACCEPTANCE_JWT",
        ),
        STELLA_MOBILE_RN_ACCEPTANCE_SESSION_SUBJECT: required(
          "STELLA_MOBILE_ACCEPTANCE_SESSION_SUBJECT",
        ),
        STELLA_MOBILE_RN_ACCEPTANCE_SESSION_ID: required(
          "STELLA_MOBILE_ACCEPTANCE_SESSION_ID",
        ),
        ...extraEnv,
      },
    },
  );
  activeChildren.add(child);
  const chunks = [];
  let bytes = 0;
  let outputOverflow = false;
  let timedOut = false;
  let forceKillTimer = null;
  const terminate = () => {
    signalChildProcessTree(child, "SIGTERM");
    if (forceKillTimer === null) {
      forceKillTimer = setTimeout(
        () => signalChildProcessTree(child, "SIGKILL"),
        CHILD_TERMINATION_GRACE_MS,
      );
    }
  };
  const collect = (chunk) => {
    if (outputOverflow) return;
    bytes += chunk.byteLength;
    if (bytes > MAX_CHILD_OUTPUT_BYTES) {
      outputOverflow = true;
      terminate();
      return;
    }
    chunks.push(chunk);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs + MOBILE_RN_CHILD_TIMEOUT_OVERHEAD_MS);
  const outcome = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) =>
      resolve({ exitCode, signal, finishedAt: Date.now() }),
    );
  }).finally(() => {
    clearTimeout(timer);
    activeChildren.delete(child);
    if (forceKillTimer !== null) clearTimeout(forceKillTimer);
  });
  const output = Buffer.concat(chunks).toString("utf8");
  assert(
    !outputOverflow && bytes <= MAX_CHILD_OUTPUT_BYTES,
    "Mounted RN child output exceeded its limit.",
  );
  assert(
    !timedOut && outcome.finishedAt <= deadlineAt,
    `Mounted RN child exceeded its checked deadline (${sha256(output)}).`,
  );
  assert(
    outcome.exitCode === 0,
    `Mounted RN child failed (${outcome.signal ?? "exit"}:${sha256(output)}).`,
  );
  const markerLines = output
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(RECEIPT_MARKER));
  assert(
    markerLines.length === 1,
    "Mounted RN child emitted no unique receipt.",
  );
  const result = JSON.parse(markerLines[0].slice(RECEIPT_MARKER.length));
  assert(
    result &&
      typeof result === "object" &&
      result.passed === true &&
      result.phase === phase,
    "Mounted RN child returned an invalid receipt.",
  );
  return result;
};

const runtimeEvidence = async (bunVersion) => {
  const productFiles = [
    "../src/lib/use-cloud-canonical-chat-thread.ts",
    "../src/lib/use-chat-thread.ts",
    "../src/lib/desktop-chat-outbox.ts",
    "../src/lib/cloud-conversation-store.ts",
    "../src/lib/cloud-conversation-socket.ts",
    "../src/lib/http.ts",
  ];
  const productModuleSha256 = {};
  for (const relative of productFiles) {
    const file = path.resolve(SCRIPT_DIRECTORY, relative);
    productModuleSha256[path.basename(file)] = sha256(await readFile(file));
  }
  return {
    bunVersion,
    executor: "bun-jsdom-react-native-web",
    renderer: "react-dom-react-native-web",
    actualSignedInChatHookMounted: true,
    actualProductScreenMounted: false,
    actualAsyncStoragePackage: true,
    actualAsyncStorageWrapper: true,
    actualAppStateSubscription: true,
    realHttp: true,
    realWebSocket: true,
    productModuleSha256,
  };
};

const boundary = Object.freeze({
  javascriptProcessRestartProved: true,
  reactNativeWebUiInteractionProved: true,
  asyncStorageWebAdapterProved: true,
  appStateVisibilityLifecycleProved: true,
  realDevHttpAndWebSocketProved: true,
  expoNativeBinaryProved: false,
  nativeAsyncStorageBackendProved: false,
  osProcessDeathProved: false,
  nativeAppStateDeliveryProved: false,
  nativeLayoutAndTouchProved: false,
});

const validateIdentityInputs = (prefix = "STELLA_MOBILE_ACCEPTANCE_") => {
  for (const suffix of [
    "JWT",
    "SESSION_SUBJECT",
    "SESSION_ID",
    "OWNER_GENERATION",
    "CONVERSATION_ID",
  ]) {
    required(`${prefix}${suffix}`);
  }
};

const runSinglePhase = async ({ harnessRoot, bunVersion }) => {
  const phase = required("STELLA_MOBILE_RN_ACCEPTANCE_PHASE");
  assert(
    [
      "enqueue_response_loss",
      "replay_reconnect_switch",
      "clean_hydrate",
    ].includes(phase),
    "Mounted RN single phase is invalid.",
  );
  validateIdentityInputs();
  if (phase === "replay_reconnect_switch") {
    validateIdentityInputs("STELLA_MOBILE_ACCEPTANCE_SECONDARY_");
    assert(
      required("STELLA_MOBILE_ACCEPTANCE_SESSION_SUBJECT") !==
        required("STELLA_MOBILE_ACCEPTANCE_SECONDARY_SESSION_SUBJECT"),
      "Primary and secondary mobile identities must be distinct.",
    );
  }
  const storageRoot = ensureInside(
    harnessRoot,
    path.join(harnessRoot, "mobile-rn-web"),
    "Mounted RN storage root",
  );
  const continuityStorage = path.join(storageRoot, "continuity");
  const cleanGenerationStorage = path.join(storageRoot, "clean-generation");
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  assert(
    !statSync(storageRoot).isSymbolicLink(),
    "Mounted RN storage root cannot be a symlink.",
  );
  const result = await childResult({
    phase,
    storageDirectory:
      phase === "clean_hydrate" ? cleanGenerationStorage : continuityStorage,
    ...(phase === "replay_reconnect_switch"
      ? {
          extraEnv: {
            STELLA_MOBILE_RN_EXPECTED_PRIOR_STATE_SHA256: required(
              "STELLA_MOBILE_RN_EXPECTED_PRIOR_STATE_SHA256",
            ),
          },
        }
      : {}),
  });
  return {
    version: 2,
    contract: CONTRACT,
    mode: "phase",
    phase,
    passed: true,
    runtime: await runtimeEvidence(bunVersion),
    boundary,
    result,
    receipts: result.receipts,
    summarySha256: sha256(stableJson(result)),
  };
};

const runPostResetGeneration = async ({ harnessRoot, bunVersion }) => {
  validateIdentityInputs();
  const storageDirectory = ensureInside(
    harnessRoot,
    path.join(harnessRoot, "mobile-rn-web", "clean-generation"),
    "Generation canary storage",
  );
  const barrierDirectory = ensureInside(
    harnessRoot,
    required("STELLA_MOBILE_ACCEPTANCE_ROTATION_BARRIER_DIR"),
    "Generation rotation barrier",
  );
  const generationRotation = await childResult({
    phase: "generation_rotation",
    storageDirectory,
    extraEnv: {
      EXPECTED_PRIOR_STATE_SHA256: required("EXPECTED_PRIOR_STATE_SHA256"),
      STELLA_MOBILE_ACCEPTANCE_ROTATION_BARRIER_DIR: barrierDirectory,
    },
  });
  return {
    version: 2,
    contract: CONTRACT,
    mode: "post_reset_generation",
    passed: true,
    runtime: await runtimeEvidence(bunVersion),
    boundary,
    generationRotation,
    receipts: generationRotation.receipts,
    summarySha256: sha256(stableJson(generationRotation)),
  };
};

export const runMountedRnAcceptance = async () => {
  const bunVersion = assertBun14(process.versions.bun);
  const runId = required("STELLA_MOBILE_ACCEPTANCE_RUN_ID");
  assert(UUID_PATTERN.test(runId), "The acceptance run id is invalid.");
  const harnessRoot = realpathSync(
    required("STELLA_MOBILE_ACCEPTANCE_HARNESS_ROOT"),
  );
  assert(
    statSync(harnessRoot).isDirectory(),
    "The harness root is not a directory.",
  );
  required("STELLA_MOBILE_ACCEPTANCE_CONVEX_ORIGIN");
  required("STELLA_MOBILE_ACCEPTANCE_CONVEX_SITE_ORIGIN");
  required("STELLA_MOBILE_ACCEPTANCE_BUILDER_ORIGIN");
  const mode = process.env.STELLA_MOBILE_RN_ACCEPTANCE_MODE?.trim() || "phase";
  assert(
    mode === "phase" || mode === "post_reset_generation",
    "Mounted RN acceptance mode is invalid.",
  );
  const result =
    mode === "phase"
      ? await runSinglePhase({ harnessRoot, bunVersion })
      : await runPostResetGeneration({ harnessRoot, bunVersion });
  assert(SHA256_PATTERN.test(result.summarySha256), "Summary hash is invalid.");
  return assertHashOnlyAcceptanceResult(result, {
    sensitiveValues: [
      runId,
      process.env.STELLA_MOBILE_ACCEPTANCE_JWT,
      process.env.STELLA_MOBILE_ACCEPTANCE_SESSION_SUBJECT,
      process.env.STELLA_MOBILE_ACCEPTANCE_SESSION_ID,
      process.env.STELLA_MOBILE_ACCEPTANCE_OWNER_GENERATION,
      process.env.STELLA_MOBILE_ACCEPTANCE_CONVERSATION_ID,
      process.env.STELLA_MOBILE_ACCEPTANCE_SECONDARY_JWT,
      process.env.STELLA_MOBILE_ACCEPTANCE_SECONDARY_SESSION_SUBJECT,
      process.env.STELLA_MOBILE_ACCEPTANCE_SECONDARY_SESSION_ID,
      process.env.STELLA_MOBILE_ACCEPTANCE_SECONDARY_OWNER_GENERATION,
      process.env.STELLA_MOBILE_ACCEPTANCE_SECONDARY_CONVERSATION_ID,
      process.env.STELLA_MOBILE_ACCEPTANCE_CONVEX_ORIGIN,
      process.env.STELLA_MOBILE_ACCEPTANCE_CONVEX_SITE_ORIGIN,
      process.env.STELLA_MOBILE_ACCEPTANCE_BUILDER_ORIGIN,
    ],
  });
};

const terminateActiveChildrenForSignal = async () => {
  const children = [...activeChildren];
  if (children.length === 0) return;
  for (const child of children) signalChildProcessTree(child, "SIGTERM");
  await Promise.race([
    Promise.all(
      children.map(
        (child) =>
          new Promise((resolve) => {
            if (
              !activeChildren.has(child) ||
              child.exitCode !== null ||
              child.signalCode !== null
            ) {
              resolve();
              return;
            }
            child.once("close", resolve);
            child.once("error", resolve);
          }),
      ),
    ),
    new Promise((resolve) =>
      setTimeout(resolve, CHILD_TERMINATION_GRACE_MS - 1_000),
    ),
  ]);
  for (const child of activeChildren) signalChildProcessTree(child, "SIGKILL");
};

if (import.meta.main) {
  let terminatingFromSignal = false;
  const terminateFromSignal = (exitCode) => {
    if (terminatingFromSignal) return;
    terminatingFromSignal = true;
    void terminateActiveChildrenForSignal().finally(() => {
      process.exit(exitCode);
    });
  };
  process.once("SIGTERM", () => terminateFromSignal(143));
  process.once("SIGINT", () => terminateFromSignal(130));
  try {
    const result = await runMountedRnAcceptance();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(
      `${JSON.stringify({
        version: 2,
        contract: CONTRACT,
        passed: false,
        errorSha256: sha256(message),
      })}\n`,
    );
    process.exitCode = 1;
  }
}
