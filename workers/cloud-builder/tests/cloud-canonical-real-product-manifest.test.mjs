import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import { STELLA_PROMPT_IDS } from "@stella/contracts/stella-prompts";
import { MOBILE_RN_CHILD_TIMEOUT_OVERHEAD_MS as MOBILE_RN_ORCHESTRATOR_CHILD_TIMEOUT_OVERHEAD_MS } from "../../../packages/mobile/scripts/cloud-canonical-rn-acceptance.mjs";

import {
  HARNESS_SUBDIRECTORIES,
  REAL_PRODUCT_HUMAN_ACTION,
  REAL_PRODUCT_STEP_IDS,
  REAL_PRODUCT_TARGET,
  resolveDisposableHarnessRoot,
} from "../scripts/cloud-canonical-real-product-manifest.mjs";
import {
  AUTHORITY_RUNWAY_EXHAUSTED,
  AUTHORITY_RUNWAY_EXHAUSTED_EXIT_CODE,
  CANONICAL_PROMPT_IDS,
  CANONICAL_PROMPT_SOURCES,
  MOBILE_RN_CHILD_TIMEOUT_OVERHEAD_MS,
  MOBILE_RN_GENERATION_PHASE_TIMEOUT_MS,
  MOBILE_RN_GENERATION_MAX_NO_REFRESH_WINDOW_MS,
  MOBILE_RN_PHASE_MAX_NO_REFRESH_WINDOW_MS,
  OWNER_RESET_CONTINUATION_RESERVE_MS,
  REAL_PRODUCT_DRIVER_STEP_IDS,
  REFRESHED_JWT_MINIMUM_RUNWAY_MS,
  assertNoSerializedCredentialMaterial,
  assertRefreshedJwtRunway,
  assertJwtAuthorityThroughDeadline,
  canonicalPromptSourceBody,
  commandResult,
  isolatedElectronEnvironment,
  parseDetachedProcessGroupId,
  parseJwtIdentity,
  parseDevToolsActivePort,
  parseTrustedViteListenerRecords,
  reviewedMemoryArchitectureBoundary,
} from "../scripts/cloud-canonical-real-product-driver.mjs";
import {
  ACCEPTANCE_DRIVER_CONTRACT,
  AUTHORITY_RUNWAY_EXHAUSTED_EXIT_CODE as RUNNER_AUTHORITY_RUNWAY_EXHAUSTED_EXIT_CODE,
  REQUIRED_STEP_IDS,
} from "../scripts/cloud-canonical-acceptance.mjs";

const generator = fileURLToPath(
  new URL(
    "../scripts/cloud-canonical-real-product-manifest.mjs",
    import.meta.url,
  ),
);
const runner = fileURLToPath(
  new URL("../scripts/cloud-canonical-acceptance.mjs", import.meta.url),
);
const driver = fileURLToPath(
  new URL(
    "../scripts/cloud-canonical-real-product-driver.mjs",
    import.meta.url,
  ),
);
const repoRoot = realpathSync(
  fileURLToPath(new URL("../../..", import.meta.url)),
);

const createRoot = () =>
  mkdtemp(path.join(tmpdir(), "stella-cloud-real-product-manifest-"));

const runGenerator = (root, ...extra) =>
  Bun.spawnSync(["node", generator, "--root", root, ...extra], {
    stdout: "pipe",
    stderr: "pipe",
  });

const parseGeneratedManifest = async (root, manifestPath) =>
  JSON.parse(
    await readFile(manifestPath ?? path.join(root, "manifest.json"), "utf8"),
  );

const EXPECTED_CANONICAL_PROMPT_SOURCES = [
  [
    "agents/orchestrator.md",
    "agent-metadata",
    "agent-metadata/orchestrator.md",
  ],
  ["agents/general.md", "agent-metadata", "agent-metadata/general.md"],
  ["agents/fashion.md", "agent-metadata", "agent-metadata/fashion.md"],
  [
    "agents/social_session.md",
    "agent-metadata",
    "agent-metadata/social_session.md",
  ],
  ["agents/explore.md", "agent-metadata", "agent-metadata/explore.md"],
  ["prompts/thread-compaction.md", "prompt", "prompts/thread-compaction.md"],
  [
    "prompts/fallback-orchestrator.md",
    "prompt",
    "prompts/fallback-orchestrator.md",
  ],
  ["prompts/fallback-subagent.md", "prompt", "prompts/fallback-subagent.md"],
  ["prompts/personality-stella.md", "prompt", "prompts/personality-stella.md"],
  [
    "prompts/personality-professional.md",
    "prompt",
    "prompts/personality-professional.md",
  ],
].map(([id, kind, suffix]) => ({
  id,
  kind,
  relativePath: `packages/runtime/extensions/stella-runtime/${suffix}`,
}));

