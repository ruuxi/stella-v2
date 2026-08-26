#!/usr/bin/env node

/**
 * Manifest runner for real Stella cloud-canonical product acceptance.
 *
 * Unlike cloud-canonical-protocol-smoke.mjs, every step here must launch or
 * drive a real product surface and write structured evidence. The runner does
 * not manufacture transcript rows, infer success from exit code, or accept a
 * mocked/synthetic assistant response.
 *
 * Usage:
 *   node cloud-canonical-acceptance.mjs --list
 *   node cloud-canonical-acceptance.mjs --check /abs/manifest.json
 *   STELLA_CLOUD_ACCEPTANCE_CONFIRM=run-real-dev:impartial-crab-34 \
 *     node cloud-canonical-acceptance.mjs --run /abs/manifest.json
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CloudProofError,
  FORBIDDEN_TARGET_PATTERN,
  assert,
  assertSafeAcceptanceEnvironment,
  loadNonMutatingTarget,
  sanitizeEvidence,
  sha256,
  writeEvidence,
} from "./cloud-proof-lib.mjs";

const REPO_ROOT = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
);
const USER_HOME = path.resolve(homedir());
const LIVE_STELLA_ROOT = path.join(USER_HOME, ".stella");
const MAX_COMMAND_OUTPUT_BYTES = 2_000_000;
const MAX_JSON_FILE_BYTES = 2_000_000;

const requiredStepDescriptions = Object.freeze({
  electron_real_stream:
    "A real isolated Electron profile streams a real turn into the conversation DO.",
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
    "An injected cloud-authority failure is visible and creates no local-authoritative row.",
  desktop_local_routing:
    "Desktop computer work executes in the eligible local runtime, never a sandbox.",
  mobile_reachable_computer_routing:
    "Mobile computer work routes to the reachable paired computer under a fenced claim.",
  mobile_unreachable_cloud_routing:
    "Mobile computer work without an eligible computer runs in a real cloud sandbox.",
  browser_cloud_routing:
    "A browser-only turn runs in a real cloud sandbox and never silently runs locally.",
  child_completion:
    "A real child completion reaches the parent DO exactly once.",
  cleanup:
    "Disposable conversations, R2 objects, and isolated profiles are removed; live state is untouched.",
});

const REQUIRED_STEP_IDS = Object.keys(requiredStepDescriptions);

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

const commonEvidence = (stepId, payload, runId) => {
  assert(payload?.version === 1, `${stepId} evidence version must be 1.`);
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
  return payload.observations;
};

const validators = {
  electron_real_stream(observation) {
    const profileDir = safeIsolatedPath(
      existingDirectory(
        safeIsolatedPath(observation.profileDir, "profileDir"),
        "profileDir",
      ),
      "profileDir",
    );
    return {
      conversationId: nonEmptyString(
        observation.conversationId,
        "conversationId",
      ),
      turnId: nonEmptyString(observation.turnId, "turnId"),
      streamEventCount: finiteInteger(
        observation.streamEventCount,
        "streamEventCount",
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
      doObserved: booleanTrue(observation.doObserved, "doObserved"),
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
    return {
      conversationId: nonEmptyString(
        observation.conversationId,
        "conversationId",
      ),
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
      profileBInitiallyHadCache:
        observation.profileBInitiallyHadCache === false
          ? false
          : (() => {
              throw new CloudProofError(
                "profileBInitiallyHadCache must be false.",
              );
            })(),
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
  projection_and_r2(observation) {
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
      ) && r2ObjectKey.includes(`/${conversationId}/seg/`),
      "r2ObjectKey is not the real archive key for this conversation.",
    );
    const r2Etag = nonEmptyString(observation.r2Etag, "r2Etag");
    assert(/^[A-Za-z0-9'"_-]{8,256}$/.test(r2Etag), "r2Etag is malformed.");
    assert(
      synced === headSeq,
      "Convex projection is not caught up to the DO head.",
    );
    return {
      conversationId,
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
    return {
      conversationId: nonEmptyString(
        observation.conversationId,
        "conversationId",
      ),
      turnId: nonEmptyString(observation.turnId, "turnId"),
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
      turnId: nonEmptyString(observation.turnId, "turnId"),
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
      turnId: nonEmptyString(observation.turnId, "turnId"),
      deviceClaimId: nonEmptyString(observation.deviceClaimId, "deviceClaimId"),
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
      turnId: nonEmptyString(observation.turnId, "turnId"),
      chosenLocation: "cloud",
      realSandboxStarted: booleanTrue(
        observation.realSandboxStarted,
        "realSandboxStarted",
      ),
      localRuntimeStarted: false,
      fenceVerified: booleanTrue(observation.fenceVerified, "fenceVerified"),
    };
  },
  browser_cloud_routing(observation) {
    assert(
      observation.chosenLocation === "cloud",
      "Browser-only route must choose cloud.",
    );
    assert(
      observation.localRuntimeStarted === false,
      "Browser-only route silently ran locally.",
    );
    return {
      turnId: nonEmptyString(observation.turnId, "turnId"),
      chosenLocation: "cloud",
      realSandboxStarted: booleanTrue(
        observation.realSandboxStarted,
        "realSandboxStarted",
      ),
      localRuntimeStarted: false,
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

const inside = (candidate, root) =>
  candidate === root || candidate.startsWith(`${root}${path.sep}`);

const assertEvidenceCoherence = (steps, isolatedRoots) => {
  const byId = new Map(steps.map((step) => [step.id, step.evidence]));
  const stream = byId.get("electron_real_stream");
  const reconnect = byId.get("electron_restart_reconnect");
  const clean = byId.get("clean_client_hydration");
  const cache = byId.get("cache_loss_recovery");
  const projection = byId.get("projection_and_r2");
  assert(
    stream && reconnect && clean && cache && projection,
    "Primary cloud-canonical evidence is incomplete.",
  );
  for (const [stepId, observation] of [
    ["electron_restart_reconnect", reconnect],
    ["clean_client_hydration", clean],
    ["cache_loss_recovery", cache],
    ["projection_and_r2", projection],
  ]) {
    assert(
      observation.conversationId === stream.conversationId,
      `${stepId} did not prove the primary Electron conversation.`,
    );
  }
  assert(
    reconnect.historySha256 === clean.historySha256 &&
      reconnect.historySha256 === cache.historySha256,
    "Reconnect, clean-client, and cache-loss histories do not match.",
  );
  assert(
    projection.journalHeadSeq >= stream.journalHeadSeq,
    "Projection evidence predates the real streamed turn.",
  );
  assert(
    clean.profileA === stream.profileDir,
    "Clean-client profile A is not the Electron streaming profile.",
  );
  for (const [label, observedPath] of [
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
    "\nEach command receives STELLA_CLOUD_ACCEPTANCE_RUN_ID, STELLA_CLOUD_ACCEPTANCE_STEP, and STELLA_CLOUD_ACCEPTANCE_EVIDENCE_FILE and must write version-1 JSON evidence.",
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

const validateCommand = (step, allowedRoots) => {
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
  const runtime = path.basename(command[0]);
  assert(
    runtime === "node" || runtime === "bun",
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
    allowedRoots.some((root) => inside(driverFile, root)),
    `${step.id}.driverFile is outside the integration worktree and declared isolated roots.`,
    { driverFile },
  );
  command[1] = driverFile;
  const declaredCwd = path.resolve(nonEmptyString(step.cwd, `${step.id}.cwd`));
  assert(path.isAbsolute(step.cwd), `${step.id}.cwd must be absolute.`);
  const cwd = existingDirectory(declaredCwd, `${step.id}.cwd`);
  assert(
    allowedRoots.some((root) => inside(cwd, root)),
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
    allowedRoots.some((root) => inside(output, root)),
    `${step.id}.evidenceFile is outside the allowed roots.`,
    { output },
  );
  assert(output.endsWith(".json"), `${step.id}.evidenceFile must be JSON.`);
  const timeoutMs = step.timeoutMs ?? 300_000;
  assert(
    Number.isSafeInteger(timeoutMs) &&
      timeoutMs >= 5_000 &&
      timeoutMs <= 1_800_000,
    `${step.id}.timeoutMs must be 5 seconds to 30 minutes.`,
  );
  return {
    id: step.id,
    command,
    driverFile,
    driverSha256: sha256(driverBytes),
    cwd,
    evidenceFile: output,
    timeoutMs,
  };
};

const validateManifest = (manifest) => {
  assert(manifest?.version === 1, "Acceptance manifest version must be 1.");
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
    isolatedRoots.every((root) => !inside(REPO_ROOT, root)),
    "A disposable harness root must not be the integration worktree or one of its ancestors.",
  );
  const allowedRoots = [REPO_ROOT, ...isolatedRoots];
  const declaredOutput = nonEmptyString(manifest.output, "manifest.output");
  assert(path.isAbsolute(declaredOutput), "manifest.output must be absolute.");
  const output = futureFile(declaredOutput, "manifest.output");
  assert(
    allowedRoots.some((root) => inside(output, root)),
    "manifest.output is outside allowed roots.",
  );
  assert(output.endsWith(".json"), "manifest.output must be a JSON file.");
  assert(Array.isArray(manifest.steps), "manifest.steps must be an array.");
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
    byId.set(rawStep.id, validateCommand(rawStep, allowedRoots));
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

const runCommand = async (step, runId, target) => {
  const currentDriver = await readFile(step.driverFile);
  assert(
    sha256(currentDriver) === step.driverSha256,
    `${step.id}.driverFile changed after manifest validation.`,
  );
  await assertFreshFile(step.evidenceFile, `${step.id} evidence file`);

  const env = {
    ...process.env,
    CONVEX_DEPLOYMENT: target.deployment,
    CONVEX_URL: target.convexUrl,
    CONVEX_SITE_URL: target.convexSiteUrl,
    VITE_CONVEX_URL: target.convexUrl,
    VITE_CONVEX_SITE_URL: target.convexSiteUrl,
    CLOUD_BUILDER_URL: target.cloudBuilderUrl,
    STELLA_CLOUD_ACCEPTANCE_RUN_ID: runId,
    STELLA_CLOUD_ACCEPTANCE_STEP: step.id,
    STELLA_CLOUD_ACCEPTANCE_EVIDENCE_FILE: step.evidenceFile,
  };
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
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  let bytes = 0;
  let outputOverflow = false;
  let forceKillTimer;
  const terminate = () => {
    child.kill("SIGTERM");
    if (!forceKillTimer) {
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
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
    if (forceKillTimer) clearTimeout(forceKillTimer);
  });
  const stdoutBytes = Buffer.concat(stdout);
  const stderrBytes = Buffer.concat(stderr);
  assert(!outputOverflow, `${step.id} exceeded the command-output limit.`);
  assert(!timedOut, `${step.id} timed out after ${step.timeoutMs}ms.`, {
    signal: result.signal,
  });
  assert(result.code === 0, `${step.id} command failed.`, {
    code: result.code,
    signal: result.signal,
    stdoutSha256: sha256(stdoutBytes),
    stderrSha256: sha256(stderrBytes),
  });
  const payload = await readJson(step.evidenceFile, `${step.id} evidence`);
  const observation = commonEvidence(step.id, payload, runId);
  const summary = validators[step.id](observation);
  return {
    id: step.id,
    passed: true,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    commandExecutable: path.basename(step.command[0]),
    driverFile: step.driverFile,
    driverSha256: step.driverSha256,
    cwd: step.cwd,
    stdoutBytes: stdoutBytes.length,
    stderrBytes: stderrBytes.length,
    stdoutSha256: sha256(stdoutBytes),
    stderrSha256: sha256(stderrBytes),
    evidence: summary,
  };
};

const [mode, manifestArgument, ...extra] = process.argv.slice(2);
if (mode === "--list" && !manifestArgument && extra.length === 0) {
  printChecklist();
  process.exit(0);
}
if (
  !["--check", "--run"].includes(mode) ||
  !manifestArgument ||
  extra.length > 0
) {
  throw new CloudProofError(
    "Use --list, --check /absolute/manifest.json, or --run /absolute/manifest.json.",
  );
}
assert(path.isAbsolute(manifestArgument), "Manifest path must be absolute.");
const manifest = await readJson(manifestArgument, "acceptance manifest");
const validated = validateManifest(manifest);
if (mode === "--check") {
  console.log(
    `Acceptance manifest is structurally valid for ${validated.target.deployment}.`,
  );
  process.exit(0);
}
assertSafeAcceptanceEnvironment(manifest, process.env);
await Promise.all([
  assertFreshFile(validated.output, "Acceptance report"),
  ...validated.steps.map((step) =>
    assertFreshFile(step.evidenceFile, `${step.id} evidence file`),
  ),
]);

const runId = randomUUID();
const report = {
  version: 1,
  kind: "cloud-canonical-real-product-acceptance",
  runId,
  startedAt: new Date().toISOString(),
  target: validated.target,
  repoRoot: REPO_ROOT,
  isolatedRoots: validated.isolatedRoots,
  steps: [],
};
let failure = null;
const cleanupStep = validated.steps.find((step) => step.id === "cleanup");

try {
  for (const step of validated.steps) {
    if (step.id === "cleanup") continue;
    report.steps.push(await runCommand(step, runId, validated.target));
  }
  assertEvidenceCoherence(report.steps, validated.isolatedRoots);
} catch (error) {
  failure = error;
  report.failure = sanitizeEvidence({
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    details: error instanceof CloudProofError ? error.details : undefined,
  });
} finally {
  try {
    report.steps.push(await runCommand(cleanupStep, runId, validated.target));
  } catch (error) {
    report.cleanupFailure = sanitizeEvidence({
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      details: error instanceof CloudProofError ? error.details : undefined,
    });
    if (!failure) failure = error;
  }
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
