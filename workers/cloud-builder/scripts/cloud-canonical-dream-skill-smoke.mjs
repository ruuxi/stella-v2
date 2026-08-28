#!/usr/bin/env node

/**
 * One integrated real-product proof: a Stella-managed cloud turn discovers
 * and reads a versioned cloud skill, then that exact completed turn flows
 * through automatic Dream into cloud-authoritative memory.
 *
 * The runner reuses the disposable account/profile established by the focused
 * core smoke. It launches one isolated Electron client, writes hash-only
 * evidence, restores the prior Memory preference, revokes/disables the proof
 * skill, and stops every process it owns.
 */

import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CORE_PRODUCT_SMOKE_DRIVER_PRIMITIVES as core,
  DREAM_SKILL_SMOKE_DRIVER_PRIMITIVES as focused,
} from "./cloud-canonical-real-product-driver.mjs";
import {
  CloudProofError,
  REQUIRED_CLOUD_BUILDER_ORIGIN,
  REQUIRED_CONVEX,
  REQUIRED_REAL_PRODUCT_CONFIRMATION,
  assert,
  sha256,
} from "./cloud-proof-lib.mjs";
import {
  resolveCoreSmokeRoot,
  validateCoreSmokeReport,
} from "./cloud-canonical-core-product-smoke.mjs";

const SCRIPT_FILE = realpathSync(fileURLToPath(import.meta.url));
const CONTRACT = "stella-cloud-dream-skill-smoke-v1";
const STATE_FILE = "dream-skill-smoke-state.json";
const REPORT_FILE = "dream-skill-smoke-report.json";
const LOCK_FILE = "dream-skill-smoke.lock";
const CORE_STATE_FILE = "core-product-smoke-state.json";
const CORE_REPORT_FILE = "core-product-smoke-report.json";
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_ATTEMPTS = 2;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PHASES = new Set(["prepared", "turn-complete", "complete"]);
const STELLA_EXECUTION = Object.freeze({
  engine: "stella",
  provider: "stella",
  model: "stella/default",
  reasoningEffort: "default",
});

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

const target = Object.freeze({
  deployment: REQUIRED_CONVEX.deployment,
  convexUrl: REQUIRED_CONVEX.cloudUrl,
  convexSiteUrl: REQUIRED_CONVEX.siteUrl,
  cloudBuilderUrl: REQUIRED_CLOUD_BUILDER_ORIGIN,
});
const targetSha256 = sha256(canonicalJson(target));

