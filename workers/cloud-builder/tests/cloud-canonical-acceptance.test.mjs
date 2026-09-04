import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import {
  ACCEPTANCE_DRIVER_CONTRACT,
  REQUIRED_JOINED_PROVIDER_LIFECYCLE_PHASES,
  REQUIRED_STEP_IDS,
  assertEvidenceCoherence,
  assertEvidenceIdentityCoherence,
  loadCompletedAcceptancePrefix,
  stripInheritedAcceptanceAuthority,
  validateStepEvidence,
} from "../scripts/cloud-canonical-acceptance.mjs";
import {
  REQUIRED_RAW_SURFACES,
  loadAcceptanceDriverContext,
  validateAcceptanceRawLogEntries,
  writeAcceptanceDriverEvidence,
} from "../scripts/cloud-canonical-acceptance-driver-contract.mjs";

const script = fileURLToPath(
  new URL("../scripts/cloud-canonical-acceptance.mjs", import.meta.url),
);
const reviewedContractDriver = fileURLToPath(
  new URL(
    "../scripts/cloud-canonical-acceptance-driver-contract.mjs",
    import.meta.url,
  ),
);
const repoRoot = realpathSync(
  fileURLToPath(new URL("../../..", import.meta.url)),
);

const expectedStepIds = [
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
];

const target = {
  deployment: "preview:basic-nightingale-118",
  convexUrl: "https://basic-nightingale-118.convex.cloud",
  convexSiteUrl: "https://basic-nightingale-118.convex.site",
  cloudBuilderUrl:
    "https://stella-v2-cloud-builder-basic-nightingale-118.lolruuxi.workers.dev",
};

test("strips every inherited acceptance JWT before a driver process", () => {
  const inherited = {
    KEEP_ME: "safe",
    STELLA_CLOUD_PROOF_JWT: "stale-primary",
    STELLA_CLOUD_PROOF_SESSION_COOKIE: "stale-cookie",
    STELLA_CLOUD_ACCEPTANCE_SECONDARY_JWT: "stale-secondary",
    STELLA_CLOUD_ACCEPTANCE_SECONDARY_SESSION_COOKIE: "stale-secondary-cookie",
    STELLA_MOBILE_ACCEPTANCE_JWT: "stale-mobile",
    STELLA_MOBILE_ACCEPTANCE_SECONDARY_JWT: "stale-mobile-secondary",
    STELLA_MOBILE_RN_ACCEPTANCE_JWT: "stale-mounted-mobile",
  };
  const stripped = stripInheritedAcceptanceAuthority(inherited);
  expect(stripped).toEqual({ KEEP_ME: "safe" });
  expect(inherited.STELLA_CLOUD_PROOF_JWT).toBe("stale-primary");
});

const makeManifest = (root) => ({
  version: 3,
  stepCount: expectedStepIds.length,
  target: {
    convexDeployment: target.deployment,
    convexUrl: target.convexUrl,
    convexSiteUrl: target.convexSiteUrl,
    cloudBuilderUrl: target.cloudBuilderUrl,
  },
  isolatedRoots: [root],
  output: path.join(root, "report.json"),
  steps: expectedStepIds.map((id) => ({
    id,
    humanAction:
      id === "primary_auth_handoff"
        ? "external-inbox-primary-login"
        : id === "browser_cloud_routing"
          ? "external-inbox-storage-recovery-login"
          : "none",
    driverContract: ACCEPTANCE_DRIVER_CONTRACT,
    driverFile: reviewedContractDriver,
    command: ["node", reviewedContractDriver, id],
    cwd: root,
    evidenceFile: path.join(root, `${id}.json`),
    timeoutMs: 5_000,
  })),
});

