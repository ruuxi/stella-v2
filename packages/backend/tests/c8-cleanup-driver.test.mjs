import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  ARM_CONFIRMATION,
  CLEANUP_PHASES,
  DESTRUCTIVE_CONFIRMATION,
  TARGET_DEPLOYMENT,
  atomicWriteRestrictedJson,
  createConvexRunner,
  parseArgs,
  runDriver,
} from "../scripts/c8-cleanup-driver-lib.mjs";

const temporaryPaths = [];
const makeTemporaryDirectory = () => {
  const path = mkdtempSync(join(tmpdir(), "stella-c8-driver-"));
  temporaryPaths.push(path);
  return path;
};

afterEach(() => {
  while (temporaryPaths.length > 0) {
    rmSync(temporaryPaths.pop(), { recursive: true, force: true });
  }
});

const exactEnv = { CONVEX_DEPLOYMENT: TARGET_DEPLOYMENT };

const zeroRunner = (calls) => (name) => {
  calls.push(name);
  if (name.endsWith(":getWriterCutoverStatusInternal")) {
    return {
      deployment: TARGET_DEPLOYMENT,
      cloudUrlMatches: true,
      siteUrlMatches: true,
      retiredWritesDisabled: true,
    };
  }
  if (name.endsWith(":getDurableCutoverStateInternal")) {
    return { closed: true, barrierClosesAt: 1 };
  }
  if (name.endsWith(":auditPhaseInternal")) {
    return {
      scanned: 0,
      matched: 0,
      retainedSharedR2Objects: 0,
      identifiers: [],
      isDone: true,
      continueCursor: "",
    };
  }
  if (
    name.endsWith(":getStoreLocatorManifestPageInternal") ||
    name.endsWith(":getStoreReleaseManifestPageInternal") ||
    name.endsWith(":getUserPetOrphanManifestPageInternal")
  ) {
    return { manifests: [], isDone: true, continueCursor: "" };
  }
  if (
    name.endsWith(":getUserPetManifestInternal") ||
    name.endsWith(":getNextStoreReleaseManifestInternal")
  ) {
    return null;
  }
  if (name.endsWith(":runDatabaseBatchInternal")) {
    return {
      deletedRows: 0,
      deletedStorageObjects: 0,
      patchedRows: 0,
      hasMore: false,
    };
  }
  throw new Error(`Unexpected fake Convex call: ${name}`);
};