const requireRecord = (value, label) => {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object.`,
  );
  return value;
};

const requireString = (value, label, maxLength = 16_384) => {
  assert(
    typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= maxLength,
    `${label} must be a bounded non-empty string.`,
  );
  return value;
};

const requireInteger = (value, label, minimum = 0) => {
  assert(
    Number.isSafeInteger(value) && value >= minimum,
    `${label} must be an integer of at least ${minimum}.`,
  );
  return value;
};

const requireSha256 = (value, label) => {
  assert(SHA256_PATTERN.test(value ?? ""), `${label} must be SHA-256.`);
  return value;
};

const readBoundedJson = async (file, label) => {
  const metadata = statSync(file);
  assert(
    metadata.isFile() && metadata.size > 0 && metadata.size <= MAX_JSON_BYTES,
    `${label} is not a bounded regular file.`,
  );
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new CloudProofError(`${label} is not valid JSON.`);
  }
};

const writePrivateJson = async (file, value) => {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, file);
};

const pathsFor = async (root) => {
  const stateDirectory = path.join(root, "state");
  const profileDirectory = path.join(root, "profile");
  const processLogDirectory = path.join(stateDirectory, "process-logs");
  const evidenceDirectory = path.join(root, "evidence");
  for (const directory of [
    stateDirectory,
    profileDirectory,
    processLogDirectory,
    evidenceDirectory,
  ]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  return Object.freeze({
    root,
    stateDirectory,
    profileDirectory,
    processLogDirectory,
    evidenceDirectory,
    coreStateFile: path.join(stateDirectory, CORE_STATE_FILE),
    coreReportFile: path.join(evidenceDirectory, CORE_REPORT_FILE),
    stateFile: path.join(stateDirectory, STATE_FILE),
    reportFile: path.join(evidenceDirectory, REPORT_FILE),
    lockFile: path.join(stateDirectory, LOCK_FILE),
  });
};

const acquireLock = async (file) => {
  let handle;
  try {
    handle = await open(file, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n`, "utf8");
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw new CloudProofError(
      `Focused Dream+skill proof is already locked: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return async () => {
    await handle.close();
    await unlink(file).catch(() => undefined);
  };
};

const stateBody = (state) =>
  Object.fromEntries(
    Object.entries(state).filter(([key]) => key !== "stateSha256"),
  );

const sealState = (body) => ({
  ...body,
  stateSha256: sha256(canonicalJson(body)),
});

const checkpointState = async (paths, state, patch) => {
  const next = sealState({ ...stateBody(state), ...patch });
  await writePrivateJson(paths.stateFile, next);
  return next;
};

const promptForAttempt = (proofRunId, attemptId) => {
  const capability = sha256(proofRunId).slice(0, 16);
  const nonce = sha256(attemptId).slice(0, 12);
  return [
    `Use only the authorized cloud skill tools for capability ${capability}.`,
    "First call skill_search with that capability.",
    "From its result, take the exact skill id and call skill_read for SKILL.md, then call skill_read for references/marker.txt.",
    `Reply with only the marker file content. Proof nonce: ${nonce}.`,
  ].join(" ");
};

const validateAttempt = (attempt, proofRunId) => {
  assert(
    UUID_PATTERN.test(attempt?.attemptId ?? "") &&
      ["pending", "failed", "completed"].includes(attempt.status) &&
      attempt.promptSha256 ===
        sha256(promptForAttempt(proofRunId, attempt.attemptId)),
    "Dream+skill attempt is invalid.",
  );
  if (attempt.status === "completed") {
    assert(
      SHA256_PATTERN.test(attempt.turnIdSha256 ?? "") &&
        attempt.evidence?.passed === true,
      "Completed Dream+skill attempt omitted its evidence.",
    );
  }
};

const loadCoreCheckpoint = async (paths) => {
  const state = await readBoundedJson(paths.coreStateFile, "Core smoke state");
  const { stateSha256, ...body } = state;
  assert(
    stateSha256 === sha256(canonicalJson(body)) &&
      state.version === 2 &&
      state.contract === "stella-cloud-canonical-core-product-smoke-v2" &&
      state.root === paths.root &&
      state.targetSha256 === targetSha256 &&
      state.phase === "complete" &&
      UUID_PATTERN.test(state.runId ?? "") &&
      UUID_PATTERN.test(state.conversationId ?? ""),
    "Core smoke checkpoint failed its integrity or isolated-target fence.",
  );
  const report = validateCoreSmokeReport(
    await readBoundedJson(paths.coreReportFile, "Core smoke report"),
  );
  assert(
    report.targetSha256 === state.targetSha256 &&
      report.runIdSha256 === sha256(state.runId) &&
      report.conversationIdSha256 === sha256(state.conversationId),
    "Core smoke report does not bind this exact checkpoint.",
  );
  return { state, report };
};

const loadProofState = async (paths, coreState) => {
  try {
    const state = await readBoundedJson(
      paths.stateFile,
      "Dream+skill smoke state",
    );
    const { stateSha256, ...body } = state;
    assert(
      stateSha256 === sha256(canonicalJson(body)) &&
        state.version === 1 &&
        state.contract === CONTRACT &&
        state.root === paths.root &&
        state.targetSha256 === targetSha256 &&
        state.coreRunIdSha256 === sha256(coreState.runId) &&
        state.conversationIdSha256 === sha256(coreState.conversationId) &&
        PHASES.has(state.phase) &&
        UUID_PATTERN.test(state.proofRunId ?? "") &&
        Array.isArray(state.attempts) &&
        state.attempts.length >= 1 &&
        state.attempts.length <= MAX_ATTEMPTS,
      "Dream+skill smoke state failed its integrity or core-proof fence.",
    );
    const ids = new Set();
    for (const attempt of state.attempts) {
      validateAttempt(attempt, state.proofRunId);
      assert(!ids.has(attempt.attemptId), "Dream+skill attempt is duplicated.");
      ids.add(attempt.attemptId);
    }
    assert(
      state.phase === "prepared" ||
        (state.attempts.at(-1)?.status === "completed" &&
          state.evidence?.passed === true),
      "Dream+skill state phase is not backed by completed evidence.",
    );
    return state;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const proofRunId = randomUUID();
  const attemptId = randomUUID();
  const state = sealState({
    version: 1,
    contract: CONTRACT,
    root: paths.root,
    targetSha256,
    coreRunIdSha256: sha256(coreState.runId),
    conversationIdSha256: sha256(coreState.conversationId),
    proofRunId,
    phase: "prepared",
    attempts: [
      {
        attemptId,
        status: "pending",
        promptSha256: sha256(promptForAttempt(proofRunId, attemptId)),
      },
    ],
    createdAt: new Date().toISOString(),
  });
  await writePrivateJson(paths.stateFile, state);
  return state;
};

const loadExistingReport = async (paths, state) => {
  try {
    const report = await readBoundedJson(
      paths.reportFile,
      "Dream+skill smoke report",
    );
    validateReport(report);
    assert(
      state.phase === "complete" &&
        report.proofRunIdSha256 === sha256(state.proofRunId),
      "Existing Dream+skill report is not bound to the completed state.",
    );
    return report;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};

const requireEnvironment = () => {
  assert(
    process.env.STELLA_CLOUD_ACCEPTANCE_CONFIRM ===
      REQUIRED_REAL_PRODUCT_CONFIRMATION,
    `STELLA_CLOUD_ACCEPTANCE_CONFIRM must be ${REQUIRED_REAL_PRODUCT_CONFIRMATION}.`,
  );
  assert(
    process.env.STELLA_CLOUD_PROOF_IDENTITY_KIND === "disposable",
    "STELLA_CLOUD_PROOF_IDENTITY_KIND must be disposable.",
  );
  for (const [key, expected] of Object.entries({
    CONVEX_DEPLOYMENT: REQUIRED_CONVEX.deployment,
    CONVEX_URL: REQUIRED_CONVEX.cloudUrl,
    CONVEX_SITE_URL: REQUIRED_CONVEX.siteUrl,
    CLOUD_BUILDER_URL: REQUIRED_CLOUD_BUILDER_ORIGIN,
  })) {
    const actual = process.env[key]?.trim();
    if (actual) assert(actual === expected, `${key} names another target.`);
  }
};

const terminalPhase = (journal, turnId) => {
  const rows = focused.recordsForTurn(journal, turnId);
  const terminal = rows.filter(
    (row) =>
      row?.kind === "turn" &&
      ["completed", "failed", "canceled", "timeout"].includes(row.phase),
  );
  assert(
    terminal.length === 1,
    "Representative Stella turn has no unique terminal.",
  );
  return terminal[0].phase;
};

const toolNamesForRows = (rows) =>
  rows.flatMap((row) =>
    row?.kind === "message" &&
    row.role === "assistant" &&
    Array.isArray(row.payload?.content)
      ? row.payload.content
          .filter(
            (block) =>
              block &&
              typeof block === "object" &&
              (block.type === "toolCall" || block.type === "tool_call") &&
              typeof block.name === "string",
          )
          .map((block) => block.name)
      : [],
  );

const messageText = (payload) =>
  Array.isArray(payload?.content)
    ? payload.content
        .filter(
          (block) => block?.type === "text" && typeof block.text === "string",
        )
        .map((block) => block.text)
        .join("\n")
    : "";

const readPublicSkills = async (context, secrets, state, rawLog, suffix) => {
  const value = await core.convexCall(
    context,
    secrets,
    "query",
    "cloud_skills:listMySkills",
    { clientScope: `focused:${state.proofRunId}:${suffix}` },
    `read focused cloud skill ${suffix}`,
    rawLog,
  );
  assert(Array.isArray(value), "Focused cloud skill list is invalid.");
  return value;
};

const prepareSkillAndMemory = async ({
  context,
  secrets,
  owner,
  state,
  rawLog,
}) => {
  let preference = requireRecord(
    await core.convexCall(
      context,
      secrets,
      "query",
      "cloud_memory:getMyMemoryPreference",
      { expectedSubject: owner.ownerId },
      "read focused Memory preference",
      rawLog,
    ),
    "Focused Memory preference",
  );
  const priorMemoryEnabled =
    state.setup?.priorMemoryEnabled ?? preference.memoryEnabled;
  assert(
    typeof priorMemoryEnabled === "boolean",
    "Prior Memory preference is invalid.",
  );
  if (preference.memoryEnabled !== true) {
    preference = requireRecord(
      await core.convexCall(
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
          requestId: `focused-memory-enable:${state.proofRunId}`.slice(0, 128),
        },
        "enable focused automatic Dream",
        rawLog,
      ),
      "Enabled focused Memory preference",
    );
  }
  assert(preference.memoryEnabled === true, "Focused Memory did not enable.");

  const capability = sha256(state.proofRunId).slice(0, 16);
  const slug = `focused-${capability}`;
  const assetPath = "references/marker.txt";
  const assetText = `CLOUD-SKILL-ASSET-${state.proofRunId}`;
  const skillMarkdown = [
    "---",
    `name: Focused Cloud Skill ${capability}`,
    `description: Find and read the focused marker ${capability}`,
    "---",
    "",
    `# Focused Cloud Skill ${capability}`,
    "",
    `Read ${assetPath} and return its marker verbatim.`,
    "",
  ].join("\n");
  const upload = requireRecord(
    (
      await focused.cloudHomeUserRequest(
        context,
        secrets,
        "/cloud-home/skills/upload",
        {
          method: "POST",
          body: JSON.stringify({
            slug,
            name: `Focused Cloud Skill ${capability}`,
            description: `Find and read the focused marker ${capability}`,
            source: "cloud_created",
            availability: "both",
            expectedRevision: 0,
            idempotencyKey: `focused-skill-upload:${state.proofRunId}`.slice(
              0,
              128,
            ),
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
        "cloud-home.focused-skill.upload",
        rawLog,
      )
    ).body,
    "Focused cloud skill upload receipt",
  );
  assert(upload.status === "committed", "Focused cloud skill did not commit.");
  if (state.setup?.skillId) {
    assert(
      upload.skillId === state.setup.skillId &&
        upload.versionId === state.setup.versionId,
      "Focused cloud skill idempotency changed package identity.",
    );
  }

  let publicSkills = await readPublicSkills(
    context,
    secrets,
    state,
    rawLog,
    "prepare",
  );
  let publicSkill = requireRecord(
    publicSkills.find(
      (skill) =>
        skill?.skillId === upload.skillId &&
        skill?.versionId === upload.versionId,
    ),
    "Focused public cloud skill",
  );
  if (publicSkill.enabled !== true) {
    await core.convexCall(
      context,
      secrets,
      "mutation",
      "cloud_skills:setMySkillEnabled",
      {
        skillId: upload.skillId,
        enabled: true,
        expectedOwnerGeneration: owner.ownerGeneration,
        expectedRevision: publicSkill.revision,
      },
      "enable focused cloud skill",
      rawLog,
    );
    publicSkills = await readPublicSkills(
      context,
      secrets,
      state,
      rawLog,
      "enabled",
    );
    publicSkill = requireRecord(
      publicSkills.find((skill) => skill?.skillId === upload.skillId),
      "Enabled focused public cloud skill",
    );
  }
  const exactAuthorization =
    publicSkill.authorizationState === "active" &&
    publicSkill.authorizationVersionId === upload.versionId &&
    Array.isArray(publicSkill.allowedAgentTypes) &&
    publicSkill.allowedAgentTypes.includes("orchestrator") &&
    Array.isArray(publicSkill.allowedToolNames) &&
    ["skill_read", "skill_search"].every((name) =>
      publicSkill.allowedToolNames.includes(name),
    );
  if (!exactAuthorization) {
    await core.convexCall(
      context,
      secrets,
      "mutation",
      "cloud_skills:authorizeMySkill",
      {
        skillId: upload.skillId,
        versionId: upload.versionId,
        expectedOwnerGeneration: owner.ownerGeneration,
        expectedAuthorizationRevision: publicSkill.authorizationRevision ?? 0,
        allowedAgentTypes: ["orchestrator", "general"],
        allowedToolNames: ["skill_read", "skill_search"],
      },
      "authorize focused cloud skill",
      rawLog,
    );
    publicSkills = await readPublicSkills(
      context,
      secrets,
      state,
      rawLog,
      "authorized",
    );
    publicSkill = requireRecord(
      publicSkills.find((skill) => skill?.skillId === upload.skillId),
      "Authorized focused public cloud skill",
    );
  }
  assert(
    publicSkill.enabled === true &&
      publicSkill.authorizationState === "active" &&
      publicSkill.authorizationVersionId === upload.versionId &&
      publicSkill.allowedAgentTypes.includes("orchestrator") &&
      ["skill_read", "skill_search"].every((name) =>
        publicSkill.allowedToolNames.includes(name),
      ),
    "Focused cloud skill is not enabled and authorized for Stella.",
  );

  const privateCatalog = await focused.cloudHomeControlRequest(
    context,
    secrets,
    owner,
    "/api/cloud/home/skills/catalog",
    { agentType: "orchestrator", includeFiles: true },
    "cloud-home.focused-skill.catalog",
    rawLog,
  );
  assert(
    Array.isArray(privateCatalog),
    "Focused private skill catalog is invalid.",
  );
  const skill = requireRecord(
    privateCatalog.find(
      (entry) =>
        entry?.skillId === upload.skillId &&
        entry?.versionId === upload.versionId,
    ),
    "Focused private cloud skill",
  );
  const asset = requireRecord(
    skill.files?.find((file) => file?.path === assetPath),
    "Focused cloud skill asset",
  );
  assert(
    asset.sha256 === sha256(`${assetText}\n`) &&
      skill.files.some((file) => file?.path === "SKILL.md"),
    "Focused cloud skill package bytes are not the uploaded version.",
  );
  return Object.freeze({
    priorMemoryEnabled,
    skillId: skill.skillId,
    versionId: skill.versionId,
    assetPath,
    assetText,
    setupEvidence: Object.freeze({
      skillIdSha256: sha256(skill.skillId),
      skillVersionIdSha256: sha256(skill.versionId),
      skillRevision: requireInteger(
        skill.revision,
        "Focused skill revision",
        1,
      ),
      manifestSha256: requireSha256(
        skill.manifestSha256,
        "Focused skill manifest hash",
      ),
      assetPathSha256: sha256(assetPath),
      assetSha256: asset.sha256,
      manifestR2KeySha256: sha256(skill.manifestR2Key),
      assetR2KeySha256: sha256(asset.r2Key),
      catalogSha256: sha256(canonicalJson(privateCatalog)),
    }),
  });
};

const validateSkillTurn = ({
  journal,
  turnId,
  skillId,
  versionId,
  assetPath,
  assetText,
}) => {
  const rows = focused.recordsForTurn(journal, turnId);
  const toolNames = toolNamesForRows(rows);
  if (terminalPhase(journal, turnId) !== "completed") {
    return { passed: false, toolNames };
  }
  let codeEvidence;
  try {
    codeEvidence = focused.matchedToolReceipts(rows, "code");
  } catch {
    return { passed: false, toolNames };
  }
  const searchReceipt = codeEvidence[0];
  const skillFileReceipt = codeEvidence[1];
  const assetReceipt = codeEvidence[2];
  const searchCall = canonicalJson(searchReceipt?.block?.arguments) ?? "";
  const skillFileCall = canonicalJson(skillFileReceipt?.block?.arguments) ?? "";
  const assetCall = canonicalJson(assetReceipt?.block?.arguments) ?? "";
  const searchResult = canonicalJson(searchReceipt?.result?.payload) ?? "";
  const skillFileResult =
    canonicalJson(skillFileReceipt?.result?.payload) ?? "";
  const assetResult = canonicalJson(assetReceipt?.result?.payload) ?? "";
  const assistantText = focused.assistantTextForTurn(journal, turnId);
  const passed =
    codeEvidence.length === 3 &&
    toolNames.length === 3 &&
    toolNames.every((name) => name === "code") &&
    searchCall.includes("skill_search") &&
    searchResult.includes(skillId) &&
    searchResult.includes(versionId) &&
    skillFileCall.includes("skill_read") &&
    skillFileCall.includes(skillId) &&
    skillFileCall.includes("SKILL.md") &&
    skillFileResult.includes(assetPath) &&
    assetCall.includes("skill_read") &&
    assetCall.includes(skillId) &&
    assetCall.includes(assetPath) &&
    skillFileReceipt?.toolCallId !== assetReceipt?.toolCallId &&
    searchReceipt?.toolCallId !== skillFileReceipt?.toolCallId &&
    assetResult.includes(assetText) &&
    assistantText.trim() === assetText;
  return {
    passed,
    toolNames,
    ...(passed
      ? {
          evidence: Object.freeze({
            passed: true,
            provider: "stella",
            executionSha256: sha256(canonicalJson(STELLA_EXECUTION)),
            turnIdSha256: sha256(turnId),
            codeReceiptSha256: sha256(canonicalJson(codeEvidence)),
            skillSearchCallSha256: sha256(searchCall),
            skillSearchResultSha256: sha256(searchResult),
            manifestReadCallSha256: sha256(skillFileCall),
            manifestReadResultSha256: sha256(skillFileResult),
            assetReadCallSha256: sha256(assetCall),
            assetReadResultSha256: sha256(assetResult),
            assistantResultSha256: sha256(assistantText),
            discoveredByCloudAgent: true,
            loadedByWorker: true,
            assetReadByWorker: true,
            usedByCloudAgent: true,
            macFilesystemReadCount: 0,
          }),
        }
      : {}),
  };
};

const findAutomaticDreamOutput = ({ exported, sourceKey, assetText }) => {
  const encodedSource = encodeURIComponent(sourceKey);
  const matches = exported.documents.filter((document) => {
    const content = String(document?.content ?? "");
    return (
      content.includes(`source=${encodedSource} -->`) &&
      content.includes(assetText)
    );
  });
  if (matches.length !== 1) return null;
  const memoryMap = exported.documents.find(
    (document) => document?.name === "memories/memory_map.md",
  );
  if (!String(memoryMap?.content ?? "").includes(sourceKey)) return null;
  return { document: matches[0], memoryMap };
};

const waitForAutomaticDream = async ({
  context,
  secrets,
  conversationId,
  turnId,
  assetText,
  rawLog,
}) => {
  const sourceKey = `conversation:${conversationId}:turn:${turnId}`;
  const deadline = Date.now() + 180_000;
  let latestStatus = null;
  while (Date.now() < deadline) {
    latestStatus = requireRecord(
      await core.convexCall(
        context,
        secrets,
        "query",
        "cloud_dream:getMyDreamStatus",
        {},
        "read focused automatic Dream status",
        rawLog,
      ),
      "Focused automatic Dream status",
    );
    if (
      latestStatus.lastAutomaticStatus === "abandoned" &&
      latestStatus.automaticPending === false
    ) {
      throw new CloudProofError("Focused automatic Dream was abandoned.", {
        attemptCount: latestStatus.lastAutomaticAttemptCount ?? null,
        errorCodeSha256: sha256(
          String(latestStatus.lastAutomaticErrorCode ?? "none"),
        ),
      });
    }
    if (latestStatus.lastAutomaticStatus === "completed") {
      const exported = await focused.loadCloudHomeExport(
        context,
        secrets,
        rawLog,
      );
      const output = findAutomaticDreamOutput({
        exported,
        sourceKey,
        assetText,
      });
      if (output) {
        return Object.freeze({
          passed: true,
          automaticDreamCompleted: true,
          sourceTurnSha256: sha256(turnId),
          sourceKeySha256: sha256(sourceKey),
          sourceMarkerObserved: true,
          skillMarkerObserved: true,
          memoryEpochSha256: sha256(exported.memoryEpoch),
          outputDocumentNameSha256: sha256(output.document.name),
          outputDocumentVersionSha256: sha256(output.document.versionId),
          outputDocumentContentSha256: sha256(String(output.document.content)),
          memoryMapVersionSha256: sha256(output.memoryMap.versionId),
          memoryMapContentSha256: sha256(String(output.memoryMap.content)),
          automaticAttemptCount: requireInteger(
            latestStatus.lastAutomaticAttemptCount ?? 0,
            "Automatic Dream attempt count",
          ),
        });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new CloudProofError(
    "Focused automatic Dream did not publish the exact completed skill turn.",
    {
      automaticPending: latestStatus?.automaticPending ?? null,
      lastAutomaticStatus: latestStatus?.lastAutomaticStatus ?? null,
      lastAutomaticAttemptCount:
        latestStatus?.lastAutomaticAttemptCount ?? null,
    },
  );
};

const runIntegratedAttempt = async ({
  context,
  secrets,
  owner,
  electron,
  conversationId,
  state,
  setup,
  attempt,
  rawLog,
}) => {
  const prompt = promptForAttempt(state.proofRunId, attempt.attemptId);
  assert(
    sha256(prompt) === attempt.promptSha256 &&
      !prompt.includes(setup.assetText),
    "Focused skill prompt leaked the unknown asset marker.",
  );
  const turn = await focused.electronCloudTurn(
    context,
    electron,
    { ownerGeneration: owner.ownerGeneration },
    conversationId,
    {
      prompt,
      clientMsgId: `focused-skill-dream:${attempt.attemptId}`,
      execution: STELLA_EXECUTION,
    },
    rawLog,
  );
  const journal = await focused.waitForTurnTerminal(
    context,
    secrets,
    conversationId,
    turn.turnId,
    rawLog,
  );
  const skill = validateSkillTurn({
    journal,
    turnId: turn.turnId,
    skillId: setup.skillId,
    versionId: setup.versionId,
    assetPath: setup.assetPath,
    assetText: setup.assetText,
  });
  if (!skill.passed) {
    return Object.freeze({
      passed: false,
      turnIdSha256: sha256(turn.turnId),
      terminalPhase: terminalPhase(journal, turn.turnId),
      toolNamesSha256: sha256(canonicalJson(skill.toolNames)),
    });
  }
  const dream = await waitForAutomaticDream({
    context,
    secrets,
    conversationId,
    turnId: turn.turnId,
    assetText: setup.assetText,
    rawLog,
  });
  return Object.freeze({
    passed: true,
    turnIdSha256: sha256(turn.turnId),
    skill: Object.freeze({ ...setup.setupEvidence, ...skill.evidence }),
    dream,
  });
};

const recoverCompletedAttempt = async ({
  context,
  secrets,
  conversationId,
  attempts,
  setup,
  rawLog,
}) => {
  const journal = await focused.loadWholeJournal(
    context,
    secrets,
    conversationId,
    rawLog,
  );
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index];
    if (attempt.status !== "failed") continue;
    const matchingPrompts = journal.records.filter(
      (record) =>
        record?.kind === "message" &&
        record.role === "user" &&
        sha256(messageText(record.payload)) === attempt.promptSha256,
    );
    if (matchingPrompts.length !== 1) continue;
    const turnId = matchingPrompts[0].turnId;
    if (!UUID_PATTERN.test(turnId ?? "")) continue;
    const skill = validateSkillTurn({
      journal,
      turnId,
      skillId: setup.skillId,
      versionId: setup.versionId,
      assetPath: setup.assetPath,
      assetText: setup.assetText,
    });
    if (!skill.passed) continue;
    const dream = await waitForAutomaticDream({
      context,
      secrets,
      conversationId,
      turnId,
      assetText: setup.assetText,
      rawLog,
    });
    return Object.freeze({
      attemptId: attempt.attemptId,
      result: Object.freeze({
        passed: true,
        turnIdSha256: sha256(turnId),
        skill: Object.freeze({ ...setup.setupEvidence, ...skill.evidence }),
        dream,
      }),
    });
  }
  return null;
};

const cleanupProofState = async ({
  context,
  secrets,
  owner,
  state,
  rawLog,
}) => {
  const setup = requireRecord(state.setup, "Focused setup checkpoint");
  let skills = await readPublicSkills(
    context,
    secrets,
    state,
    rawLog,
    "cleanup-before",
  );
  let skill = requireRecord(
    skills.find((entry) => entry?.skillId === setup.skillId),
    "Focused cleanup skill",
  );
  if (skill.authorizationState === "active") {
    await core.convexCall(
      context,
      secrets,
      "mutation",
      "cloud_skills:revokeMySkill",
      {
        skillId: setup.skillId,
        expectedOwnerGeneration: owner.ownerGeneration,
        expectedAuthorizationRevision: requireInteger(
          skill.authorizationRevision,
          "Focused skill authorization revision",
          1,
        ),
      },
      "revoke focused cloud skill",
      rawLog,
    );
    skills = await readPublicSkills(
      context,
      secrets,
      state,
      rawLog,
      "cleanup-revoked",
    );
    skill = requireRecord(
      skills.find((entry) => entry?.skillId === setup.skillId),
      "Revoked focused cleanup skill",
    );
  }
  if (skill.enabled === true) {
    await core.convexCall(
      context,
      secrets,
      "mutation",
      "cloud_skills:setMySkillEnabled",
      {
        skillId: setup.skillId,
        enabled: false,
        expectedOwnerGeneration: owner.ownerGeneration,
        expectedRevision: requireInteger(
          skill.revision,
          "Focused skill cleanup revision",
          1,
        ),
      },
      "disable focused cloud skill",
      rawLog,
    );
    skills = await readPublicSkills(
      context,
      secrets,
      state,
      rawLog,
      "cleanup-disabled",
    );
    skill = requireRecord(
      skills.find((entry) => entry?.skillId === setup.skillId),
      "Disabled focused cleanup skill",
    );
  }
  assert(
    skill.enabled === false && skill.authorizationState !== "active",
    "Focused cloud skill cleanup did not revoke and disable the package.",
  );

  let preference = requireRecord(
    await core.convexCall(
      context,
      secrets,
      "query",
      "cloud_memory:getMyMemoryPreference",
      { expectedSubject: owner.ownerId },
      "read focused Memory cleanup preference",
      rawLog,
    ),
    "Focused Memory cleanup preference",
  );
  if (preference.memoryEnabled !== setup.priorMemoryEnabled) {
    preference = requireRecord(
      await core.convexCall(
        context,
        secrets,
        "mutation",
        "cloud_memory:setMyMemoryEnabled",
        {
          memoryEnabled: setup.priorMemoryEnabled,
          expectedSubject: owner.ownerId,
          expectedOwnerGeneration: owner.ownerGeneration,
          expectedRevision: requireInteger(
            preference.revision,
            "Focused Memory cleanup revision",
          ),
          requestId: `focused-memory-restore:${state.proofRunId}`.slice(0, 128),
        },
        "restore focused Memory preference",
        rawLog,
      ),
      "Restored focused Memory preference",
    );
  }
  assert(
    preference.memoryEnabled === setup.priorMemoryEnabled,
    "Focused Memory preference was not restored.",
  );
  return Object.freeze({
    passed: true,
    skillRevoked: true,
    skillDisabled: true,
    priorMemoryEnabled: setup.priorMemoryEnabled,
    memoryPreferenceRestored: true,
    finalMemoryRevision: requireInteger(
      preference.revision,
      "Final Memory preference revision",
    ),
  });
};

const validateReport = (report) => {
  assert(
    report?.version === 1 &&
      report.contract === CONTRACT &&
      report.passed === true &&
      report.provider === "stella" &&
      report.targetSha256 === targetSha256 &&
      report.scenario?.passed === true &&
      report.scenario.skill?.passed === true &&
      report.scenario.dream?.passed === true &&
      report.cleanup?.passed === true &&
      report.cleanup.skillRevoked === true &&
      report.cleanup.skillDisabled === true &&
      report.cleanup.memoryPreferenceRestored === true,
    "Dream+skill smoke report is incomplete.",
  );
  const visit = (value, key = "") => {
    if (key.endsWith("Sha256")) requireSha256(value, key);
    if (Array.isArray(value)) value.forEach((entry) => visit(entry));
    else if (value && typeof value === "object") {
      Object.entries(value).forEach(([childKey, child]) =>
        visit(child, childKey),
      );
    }
  };
  visit(report);
  return report;
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

const run = async ({ root }) => {
  requireEnvironment();
  const resolvedRoot = resolveCoreSmokeRoot(root);
  const paths = await pathsFor(resolvedRoot);
  const release = await acquireLock(paths.lockFile);
  const rawLog = [];
  let electron = null;
  let primaryError = null;
  let cleanupError = null;
  let reportInputs = null;
  let activeState = null;
  let cleanupContext = null;
  let cleanupSecrets = null;
  let cleanupOwner = null;
  try {
    const { state: coreState, report: coreReport } =
      await loadCoreCheckpoint(paths);
    let state = await loadProofState(paths, coreState);
    activeState = state;
    const saveState = async (patch) => {
      state = await checkpointState(paths, state, patch);
      activeState = state;
      return state;
    };
    const existingReport = await loadExistingReport(paths, state);
    if (existingReport) {
      return { reportFile: paths.reportFile, report: existingReport };
    }
    const context = Object.freeze({ runId: coreState.runId, target });
    cleanupContext = context;
    const baseSecrets = core.loadSecrets();
    electron = await core.relaunchElectron(
      context,
      baseSecrets,
      paths,
      { electron: coreState.primary },
      "primary",
      rawLog,
    );
    const completion = requireRecord(
      coreState.auth?.primaryCompletion,
      "Core primary auth completion",
    );
    // This proof exercises the cloud turn directly through Stella's renderer
    // modules. Reading authority must not gate it on the unrelated local-agent
    // worker health check performed when a conversation id is supplied.
    const authority = await core.readElectronSessionAuthority(
      context,
      baseSecrets,
      electron,
      null,
      rawLog,
      "focused Dream+skill",
      {
        expectedIdentitySha256: requireSha256(
          completion.identitySha256,
          "Core identity hash",
        ),
        expectedSessionIdSha256: requireSha256(
          completion.sessionIdSha256,
          "Core session hash",
        ),
        expectedOwnerAccountSha256: requireSha256(
          completion.ownerAccountSha256,
          "Core owner hash",
        ),
      },
    );
    const secrets = core.ephemeralJwtSecrets(
      baseSecrets,
      authority.token,
      "focused Dream+skill",
    );
    cleanupSecrets = secrets;
    const owner = requireRecord(
      await core.convexCall(
        context,
        secrets,
        "query",
        "execution_placement:getMyExecutionPlacementIdentity",
        {},
        "read focused Dream+skill owner",
        rawLog,
      ),
      "Focused Dream+skill owner",
    );
    cleanupOwner = owner;
    const conversation = requireRecord(
      await core.convexCall(
        context,
        secrets,
        "query",
        "cloud_apps:getMyConversation",
        { conversationId: coreState.conversationId },
        "read focused Dream+skill conversation",
        rawLog,
      ),
      "Focused Dream+skill conversation",
    );
    assert(
      owner.ownerId === authority.tokenIdentity.tokenIdentifier &&
        conversation.ownerId === owner.ownerId &&
        conversation.conversationId === coreState.conversationId &&
        typeof owner.ownerGeneration === "string",
      "Focused Dream+skill authority does not own the core conversation.",
    );

    if (state.phase === "prepared") {
      if (!state.setup) {
        const originalPreference = requireRecord(
          await core.convexCall(
            context,
            secrets,
            "query",
            "cloud_memory:getMyMemoryPreference",
            { expectedSubject: owner.ownerId },
            "checkpoint focused Memory preference",
            rawLog,
          ),
          "Original focused Memory preference",
        );
        assert(
          typeof originalPreference.memoryEnabled === "boolean",
          "Original focused Memory preference is invalid.",
        );
        await saveState({
          setup: {
            priorMemoryEnabled: originalPreference.memoryEnabled,
          },
        });
      }
      const setup = await prepareSkillAndMemory({
        context,
        secrets,
        owner,
        state,
        rawLog,
      });
      if (!state.setup?.skillId) {
        await saveState({
          setup: {
            priorMemoryEnabled: setup.priorMemoryEnabled,
            skillId: setup.skillId,
            versionId: setup.versionId,
            assetPath: setup.assetPath,
            setupEvidence: setup.setupEvidence,
          },
        });
      }
      let attempts = [...state.attempts];
      if (
        attempts.at(-1)?.status === "failed" &&
        attempts.length >= MAX_ATTEMPTS
      ) {
        const recovered = await recoverCompletedAttempt({
          context,
          secrets,
          conversationId: coreState.conversationId,
          attempts,
          setup,
          rawLog,
        });
        if (recovered) {
          attempts = attempts.map((attempt) => {
            if (attempt.attemptId !== recovered.attemptId) return attempt;
            const { failureEvidence: _failureEvidence, ...rest } = attempt;
            return {
              ...rest,
              status: "completed",
              turnIdSha256: recovered.result.turnIdSha256,
              evidence: recovered.result,
            };
          });
          await saveState({
            phase: "turn-complete",
            attempts,
            evidence: recovered.result,
          });
        }
      }
      while (state.phase === "prepared") {
        let active = attempts.at(-1);
        if (active.status === "failed") {
          assert(
            attempts.length < MAX_ATTEMPTS,
            "Focused Dream+skill proof exhausted its terminal attempt limit.",
          );
          const attemptId = randomUUID();
          active = {
            attemptId,
            status: "pending",
            promptSha256: sha256(promptForAttempt(state.proofRunId, attemptId)),
          };
          attempts.push(active);
          await saveState({ attempts });
        }
        const attemptResult = await runIntegratedAttempt({
          context,
          secrets,
          owner,
          electron,
          conversationId: coreState.conversationId,
          state,
          setup,
          attempt: active,
          rawLog,
        });
        if (!attemptResult.passed) {
          attempts = attempts.map((attempt) =>
            attempt.attemptId === active.attemptId
              ? {
                  ...attempt,
                  status: "failed",
                  failureEvidence: attemptResult,
                }
              : attempt,
          );
          await saveState({ attempts });
          if (attempts.length >= MAX_ATTEMPTS) {
            throw new CloudProofError(
              "Stella did not complete the exact representative cloud-skill tool path.",
              attemptResult,
            );
          }
          continue;
        }
        attempts = attempts.map((attempt) =>
          attempt.attemptId === active.attemptId
            ? {
                ...attempt,
                status: "completed",
                turnIdSha256: attemptResult.turnIdSha256,
                evidence: attemptResult,
              }
            : attempt,
        );
        await saveState({
          phase: "turn-complete",
          attempts,
          evidence: attemptResult,
        });
        break;
      }
    }

    if (state.phase === "turn-complete") {
      const cleanup = await cleanupProofState({
        context,
        secrets,
        owner,
        state,
        rawLog,
      });
      await saveState({
        phase: "complete",
        cleanup,
      });
    }
    assert(
      state.phase === "complete" &&
        state.evidence?.passed === true &&
        state.cleanup?.passed === true,
      "Focused Dream+skill state did not reach verified cleanup.",
    );
    reportInputs = {
      coreState,
      coreReport,
      state,
      authorityEvidence: {
        identitySha256: authority.identitySha256,
        sessionIdSha256: authority.sessionIdSha256,
        ownerAccountSha256: authority.ownerAccountSha256,
        ownerGenerationSha256: sha256(owner.ownerGeneration),
      },
      forbidden: [
        authority.token,
        authority.subject,
        authority.sessionId,
        owner.ownerId,
        coreState.conversationId,
        state.proofRunId,
        `CLOUD-SKILL-ASSET-${state.proofRunId}`,
        state.setup?.skillId,
        state.setup?.versionId,
      ],
    };
  } catch (error) {
    primaryError = error;
    const setup = activeState?.setup;
    if (
      cleanupContext &&
      cleanupSecrets &&
      cleanupOwner &&
      typeof setup?.priorMemoryEnabled === "boolean"
    ) {
      try {
        let failureCleanup;
        if (setup.skillId && setup.versionId) {
          failureCleanup = await cleanupProofState({
            context: cleanupContext,
            secrets: cleanupSecrets,
            owner: cleanupOwner,
            state: activeState,
            rawLog,
          });
        } else {
          let preference = requireRecord(
            await core.convexCall(
              cleanupContext,
              cleanupSecrets,
              "query",
              "cloud_memory:getMyMemoryPreference",
              { expectedSubject: cleanupOwner.ownerId },
              "read failed-proof Memory preference",
              rawLog,
            ),
            "Failed-proof Memory preference",
          );
          if (preference.memoryEnabled !== setup.priorMemoryEnabled) {
            preference = requireRecord(
              await core.convexCall(
                cleanupContext,
                cleanupSecrets,
                "mutation",
                "cloud_memory:setMyMemoryEnabled",
                {
                  memoryEnabled: setup.priorMemoryEnabled,
                  expectedSubject: cleanupOwner.ownerId,
                  expectedOwnerGeneration: cleanupOwner.ownerGeneration,
                  expectedRevision: requireInteger(
                    preference.revision,
                    "Failed-proof Memory cleanup revision",
                  ),
                  requestId:
                    `focused-memory-failure:${activeState.proofRunId}`.slice(
                      0,
                      128,
                    ),
                },
                "restore failed-proof Memory preference",
                rawLog,
              ),
              "Restored failed-proof Memory preference",
            );
          }
          assert(
            preference.memoryEnabled === setup.priorMemoryEnabled,
            "Failed-proof Memory preference was not restored.",
          );
          failureCleanup = Object.freeze({
            passed: true,
            memoryPreferenceRestored: true,
            priorMemoryEnabled: setup.priorMemoryEnabled,
            finalMemoryRevision: requireInteger(
              preference.revision,
              "Failed-proof final Memory revision",
            ),
          });
        }
        activeState = await checkpointState(paths, activeState, {
          failureCleanup,
        });
      } catch (failureCleanupError) {
        cleanupError ??= failureCleanupError;
      }
    }
  } finally {
    if (electron) {
      try {
        if (processAlive(electron.pid)) {
          await core.stopRenderedElectron(
            electron,
            "electron.focused-dream-skill",
            rawLog,
          );
        } else if (!primaryError) {
          throw new CloudProofError(
            "Focused Dream+skill Electron exited before owned cleanup.",
          );
        }
      } catch (error) {
        cleanupError ??= error;
      }
      try {
        if (processAlive(electron.vitePid)) {
          await core.stopProcess(
            electron.vitePid,
            "vite.focused-dream-skill",
            rawLog,
            {
              surface: "vite-process",
              expectedProcessFingerprintSha256:
                electron.viteProcessFingerprintSha256,
            },
          );
        } else if (!primaryError) {
          throw new CloudProofError(
            "Focused Dream+skill Vite exited before owned cleanup.",
          );
        }
      } catch (error) {
        cleanupError ??= error;
      }
    }
    await release().catch((error) => {
      cleanupError ??= error;
    });
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  assert(reportInputs, "Focused Dream+skill proof produced no report input.");
  const report = validateReport({
    version: 1,
    contract: CONTRACT,
    passed: true,
    provider: "stella",
    targetSha256,
    proofRunIdSha256: sha256(reportInputs.state.proofRunId),
    coreRunIdSha256: sha256(reportInputs.coreState.runId),
    coreReportSha256: sha256(canonicalJson(reportInputs.coreReport)),
    conversationIdSha256: sha256(reportInputs.coreState.conversationId),
    authorityReceiptSha256: sha256(
      canonicalJson(reportInputs.authorityEvidence),
    ),
    receiptSetSha256: sha256(canonicalJson(rawLog)),
    scenario: reportInputs.state.evidence,
    cleanup: reportInputs.state.cleanup,
  });
  const serialized = canonicalJson(report);
  for (const forbidden of reportInputs.forbidden.filter(Boolean)) {
    assert(
      !serialized.includes(forbidden),
      "Dream+skill report exposed raw authority, package, or marker material.",
    );
  }
  await writePrivateJson(paths.reportFile, report);
  return { reportFile: paths.reportFile, report };
};

const check = () => {
  const expectedCore = [
    "convexCall",
    "ephemeralJwtSecrets",
    "loadSecrets",
    "readElectronSessionAuthority",
    "relaunchElectron",
    "stopProcess",
    "stopRenderedElectron",
  ];
  const expectedFocused = [
    "assistantTextForTurn",
    "cloudHomeControlRequest",
    "cloudHomeUserRequest",
    "electronCloudTurn",
    "loadCloudHomeExport",
    "loadWholeJournal",
    "matchedToolReceipts",
    "recordsForTurn",
    "waitForTurnTerminal",
  ];
  assert(
    expectedCore.every((name) => typeof core[name] === "function") &&
      expectedFocused.every((name) => typeof focused[name] === "function"),
    "A reviewed Dream+skill smoke primitive is unavailable.",
  );
  return Object.freeze({
    contract: CONTRACT,
    targetSha256,
    provider: "stella",
    scenario: "skill_turn_triggers_automatic_dream",
    cloudSkillTurnCount: 1,
    exhaustiveMatrixIncluded: false,
    liveMutationPerformed: false,
  });
};

const parseArguments = (argv) => {
  if (argv.length === 1 && argv[0] === "--check") return { mode: "check" };
  assert(
    argv.length === 3 && argv[0] === "--run" && argv[1] === "--root",
    "Use --check or --run --root <existing core-smoke root>.",
  );
  return { mode: "run", root: argv[2] };
};

export const runDreamSkillSmokeCli = async (argv = process.argv.slice(2)) => {
  const parsed = parseArguments(argv);
  const value = parsed.mode === "check" ? check() : await run(parsed);
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const invokedDirectly = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === SCRIPT_FILE;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  runDreamSkillSmokeCli().catch((error) => {
    const message =
      error instanceof CloudProofError
        ? error.message
        : `Unexpected focused-proof failure (${sha256(
            error instanceof Error ? error.message : String(error),
          )}).`;
    process.stderr.write(`DREAM+SKILL SMOKE FAILED: ${message}\n`);
    if (error instanceof CloudProofError && error.details) {
      process.stderr.write(
        `DREAM+SKILL SMOKE DETAILS SHA256: ${sha256(
          canonicalJson(error.details),
        )}\n`,
      );
    }
    process.exitCode = 1;
  });
}