const checkManifest = async (manifest) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "stella-cloud-acceptance-"),
  );
  await mkdir(path.join(directory, "raw"));
  const manifestPath = path.join(directory, "manifest.json");
  await writeFile(
    path.join(directory, "unreviewed-driver.mjs"),
    "throw new Error('structural rejection fixture');\n",
    "utf8",
  );
  await writeFile(manifestPath, JSON.stringify(manifest(directory)), "utf8");
  return Bun.spawnSync([process.execPath, script, "--check", manifestPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
};

const digest = (value) => value.repeat(64);
const sha256Text = (value) => createHash("sha256").update(value).digest("hex");
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
const makeRenderedProofs = (surface, operations, overrides = {}) => {
  const observations = {
    "rendered.list-open": { projectionSha256: digest("a") },
    "rendered.send-terminal": {
      terminalKind: "completed",
      localFallbackCount: 0,
    },
    "rendered.fail-closed": {
      terminalKind: "failed",
      visibleAlertDelta: 1,
      newAssistantRowCount: 0,
      providerDispatchCountBefore: 1,
      providerDispatchCountAfter: 1,
      localFallbackCount: 0,
    },
    "rendered.mounted-resume": {
      outcome: "resumed",
      gapless: true,
      noDuplicateRows: true,
      sameMountedClient: true,
      replayRecordCount: 1,
      since: 0,
      epoch: 1,
    },
    "rendered.same-target-reload": {
      outcome: "same-target-page-reloaded",
      sameTarget: true,
      newRendererMount: true,
      noDuplicateRows: true,
    },
    "rendered.cold-process": {
      outcome: "cold-process-hydrated",
      identityObservedBeforeAuth: true,
      profileReused: true,
      newProcess: true,
      newTarget: true,
      noDuplicateRows: true,
      canonicalRowsSha256: digest("6"),
      previousProcessInstanceSha256: digest("2"),
      currentProcessInstanceSha256: digest("3"),
      priorStopReceiptSha256: digest("7"),
    },
    "rendered.identity-round-trip": {
      outcome: "cross-process-identity-round-trip",
      primaryProcessInstanceSha256: digest("2"),
      secondaryProcessBeforeSha256: digest("4"),
      secondaryProcessAfterSha256: digest("5"),
      secondaryExistingProfilePreserved: true,
      secondaryRelaunched: true,
      primaryRemainedMounted: true,
      staleContentRejected: true,
      credentialMaterialReturned: false,
    },
    "rendered.storage-recovery": {
      outcome: "browser-storage-recovered-after-product-login",
      checkpointSha256: digest("8"),
      canonicalRowsSha256: digest("6"),
      localRowsAbsentBeforeReauth: true,
      priorAuthoritySignedOutOrAnonymous: true,
      outboxEmptyBeforeReauth: true,
      accountAuthorityPreserved: true,
      productLoginRequired: true,
      credentialMaterialReturned: false,
      noDuplicateRows: true,
    },
    "rendered.generation-rotation":
      surface === "browser-cdp"
        ? {
            outcome: "browser-generation-rotated",
            oldSocketClosedBeforeStaleRelease: true,
            postRotationOldSocketCount: 0,
            oldGenerationOutboxPurged: true,
            staleCallbackDropped: true,
            oldGenerationAckCouldNotRecreate: true,
            staleMutationServerRejected: true,
            staleRowsRejected: true,
            localFallbackCount: 0,
          }
        : {
            outcome: "electron-generation-rotated",
            sameMountedRenderer: true,
            oldSocketClosed: true,
            staleRowsRejected: true,
            localFallbackCount: 0,
            outboxApplicable: false,
          },
  };
  const entries = operations.map((operation, index) => {
    const observation = {
      ...observations[operation],
      ...(overrides[operation] ?? {}),
    };
    const receiptBody = {
      contract: "stella-rendered-client-cdp-v1",
      surface,
      operation,
      outcome: "passed",
      processIdSha256: digest(String((index + 1) % 10)),
      processInstanceSha256: digest(String((index + 2) % 10)),
      profileSha256: digest("b"),
      browserBuildSha256: digest("c"),
      applicationIdentitySha256: digest("d"),
      observationSha256: sha256Text(stableJson(observation)),
      ...(overrides.__receipts?.[operation] ?? {}),
    };
    return {
      observation,
      receipt: {
        ...receiptBody,
        receiptSha256: sha256Text(stableJson(receiptBody)),
      },
    };
  });
  return {
    entries,
    setSha256: sha256Text(
      stableJson(
        entries.map(({ receipt }) => ({
          receiptSha256: receipt.receiptSha256,
          observationSha256: receipt.observationSha256,
        })),
      ),
    ),
  };
};
const ownerGeneration = "generation-acceptance-1";
const ownerIdSha256 = digest("3");
const identity = Object.freeze({
  deploymentFingerprintSha256: digest("1"),
  sourceTreeSha256: digest("2"),
  ownerIdSha256,
  ownerGeneration,
});
const runId = "00000000-0000-4000-8000-000000000001";
const workerVersionId = "00000000-0000-4000-8000-000000000002";
const startedAt = "2026-08-26T12:00:00.000Z";
const finishedAt = "2026-08-26T12:00:01.000Z";
const generationSha256 = createHash("sha256")
  .update(ownerGeneration)
  .digest("hex");
const validationArtifactRoot = await mkdtemp(
  path.join(tmpdir(), "stella-cloud-acceptance-artifact-"),
);
const validationArtifacts = new Map();
for (const stepId of expectedStepIds) {
  const validationRawLogPath = path.join(
    validationArtifactRoot,
    `${stepId}.jsonl`,
  );
  const entries = REQUIRED_RAW_SURFACES[stepId].map((surface) => ({
    at: startedAt,
    runId,
    step: stepId,
    surface,
    operation: "validate-retained-receipt",
    mocked: false,
    synthetic: false,
  }));
  const validationRawLog = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  await writeFile(validationRawLogPath, validationRawLog, "utf8");
  validationArtifacts.set(
    stepId,
    Object.freeze({
      path: validationRawLogPath,
      sha256: createHash("sha256").update(validationRawLog).digest("hex"),
      bytes: Buffer.byteLength(validationRawLog),
      entries: entries.length,
    }),
  );
}

const evidencePayload = (step, observations, overrides = {}) => ({
  version: 2,
  driverContract: ACCEPTANCE_DRIVER_CONTRACT,
  step,
  runId,
  passed: true,
  productPath: true,
  syntheticAssistantRecords: false,
  mocked: false,
  realNetwork: true,
  startedAt,
  finishedAt,
  identity,
  observations,
  artifacts: { rawLog: validationArtifacts.get(step) },
  ...overrides,
});

const validateObservation = (stepId, observations, overrides) =>
  validateStepEvidence({
    stepId,
    payload: evidencePayload(stepId, observations, overrides),
    runId,
    target,
  });

const consecutiveObservation = () => ({
  conversationId: "conversation-primary",
  durableObjectIdSha256: digest("4"),
  journalEpoch: "epoch-primary",
  firstTurnId: "turn-first",
  secondTurnId: "turn-second",
  firstTurnRecordCount: 4,
  secondTurnRecordCount: 4,
  journalHeadSeqBeforeSecond: 10,
  secondPromptSeq: 11,
  secondTerminalSeq: 12,
  journalHeadSeqAfterSecond: 12,
  secondTurnObservedFirst: true,
  secondResponseSha256: digest("5"),
  historySha256: digest("6"),
});

const deploymentObservation = () => ({
  repoCommitSha: "a".repeat(40),
  repoTreeSha: "b".repeat(40),
  sourceTreeSha256: identity.sourceTreeSha256,
  cloudBuilderUrl: target.cloudBuilderUrl,
  workerName: "stella-v2-cloud-builder-basic-nightingale-118",
  workerVersionId,
  workerScriptSha256: digest("4"),
  workerDeployedAt: startedAt,
  workerProbeRequestId: "worker-probe-1",
  convexDeployment: target.deployment,
  convexUrl: target.convexUrl,
  convexSiteUrl: target.convexSiteUrl,
  convexFunctionManifestSha256: digest("5"),
  convexObservedAt: finishedAt,
  convexProbeRequestId: "convex-probe-1",
  jwtIssuerSha256: createHash("sha256")
    .update(target.convexSiteUrl)
    .digest("hex"),
  jwtSubjectSha256: digest("9"),
  jwtTokenIdentifierSha256: identity.ownerIdSha256,
  issuerQualifiedOwnerMatched: true,
  canonicalPromptSchemaVersion: 2,
  canonicalPromptRevision: digest("6"),
  canonicalPromptPublishedAt: 1_756_209_600_000,
  canonicalPromptManifestSha256: digest("7"),
  canonicalPromptIdsSha256: digest("8"),
  canonicalPromptCount: 10,
  canonicalPromptObservedAt: finishedAt,
  canonicalPromptMatchesReviewedSource: true,
  gitWorktreeClean: true,
  workerSourceMatches: true,
  convexFunctionsMatch: true,
  productLoginChatStatus: "verified",
  primaryProductLoginChatReceiptSha256: digest("1"),
  cleanClientProductLoginChatReceiptSha256: digest("2"),
  browserProductLoginChatReceiptSha256: digest("3"),
  productLoginChatReceiptSetSha256: digest("4"),
  productLoginChatSameAccount: true,
  productLoginChatCredentialMaterialReturned: false,
});

const primaryAuthObservation = () => ({
  status: "verified-product-login",
  emailSha256: digest("1"),
  profileSetSha256: digest("2"),
  requestSetSha256: digest("3"),
  primaryProcessInstanceSha256: digest("4"),
  cleanClientProcessInstanceSha256: digest("5"),
  browserProcessInstanceSha256: digest("6"),
  secondaryProcessInstanceSha256: digest("7"),
  primaryIdentitySha256: deploymentObservation().jwtSubjectSha256,
  primaryOwnerAccountSha256: identity.ownerIdSha256,
  primarySessionIdSha256: digest("8"),
  cleanClientSessionIdSha256: digest("9"),
  browserSessionIdSha256: digest("a"),
  secondaryEmailSha256: digest("b"),
  secondaryIdentitySha256: digest("c"),
  secondaryJwtIssuerSha256: sha256Text(target.convexSiteUrl),
  secondaryJwtSubjectSha256: digest("c"),
  secondaryJwtTokenIdentifierSha256: digest("d"),
  secondaryOwnerAccountSha256: digest("d"),
  secondarySessionIdSha256: digest("e"),
  primaryAuthorityReceiptSha256: digest("1"),
  cleanClientAuthorityReceiptSha256: digest("2"),
  browserAuthorityReceiptSha256: digest("3"),
  secondaryAuthorityReceiptSha256: digest("4"),
  onboardingReceiptSetSha256: digest("5"),
  onboardingPhaseCount: 40,
  ownerGenerationSha256: generationSha256,
  onboardingPreferenceAttestationSha256: digest("6"),
  onboardingMemoryEnabled: false,
  onboardingMemoryRevision: 1,
  secondaryOnboardingPreferenceAttestationSha256: digest("7"),
  secondaryOnboardingMemoryEnabled: false,
  secondaryOnboardingMemoryRevision: 1,
  sameAccountAcrossProfiles: true,
  distinctConnectedSecondaryAccount: true,
  distinctProfileSessions: true,
  callbackStateCleared: true,
  authDialogClosed: true,
  cleanClientInitiallyEmpty: true,
  cleanupEligible: true,
  credentialMaterialReturned: false,
  cookieSetupUseCount: 0,
  freshOwnerConversationCount: 0,
  freshOwnerResetResidueCount: 0,
  freshOwnerAccountCoreResidueCount: 0,
  freshOwnerCloudProductStateCount: 1,
  ownerLifecycleState: "open",
  secondaryOwnerGenerationSha256: digest("f"),
  secondaryOwnerLifecycleState: "open",
  secondaryFreshOwnerConversationCount: 0,
  secondaryFreshOwnerResetResidueCount: 0,
  secondaryFreshOwnerAccountCoreResidueCount: 0,
  secondaryFreshOwnerCloudProductStateCount: 1,
  deployment: {
    ...deploymentObservation(),
    productLoginChatStatus: "pending-post-deployment-conversation",
  },
});

const duplicateObservation = () => ({
  conversationId: "conversation-primary",
  durableObjectIdSha256: digest("4"),
  journalEpoch: "epoch-primary",
  turnId: "turn-second",
  clientMsgIdSha256: digest("7"),
  deliveryFingerprintSha256: digest("8"),
  firstReceiptSha256: digest("9"),
  replayReceiptSha256: digest("9"),
  journalHeadSeqBeforeReplay: 12,
  journalHeadSeqAfterReplay: 12,
  journalRowCountBeforeReplay: 8,
  journalRowCountAfterReplay: 8,
  promptRecordCount: 1,
  terminalRecordCount: 1,
  terminalKind: "completed",
  receiptReplayed: true,
  duplicateAppendPrevented: true,
});

const localLifecycleObservation = (profileDir, secondaryProfileDir) => ({
  profileDir,
  secondaryProfileDir,
  secondaryJwtSubjectSha256: digest("a"),
  secondaryJwtTokenIdentifierSha256: digest("b"),
  secondaryOwnerGenerationSha256: digest("c"),
  secondaryConversationIdSha256: digest("d"),
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
  localConversationId: "conversation-local",
  initialTurnId: "turn-local-initial",
  continuationTurnId: "turn-local-continuation",
  childTurnId: "turn-local-child",
  providerRequestIdSha256: digest("1"),
  assistantMessageEventCount: 2,
  providerLifecyclePhases: [...REQUIRED_JOINED_PROVIDER_LIFECYCLE_PHASES],
  providerPhysicalAttempt: 1,
  providerStreamOrdinal: 1,
  providerOutcome: "completed",
  providerRawRequestIdExposed: false,
  toolCallId: "tool-call-local",
  toolDispatchCount: 1,
  toolResultSha256: digest("2"),
  childCompletionObserved: true,
  interruptionRequested: true,
  interruptedProviderStopped: true,
  interruptedProviderRequestIdSha256: digest("3"),
  interruptedProviderLifecyclePhases: [
    ...REQUIRED_JOINED_PROVIDER_LIFECYCLE_PHASES,
  ],
  interruptedProviderPhysicalAttempt: 1,
  interruptedProviderStreamOrdinal: 2,
  interruptedProviderOutcome: "canceled",
  interruptedProviderRawRequestIdExposed: false,
  interruptedProviderStoppedAfterJoin: true,
  continuationObserved: true,
  persistenceObserved: true,
  processRestarted: true,
  processIdBefore: 1001,
  processIdAfter: 1002,
  historySha256BeforeRestart: digest("4"),
  historySha256AfterRestart: digest("4"),
  cloudSandboxStarted: false,
});

const coldPromptFailureObservation = () => ({
  conversationId: "conversation-primary",
  turnId: "turn-failure",
  cloudFailureInjected: true,
  userVisibleFailure: true,
  localAuthorityRowsBefore: 4,
  localAuthorityRowsAfter: 4,
  localAuthoritySha256Before: digest("d"),
  localAuthoritySha256After: digest("d"),
  localExecutionStarted: false,
  canonicalContextFailureExplicit: true,
  canonicalContextFailureCode: "CLOUD_CONTEXT_UNAVAILABLE",
  canonicalContextFailureComponent: "canonical_prompt",
  canonicalContextTerminalKind: "failed",
  canonicalFallbackPromptUsed: false,
  providerDispatchCountBefore: 7,
  providerDispatchCountAfter: 7,
  canonicalHistoryTurnId: "turn-history-failure",
  canonicalHistoryFailureInjected: true,
  canonicalHistoryUserVisibleFailure: true,
  canonicalHistoryFailureExplicit: true,
  canonicalHistoryFailureCode: "CLOUD_CONTEXT_UNAVAILABLE",
  canonicalHistoryFailureComponent: "canonical_history",
  canonicalHistoryTerminalKind: "failed",
  canonicalHistoryFallbackUsed: false,
  canonicalHistoryProviderDispatchCountBefore: 7,
  canonicalHistoryProviderDispatchCountAfter: 7,
  canonicalHistoryContextFirstSeq: 8,
  canonicalHistoryContextLastSeq: 13,
  canonicalHistoryCorruptSeq: 9,
  canonicalHistoryFailedEventSeq: 14,
  canonicalHistoryCorruptPayloadSha256Before: digest("e"),
  canonicalHistoryCorruptPayloadSha256After: digest("e"),
  canonicalHistoryCorruptRowModelSkip: false,
  canonicalHistoryCorruptRowPreserved: true,
  canonicalHistoryReconnectObservedFailure: true,
  canonicalHistoryRestartObservedFailure: true,
  canonicalHistoryRepairObserved: true,
  canonicalHistoryOriginalPayloadSha256: digest("a"),
  canonicalHistoryRepairedPayloadSha256: digest("a"),
  canonicalHistoryRepairTurnId: "turn-history-repaired",
  canonicalHistoryRepairTerminalKind: "completed",
  canonicalHistoryProviderDispatchCountAfterRepair: 8,
});

const memoryObservation = () => ({
  conversationId: "conversation-primary",
  writeTurnId: "turn-second",
  recallTurnId: "turn-recall",
  laterTurnId: "turn-later",
  memoryDocumentName: "MEMORY.md",
  memoryDocumentId: "memdoc-1",
  memoryVersionId: "memver-1",
  memoryRevision: 2,
  memoryContentSha256: digest("a"),
  memoryMarkerSha256: digest("b"),
  memoryR2Key: `agent-home/${ownerIdSha256}/generations/${generationSha256}/memory-versions/memdoc-1/memver-1/${digest("a")}.md`,
  memoryR2Etag: "memory-etag-1",
  memoryWriteReceiptSha256: digest("e"),
  memoryWriteIdempotencySha256: createHash("sha256")
    .update("memory:turn-second")
    .digest("hex"),
  profileDocumentName: "memories/profile.md",
  profileDocumentId: "profile-doc-1",
  profileVersionId: "profile-ver-1",
  profileRevision: 1,
  profileContentSha256: digest("f"),
  profileR2Key: `agent-home/${ownerIdSha256}/generations/${generationSha256}/memory-versions/profile-doc-1/profile-ver-1/${digest("f")}.md`,
  profileR2Etag: "profile-etag-1",
  rememberReceiptSha256: digest("0"),
  profileContainsMarker: true,
  workerVersionIdBeforeRestart: workerVersionId,
  workerVersionIdAfterRestart: workerVersionId,
  workerRestartObserved: true,
  recallResultSha256: digest("c"),
  laterTurnContextSha256: digest("d"),
  markerObservedAfterRestart: true,
  laterTurnObservedMemory: true,
});

const codeModeObservation = () => ({
  conversationId: "conversation-primary",
  turnId: "turn-code",
  workerVersionId,
  codeExecutionId: "code-execution-1",
  mcpServerIdSha256: digest("e"),
  connectedAccountIdSha256: digest("f"),
  protocolVersion: "2025-03-26",
  integrationId: "integration-1",
  toolName: "CONNECTED_READ",
  toolRevision: `v2:${digest("0")}`,
  codePolicyVersion: "2026-08-26.acceptance-read.v1",
  toolkitVersion: "20260826_01",
  catalogRevisionSha256: digest("c"),
  reviewedInputSchemaSha256: digest("d"),
  initializeRequestIdSha256: digest("3"),
  toolsListRequestIdSha256s: [digest("4"), digest("5")],
  describeRequestIdSha256: digest("6"),
  toolsCallRequestIdSha256: digest("7"),
  listedToolIdSha256: digest("8"),
  describedToolIdSha256: digest("8"),
  calledToolIdSha256: digest("8"),
  toolsListPageCount: 2,
  initializationReceiptSha256: digest("9"),
  initializedNotificationReceiptSha256: digest("a"),
  describeReceiptSha256: digest("b"),
  providerReceiptSha256: digest("1"),
  toolResultSha256: digest("2"),
  initializeCompleted: true,
  initializedNotificationSent: true,
  toolsListCompleted: true,
  toolDescribed: true,
  toolsCallCompleted: true,
  realConnectedService: true,
  externalTransport: "composio",
  disposableConnectedAccount: true,
  externalAccountHashMatched: true,
  catalogPolicyVerifiedBeforeCall: true,
  annotationsReadOnly: true,
  annotationsDestructive: false,
  inProcessFixture: false,
  readOnlyTool: true,
  serverPolicyRechecked: true,
  childGlobalOutboundBlocked: true,
});

const mobileProductModuleSha256 = () =>
  Object.fromEntries(
    [
      "use-cloud-canonical-chat-thread.ts",
      "use-chat-thread.ts",
      "desktop-chat-outbox.ts",
      "cloud-conversation-store.ts",
      "cloud-conversation-socket.ts",
      "http.ts",
    ].map((filename) => [
      filename,
      createHash("sha256")
        .update(
          readFileSync(
            path.join(repoRoot, "packages/mobile/src/lib", filename),
          ),
        )
        .digest("hex"),
    ]),
  );

const sealMobileSignedInCanonicalObservation = (observation) => {
  const mountedRn = observation.mountedRn;
  mountedRn.receipts = [
    ...mountedRn.enqueue.receipts,
    ...mountedRn.replay.receipts,
    ...mountedRn.clean.receipts,
  ];
  mountedRn.summarySha256 = sha256Text(
    stableJson({
      enqueue: mountedRn.enqueue.storageStateSha256,
      replay: mountedRn.replay.messageStateSha256,
      clean: mountedRn.clean.messageStateSha256,
    }),
  );
  observation.mountedRnResultSha256 = sha256Text(stableJson(mountedRn));
  observation.receiptSetSha256 = sha256Text(stableJson(mountedRn.receipts));
  return observation;
};

const mobileSignedInCanonicalObservation = () => {
  const conversationId = "conversation-primary";
  const dispatchId = "dispatch-mobile-canonical";
  const sendIdSha256 = digest("6");
  const dispatchIdSha256 = sha256Text(dispatchId);
  const responseSha256 = digest("7");
  const authority = {
    identityKeySha256: digest("1"),
    accountScopeSha256: digest("2"),
    ownerGenerationSha256: generationSha256,
    conversationIdSha256: sha256Text(conversationId),
    socketOriginSha256: sha256Text(target.cloudBuilderUrl),
  };
  const secondaryAuthority = {
    identityKeySha256: digest("a"),
    accountScopeSha256: digest("b"),
    ownerGenerationSha256: digest("c"),
    conversationIdSha256: digest("d"),
    socketOriginSha256: authority.socketOriginSha256,
  };
  const enqueue = {
    phase: "enqueue_response_loss",
    passed: true,
    processIdSha256: digest("1"),
    mountIdSha256: digest("4"),
    authority: { ...authority },
    storageStateSha256: digest("8"),
    promptSha256: digest("9"),
    sendIdSha256,
    dispatchIdSha256,
    uiSendAccepted: true,
    asyncStorageWriteCompletedBeforeNetwork: true,
    serverCommittedBeforeResponseLoss: true,
    responseWithheldFromHook: true,
    processExitsWithPendingOutbox: true,
    ordering: {
      asyncStorageWriteCompletion: 1,
      submitStart: 2,
      serverResponse: 3,
      responseWithheld: 4,
    },
    receipts: [
      {
        surface: "mobile-client",
        operation: "mobile.rn.ui-send",
        outcome: "accepted",
        requestIdSha256: sendIdSha256,
        stateSha256: digest("a"),
      },
      {
        surface: "mobile-http",
        operation: "mobile.execution.submit.response-loss",
        outcome: "committed-response-withheld",
        status: 200,
        requestIdSha256: sendIdSha256,
        resourceIdSha256: dispatchIdSha256,
        responseSha256,
      },
    ],
  };
  const replay = {
    phase: "replay_reconnect_switch",
    passed: true,
    processIdSha256: digest("2"),
    mountIdSha256: digest("5"),
    authority: { ...authority },
    secondaryAuthority,
    storageStateSha256: digest("b"),
    sendIdSha256,
    dispatchIdSha256,
    restoredQueuedMessage: true,
    replayCollapsedToCommittedDispatch: true,
    acknowledgedAfterTerminal: true,
    priorStateSha256: enqueue.storageStateSha256,
    terminalAcknowledgementOrdering: {
      serverTerminalStatus: 10,
      asyncStorageOutboxRemoval: 11,
    },
    cursorReconnect: {
      sameMountedClient: true,
      resumedWithCursor: true,
      resumedWithEpoch: true,
      epochStable: true,
      gapCount: 0,
      duplicateCount: 0,
      recoveredRecordCount: 2,
    },
    appState: {
      backgroundCallbacks: 1,
      activeCallbacks: 1,
      foregroundWakeObserved: true,
    },
    identitySwitch: {
      actualHookRerendered: true,
      accountsDiffer: true,
      aToBToA: true,
      outboxIsolated: true,
      aAcknowledgementPreserved: true,
      serverAuthorityFenceProved: false,
    },
    noLocalFallback: {
      explicitIssueSha256: digest("c"),
      attemptedPromptSha256: digest("d"),
      blockedSendPreservedDraft: true,
      localFallbackCount: 0,
      fallbackNetworkCount: 0,
    },
    messageStateSha256: digest("e"),
    receipts: [
      {
        surface: "mobile-http",
        operation: "mobile.execution.submit.replay",
        outcome: "idempotent-replay",
        status: 200,
        requestIdSha256: sendIdSha256,
        resourceIdSha256: dispatchIdSha256,
        responseSha256,
      },
      {
        surface: "mobile-client",
        operation: "mobile.rn.websocket.cursor-reconnect",
        outcome: "gapless",
        stateSha256: digest("e"),
        count: 3,
      },
      {
        surface: "mobile-client",
        operation: "mobile.rn.app-state",
        outcome: "background-active",
        count: 2,
      },
      {
        surface: "mobile-client",
        operation: "mobile.rn.identity-switch",
        outcome: "a-b-a",
        stateSha256: digest("f"),
      },
      {
        surface: "mobile-client",
        operation: "mobile.rn.no-local-fallback",
        outcome: "explicit-error",
        responseSha256: digest("c"),
        count: 0,
      },
    ],
  };
  const clean = {
    phase: "clean_hydrate",
    passed: true,
    processIdSha256: digest("3"),
    mountIdSha256: digest("6"),
    authority: { ...authority },
    cleanNamespaceStartedEmpty: true,
    canonicalUserProjected: true,
    canonicalAssistantProjected: true,
    localFallbackCount: 0,
    messageStateSha256: digest("f"),
    generationCanaryOutboxStateSha256: digest("1"),
    generationCanarySendIdSha256: digest("2"),
    receipts: [
      {
        surface: "mobile-client",
        operation: "mobile.rn.clean-hydration",
        outcome: "canonical",
        stateSha256: digest("f"),
        count: 2,
      },
      {
        surface: "mobile-client",
        operation: "mobile.rn.generation-canary",
        outcome: "durable",
        requestIdSha256: digest("2"),
        stateSha256: digest("1"),
        count: 1,
      },
    ],
  };
  return sealMobileSignedInCanonicalObservation({
    conversationId,
    turnId: "turn-mobile-canonical",
    dispatchId,
    ownerGeneration,
    chosenLocation: "cloud",
    terminalState: "completed",
    terminalRevision: 2,
    journalEpoch: 1,
    promptSeq: 1,
    terminalSeq: 4,
    durableObjectIdSha256: digest("9"),
    fenceVerified: true,
    serverAuthorityFence: {
      anonymousAccountAdmissionStatus: 403,
      anonymousAccountStatusProbeStatus: 403,
      anonymousAccountCancelProbeStatus: 403,
      anonymousAccountPolicyReasonSha256: createHash("sha256")
        .update("Sign in with an account to use Stella mobile.")
        .digest("hex"),
      initialCrossOwnerSocketCloseCode: 4404,
      liveSocketIdentitySwitchCloseCode: 4403,
      anonymousAccountAdmissionRejected: true,
      initialCrossOwnerSocketPrivateNotFound: true,
      liveSocketIdentitySwitchRejected: true,
    },
    mountedRn: {
      version: 2,
      contract: "stella-mobile-rn-canonical-v2",
      mode: "full",
      passed: true,
      runtime: {
        bunVersion: "1.4.0",
        executor: "bun-jsdom-react-native-web",
        renderer: "react-dom-react-native-web",
        actualSignedInChatHookMounted: true,
        actualProductScreenMounted: false,
        actualAsyncStoragePackage: true,
        actualAsyncStorageWrapper: true,
        actualAppStateSubscription: true,
        realHttp: true,
        realWebSocket: true,
        productModuleSha256: mobileProductModuleSha256(),
      },
      boundary: {
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
      },
      authority,
      enqueue,
      replay,
      clean,
      generationCanaryOutboxStateSha256:
        clean.generationCanaryOutboxStateSha256,
      receipts: [],
      summarySha256: digest("0"),
    },
    mountedRnResultSha256: digest("0"),
    receiptSetSha256: digest("0"),
  });
};

const sealOwnerResetMobileGenerationObservation = (observation) => {
  const result = observation.mobileGenerationRotation;
  const rotation = result.generationRotation;
  result.receipts = [...rotation.receipts];
  result.summarySha256 = sha256Text(stableJson(rotation));
  observation.mobileGenerationResultSha256 = sha256Text(stableJson(result));
  observation.mobileGenerationReadySha256 = sha256Text(
    stableJson({
      version: 1,
      processIdSha256: rotation.processIdSha256,
      mountIdSha256: rotation.mountIdSha256,
      accountScopeSha256: rotation.accountScopeSha256,
      ownerGenerationSha256: rotation.oldGenerationSha256,
      conversationIdSha256: rotation.oldConversationIdSha256,
      canarySendIdSha256: rotation.receipts[0].requestIdSha256,
      serverAdmissionResponseHeld: true,
      staleSocketLive: true,
    }),
  );
  return observation;
};

const ownerResetObservation = () => {
  const priorMobile = mobileSignedInCanonicalObservation();
  const oldConversationId = priorMobile.conversationId;
  const newConversationId = "conversation-post-reset";
  const oldOwnerGenerationSha256 = sha256Text(priorMobile.ownerGeneration);
  const newOwnerGenerationSha256 = digest("e");
  const replacementConversationSha256 = sha256Text(newConversationId);
  const browserRenderedGeneration = makeRenderedProofs(
    "browser-cdp",
    ["rendered.generation-rotation"],
    {
      "rendered.generation-rotation": {
        oldOwnerGenerationSha256,
        newOwnerGenerationSha256,
        replacementConversationSha256,
      },
    },
  );
  const electronRenderedGeneration = makeRenderedProofs(
    "electron-cdp",
    ["rendered.generation-rotation"],
    {
      "rendered.generation-rotation": {
        oldOwnerGenerationSha256,
        newOwnerGenerationSha256,
        replacementConversationSha256,
      },
    },
  );
  const renderedGenerationProofs = [
    browserRenderedGeneration.entries[0],
    electronRenderedGeneration.entries[0],
  ];
  const renderedGenerationProofSetSha256 = sha256Text(
    stableJson(
      renderedGenerationProofs.map(({ receipt }) => ({
        receiptSha256: receipt.receiptSha256,
        observationSha256: receipt.observationSha256,
      })),
    ),
  );
  const finalStateSha256 = digest("4");
  const generationRotation = {
    phase: "generation_rotation",
    passed: true,
    processIdSha256: digest("7"),
    mountIdSha256: digest("8"),
    accountScopeSha256: priorMobile.mountedRn.authority.accountScopeSha256,
    oldConversationIdSha256: sha256Text(oldConversationId),
    conversationIdSha256: sha256Text(newConversationId),
    oldGenerationSha256: oldOwnerGenerationSha256,
    newGenerationSha256: newOwnerGenerationSha256,
    generationsDiffer: true,
    liveAcrossResetBarrier: true,
    serverAdmissionResponseHeldAcrossReset: true,
    heldOldResponseDeliveredAfterRerender: true,
    actualHookRerendered: true,
    oldGenerationOutboxPurged: true,
    staleSocketRetired: true,
    staleCallbackDropCount: 1,
    staleOutboxAckRejected: true,
    newGenerationHydrated: true,
    newAuthorityIdleAfterStaleCallback: true,
    localFallbackCount: 0,
    priorStateSha256: priorMobile.mountedRn.generationCanaryOutboxStateSha256,
    finalStateSha256,
    receipts: [
      {
        surface: "mobile-client",
        operation: "mobile.rn.owner-generation-rotation",
        outcome: "retired-and-purged",
        requestIdSha256:
          priorMobile.mountedRn.clean.generationCanarySendIdSha256,
        stateSha256: finalStateSha256,
        count: 1,
      },
    ],
  };
  return sealOwnerResetMobileGenerationObservation({
    oldConversationId,
    newConversationId,
    oldOwnerGenerationSha256,
    newOwnerGenerationSha256,
    oldMemoryEpochSha256: digest("1"),
    wipedMemoryEpochSha256: digest("2"),
    postResetMemoryEpochSha256: digest("3"),
    localDocumentName: "imports/local/acceptance-proof.md",
    localDocumentSha256: digest("4"),
    initialVersionId: "memory-version-initial",
    explicitReimportVersionId: "memory-version-explicit-reimport",
    explicitReimportR2KeySha256: digest("5"),
    explicitReimportR2Etag: "etag-explicit-reimport",
    postResetVersionId: "memory-version-post-reset",
    postResetR2KeySha256: digest("6"),
    postResetR2Etag: "etag-post-reset",
    signedInOwnershipConfirmed: true,
    initialLocalImportObserved: true,
    memoryWipeCompleted: true,
    implicitReimportBlocked: true,
    explicitReimportAuthorized: true,
    explicitReimportExact: true,
    ownerGenerationRotated: true,
    resetJobCompleted: true,
    remainingResetOwnedCoreStoreCount: 0,
    oldGenerationR2ObjectCount: 0,
    integrationBeforeResetSha256: digest("7"),
    integrationAfterResetSha256: digest("7"),
    connectedIntegrationPreservedByReset: true,
    connectedIntegrationRoutedAfterReset: true,
    connectedIntegrationUsedAfterReset: true,
    postResetMcpCallRequestIdSha256: digest("9"),
    postResetMcpToolIdSha256: digest("8"),
    postResetMcpProviderReceiptSha256: digest("8"),
    mobileGenerationRotation: {
      version: 2,
      contract: "stella-mobile-rn-canonical-v2",
      mode: "post_reset_generation",
      passed: true,
      runtime: JSON.parse(JSON.stringify(priorMobile.mountedRn.runtime)),
      boundary: JSON.parse(JSON.stringify(priorMobile.mountedRn.boundary)),
      generationRotation,
      receipts: [],
      summarySha256: digest("0"),
    },
    mobileGenerationResultSha256: digest("0"),
    mobileGenerationReadySha256: digest("0"),
    mobileGenerationBarrierRemoved: true,
    renderedGenerationProofs,
    renderedGenerationProofSetSha256,
    renderedGenerationReadySha256: digest("a"),
    preResetSandboxTerminalVerified: true,
    localMemoryPreservedByHardReset: true,
    localOwnershipMarkerPreserved: true,
    postResetReimportExact: true,
  });
};

const skillObservation = () => ({
  conversationId: "conversation-primary",
  discoveryTurnId: "turn-skill-discovery",
  useTurnId: "turn-skill-use",
  skillId: "skill-1",
  skillVersionId: "skillver-1",
  skillRevision: 1,
  manifestSha256: digest("6"),
  assetPath: "references/example.md",
  assetSha256: digest("7"),
  manifestR2Key: `agent-home/${ownerIdSha256}/generations/${generationSha256}/skills/skill-1/skillver-1/manifest.json`,
  manifestR2Etag: "manifest-etag-1",
  assetR2Key: `agent-home/${ownerIdSha256}/generations/${generationSha256}/skills/skill-1/skillver-1/files/references/example.md`,
  assetR2Etag: "asset-etag-1",
  catalogRevisionSha256: digest("8"),
  skillUseReceiptSha256: digest("9"),
  discoveredByCloudAgent: true,
  loadedByWorker: true,
  assetReadByWorker: true,
  usedByCloudAgent: true,
  macFilesystemReadCount: 0,
});

const appsHostWorkerdObservation = () => ({
  workerName: "stella-v2-apps-host-basic-nightingale-118",
  deploymentIdentity: "preview:basic-nightingale-118",
  runtimeEngine: "workerd",
  wranglerVersion: "4.127.1",
  bundleSha256: digest("1"),
  bundleBytes: 42_000,
  routeSetSha256: digest("2"),
  appAssetSha256: digest("3"),
  blockedProxyResponseSha256: digest("7"),
  receiptChainSha256: digest("8"),
  healthStatus: 200,
  appAssetStatus: 200,
  appHeadStatus: 200,
  blockedProxyStatus: 401,
  invalidConfigStatus: 503,
  productionBundleBuilt: true,
  workerdRuntimeStarted: true,
  realKvBindingUsed: true,
  realR2BindingUsed: true,
  strictHostedContentSecurityPolicy: true,
  unauthenticatedProxyBlockedBeforeFetch: true,
  invalidConfigurationFailedClosed: true,
  runtimeDisposed: true,
  isolatedStateRemoved: true,
});

const cleanupObservation = () => ({
  conversationPurged: true,
  r2ObjectsPurged: true,
  cloudMemoryPurged: true,
  cloudSkillsPurged: true,
  sandboxResourcesPurged: true,
  appsHostWorkerdStateRemoved: true,
  ownerGenerationsPurged: true,
  oldOwnerResetCorePurged: true,
  connectedTestAccountRevoked: true,
  primarySessionRevoked: true,
  primaryOwnerResidueRemoved: true,
  primaryLifecycleTombstoned: true,
  primaryPurgeJobCompleted: true,
  primaryConversationResidueCount: 0,
  primaryResetCoreResidueCount: 0,
  primaryAccountCoreResidueCount: 0,
  primaryCloudStoreResidueCount: 0,
  secondaryTestAccountRevoked: true,
  secondarySessionRevoked: true,
  secondaryOwnerResidueRemoved: true,
  secondaryConversationPurged: true,
  secondaryResetCorePurged: true,
  secondaryAccountCorePurged: true,
  secondaryCloudStoresPurged: true,
  secondaryLifecycleTombstoned: true,
  secondaryPurgeJobCompleted: true,
  primarySessionRestoredAfterSecondaryRevocation: true,
  secondaryRevocationPrecededPrimaryRevocation: true,
  secondaryConversationResidueCount: 0,
  secondaryResetCoreResidueCount: 0,
  secondaryAccountCoreResidueCount: 0,
  secondaryCloudStoreResidueCount: 0,
  anonymousMobilePolicyAccountDisposed: true,
  anonymousMobilePolicySessionRevoked: true,
  anonymousMobilePolicyOwnerResidueRemoved: true,
  connectedIntegrationRemovedAfterAccountDeletion: true,
  processLogsPromptRedacted: true,
  processLogsRemoved: true,
  harnessProcessGroupsStopped: true,
  trustedLoopbackPortReleased: true,
  isolatedProfilesRemoved: true,
  liveProfileUntouched: true,
  liveProfileSha256Before: digest("9"),
  liveProfileSha256After: digest("9"),
  remainingResources: [],
});

const coherentSteps = (root) => {
  const profileA = path.join(root, "profile-a");
  const profileB = path.join(root, "profile-b");
  const step = (id, evidence, stepIdentity = identity) => ({
    id,
    identity: stepIdentity,
    artifact: {
      path: path.join(root, "raw", `${id}.jsonl`),
      sha256: digest("a"),
      bytes: 1,
      entries: 1,
    },
    evidence,
  });
  return [
    step("deployment_identity", {
      sourceTreeSha256: identity.sourceTreeSha256,
      deploymentFingerprintSha256: identity.deploymentFingerprintSha256,
      workerVersionId,
      convexDeployment: target.deployment,
    }),
    step("local_runtime_lifecycle", {
      localConversationId: "conversation-local",
      initialTurnId: "turn-local-initial",
      profileDir: profileA,
      secondaryProfileDir: profileB,
      secondaryJwtSubjectSha256: digest("a"),
      secondaryJwtTokenIdentifierSha256: digest("b"),
      secondaryOwnerGenerationSha256: digest("c"),
      secondaryConversationIdSha256: digest("d"),
      secondaryIdentityClass: "connected-secondary",
      providerLifecyclePhases: [...REQUIRED_JOINED_PROVIDER_LIFECYCLE_PHASES],
      providerOutcome: "completed",
      interruptedProviderLifecyclePhases: [
        ...REQUIRED_JOINED_PROVIDER_LIFECYCLE_PHASES,
      ],
      interruptedProviderOutcome: "canceled",
      interruptedProviderStoppedAfterJoin: true,
    }),
    step("electron_real_stream", {
      conversationId: "conversation-primary",
      durableObjectIdSha256: digest("4"),
      journalEpoch: "epoch-primary",
      turnId: "turn-first",
      journalHeadSeq: 10,
      profileDir: profileA,
    }),
    step("consecutive_durable_turns", consecutiveObservation()),
    step("duplicate_delivery_idempotency", duplicateObservation()),
    step("electron_restart_reconnect", {
      conversationId: "conversation-primary",
      durableObjectIdSha256: digest("4"),
      journalEpoch: "epoch-primary",
      journalHeadSeqBefore: 12,
      journalHeadSeqAfter: 12,
      historySha256: digest("6"),
    }),
    step("clean_client_hydration", {
      conversationId: "conversation-primary",
      profileA,
      profileB,
      historySha256: digest("6"),
    }),
    step("cache_loss_recovery", {
      conversationId: "conversation-primary",
      cachePath: path.join(profileA, "cloud-cache.sqlite"),
      historySha256: digest("6"),
    }),
    step("projection_and_r2", {
      conversationId: "conversation-primary",
      journalEpoch: "epoch-primary",
      journalHeadSeq: 40,
      coldHistorySha256: digest("6"),
      hotHistorySha256: digest("6"),
    }),
    step("cancellation", {
      conversationId: "conversation-primary",
      turnId: "turn-cancel",
    }),
    step("cloud_failure_no_local_fallback", coldPromptFailureObservation()),
    step("desktop_local_routing", {
      conversationId: "conversation-local",
      turnId: "turn-local-initial",
    }),
    step("mobile_reachable_computer_routing", {
      conversationId: "conversation-mobile-reachable",
      turnId: "turn-mobile-reachable",
    }),
    step("mobile_unreachable_cloud_routing", {
      conversationId: "conversation-mobile-unreachable",
      turnId: "turn-mobile-unreachable",
    }),
    step(
      "mobile_signed_in_canonical_sync",
      mobileSignedInCanonicalObservation(),
    ),
    step("browser_cloud_routing", {
      conversationId: "conversation-browser",
      turnId: "turn-browser",
      expectedOwnerGeneration: ownerGeneration,
    }),
    step("child_completion", {
      parentConversationId: "conversation-browser",
      parentTurnId: "turn-browser",
      childTurnId: "turn-sandbox-child",
      completionJournalSeq: 30,
    }),
    step("memory_restart_recall", {
      conversationId: "conversation-primary",
      writeTurnId: "turn-second",
      recallTurnId: "turn-recall",
      laterTurnId: "turn-later",
      workerVersionIdBeforeRestart: workerVersionId,
      workerVersionIdAfterRestart: workerVersionId,
      memoryVersionId: "memver-1",
      memoryRevision: 2,
    }),
    step("cloud_skill_discovery_use", {
      conversationId: "conversation-primary",
      discoveryTurnId: "turn-skill-discovery",
      useTurnId: "turn-skill-use",
    }),
    step("code_mode_real_mcp", {
      conversationId: "conversation-primary",
      turnId: "turn-code",
      workerVersionId,
      toolsCallRequestIdSha256: digest("7"),
      calledToolIdSha256: digest("8"),
    }),
    step("general_agent_real_sandbox", {
      conversationId: "conversation-browser",
      parentTurnId: "turn-browser",
      childTurnId: "turn-sandbox-child",
      completionJournalSeq: 30,
    }),
    step("owner_reset_memory_reimport", ownerResetObservation()),
    step("apps_host_workerd_runtime", appsHostWorkerdObservation()),
  ];
};

describe("cloud canonical acceptance manifest", () => {
  test("requires the complete prompt-backed scenario set", () => {
    expect(REQUIRED_STEP_IDS).toEqual(expectedStepIds);
    const result = Bun.spawnSync([process.execPath, script, "--list"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    for (const id of expectedStepIds) {
      expect(result.stdout.toString()).toContain(`- ${id}:`);
    }
  });

  test("accepts a complete isolated manifest for the pinned preview target", async () => {
    const result = await checkManifest(makeManifest);
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(
      "structurally valid for preview:basic-nightingale-118",
    );
  });

  test("rejects a manifest that omits any new real-product scenario", async () => {
    const result = await checkManifest((root) => {
      const manifest = makeManifest(root);
      manifest.steps = manifest.steps.filter(
        (step) => step.id !== "consecutive_durable_turns",
      );
      manifest.stepCount = manifest.steps.length;
      return manifest;
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      `Acceptance manifest stepCount must be ${expectedStepIds.length}`,
    );
  });

  test("rejects a stale manifest version or declared step count", async () => {
    const staleVersion = await checkManifest((root) => ({
      ...makeManifest(root),
      version: 1,
    }));
    expect(staleVersion.exitCode).not.toBe(0);
    expect(staleVersion.stderr.toString()).toContain(
      "Acceptance manifest version must be 3",
    );

    const staleCount = await checkManifest((root) => ({
      ...makeManifest(root),
      stepCount: expectedStepIds.length - 1,
    }));
    expect(staleCount.exitCode).not.toBe(0);
    expect(staleCount.stderr.toString()).toContain(
      `Acceptance manifest stepCount must be ${expectedStepIds.length}`,
    );
  });

  test("declares both external-inbox pauses separately from automatic steps", async () => {
    const runnerSource = await readFile(script, "utf8");
    expect(runnerSource).toContain(
      "full machine or app-process death requires restarting the acceptance run",
    );
    expect(runnerSource).toContain("no resumable credential is persisted");
    const missingStorageHandoff = await checkManifest((root) => {
      const manifest = makeManifest(root);
      manifest.steps.find(
        (step) => step.id === "browser_cloud_routing",
      ).humanAction = "none";
      return manifest;
    });
    expect(missingStorageHandoff.exitCode).not.toBe(0);
    expect(missingStorageHandoff.stderr.toString()).toContain(
      "browser_cloud_routing.humanAction must be external-inbox-storage-recovery-login",
    );

    const inventedAutomaticHandoff = await checkManifest((root) => {
      const manifest = makeManifest(root);
      manifest.steps.find(
        (step) => step.id === "electron_real_stream",
      ).humanAction = "external-inbox-primary-login";
      return manifest;
    });
    expect(inventedAutomaticHandoff.exitCode).not.toBe(0);
    expect(inventedAutomaticHandoff.stderr.toString()).toContain(
      "electron_real_stream.humanAction must be none",
    );
  });

  test("resumes only from a contiguous evidence and raw-log prefix", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "stella-cloud-resume-prefix-"),
    );
    const step = (id) => ({
      id,
      command: [process.execPath, reviewedContractDriver, id],
      driverContract: ACCEPTANCE_DRIVER_CONTRACT,
      driverFile: reviewedContractDriver,
      driverSha256: digest("a"),
      cwd: root,
      evidenceFile: path.join(root, `${id}.json`),
      rawLogFile: path.join(root, `${id}.jsonl`),
      timeoutMs: 5_000,
    });
    const validated = {
      target,
      steps: [
        step("primary_auth_handoff"),
        step("deployment_identity"),
        step("cleanup"),
      ],
    };
    try {
      await writeFile(validated.steps[0].evidenceFile, "{}\n", "utf8");
      await expect(
        loadCompletedAcceptancePrefix(validated, runId),
      ).rejects.toThrow("only one half of its evidence/raw-log pair");

      await rm(validated.steps[0].evidenceFile);
      await Promise.all([
        writeFile(validated.steps[1].evidenceFile, "{}\n", "utf8"),
        writeFile(validated.steps[1].rawLogFile, "{}\n", "utf8"),
      ]);
      await expect(
        loadCompletedAcceptancePrefix(validated, runId),
      ).rejects.toThrow("exists after an incomplete predecessor");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  test("rejects an isolated root that overlaps the integration worktree", async () => {
    const result = await checkManifest((root) => ({
      ...makeManifest(root),
      isolatedRoots: [path.join(repoRoot, "workers")],
    }));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "must not overlap the integration worktree",
    );
  });

  test("keeps aggregate and step evidence inside disposable roots", async () => {
    const aggregateInRepo = await checkManifest((root) => ({
      ...makeManifest(root),
      output: path.join(
        repoRoot,
        "workers/cloud-builder/tests/would-be-acceptance-report.json",
      ),
    }));
    expect(aggregateInRepo.exitCode).not.toBe(0);
    expect(aggregateInRepo.stderr.toString()).toContain(
      "manifest.output is outside the disposable isolated roots",
    );

    const stepInRepo = await checkManifest((root) => {
      const manifest = makeManifest(root);
      manifest.steps[0].evidenceFile = path.join(
        repoRoot,
        "workers/cloud-builder/tests/would-be-step-evidence.json",
      );
      return manifest;
    });
    expect(stepInRepo.exitCode).not.toBe(0);
    expect(stepInRepo.stderr.toString()).toContain(
      "evidenceFile is outside the disposable isolated roots",
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

  test("rejects an arbitrary shell command in place of a reviewed driver", async () => {
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

  test("rejects an arbitrary executable merely named node", async () => {
    const result = await checkManifest((root) => {
      const manifest = makeManifest(root);
      manifest.steps[0].command[0] = path.join(root, "node");
      return manifest;
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "must invoke an explicit node or bun acceptance driver",
    );
  });

  test("rejects a driver outside the reviewed integration worktree", async () => {
    const result = await checkManifest((root) => {
      const manifest = makeManifest(root);
      const unreviewed = path.join(root, "unreviewed-driver.mjs");
      manifest.steps[0].driverFile = unreviewed;
      manifest.steps[0].command[1] = unreviewed;
      return manifest;
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "must be a reviewed file inside the integration worktree",
    );
  });

  test("rejects a driver that does not declare the reviewed contract", async () => {
    const result = await checkManifest((root) => {
      const manifest = makeManifest(root);
      delete manifest.steps[0].driverContract;
      return manifest;
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      `driverContract must be ${ACCEPTANCE_DRIVER_CONTRACT}`,
    );
  });
});

describe("cloud canonical evidence validators", () => {
  test("requires a distinct connected secondary magic-link authority", () => {
    const deployment = validateObservation(
      "deployment_identity",
      deploymentObservation(),
    );
    const matchingIdentity = {
      ...identity,
      deploymentFingerprintSha256:
        deployment.evidence.deploymentFingerprintSha256,
    };
    expect(() =>
      validateObservation("primary_auth_handoff", primaryAuthObservation(), {
        identity: matchingIdentity,
      }),
    ).not.toThrow();

    const reusedSession = primaryAuthObservation();
    reusedSession.secondarySessionIdSha256 =
      reusedSession.cleanClientSessionIdSha256;
    expect(() =>
      validateObservation("primary_auth_handoff", reusedSession, {
        identity: matchingIdentity,
      }),
    ).toThrow("distinct connected-secondary account and session");

    const anonymousSecondary = primaryAuthObservation();
    anonymousSecondary.secondaryJwtSubjectSha256 = digest("f");
    expect(() =>
      validateObservation("primary_auth_handoff", anonymousSecondary, {
        identity: matchingIdentity,
      }),
    ).toThrow("distinct connected-secondary account and session");
  });

  test("binds the Electron harness app name to the canonical isolated userData profile", async () => {
    const profileDir = await mkdtemp(
      path.join(tmpdir(), "stella-electron-harness-profile-"),
    );
    const userDataDir = path.join(profileDir, "user-data");
    await mkdir(userDataDir, { recursive: true });
    const canonicalUserDataDir = realpathSync(userDataDir);
    const harnessAppName = `Stella v2 Harness ${sha256Text(canonicalUserDataDir).slice(0, 12)}`;
    const rendered = makeRenderedProofs("electron-cdp", [
      "rendered.list-open",
      "rendered.send-terminal",
      "rendered.fail-closed",
      "rendered.mounted-resume",
      "rendered.same-target-reload",
    ]);
    const observation = {
      conversationId: "conversation-primary",
      durableObjectIdSha256: digest("4"),
      journalEpoch: "epoch-primary",
      turnId: "turn-first",
      liveEventCount: 2,
      journalHeadSeq: 10,
      finalTextSha256: digest("5"),
      profileDir,
      harnessAppNameSha256: sha256Text(harnessAppName),
      harnessAppNameProfileBound: true,
      renderedProofs: rendered.entries,
      renderedProofSetSha256: rendered.setSha256,
      renderedCanonicalRowsSha256: digest("e"),
      renderedProcessInstanceSha256: digest("f"),
      doObserved: true,
    };

    expect(() =>
      validateObservation("electron_real_stream", observation),
    ).not.toThrow();

    const crossedProfileName = {
      ...observation,
      harnessAppNameSha256: digest("f"),
    };
    expect(() =>
      validateObservation("electron_real_stream", crossedProfileName),
    ).toThrow("not derived from the canonical isolated userData profile");

    const unbound = { ...observation, harnessAppNameProfileBound: false };
    expect(() => validateObservation("electron_real_stream", unbound)).toThrow(
      "harnessAppNameProfileBound must be true",
    );
  });

  test("runner independently rejects a raw receipt that bypasses the helper schema", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stella-raw-bypass-"));
    try {
      const rawPath = path.join(root, "deployment_identity.jsonl");
      const entries = REQUIRED_RAW_SURFACES.deployment_identity.map(
        (surface, index) => ({
          at: startedAt,
          runId,
          step: "deployment_identity",
          surface,
          operation: "observe-real-product",
          mocked: false,
          synthetic: false,
          ...(index === 0 ? { rawProviderRequestId: "upstream-raw-id" } : {}),
        }),
      );
      const raw = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
      await writeFile(rawPath, raw, "utf8");
      const artifact = {
        path: rawPath,
        sha256: createHash("sha256").update(raw).digest("hex"),
        bytes: Buffer.byteLength(raw),
        entries: entries.length,
      };
      expect(() =>
        validateStepEvidence({
          stepId: "deployment_identity",
          payload: evidencePayload(
            "deployment_identity",
            deploymentObservation(),
            { artifacts: { rawLog: artifact } },
          ),
          runId,
          target,
        }),
      ).toThrow('contains forbidden field "rawProviderRequestId"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("binds the identity envelope to the exact deployed source fingerprint", () => {
    const first = validateObservation(
      "deployment_identity",
      deploymentObservation(),
    );
    expect(() =>
      assertEvidenceIdentityCoherence([
        { id: "deployment_identity", ...first },
      ]),
    ).toThrow("fingerprint does not match");

    const matchingIdentity = {
      ...identity,
      deploymentFingerprintSha256: first.evidence.deploymentFingerprintSha256,
    };
    const matching = validateObservation(
      "deployment_identity",
      deploymentObservation(),
      { identity: matchingIdentity },
    );
    expect(() =>
      assertEvidenceIdentityCoherence([
        { id: "deployment_identity", ...matching },
      ]),
    ).not.toThrow();
  });

  test("requires the deployed canonical prompt digest to match the reviewed 10-prompt source", () => {
    expect(() =>
      validateObservation("deployment_identity", {
        ...deploymentObservation(),
        canonicalPromptCount: 9,
      }),
    ).toThrow("canonicalPromptCount must be an integer >= 10");

    expect(() =>
      validateObservation("deployment_identity", {
        ...deploymentObservation(),
        canonicalPromptMatchesReviewedSource: false,
      }),
    ).toThrow("canonicalPromptMatchesReviewedSource must be true");

    expect(() =>
      validateObservation("deployment_identity", {
        ...deploymentObservation(),
        canonicalPromptRevision: "retired-17-prompt-roster",
      }),
    ).toThrow("canonicalPromptRevision must be a SHA-256 hex digest");
  });

  test("does not let reconnect stand in for a distinct advancing second turn", () => {
    const sameTurn = consecutiveObservation();
    sameTurn.secondTurnId = sameTurn.firstTurnId;
    expect(() =>
      validateObservation("consecutive_durable_turns", sameTurn),
    ).toThrow("distinct turn ids");

    const noAdvance = consecutiveObservation();
    noAdvance.journalHeadSeqAfterSecond = noAdvance.journalHeadSeqBeforeSecond;
    expect(() =>
      validateObservation("consecutive_durable_turns", noAdvance),
    ).toThrow("journalHeadSeqAfterSecond must be an integer");
  });

  test("binds Electron cold hydration to a no-cookie cross-process A-B-A receipt", () => {
    const rendered = makeRenderedProofs("electron-cdp", [
      "rendered.identity-round-trip",
      "rendered.cold-process",
    ]);
    const identityReceipt = rendered.entries[0].receipt;
    const observation = {
      conversationId: "conversation-primary",
      durableObjectIdSha256: digest("4"),
      journalEpoch: "epoch-primary",
      processRestarted: true,
      socketReconnected: true,
      historySha256Before: digest("6"),
      historySha256After: digest("6"),
      journalHeadSeqBefore: 12,
      journalHeadSeqAfter: 12,
      renderedProofs: rendered.entries,
      renderedProofSetSha256: rendered.setSha256,
      previousProcessInstanceSha256: digest("2"),
      currentProcessInstanceSha256: digest("3"),
      previousStopReceiptSha256: digest("7"),
      coldProjectionSha256: digest("6"),
      identityRoundTripSha256: identityReceipt.receiptSha256,
      secondaryProcessBeforeSha256: digest("4"),
      secondaryProcessAfterSha256: digest("5"),
    };
    expect(() =>
      validateObservation("electron_restart_reconnect", observation),
    ).not.toThrow();

    const crossedSecondary = structuredClone(observation);
    crossedSecondary.secondaryProcessAfterSha256 = digest("8");
    expect(() =>
      validateObservation("electron_restart_reconnect", crossedSecondary),
    ).toThrow("not bound to the exact process transitions");
  });

  test("rejects a duplicate whose receipt or journal state changes", () => {
    const changedReceipt = duplicateObservation();
    changedReceipt.replayReceiptSha256 = digest("a");
    expect(() =>
      validateObservation("duplicate_delivery_idempotency", changedReceipt),
    ).toThrow("exact stored receipt");

    const changedHead = duplicateObservation();
    changedHead.journalHeadSeqAfterReplay += 1;
    expect(() =>
      validateObservation("duplicate_delivery_idempotency", changedHead),
    ).toThrow("advanced the journal head");
  });

  test("binds browser routing evidence to the server-derived cloud subject", () => {
    const operations = [
      "rendered.list-open",
      "rendered.send-terminal",
      "rendered.fail-closed",
      "rendered.mounted-resume",
      "rendered.same-target-reload",
      "rendered.cold-process",
      "rendered.storage-recovery",
    ];
    const rendered = makeRenderedProofs("browser-cdp", operations, {
      __receipts: Object.fromEntries(
        operations.map((operation) => [
          operation,
          {
            processInstanceSha256: [
              "rendered.cold-process",
              "rendered.storage-recovery",
            ].includes(operation)
              ? digest("3")
              : digest("2"),
          },
        ]),
      ),
    });
    const observation = {
      conversationId: "conversation-browser",
      turnId: "turn-browser",
      subject: "cloud",
      expectedOwnerGeneration: ownerGeneration,
      chosenLocation: "cloud",
      realSandboxStarted: true,
      localRuntimeStarted: false,
      renderedProofs: rendered.entries,
      renderedProofSetSha256: rendered.setSha256,
      renderedCanonicalRowsSha256: digest("6"),
      renderedProcessInstanceSha256: digest("3"),
      renderedPriorProcessInstanceSha256: digest("2"),
      renderedColdProjectionSha256: digest("6"),
      renderedBrowserStopReceiptSha256: digest("7"),
      renderedStorageRecoverySha256:
        rendered.entries.at(-1).receipt.receiptSha256,
      renderedStorageRecoveryCheckpointSha256: digest("8"),
      renderedStorageRecoveryRequiredHumanAction: true,
      renderedStorageRecoveryCredentialMaterialReturned: false,
      browserUiSubmittedExecutionPlacement: true,
      fenceVerified: true,
    };
    expect(() =>
      validateObservation("browser_cloud_routing", observation),
    ).not.toThrow();

    expect(() =>
      validateObservation("browser_cloud_routing", {
        ...observation,
        subject: "portable",
      }),
    ).toThrow('subject must be "cloud"');

    expect(() =>
      validateObservation("browser_cloud_routing", {
        ...observation,
        expectedOwnerGeneration: "generation-stale",
      }),
    ).toThrow("current acceptance owner generation");
  });

  test("requires a physically closed and joined provider lifecycle before reporting interruption stopped", async () => {
    const profileDir = await mkdtemp(
      path.join(tmpdir(), "stella-local-lifecycle-profile-"),
    );
    const secondaryProfileDir = await mkdtemp(
      path.join(tmpdir(), "stella-local-lifecycle-secondary-"),
    );
    try {
      expect(() =>
        validateObservation(
          "local_runtime_lifecycle",
          localLifecycleObservation(profileDir, secondaryProfileDir),
        ),
      ).not.toThrow();

      const unjoined = localLifecycleObservation(
        profileDir,
        secondaryProfileDir,
      );
      unjoined.interruptedProviderLifecyclePhases =
        unjoined.interruptedProviderLifecyclePhases.slice(0, -1);
      expect(() =>
        validateObservation("local_runtime_lifecycle", unjoined),
      ).toThrow("transport-joined in order");

      const exposed = localLifecycleObservation(
        profileDir,
        secondaryProfileDir,
      );
      exposed.interruptedProviderRawRequestIdExposed = true;
      expect(() =>
        validateObservation("local_runtime_lifecycle", exposed),
      ).toThrow("rawRequestIdExposed must be false");

      const reusedStream = localLifecycleObservation(
        profileDir,
        secondaryProfileDir,
      );
      reusedStream.interruptedProviderStreamOrdinal =
        reusedStream.providerStreamOrdinal;
      expect(() =>
        validateObservation("local_runtime_lifecycle", reusedStream),
      ).toThrow("distinct supervised streams");
    } finally {
      await rm(profileDir, { recursive: true, force: true });
      await rm(secondaryProfileDir, { recursive: true, force: true });
    }
  });

  test("requires cold prompt and malformed canonical history failures before any provider dispatch", () => {
    expect(() =>
      validateObservation(
        "cloud_failure_no_local_fallback",
        coldPromptFailureObservation(),
      ),
    ).not.toThrow();

    const dispatched = coldPromptFailureObservation();
    dispatched.providerDispatchCountAfter += 1;
    expect(() =>
      validateObservation("cloud_failure_no_local_fallback", dispatched),
    ).toThrow("dispatched a model/provider request");

    const fallback = coldPromptFailureObservation();
    fallback.canonicalFallbackPromptUsed = true;
    expect(() =>
      validateObservation("cloud_failure_no_local_fallback", fallback),
    ).toThrow("canonicalFallbackPromptUsed must be false");

    const historyDispatched = coldPromptFailureObservation();
    historyDispatched.canonicalHistoryProviderDispatchCountAfter += 1;
    expect(() =>
      validateObservation("cloud_failure_no_local_fallback", historyDispatched),
    ).toThrow("Malformed canonical history dispatched");

    const skippedCorruption = coldPromptFailureObservation();
    skippedCorruption.canonicalHistoryCorruptRowModelSkip = true;
    expect(() =>
      validateObservation("cloud_failure_no_local_fallback", skippedCorruption),
    ).toThrow("canonicalHistoryCorruptRowModelSkip must be false");

    const changedCorruption = coldPromptFailureObservation();
    changedCorruption.canonicalHistoryCorruptPayloadSha256After = digest("f");
    expect(() =>
      validateObservation("cloud_failure_no_local_fallback", changedCorruption),
    ).toThrow("preserved for repair");

    const noRestartProof = coldPromptFailureObservation();
    noRestartProof.canonicalHistoryRestartObservedFailure = false;
    expect(() =>
      validateObservation("cloud_failure_no_local_fallback", noRestartProof),
    ).toThrow("canonicalHistoryRestartObservedFailure must be true");

    const changedRepair = coldPromptFailureObservation();
    changedRepair.canonicalHistoryRepairedPayloadSha256 = digest("b");
    expect(() =>
      validateObservation("cloud_failure_no_local_fallback", changedRepair),
    ).toThrow("repair was not byte-identical");

    const noRepair = coldPromptFailureObservation();
    noRepair.canonicalHistoryRepairObserved = false;
    expect(() =>
      validateObservation("cloud_failure_no_local_fallback", noRepair),
    ).toThrow("canonicalHistoryRepairObserved must be true");

    const noResumedDispatch = coldPromptFailureObservation();
    noResumedDispatch.canonicalHistoryProviderDispatchCountAfterRepair = 7;
    expect(() =>
      validateObservation("cloud_failure_no_local_fallback", noResumedDispatch),
    ).toThrow(
      "canonicalHistoryProviderDispatchCountAfterRepair must be an integer >= 8",
    );
  });

  test("rejects memory evidence outside the exact owner generation", () => {
    const observation = memoryObservation();
    observation.memoryR2Key = observation.memoryR2Key.replace(
      ownerIdSha256,
      digest("9"),
    );
    expect(() =>
      validateObservation("memory_restart_recall", observation),
    ).toThrow("exact generation-fenced document version for this owner");

    const crossedVersion = memoryObservation();
    crossedVersion.memoryVersionId = "memver-other";
    expect(() =>
      validateObservation("memory_restart_recall", crossedVersion),
    ).toThrow("exact generation-fenced document version for this owner");

    const crossedProfile = memoryObservation();
    crossedProfile.profileR2Key = crossedProfile.profileR2Key.replace(
      ownerIdSha256,
      digest("8"),
    );
    expect(() =>
      validateObservation("memory_restart_recall", crossedProfile),
    ).toThrow("exact generation-fenced profile version for this owner");

    const unboundWrite = memoryObservation();
    unboundWrite.memoryWriteIdempotencySha256 = digest("7");
    expect(() =>
      validateObservation("memory_restart_recall", unboundWrite),
    ).toThrow("not bound to writeTurnId");
  });

  test("requires code mode to reach a real connected MCP service", () => {
    const observation = codeModeObservation();
    observation.realConnectedService = false;
    expect(() =>
      validateObservation("code_mode_real_mcp", observation),
    ).toThrow("realConnectedService must be true");

    const reusedRequest = codeModeObservation();
    reusedRequest.toolsCallRequestIdSha256 =
      reusedRequest.toolsListRequestIdSha256s[0];
    expect(() =>
      validateObservation("code_mode_real_mcp", reusedRequest),
    ).toThrow("request hashes must be distinct");

    const missingPageReceipt = codeModeObservation();
    missingPageReceipt.toolsListRequestIdSha256s.pop();
    expect(() =>
      validateObservation("code_mode_real_mcp", missingPageReceipt),
    ).toThrow("Every MCP tools/list page");

    const crossedDescribe = codeModeObservation();
    crossedDescribe.describedToolIdSha256 = digest("d");
    expect(() =>
      validateObservation("code_mode_real_mcp", crossedDescribe),
    ).toThrow("exact same tool identity");

    const reusedDescribeRequest = codeModeObservation();
    reusedDescribeRequest.describeRequestIdSha256 =
      reusedDescribeRequest.toolsListRequestIdSha256s[1];
    expect(() =>
      validateObservation("code_mode_real_mcp", reusedDescribeRequest),
    ).toThrow("request hashes must be distinct");

    const rawRequestId = codeModeObservation();
    rawRequestId.initializeRequestId = "rpc-initialize";
    expect(() =>
      validateObservation("code_mode_real_mcp", rawRequestId),
    ).toThrow("must not persist raw initializeRequestId");

    const fabricated = codeModeObservation();
    fabricated.inProcessFixture = true;
    expect(() => validateObservation("code_mode_real_mcp", fabricated)).toThrow(
      "inProcessFixture must be false",
    );

    const destructive = codeModeObservation();
    destructive.annotationsDestructive = true;
    expect(() =>
      validateObservation("code_mode_real_mcp", destructive),
    ).toThrow("annotationsDestructive must be false");
  });

  test("requires wipe confirmation, reset-core removal, integration preservation, and generation rotation", () => {
    expect(() =>
      validateObservation(
        "owner_reset_memory_reimport",
        ownerResetObservation(),
      ),
    ).not.toThrow();

    const implicit = ownerResetObservation();
    implicit.implicitReimportBlocked = false;
    expect(() =>
      validateObservation("owner_reset_memory_reimport", implicit),
    ).toThrow("implicitReimportBlocked must be true");

    const staleGeneration = ownerResetObservation();
    staleGeneration.newOwnerGenerationSha256 = generationSha256;
    expect(() =>
      validateObservation("owner_reset_memory_reimport", staleGeneration),
    ).toThrow("distinct generation");

    const residue = ownerResetObservation();
    residue.remainingResetOwnedCoreStoreCount = 1;
    expect(() =>
      validateObservation("owner_reset_memory_reimport", residue),
    ).toThrow("reset-owned core data or old-generation R2 residue");

    const disconnected = ownerResetObservation();
    disconnected.connectedIntegrationPreservedByReset = false;
    expect(() =>
      validateObservation("owner_reset_memory_reimport", disconnected),
    ).toThrow("connectedIntegrationPreservedByReset must be true");

    const changedIntegration = ownerResetObservation();
    changedIntegration.integrationAfterResetSha256 = digest("9");
    expect(() =>
      validateObservation("owner_reset_memory_reimport", changedIntegration),
    ).toThrow("preserve the reviewed connected integration exactly");

    const erasedLocal = ownerResetObservation();
    erasedLocal.localMemoryPreservedByHardReset = false;
    expect(() =>
      validateObservation("owner_reset_memory_reimport", erasedLocal),
    ).toThrow("localMemoryPreservedByHardReset must be true");

    const staleCallbackMultiplicity = ownerResetObservation();
    staleCallbackMultiplicity.mobileGenerationRotation.generationRotation.staleCallbackDropCount = 2;
    sealOwnerResetMobileGenerationObservation(staleCallbackMultiplicity);
    expect(() =>
      validateObservation(
        "owner_reset_memory_reimport",
        staleCallbackMultiplicity,
      ),
    ).toThrow("staleCallbackDropCount must be 1");

    const changedMobileModule = ownerResetObservation();
    changedMobileModule.mobileGenerationRotation.runtime.productModuleSha256[
      "http.ts"
    ] = digest("0");
    sealOwnerResetMobileGenerationObservation(changedMobileModule);
    expect(() =>
      validateObservation("owner_reset_memory_reimport", changedMobileModule),
    ).toThrow("does not match the reviewed product module");

    const barrierSurvived = ownerResetObservation();
    barrierSurvived.mobileGenerationBarrierRemoved = false;
    expect(() =>
      validateObservation("owner_reset_memory_reimport", barrierSurvived),
    ).toThrow("mobileGenerationBarrierRemoved must be true");

    const alteredGenerationSeal = ownerResetObservation();
    alteredGenerationSeal.mobileGenerationResultSha256 = digest("f");
    expect(() =>
      validateObservation("owner_reset_memory_reimport", alteredGenerationSeal),
    ).toThrow("does not seal the complete mounted RN live reset result");
  });

  test("requires the complete mounted RNW v2 continuity, authority, receipt, and truth-boundary proof", () => {
    expect(() =>
      validateObservation(
        "mobile_signed_in_canonical_sync",
        mobileSignedInCanonicalObservation(),
      ),
    ).not.toThrow();

    const fakeRestart = mobileSignedInCanonicalObservation();
    fakeRestart.mountedRn.replay.processIdSha256 =
      fakeRestart.mountedRn.enqueue.processIdSha256;
    sealMobileSignedInCanonicalObservation(fakeRestart);
    expect(() =>
      validateObservation("mobile_signed_in_canonical_sync", fakeRestart),
    ).toThrow("three distinct JavaScript processes");

    const wrongRuntime = mobileSignedInCanonicalObservation();
    wrongRuntime.mountedRn.runtime.bunVersion = "1.3.0";
    sealMobileSignedInCanonicalObservation(wrongRuntime);
    expect(() =>
      validateObservation("mobile_signed_in_canonical_sync", wrongRuntime),
    ).toThrow("Bun 1.4.x");

    const fabricatedModules = mobileSignedInCanonicalObservation();
    fabricatedModules.mountedRn.runtime.productModuleSha256["http.ts"] =
      digest("0");
    sealMobileSignedInCanonicalObservation(fabricatedModules);
    expect(() =>
      validateObservation("mobile_signed_in_canonical_sync", fabricatedModules),
    ).toThrow("does not match the reviewed product module");

    const overstatedNativeBoundary = mobileSignedInCanonicalObservation();
    overstatedNativeBoundary.mountedRn.boundary.expoNativeBinaryProved = true;
    sealMobileSignedInCanonicalObservation(overstatedNativeBoundary);
    expect(() =>
      validateObservation(
        "mobile_signed_in_canonical_sync",
        overstatedNativeBoundary,
      ),
    ).toThrow("expoNativeBinaryProved must be false");

    const nonCanonicalJournal = mobileSignedInCanonicalObservation();
    nonCanonicalJournal.terminalSeq = nonCanonicalJournal.promptSeq;
    expect(() =>
      validateObservation(
        "mobile_signed_in_canonical_sync",
        nonCanonicalJournal,
      ),
    ).toThrow("terminalSeq must be an integer");

    const prematureOutboxAck = mobileSignedInCanonicalObservation();
    prematureOutboxAck.mountedRn.replay.terminalAcknowledgementOrdering.asyncStorageOutboxRemoval =
      prematureOutboxAck.mountedRn.replay.terminalAcknowledgementOrdering.serverTerminalStatus;
    sealMobileSignedInCanonicalObservation(prematureOutboxAck);
    expect(() =>
      validateObservation(
        "mobile_signed_in_canonical_sync",
        prematureOutboxAck,
      ),
    ).toThrow("outbox removal must occur after terminal server status");

    const cursorGap = mobileSignedInCanonicalObservation();
    cursorGap.mountedRn.replay.cursorReconnect.gapCount = 1;
    sealMobileSignedInCanonicalObservation(cursorGap);
    expect(() =>
      validateObservation("mobile_signed_in_canonical_sync", cursorGap),
    ).toThrow("cursorReconnect.gapCount must be 0");

    const noRecoveredRecords = mobileSignedInCanonicalObservation();
    noRecoveredRecords.mountedRn.replay.cursorReconnect.recoveredRecordCount = 0;
    sealMobileSignedInCanonicalObservation(noRecoveredRecords);
    expect(() =>
      validateObservation(
        "mobile_signed_in_canonical_sync",
        noRecoveredRecords,
      ),
    ).toThrow("recoveredRecordCount must be an integer >= 1");

    const identityLeak = mobileSignedInCanonicalObservation();
    identityLeak.mountedRn.replay.identitySwitch.outboxIsolated = false;
    sealMobileSignedInCanonicalObservation(identityLeak);
    expect(() =>
      validateObservation("mobile_signed_in_canonical_sync", identityLeak),
    ).toThrow("outboxIsolated must be true");

    const fallbackNetwork = mobileSignedInCanonicalObservation();
    fallbackNetwork.mountedRn.replay.noLocalFallback.fallbackNetworkCount = 1;
    sealMobileSignedInCanonicalObservation(fallbackNetwork);
    expect(() =>
      validateObservation("mobile_signed_in_canonical_sync", fallbackNetwork),
    ).toThrow("fallbackNetworkCount must be 0");

    const wrongAuthority = mobileSignedInCanonicalObservation();
    wrongAuthority.mountedRn.authority.ownerGenerationSha256 = digest("f");
    wrongAuthority.mountedRn.enqueue.authority.ownerGenerationSha256 =
      digest("f");
    wrongAuthority.mountedRn.replay.authority.ownerGenerationSha256 =
      digest("f");
    wrongAuthority.mountedRn.clean.authority.ownerGenerationSha256 =
      digest("f");
    sealMobileSignedInCanonicalObservation(wrongAuthority);
    expect(() =>
      validateObservation("mobile_signed_in_canonical_sync", wrongAuthority),
    ).toThrow("authority hashes do not bind the exact generation");

    const alteredReceipt = mobileSignedInCanonicalObservation();
    alteredReceipt.mountedRn.replay.receipts[1].operation =
      "mobile.rn.websocket.unreviewed";
    sealMobileSignedInCanonicalObservation(alteredReceipt);
    expect(() =>
      validateObservation("mobile_signed_in_canonical_sync", alteredReceipt),
    ).toThrow("receipts[1].operation must be");

    const unprovedServerFence = mobileSignedInCanonicalObservation();
    unprovedServerFence.serverAuthorityFence.liveSocketIdentitySwitchRejected = false;
    expect(() =>
      validateObservation(
        "mobile_signed_in_canonical_sync",
        unprovedServerFence,
      ),
    ).toThrow("liveSocketIdentitySwitchRejected must be true");

    const alteredSeal = mobileSignedInCanonicalObservation();
    alteredSeal.mountedRnResultSha256 = digest("f");
    expect(() =>
      validateObservation("mobile_signed_in_canonical_sync", alteredSeal),
    ).toThrow("does not seal the complete mounted RN result");
  });

  test("requires the production Apps Host bundle to execute in Workerd and fail closed", () => {
    expect(() =>
      validateObservation(
        "apps_host_workerd_runtime",
        appsHostWorkerdObservation(),
      ),
    ).not.toThrow();

    const notWorkerd = appsHostWorkerdObservation();
    notWorkerd.runtimeEngine = "node";
    expect(() =>
      validateObservation("apps_host_workerd_runtime", notWorkerd),
    ).toThrow('runtimeEngine must be "workerd"');

    const unsafeProxy = appsHostWorkerdObservation();
    unsafeProxy.unauthenticatedProxyBlockedBeforeFetch = false;
    expect(() =>
      validateObservation("apps_host_workerd_runtime", unsafeProxy),
    ).toThrow("unauthenticatedProxyBlockedBeforeFetch must be true");

    const invalidAuthorityServed = appsHostWorkerdObservation();
    invalidAuthorityServed.invalidConfigStatus = 200;
    expect(() =>
      validateObservation("apps_host_workerd_runtime", invalidAuthorityServed),
    ).toThrow("invalidConfigStatus must be 503");

    const stateRetained = appsHostWorkerdObservation();
    stateRetained.isolatedStateRemoved = false;
    expect(() =>
      validateObservation("apps_host_workerd_runtime", stateRetained),
    ).toThrow("isolatedStateRemoved must be true");
  });

  test("requires final cleanup to remove any Apps Host Workerd persistence", () => {
    expect(() =>
      validateObservation("cleanup", cleanupObservation()),
    ).not.toThrow();
    const retained = cleanupObservation();
    retained.appsHostWorkerdStateRemoved = false;
    expect(() => validateObservation("cleanup", retained)).toThrow(
      "appsHostWorkerdStateRemoved must be true",
    );

    const connectedAccountRetained = cleanupObservation();
    connectedAccountRetained.connectedIntegrationRemovedAfterAccountDeletion = false;
    expect(() =>
      validateObservation("cleanup", connectedAccountRetained),
    ).toThrow("connectedIntegrationRemovedAfterAccountDeletion must be true");

    const secondaryResidue = cleanupObservation();
    secondaryResidue.secondaryOwnerResidueRemoved = false;
    expect(() => validateObservation("cleanup", secondaryResidue)).toThrow(
      "secondaryOwnerResidueRemoved must be true",
    );

    const primaryCoreResidue = cleanupObservation();
    primaryCoreResidue.primaryAccountCoreResidueCount = 1;
    expect(() => validateObservation("cleanup", primaryCoreResidue)).toThrow(
      "primaryAccountCoreResidueCount must be 0",
    );

    const reversedRevocationOrder = cleanupObservation();
    reversedRevocationOrder.secondaryRevocationPrecededPrimaryRevocation = false;
    expect(() =>
      validateObservation("cleanup", reversedRevocationOrder),
    ).toThrow("secondaryRevocationPrecededPrimaryRevocation must be true");

    const leakedProcessGroup = cleanupObservation();
    leakedProcessGroup.harnessProcessGroupsStopped = false;
    expect(() => validateObservation("cleanup", leakedProcessGroup)).toThrow(
      "harnessProcessGroupsStopped must be true",
    );

    const retainedTrustedPort = cleanupObservation();
    retainedTrustedPort.trustedLoopbackPortReleased = false;
    expect(() => validateObservation("cleanup", retainedTrustedPort)).toThrow(
      "trustedLoopbackPortReleased must be true",
    );
  });

  test("rejects evidence from another owner or deployed source identity", () => {
    const steps = coherentSteps("/tmp/stella-cloud-identity-test");
    steps[1].identity = { ...identity, ownerIdSha256: digest("8") };
    expect(() => assertEvidenceIdentityCoherence(steps)).toThrow(
      "different deployment, source tree, owner, or owner generation",
    );
  });

  test("binds a discovered skill and asset to one generation-fenced version", () => {
    expect(() =>
      validateObservation("cloud_skill_discovery_use", skillObservation()),
    ).not.toThrow();

    const crossedVersion = skillObservation();
    crossedVersion.assetR2Key = crossedVersion.assetR2Key.replace(
      "skillver-1/files",
      "skillver-other/files",
    );
    expect(() =>
      validateObservation("cloud_skill_discovery_use", crossedVersion),
    ).toThrow("exact versioned skill package");

    const nonNormalizedAsset = skillObservation();
    nonNormalizedAsset.assetPath = "references//example.md";
    nonNormalizedAsset.assetR2Key = nonNormalizedAsset.assetR2Key.replace(
      "references/example.md",
      nonNormalizedAsset.assetPath,
    );
    expect(() =>
      validateObservation("cloud_skill_discovery_use", nonNormalizedAsset),
    ).toThrow("normalized relative path");
  });

  test("ties second turn, restart, memory, sandbox, and child ids together", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stella-cloud-coherence-"));
    const steps = coherentSteps(root);
    expect(() => assertEvidenceCoherence(steps, [root])).not.toThrow();

    const staleReconnect = structuredClone(steps);
    staleReconnect.find(
      (step) => step.id === "electron_restart_reconnect",
    ).evidence.journalHeadSeqBefore = 10;
    expect(() => assertEvidenceCoherence(staleReconnect, [root])).toThrow(
      "post-duplicate DO journal head",
    );

    const wrongChild = structuredClone(steps);
    wrongChild.find(
      (step) => step.id === "child_completion",
    ).evidence.childTurnId = "another-child";
    expect(() => assertEvidenceCoherence(wrongChild, [root])).toThrow(
      "exact real sandbox child",
    );

    const wrongDuplicateDo = structuredClone(steps);
    wrongDuplicateDo.find(
      (step) => step.id === "duplicate_delivery_idempotency",
    ).evidence.durableObjectIdSha256 = digest("f");
    expect(() => assertEvidenceCoherence(wrongDuplicateDo, [root])).toThrow(
      "exact second durable turn",
    );

    const reusedPostResetMcpCall = structuredClone(steps);
    reusedPostResetMcpCall.find(
      (step) => step.id === "owner_reset_memory_reimport",
    ).evidence.postResetMcpCallRequestIdSha256 = digest("7");
    expect(() =>
      assertEvidenceCoherence(reusedPostResetMcpCall, [root]),
    ).toThrow("distinct call through the exact reviewed connected tool");
  });
});

describe("reviewed acceptance driver contract", () => {
  test("refuses to write evidence unless the driver explicitly attests to real non-mock execution", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stella-cloud-driver-"));
    await mkdir(path.join(root, "raw"));
    const context = loadAcceptanceDriverContext("deployment_identity", {
      STELLA_CLOUD_ACCEPTANCE_DRIVER_CONTRACT: ACCEPTANCE_DRIVER_CONTRACT,
      STELLA_CLOUD_ACCEPTANCE_STEP: "deployment_identity",
      STELLA_CLOUD_ACCEPTANCE_RUN_ID: runId,
      STELLA_CLOUD_ACCEPTANCE_EVIDENCE_FILE: path.join(root, "evidence.json"),
      STELLA_CLOUD_ACCEPTANCE_RAW_LOG_FILE: path.join(
        root,
        "raw/deployment_identity.jsonl",
      ),
      CONVEX_DEPLOYMENT: target.deployment,
      CONVEX_URL: target.convexUrl,
      CONVEX_SITE_URL: target.convexSiteUrl,
      CLOUD_BUILDER_URL: target.cloudBuilderUrl,
    });
    await expect(
      writeAcceptanceDriverEvidence(context, {
        attestations: {
          passed: true,
          productPath: true,
          syntheticAssistantRecords: false,
          mocked: true,
          realNetwork: true,
        },
        startedAt,
        finishedAt,
        identity,
        observations: {},
      }),
    ).rejects.toThrow("explicitly attest");
  });

  test("writes only step/run-bound allowlisted receipts to root/raw", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stella-cloud-driver-"));
    await mkdir(path.join(root, "raw"));
    try {
      const evidenceFile = path.join(root, "evidence.json");
      const rawLogFile = path.join(root, "raw/deployment_identity.jsonl");
      const context = loadAcceptanceDriverContext("deployment_identity", {
        STELLA_CLOUD_ACCEPTANCE_DRIVER_CONTRACT: ACCEPTANCE_DRIVER_CONTRACT,
        STELLA_CLOUD_ACCEPTANCE_STEP: "deployment_identity",
        STELLA_CLOUD_ACCEPTANCE_RUN_ID: runId,
        STELLA_CLOUD_ACCEPTANCE_EVIDENCE_FILE: evidenceFile,
        STELLA_CLOUD_ACCEPTANCE_RAW_LOG_FILE: rawLogFile,
        CONVEX_DEPLOYMENT: target.deployment,
        CONVEX_URL: target.convexUrl,
        CONVEX_SITE_URL: target.convexSiteUrl,
        CLOUD_BUILDER_URL: target.cloudBuilderUrl,
      });
      await writeAcceptanceDriverEvidence(context, {
        attestations: {
          passed: true,
          productPath: true,
          syntheticAssistantRecords: false,
          mocked: false,
          realNetwork: true,
        },
        startedAt,
        finishedAt,
        identity,
        observations: { receiptOnly: true },
        rawLog: REQUIRED_RAW_SURFACES.deployment_identity.map((surface) => ({
          at: startedAt,
          surface,
          operation: "observe-real-product",
          mocked: false,
          synthetic: false,
          status: 200,
          outcome: "observed",
          requestIdSha256: digest("a"),
        })),
      });

      const retained = (await readFile(rawLogFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(retained).toHaveLength(4);
      expect(retained.every((entry) => entry.runId === runId)).toBe(true);
      expect(
        retained.every((entry) => entry.step === "deployment_identity"),
      ).toBe(true);
      const evidence = JSON.parse(await readFile(evidenceFile, "utf8"));
      expect(evidence.artifacts.rawLog.path).toBe(realpathSync(rawLogFile));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects missing product surfaces, stale timestamps, and arbitrary receipt fields", () => {
    const base = REQUIRED_RAW_SURFACES.deployment_identity.map((surface) => ({
      at: startedAt,
      runId,
      step: "deployment_identity",
      surface,
      operation: "observe-real-product",
      mocked: false,
      synthetic: false,
    }));
    expect(() =>
      validateAcceptanceRawLogEntries({
        step: "deployment_identity",
        runId,
        startedAt,
        finishedAt,
        entries: base.slice(1),
      }),
    ).toThrow("missing the git product surface");

    expect(() =>
      validateAcceptanceRawLogEntries({
        step: "deployment_identity",
        runId,
        startedAt,
        finishedAt,
        entries: base.map((entry) => ({
          ...entry,
          at: "2026-08-26T11:59:59.000Z",
        })),
      }),
    ).toThrow("outside the evidence interval");

    expect(() =>
      validateAcceptanceRawLogEntries({
        step: "deployment_identity",
        runId,
        startedAt,
        finishedAt,
        entries: base.map((entry, index) =>
          index === 0 ? { ...entry, prompt: "raw user text" } : entry,
        ),
      }),
    ).toThrow('contains forbidden field "prompt"');
  });
});