describe("c8 cleanup driver", () => {
  test("defaults to dry-run and requires exact confirmations", () => {
    assert.equal(parseArgs([]).mode, "dry-run");
    assert.throws(() => parseArgs(["--execute"]), /exact destructive/u);
    assert.throws(() => parseArgs(["--arm"]), /exact writer-cutover/u);
    assert.equal(
      parseArgs(["--execute", "--confirm", DESTRUCTIVE_CONFIRMATION]).mode,
      "execute",
    );
    assert.equal(
      parseArgs(["--arm", "--confirm", ARM_CONFIRMATION]).mode,
      "arm",
    );
  });

  test("atomically writes a mode-0600 restricted receipt", () => {
    const directory = makeTemporaryDirectory();
    const path = join(directory, "nested", "receipt.json");
    atomicWriteRestrictedJson(path, { secret: "exact manifest" });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
      secret: "exact manifest",
    });
  });

  test("Convex runner pins the deployment and never pushes or codegens", () => {
    let invocation;
    const runner = createConvexRunner({
      cwd: "/tmp",
      spawn: (command, args, options) => {
        invocation = { command, args, options };
        return { status: 0, stdout: "{}\n", stderr: "" };
      },
    });
    runner("dev_c8_cleanup:auditPhaseInternal", {
      deployment: TARGET_DEPLOYMENT,
    });
    assert.equal(invocation.command, "bunx");
    assert.ok(invocation.args.includes("impartial-crab-34"));
    assert.ok(invocation.args.includes("disable"));
    assert.ok(!invocation.args.includes("--push"));
  });

  test("dry-run writes manifests/audits without any destructive call", () => {
    const directory = makeTemporaryDirectory();
    const receiptPath = join(directory, "receipt.json");
    const calls = [];
    const result = runDriver({
      options: { mode: "dry-run", receiptPath },
      runner: zeroRunner(calls),
      env: exactEnv,
    });
    assert.equal(result.mode, "dry-run");
    assert.equal(
      calls.filter((name) => name.endsWith(":auditPhaseInternal")).length,
      CLEANUP_PHASES.length,
    );
    assert.ok(
      !calls.some((name) => /delete|runDatabaseBatch|raw_r2/iu.test(name)),
    );
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.equal(receipt.dryRunCompleted, true);
    assert.equal(typeof receipt.publicManifestDigest, "string");
    assert.equal(statSync(receiptPath).mode & 0o777, 0o600);
  });

  test("execute requires dry-run state and seals an immediate terminal zero audit", () => {
    const directory = makeTemporaryDirectory();
    const receiptPath = join(directory, "receipt.json");
    const dryCalls = [];
    runDriver({
      options: { mode: "dry-run", receiptPath },
      runner: zeroRunner(dryCalls),
      env: exactEnv,
    });
    const executeCalls = [];
    const result = runDriver({
      options: {
        mode: "execute",
        receiptPath,
        confirmation: DESTRUCTIVE_CONFIRMATION,
      },
      runner: zeroRunner(executeCalls),
      env: exactEnv,
    });
    assert.equal(result.zeroAudit, true);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.ok(receipt.completedAt);
    assert.ok(
      Object.values(receipt.finalAudit).every((phase) => phase.matched === 0),
    );
    assert.equal(
      executeCalls.filter((name) => name.endsWith(":auditPhaseInternal"))
        .length,
      CLEANUP_PHASES.length,
    );
  });

  test("refuses malformed, wrong-deployment, and digest-tampered receipts", () => {
    const directory = makeTemporaryDirectory();
    const receiptPath = join(directory, "receipt.json");
    for (const receipt of [
      { version: 1, deployment: TARGET_DEPLOYMENT, dryRunCompleted: true },
      {
        version: 1,
        classification: "restricted-c8-cleanup-manifest",
        deployment: "dev:not-impartial",
        dryRunCompleted: true,
        manifests: {
          storeLocators: [],
          storeReleases: [],
          userPets: [],
          userPetOrphans: [],
        },
        publicManifestDigest: "bad",
      },
      {
        version: 1,
        classification: "restricted-c8-cleanup-manifest",
        deployment: TARGET_DEPLOYMENT,
        dryRunCompleted: true,
        manifests: {
          storeLocators: [],
          storeReleases: [],
          userPets: [],
          userPetOrphans: [],
        },
        publicManifestDigest: "0".repeat(64),
      },
    ]) {
      atomicWriteRestrictedJson(receiptPath, receipt);
      assert.throws(
        () =>
          runDriver({
            options: {
              mode: "execute",
              receiptPath,
              confirmation: DESTRUCTIVE_CONFIRMATION,
            },
            runner: () => {
              throw new Error("runner must not be reached");
            },
            env: exactEnv,
          }),
        /receipt|different deployment|digest/u,
      );
    }
  });

  test("restart resumes when a destructive call succeeded but its response was lost", () => {
    const directory = makeTemporaryDirectory();
    const receiptPath = join(directory, "receipt.json");
    const entry = {
      manifest: {
        policy: "retain-shared-stella-files-object",
        locatorId: "locator-1",
      },
      manifestSha256: "a".repeat(64),
    };
    const state = { deleted: false, loseFirstDeleteResponse: true };
    const calls = [];
    const runner = (name, args = {}) => {
      calls.push(name);
      if (name.endsWith(":getWriterCutoverStatusInternal")) {
        return {
          deployment: TARGET_DEPLOYMENT,
          cloudUrlMatches: true,
          siteUrlMatches: true,
          retiredWritesDisabled: true,
        };
      }
      if (name.endsWith(":getDurableCutoverStateInternal")) {
        return { closed: true, barrierClosesAt: 1 };
      }
      if (name.endsWith(":auditPhaseInternal")) {
        const matched =
          args.phase === "retired_external_media_locators" && !state.deleted
            ? 1
            : 0;
        return {
          scanned: matched,
          matched,
          retainedSharedR2Objects: matched,
          identifiers: matched ? ["locator-1"] : [],
          isDone: true,
          continueCursor: "",
        };
      }
      if (name.endsWith(":getStoreLocatorManifestPageInternal")) {
        return {
          manifests: state.deleted ? [] : [entry],
          isDone: true,
          continueCursor: "",
        };
      }
      if (
        name.endsWith(":getStoreReleaseManifestPageInternal") ||
        name.endsWith(":getUserPetOrphanManifestPageInternal")
      ) {
        return { manifests: [], isDone: true, continueCursor: "" };
      }
      if (
        name.endsWith(":getUserPetManifestInternal") ||
        name.endsWith(":getNextStoreReleaseManifestInternal")
      ) {
        return null;
      }
      if (name.endsWith(":runDatabaseBatchInternal")) {
        return {
          deletedRows: 0,
          deletedStorageObjects: 0,
          patchedRows: 0,
          hasMore: false,
        };
      }
      if (name.endsWith(":deleteManifestedStoreLocatorInternal")) {
        state.deleted = true;
        if (state.loseFirstDeleteResponse) {
          state.loseFirstDeleteResponse = false;
          throw new Error("simulated lost response after committed delete");
        }
        return {
          manifestSha256: entry.manifestSha256,
          retainedSharedR2Objects: 1,
        };
      }
      throw new Error(`Unexpected fake Convex call: ${name}`);
    };

    runDriver({
      options: { mode: "dry-run", receiptPath },
      runner,
      env: exactEnv,
    });
    assert.throws(
      () =>
        runDriver({
          options: {
            mode: "execute",
            receiptPath,
            confirmation: DESTRUCTIVE_CONFIRMATION,
          },
          runner,
          env: exactEnv,
        }),
      /lost response/u,
    );
    let receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.equal(receipt.manifests.storeLocators.length, 1);
    assert.equal(
      receipt.operations.filter(
        (operation) => operation.kind === "retained-store-locator",
      ).length,
      0,
    );

    const resumed = runDriver({
      options: {
        mode: "execute",
        receiptPath,
        confirmation: DESTRUCTIVE_CONFIRMATION,
      },
      runner,
      env: exactEnv,
    });
    assert.equal(resumed.zeroAudit, true);
    receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.ok(receipt.completedAt);
  });
});