describe("real-product acceptance manifest generator", () => {
  test("derives the Convex owner fence from the issuer-qualified JWT subject", () => {
    const issuer = "https://basic-nightingale-118.convex.site";
    const subject = "better-auth-user-1";
    const encoded = (value) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const jwt = `${encoded({ alg: "RS256", typ: "JWT" })}.${encoded({
      iss: issuer,
      sub: subject,
      exp: Math.ceil(Date.now() / 1_000) + 600,
    })}.signature`;
    expect(parseJwtIdentity(jwt)).toEqual({
      issuer,
      subject,
      tokenIdentifier: `${issuer}|${subject}`,
      exp: expect.any(Number),
    });
  });

  test("refreshes 30-minute product authority before every bounded window", () => {
    const nowMs = 2_000_000_000_000;
    const fresh = { exp: (nowMs + 30 * 60_000) / 1_000 };
    expect(
      assertRefreshedJwtRunway(fresh, "long mobile phase", { nowMs }),
    ).toBe(fresh);
    expect(
      assertJwtAuthorityThroughDeadline(fresh, "mounted RN phase", {
        nowMs,
        deadlineMs: nowMs + MOBILE_RN_PHASE_MAX_NO_REFRESH_WINDOW_MS,
      }),
    ).toBe(fresh);
    expect(
      assertJwtAuthorityThroughDeadline(fresh, "generation phase", {
        nowMs,
        deadlineMs: nowMs + MOBILE_RN_GENERATION_MAX_NO_REFRESH_WINDOW_MS,
      }),
    ).toBe(fresh);

    const afterHumanDelay = nowMs + 12 * 60_000;
    let failure;
    try {
      assertJwtAuthorityThroughDeadline(fresh, "stale generation phase", {
        nowMs: afterHumanDelay,
        deadlineMs:
          afterHumanDelay + MOBILE_RN_GENERATION_MAX_NO_REFRESH_WINDOW_MS,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure?.details?.code).toBe(AUTHORITY_RUNWAY_EXHAUSTED);
    expect(failure?.details?.remainingRunwayMs).toBe(18 * 60_000);

    const refreshed = {
      exp: (afterHumanDelay + 30 * 60_000) / 1_000,
    };
    expect(
      assertJwtAuthorityThroughDeadline(refreshed, "refreshed generation", {
        nowMs: afterHumanDelay,
        deadlineMs:
          afterHumanDelay + MOBILE_RN_GENERATION_MAX_NO_REFRESH_WINDOW_MS,
      }),
    ).toBe(refreshed);
  });

  test("keeps every no-refresh child window below the mint runway", () => {
    expect(AUTHORITY_RUNWAY_EXHAUSTED_EXIT_CODE).toBe(76);
    expect(RUNNER_AUTHORITY_RUNWAY_EXHAUSTED_EXIT_CODE).toBe(
      AUTHORITY_RUNWAY_EXHAUSTED_EXIT_CODE,
    );
    expect(MOBILE_RN_CHILD_TIMEOUT_OVERHEAD_MS).toBe(
      MOBILE_RN_ORCHESTRATOR_CHILD_TIMEOUT_OVERHEAD_MS,
    );
    expect(MOBILE_RN_PHASE_MAX_NO_REFRESH_WINDOW_MS).toBe(12 * 60_000);
    expect(MOBILE_RN_GENERATION_MAX_NO_REFRESH_WINDOW_MS).toBe(19 * 60_000);
    expect(OWNER_RESET_CONTINUATION_RESERVE_MS).toBe(12 * 60_000);
    expect(OWNER_RESET_CONTINUATION_RESERVE_MS).toBeLessThan(
      MOBILE_RN_GENERATION_PHASE_TIMEOUT_MS,
    );
    for (const windowMs of [
      MOBILE_RN_PHASE_MAX_NO_REFRESH_WINDOW_MS,
      MOBILE_RN_GENERATION_MAX_NO_REFRESH_WINDOW_MS,
    ]) {
      expect(windowMs).toBeLessThan(REFRESHED_JWT_MINIMUM_RUNWAY_MS);
    }
  });

  test("rejects a child that exits zero only after its checked deadline", async () => {
    const startedAt = Date.now();
    let failure;
    try {
      await commandResult(
        realpathSync(process.execPath),
        [
          "-e",
          'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);',
        ],
        {
          timeoutMs: 50,
          terminationGraceMs: 50,
          authorityIdentities: [
            {
              identity: {
                exp: Math.ceil((Date.now() + 30 * 60_000) / 1_000),
              },
              label: "fake-clock bounded child",
            },
          ],
        },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure?.details?.code).toBe(AUTHORITY_RUNWAY_EXHAUSTED);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("refreshes isolated product profiles around each mounted RN phase", async () => {
    const [source, runnerSource] = await Promise.all([
      readFile(driver, "utf8"),
      readFile(runner, "utf8"),
    ]);
    expect(source).toContain("const runMountedRnPhase = async");
    expect(source).toContain('runMountedRnPhase("enqueue_response_loss")');
    expect(source).toContain('runMountedRnPhase("replay_reconnect_switch"');
    expect(source).toContain('runMountedRnPhase("clean_hydrate")');
    expect(source).toContain('STELLA_MOBILE_RN_ACCEPTANCE_MODE: "phase"');
    expect(source).toContain(
      "minimumRunwayMs: MOBILE_RN_PHASE_MAX_NO_REFRESH_WINDOW_MS",
    );
    expect(source).toContain("deadlineMs: mobileGeneration.proofDeadlineAt");
    expect(source).toContain("OWNER_RESET_CONTINUATION_RESERVE_MS");
    expect(source).not.toContain("timeoutMs: 29 * 60_000");
    expect(source).toContain(
      "error.details?.code === AUTHORITY_RUNWAY_EXHAUSTED",
    );
    expect(runnerSource).toContain(
      "result.code === AUTHORITY_RUNWAY_EXHAUSTED_EXIT_CODE",
    );
    expect(runnerSource).toContain("code: AUTHORITY_RUNWAY_EXHAUSTED");
    expect(runnerSource).toContain("detached: DRIVER_PROCESS_GROUPS");
    expect(runnerSource).toContain("process.kill(-child.pid, signal)");
  });

  test("rejects raw credentials from every private acceptance-state write", () => {
    const digest = "a".repeat(64);
    expect(
      assertNoSerializedCredentialMaterial({
        jwtSha256: digest,
        sessionIdSha256: digest,
        credentialMaterialReturned: false,
        cookieSetupUseCount: 0,
        sessionProtectedAtRest: true,
      }),
    ).toBe(true);
    expect(() =>
      assertNoSerializedCredentialMaterial({ jwt: "raw.jwt.credential" }),
    ).toThrow("raw authority material");
    expect(() =>
      assertNoSerializedCredentialMaterial({ sessionId: "raw-session" }),
    ).toThrow("raw authority material");
    expect(() =>
      assertNoSerializedCredentialMaterial(
        { innocentField: "known-private-cookie-value" },
        ["known-private-cookie-value"],
      ),
    ).toThrow("known credential or inbox value");
    expect(() =>
      assertNoSerializedCredentialMaterial({
        opaque: `${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}`,
      }),
    ).toThrow("serialized credential material");
  });

  test("binds every required id to the reviewed executable with no receipt-import seam", async () => {
    expect(REAL_PRODUCT_DRIVER_STEP_IDS).toEqual(REQUIRED_STEP_IDS);
    expect(REAL_PRODUCT_DRIVER_STEP_IDS).toEqual(REAL_PRODUCT_STEP_IDS);
    expect(new Set(REAL_PRODUCT_DRIVER_STEP_IDS).size).toBe(
      REQUIRED_STEP_IDS.length,
    );
    expect(CANONICAL_PROMPT_IDS).toEqual(STELLA_PROMPT_IDS);

    const source = await readFile(driver, "utf8");
    expect(source).not.toContain("requireDeployedScenarioReceipt");
    expect(source).not.toContain("STELLA_CLOUD_ACCEPTANCE_OBSERVATION_FILE");
    expect(source).not.toContain("STELLA_CLOUD_ACCEPTANCE_DRIVER_COMMAND");
    expect(source).toContain("/api/stella/prompts");
    expect(source).toContain("packages/runtime/extensions/stella-runtime");
    expect(source).not.toContain("packages/backend/prompts/stella-runtime");
    expect(source).toContain("const accountScope = `account:${jwtSubject}`");
    expect(source).not.toContain(
      "const accountScope = `account:${owner.ownerId}`",
    );
    expect(source).toContain("STELLA_DATA_DIR: dataDir");
    expect(source).toMatch(
      /"deploy",\s*"--dry-run",\s*"--env",\s*REQUIRED_CLOUDFLARE_ENVIRONMENT/u,
    );
    expect(source).toContain("REQUIRED_AGENT_HOME_BUCKET_NAME");
    expect(source).toContain("REQUIRED_CONVERSATION_ARCHIVE_BUCKET_NAME");
    expect(source).not.toMatch(
      /["']stella-v2-(?:app-builds|agent-home|conversation-archive)-dev["']/u,
    );
    expect(source).toContain(
      'path.join(paths.profileDirectory, "vite-server", "data")',
    );
    expect(source).toContain("canonicalPromptMatchesReviewedSource: true");
    expect(source).toContain("connectedIntegrationPreservedByReset");
    expect(source).toContain('"mcp.post-reset.real-read"');
    expect(source).toContain(
      '"composio_purge:remainingOwnerComposioSessionsInternal"',
    );
    expect(source).toContain("connectedIntegrationRemovedAfterAccountDeletion");
    expect(source).toContain("secondaryTestAccountRevoked");
    expect(source).toContain("secondaryOwnerResidueRemoved");
    expect(source).toContain("electron.process-logs.privacy-scan");
    expect(source).toContain(
      "mobile_signed_in_canonical_sync: stepMobileMountedRnCanonicalSync",
    );
    expect(source).toContain(
      "packages/mobile/scripts/cloud-canonical-rn-acceptance.mjs",
    );
    expect(source).not.toContain(
      "packages/mobile/scripts/cloud-canonical-real-acceptance.ts",
    );
    expect(source).not.toContain("STELLA_MOBILE_ACCEPTANCE_OUTBOX_FILE");
    expect(source).not.toContain("STELLA_MOBILE_ACCEPTANCE_PHASE");
    expect(source).toContain(
      'STELLA_MOBILE_RN_ACCEPTANCE_MODE: "post_reset_generation"',
    );
    expect(source).toContain("expectedCloseCode: 4404");
    expect(source).toContain("expectedCloseCode: 4403");
    expect(source).toContain("expectedStatuses: [403]");
    expect(source).toContain("Sign in with an account to use Stella mobile.");
    expect(source).toContain("mobile.anonymous-policy-rejection.submit");
    expect(source).toContain(
      '"STELLA_CLOUD_ACCEPTANCE_SECONDARY_DISPOSABLE_EMAIL"',
    );
    expect(source).toContain(
      'secondary.identityClass === "connected-secondary"',
    );
    expect(source).toContain("jwt: secondarySecrets.jwt");
    expect(source).toContain("headers: userHeaders(anonymousSecrets)");
    expect(source).toContain("disposeAnonymousMobilePolicyAccount");
    expect(source).toContain('"STELLA_CLOUD_ACCEPTANCE_SECONDARY_JWT",');
    expect(source).toContain(
      '"STELLA_CLOUD_ACCEPTANCE_SECONDARY_SESSION_COOKIE",',
    );
    expect(source).toContain(
      "must be absent; authority is refreshed from the isolated product profile.",
    );
    expect(source).toContain("startBoundedCommand(bunBinary, [harnessFile]");
    expect(source).toContain("await terminateBoundedCommands()");
    const streamingChatSource = await readFile(
      path.join(
        repoRoot,
        "packages/desktop-ui/src/features/chat/hooks/use-streaming-chat-core.ts",
      ),
      "utf8",
    );
    expect(streamingChatSource).not.toContain("cleanedText.slice(0, 200)");
    expect(streamingChatSource).not.toMatch(/\|\s*text=\$\{/u);
    expect(streamingChatSource).toContain("textLength=${cleanedText.length}");
    expect(source).toContain("expectedOwnerGeneration: owner.ownerGeneration");
    const legacyChatAdmissions = source.match(/startCloudChat/gu) ?? [];
    const generationFencedLegacyChatAdmissions = source.match(
      /startCloudChat[\s\S]{0,320}?expectedOwnerGeneration/gu,
    );
    expect(legacyChatAdmissions).toHaveLength(8);
    expect(generationFencedLegacyChatAdmissions).toHaveLength(
      legacyChatAdmissions.length,
    );
    expect(source).toContain(
      "Reviewed source tree changed after deployment identity was attested.",
    );
    expect(source).not.toContain("connectedIntegrationPurgedByReset");
    for (const id of REQUIRED_STEP_IDS) {
      expect(source).toMatch(new RegExp(`\\b${id}:\\s*step[A-Z]`, "u"));
    }
  });

  test("keeps proof secrets out of Electron and accepts only owned loopback endpoints", async () => {
    const source = await readFile(driver, "utf8");
    expect(source).toContain("versionResult.output.trim().length > 0");
    expect(source).not.toContain("versionResult.code === 0");
    expect(
      isolatedElectronEnvironment({
        PATH: "/reviewed/bin",
        LANG: "en_US.UTF-8",
        STELLA_CLOUD_PROOF_JWT: "must-not-leak",
        BUILDER_SERVICE_SECRET: "must-not-leak",
        CONVEX_DEPLOY_KEY: "must-not-leak",
        CLOUDFLARE_API_TOKEN: "must-not-leak",
      }),
    ).toEqual({ PATH: "/reviewed/bin", LANG: "en_US.UTF-8" });
    expect(parseDevToolsActivePort("49152\n/devtools/browser/abc-123\n")).toBe(
      49152,
    );
    expect(() =>
      parseDevToolsActivePort("49152\n/devtools/page/foreign-target\n"),
    ).toThrow("invalid browser endpoint");
    expect(() =>
      parseDevToolsActivePort("9333\n/devtools/browser/abc\nforeign\n"),
    ).toThrow("invalid browser endpoint");
    expect(
      parseTrustedViteListenerRecords("p4242\nn127.0.0.1:57314\n", {
        pid: 4242,
      }),
    ).toEqual([{ pid: 4242, address: "127.0.0.1:57314" }]);
    for (const output of [
      "p4242\nn*:57314\n",
      "p4242\nn[::1]:57314\n",
      "p4343\nn127.0.0.1:57314\n",
      "p4242\nn127.0.0.1:57314\np4343\nn127.0.0.1:57314\n",
    ]) {
      expect(() =>
        parseTrustedViteListenerRecords(output, { pid: 4242 }),
      ).toThrow("exact IPv4 loopback");
    }
    expect(source).toContain("const vitePortForRun = (_runId) => 57_314");
    expect(source).toContain(
      "Trusted loopback port ${port} is already owned by another process",
    );
    expect(parseDetachedProcessGroupId(" 4242\n", 4242)).toBe(4242);
    expect(() => parseDetachedProcessGroupId("4243\n", 4242)).toThrow(
      "no longer the leader",
    );
    expect(source).toContain('process.kill(-pid, "SIGTERM")');
    expect(source).toContain("pid was recycled or replaced before shutdown");
    expect(source.match(/"Cleanup Vite process fingerprint"/gu)).toHaveLength(
      2,
    );
    expect(source.match(/"Cleanup Vite listener-address set"/gu)).toHaveLength(
      2,
    );
    expect(source).toContain('"Recorded secondary Vite state"');
  });

  test("pins authoritative parent memory and explicit child context boundaries", async () => {
    await expect(reviewedMemoryArchitectureBoundary()).resolves.toEqual({
      authoritativeMemoryLoadedAtTurnStartup: true,
      authoritativePersonalityLoadedAtTurnStartup: true,
      authoritativeContextFailureBlocksTurn: true,
      childTaskContextExplicitOnly: true,
      childPinnedSkillCatalog: true,
      childImplicitFullMemoryDump: false,
      sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  test("binds the runtime roster and removes only agent frontmatter plus its separator", async () => {
    expect(CANONICAL_PROMPT_SOURCES).toEqual(EXPECTED_CANONICAL_PROMPT_SOURCES);
    expect(CANONICAL_PROMPT_SOURCES.map(({ id }) => id)).toEqual(
      STELLA_PROMPT_IDS,
    );
    for (const source of CANONICAL_PROMPT_SOURCES) {
      const raw = await readFile(
        path.join(repoRoot, source.relativePath),
        "utf8",
      );
      const body = canonicalPromptSourceBody(raw, source);
      if (source.kind === "agent-metadata") {
        const frontmatter = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n\r?\n/u);
        expect(frontmatter).not.toBeNull();
        expect(body).toBe(raw.slice(frontmatter[0].length));
      } else {
        expect(body).toBe(raw);
      }
      expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(0);
    }

    const exactBody = "  keep leading spaces\r\nkeep trailing blanks\r\n\r\n";
    expect(
      canonicalPromptSourceBody(
        `---\r\nname: Exact\r\n---\r\n\r\n${exactBody}`,
        {
          id: "agents/exact.md",
          kind: "agent-metadata",
        },
      ),
    ).toBe(exactBody);
    expect(
      canonicalPromptSourceBody(exactBody, {
        id: "prompts/exact.md",
        kind: "prompt",
      }),
    ).toBe(exactBody);
    expect(() =>
      canonicalPromptSourceBody("---\nname: Missing separator\n---\nbody", {
        id: "agents/missing-separator.md",
        kind: "agent-metadata",
      }),
    ).toThrow("required blank separator");
  });

  test("the reviewed executable fails closed before product work without runner context", async () => {
    const declaredRoot = await createRoot();
    try {
      const result = Bun.spawnSync(["node", driver, "deployment_identity"], {
        cwd: declaredRoot,
        env: { PATH: process.env.PATH ?? "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toContain(
        "STELLA_CLOUD_ACCEPTANCE_DRIVER_CONTRACT is required",
      );
      expect(await readdir(declaredRoot)).toEqual([]);
    } finally {
      await rm(declaredRoot, { recursive: true, force: true });
    }
  });

  test("emits the complete reviewed-driver manifest and only the narrow harness layout", async () => {
    const declaredRoot = await createRoot();
    try {
      const root = realpathSync(declaredRoot);
      const result = runGenerator(root);
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);

      const manifestPath = path.join(root, "manifest.json");
      const manifest = await parseGeneratedManifest(root);
      expect(manifest.version).toBe(3);
      expect(manifest.stepCount).toBe(REQUIRED_STEP_IDS.length);
      expect(REAL_PRODUCT_TARGET).toEqual({
        convexDeployment: "preview:basic-nightingale-118",
        convexUrl: "https://basic-nightingale-118.convex.cloud",
        convexSiteUrl: "https://basic-nightingale-118.convex.site",
        cloudBuilderUrl:
          "https://stella-v2-cloud-builder-basic-nightingale-118.lolruuxi.workers.dev",
      });
      expect(manifest.target).toEqual(REAL_PRODUCT_TARGET);
      expect(manifest.isolatedRoots).toEqual([root]);
      expect(manifest.output).toBe(path.join(root, "evidence", "report.json"));
      expect(REAL_PRODUCT_STEP_IDS).toHaveLength(REQUIRED_STEP_IDS.length);
      expect(REAL_PRODUCT_STEP_IDS).toEqual(REQUIRED_STEP_IDS);
      expect(manifest.steps.map((step) => step.id)).toEqual(REQUIRED_STEP_IDS);
      expect(
        new Set(manifest.steps.map((step) => step.evidenceFile)).size,
      ).toBe(REQUIRED_STEP_IDS.length);

      const reviewedDriver = realpathSync(driver);
      for (const step of manifest.steps) {
        expect(step.humanAction).toBe(
          REAL_PRODUCT_HUMAN_ACTION[step.id] ?? "none",
        );
        expect(step.driverContract).toBe(ACCEPTANCE_DRIVER_CONTRACT);
        expect(step.driverFile).toBe(reviewedDriver);
        expect(step.command).toEqual(["node", reviewedDriver, step.id]);
        expect(step.cwd).toBe(root);
        expect(step.evidenceFile).toBe(
          path.join(root, "evidence", `${step.id}.json`),
        );
        expect(step.timeoutMs).toBeGreaterThanOrEqual(300_000);
        expect(step.timeoutMs).toBeLessThanOrEqual(3_600_000);
      }
      const mountedMobileStep = manifest.steps.find(
        (step) => step.id === "mobile_signed_in_canonical_sync",
      );
      expect(mountedMobileStep.timeoutMs).toBe(60 * 60_000);
      expect(mountedMobileStep.timeoutMs).toBeGreaterThan(
        3 * MOBILE_RN_PHASE_MAX_NO_REFRESH_WINDOW_MS,
      );

      expect((await readdir(root)).sort()).toEqual(
        [...HARNESS_SUBDIRECTORIES, path.basename(manifestPath)].sort(),
      );
      for (const directory of HARNESS_SUBDIRECTORIES) {
        expect(await readdir(path.join(root, directory))).toEqual([]);
      }
    } finally {
      await rm(declaredRoot, { recursive: true, force: true });
    }
  });

  test("produces a manifest accepted by the strict runner check", async () => {
    const declaredRoot = await createRoot();
    try {
      const root = realpathSync(declaredRoot);
      const manifestPath = path.join(root, "reviewed-manifest.json");
      const generated = runGenerator(root, "--manifest", manifestPath);
      expect(generated.stderr.toString()).toBe("");
      expect(generated.exitCode).toBe(0);

      const checked = Bun.spawnSync(["node", runner, "--check", manifestPath], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(checked.stderr.toString()).toBe("");
      expect(checked.exitCode).toBe(0);
      expect(checked.stdout.toString()).toContain(
        "structurally valid for preview:basic-nightingale-118",
      );
    } finally {
      await rm(declaredRoot, { recursive: true, force: true });
    }
  });

  test("rejects relative, broad, home, workspace, and live-state roots", () => {
    const rejectedRoots = [
      "relative/root",
      path.parse(repoRoot).root,
      tmpdir(),
      homedir(),
      path.join(homedir(), "Documents"),
      path.join(homedir(), ".stella"),
      path.dirname(repoRoot),
      repoRoot,
      path.join(repoRoot, "workers"),
    ];

    for (const rejected of rejectedRoots) {
      expect(() => resolveDisposableHarnessRoot(rejected)).toThrow();
    }
  });

  test("rejects forbidden targets and manifests outside the disposable root before creating layout", async () => {
    const declaredRoot = await createRoot();
    const forbiddenRoot = path.join(
      declaredRoot,
      "flexible-panther-999-acceptance",
    );
    await mkdir(forbiddenRoot);
    try {
      const forbidden = runGenerator(forbiddenRoot);
      expect(forbidden.exitCode).not.toBe(0);
      expect(forbidden.stderr.toString()).toContain("forbidden historical");
      expect(await readdir(forbiddenRoot)).toEqual([]);

      const safeRoot = path.join(declaredRoot, "safe", "acceptance");
      await mkdir(path.dirname(safeRoot));
      await mkdir(safeRoot);
      const outsideManifest = path.join(declaredRoot, "outside.json");
      const outside = runGenerator(safeRoot, "--manifest", outsideManifest);
      expect(outside.exitCode).not.toBe(0);
      expect(outside.stderr.toString()).toContain(
        "must remain inside the disposable --root",
      );
      expect(await readdir(safeRoot)).toEqual([]);
      expect(existsSync(outsideManifest)).toBe(false);
    } finally {
      await rm(declaredRoot, { recursive: true, force: true });
    }
  });

  test("never overwrites an existing manifest or partially creates a blocked layout", async () => {
    const declaredRoot = await createRoot();
    try {
      const root = realpathSync(declaredRoot);
      const first = runGenerator(root);
      expect(first.stderr.toString()).toBe("");
      expect(first.exitCode).toBe(0);
      const manifestPath = path.join(root, "manifest.json");
      const original = await readFile(manifestPath, "utf8");
      const entries = (await readdir(root)).sort();

      const repeated = runGenerator(root);
      expect(repeated.exitCode).not.toBe(0);
      expect(repeated.stderr.toString()).toContain(
        "Manifest already exists; refusing to overwrite it",
      );
      expect(await readFile(manifestPath, "utf8")).toBe(original);
      expect((await readdir(root)).sort()).toEqual(entries);

      const blockedRoot = path.join(root, "blocked", "acceptance");
      await mkdir(path.dirname(blockedRoot));
      await mkdir(blockedRoot);
      await mkdir(path.join(blockedRoot, "state"));
      const blocked = runGenerator(blockedRoot);
      expect(blocked.exitCode).not.toBe(0);
      expect(blocked.stderr.toString()).toContain(
        "Harness directory already exists; refusing to overwrite it",
      );
      expect(await readdir(blockedRoot)).toEqual(["state"]);
    } finally {
      await rm(declaredRoot, { recursive: true, force: true });
    }
  });
});
