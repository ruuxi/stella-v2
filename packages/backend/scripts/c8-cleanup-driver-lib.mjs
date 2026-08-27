import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

export const TARGET_DEPLOYMENT = "dev:impartial-crab-34";
export const TARGET_NAME = "impartial-crab-34";
export const DESTRUCTIVE_CONFIRMATION = "DELETE C8 DATA FROM impartial-crab-34";
export const ARM_CONFIRMATION = "ARM C8 RETIRED WRITERS ON impartial-crab-34";

export const CLEANUP_PHASES = [
  "stella_session_file_ops",
  "stella_session_files",
  "stella_session_file_blobs",
  "stella_session_turns",
  "stella_session_members",
  "stella_sessions",
  "social_messages",
  "social_room_members",
  "social_rooms",
  "social_relationships",
  "social_profiles",
  "retired_external_media_locators",
  "store_package_releases",
  "store_packages",
  "pet_tag_membership",
  "pet_tag_facets",
  "pet_catalog",
  "user_pets",
  "user_pet_external_media_locators",
  "emoji_packs.authorUsername",
];

const SIMPLE_PRE_STORE = CLEANUP_PHASES.slice(0, 11);
const SIMPLE_POST_STORE = [
  "store_packages",
  "pet_tag_membership",
  "pet_tag_facets",
  "pet_catalog",
];

const sha256Json = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const assertLocalTarget = (env = process.env) => {
  if (env.CONVEX_DEPLOYMENT !== TARGET_DEPLOYMENT) {
    throw new Error(
      `Refusing c8 cleanup: CONVEX_DEPLOYMENT must equal ${TARGET_DEPLOYMENT}.`,
    );
  }
};

export const parseArgs = (argv) => {
  const options = {
    mode: "dry-run",
    receiptPath: undefined,
    confirmation: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--execute") options.mode = "execute";
    else if (arg === "--arm") options.mode = "arm";
    else if (arg === "--receipt") options.receiptPath = argv[++index];
    else if (arg === "--confirm") options.confirmation = argv[++index];
    else throw new Error(`Unknown c8 cleanup option: ${arg}`);
  }
  if (!options.receiptPath) {
    options.receiptPath = resolve(
      process.cwd(),
      ".c8-cleanup",
      "impartial-crab-34-restricted-receipt.json",
    );
  }
  if (
    options.mode === "execute" &&
    options.confirmation !== DESTRUCTIVE_CONFIRMATION
  ) {
    throw new Error(
      "Execute mode requires the exact destructive confirmation.",
    );
  }
  if (options.mode === "arm" && options.confirmation !== ARM_CONFIRMATION) {
    throw new Error("Arm mode requires the exact writer-cutover confirmation.");
  }
  return options;
};

export const atomicWriteRestrictedJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  const directoryFd = openSync(dirname(path), "r");
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
};

export const loadReceipt = (path) =>
  existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;

export const createConvexRunner =
  ({ cwd = process.cwd(), spawn = spawnSync } = {}) =>
  (functionName, args) => {
    const result = spawn(
      "bunx",
      [
        "convex",
        "run",
        "--deployment",
        TARGET_NAME,
        "--typecheck",
        "disable",
        "--codegen",
        "disable",
        functionName,
        JSON.stringify(args),
      ],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (result.status !== 0) {
      throw new Error(
        `Convex call ${functionName} failed (${result.status}): ${result.stderr}`,
      );
    }
    return JSON.parse(result.stdout.trim());
  };

const newReceipt = () => ({
  version: 1,
  classification: "restricted-c8-cleanup-manifest",
  deployment: TARGET_DEPLOYMENT,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  dryRunCompleted: false,
  manifests: {
    storeLocators: [],
    storeReleases: [],
    userPets: [],
    userPetOrphans: [],
  },
  operations: [],
});

const persist = (path, receipt) => {
  receipt.updatedAt = new Date().toISOString();
  receipt.publicManifestDigest = sha256Json(receipt.manifests);
  atomicWriteRestrictedJson(path, receipt);
};

const assertExecuteReceipt = (path, receipt) => {
  const validManifestShape =
    receipt &&
    receipt.version === 1 &&
    receipt.classification === "restricted-c8-cleanup-manifest" &&
    receipt.deployment === TARGET_DEPLOYMENT &&
    receipt.dryRunCompleted === true &&
    typeof receipt.createdAt === "string" &&
    typeof receipt.updatedAt === "string" &&
    Array.isArray(receipt.operations) &&
    receipt.manifests &&
    ["storeLocators", "storeReleases", "userPets", "userPetOrphans"].every(
      (key) => Array.isArray(receipt.manifests[key]),
    );
  if (!validManifestShape) {
    throw new Error(
      "Execute mode requires a valid c8 dry-run receipt structure.",
    );
  }
  if ((statSync(path).mode & 0o777) !== 0o600) {
    throw new Error("Execute mode requires the receipt to remain mode 0600.");
  }
  if (receipt.publicManifestDigest !== sha256Json(receipt.manifests)) {
    throw new Error(
      "Execute mode refuses a receipt with a mismatched manifest digest.",
    );
  }
};

const call = (runner, name, args = {}) =>
  runner(`dev_c8_cleanup:${name}`, {
    deployment: TARGET_DEPLOYMENT,
    ...args,
  });

const auditAll = (runner) => {
  const phases = {};
  for (const phase of CLEANUP_PHASES) {
    let cursor = null;
    let scanned = 0;
    let matched = 0;
    let retainedSharedR2Objects = 0;
    const identifiers = [];
    do {
      const page = call(runner, "auditPhaseInternal", {
        phase,
        cursor,
        numItems: 32,
      });
      scanned += page.scanned;
      matched += page.matched;
      retainedSharedR2Objects += page.retainedSharedR2Objects;
      identifiers.push(...page.identifiers);
      cursor = page.isDone ? null : page.continueCursor;
      if (page.isDone) break;
    } while (cursor !== null);
    phases[phase] = { scanned, matched, retainedSharedR2Objects, identifiers };
  }
  return phases;
};

const collectManifestPages = (runner, functionName) => {
  const manifests = [];
  let cursor = null;
  do {
    const page = call(runner, functionName, { cursor, numItems: 32 });
    manifests.push(...page.manifests);
    cursor = page.isDone ? null : page.continueCursor;
    if (page.isDone) break;
  } while (cursor !== null);
  return manifests;
};

const collectDryRunManifests = (runner, audits) => {
  const userPets = [];
  for (const petRowId of audits.user_pets.identifiers) {
    const entry = call(runner, "getUserPetManifestInternal", { petRowId });
    if (entry) userPets.push(entry);
  }
  return {
    storeLocators: collectManifestPages(
      runner,
      "getStoreLocatorManifestPageInternal",
    ),
    storeReleases: collectManifestPages(
      runner,
      "getStoreReleaseManifestPageInternal",
    ),
    userPets,
    userPetOrphans: collectManifestPages(
      runner,
      "getUserPetOrphanManifestPageInternal",
    ),
  };
};

const rememberManifest = (receiptPath, receipt, kind, entry) => {
  const entries = receipt.manifests[kind];
  if (
    !entries.some(
      (candidate) => candidate.manifestSha256 === entry.manifestSha256,
    )
  ) {
    entries.push(entry);
    persist(receiptPath, receipt);
  }
};

const recordOperation = (receiptPath, receipt, operation) => {
  receipt.operations.push({
    ...operation,
    completedAt: new Date().toISOString(),
  });
  persist(receiptPath, receipt);
};

const deleteSimplePhase = (runner, receiptPath, receipt, phase) => {
  let cursor = null;
  for (;;) {
    const result = call(runner, "runDatabaseBatchInternal", {
      phase,
      limit: 32,
      dryRun: false,
      confirmation: DESTRUCTIVE_CONFIRMATION,
      ...(cursor !== null ? { cursor } : {}),
    });
    recordOperation(receiptPath, receipt, {
      kind: "database-batch",
      phase,
      deletedRows: result.deletedRows,
      deletedStorageObjects: result.deletedStorageObjects,
      patchedRows: result.patchedRows,
    });
    if (!result.hasMore) break;
    cursor = result.continueCursor ?? null;
  }
};

const findNextManifest = (runner, functionName) => {
  let cursor = null;
  do {
    const page = call(runner, functionName, { cursor, numItems: 32 });
    if (page.manifests.length > 0) return page.manifests[0];
    cursor = page.isDone ? null : page.continueCursor;
    if (page.isDone) return null;
  } while (cursor !== null);
  return null;
};

const executeCleanup = (runner, receiptPath, receipt) => {
  const status = call(runner, "getWriterCutoverStatusInternal");
  const cutover = call(runner, "getDurableCutoverStateInternal");
  if (!status.retiredWritesDisabled || !cutover.closed) {
    throw new Error(
      "The exact writer cutover and server quiet barrier must be closed.",
    );
  }
  for (const phase of SIMPLE_PRE_STORE) {
    deleteSimplePhase(runner, receiptPath, receipt, phase);
  }
  for (;;) {
    const entry = findNextManifest(
      runner,
      "getStoreLocatorManifestPageInternal",
    );
    if (!entry) break;
    rememberManifest(receiptPath, receipt, "storeLocators", entry);
    const result = call(runner, "deleteManifestedStoreLocatorInternal", {
      confirmation: DESTRUCTIVE_CONFIRMATION,
      locatorId: entry.manifest.locatorId,
      manifestSha256: entry.manifestSha256,
      manifestPersisted: true,
    });
    recordOperation(receiptPath, receipt, {
      kind: "retained-store-locator",
      manifestSha256: result.manifestSha256,
      retainedSharedR2Objects: result.retainedSharedR2Objects,
    });
  }
  for (;;) {
    const entry = call(runner, "getNextStoreReleaseManifestInternal");
    if (!entry) break;
    rememberManifest(receiptPath, receipt, "storeReleases", entry);
    const result = call(runner, "deleteManifestedStoreReleaseInternal", {
      confirmation: DESTRUCTIVE_CONFIRMATION,
      releaseId: entry.manifest.releaseId,
      manifestSha256: entry.manifestSha256,
      manifestPersisted: true,
    });
    recordOperation(receiptPath, receipt, {
      kind: "retained-store-release",
      manifestSha256: result.manifestSha256,
      retainedSharedR2Objects: result.retainedSharedR2Objects,
    });
  }
  for (const phase of SIMPLE_POST_STORE) {
    deleteSimplePhase(runner, receiptPath, receipt, phase);
  }
  for (;;) {
    const entry = call(runner, "getUserPetManifestInternal");
    if (!entry) break;
    rememberManifest(receiptPath, receipt, "userPets", entry);
    const result = runner(
      "dev_c8_cleanup_raw_r2:deleteManifestedUserPetInternal",
      {
        deployment: TARGET_DEPLOYMENT,
        confirmation: DESTRUCTIVE_CONFIRMATION,
        petRowId: entry.manifest.petRowId,
        manifestSha256: entry.manifestSha256,
        manifestPersisted: true,
      },
    );
    recordOperation(receiptPath, receipt, {
      kind: "deleted-exact-dev-user-pet-objects",
      manifestSha256: result.manifestSha256,
      deletedObjects: result.deletedObjects,
      deletedLocators: result.deletedLocators,
    });
  }
  for (;;) {
    const entry = findNextManifest(
      runner,
      "getUserPetOrphanManifestPageInternal",
    );
    if (!entry) break;
    rememberManifest(receiptPath, receipt, "userPetOrphans", entry);
    const result = runner(
      "dev_c8_cleanup_raw_r2:deleteManifestedUserPetOrphanInternal",
      {
        deployment: TARGET_DEPLOYMENT,
        confirmation: DESTRUCTIVE_CONFIRMATION,
        locatorId: entry.manifest.locatorId,
        manifestSha256: entry.manifestSha256,
        manifestPersisted: true,
      },
    );
    recordOperation(receiptPath, receipt, {
      kind: "deleted-exact-dev-user-pet-orphan",
      manifestSha256: result.manifestSha256,
      deletedObjects: result.deletedObjects,
    });
  }
  deleteSimplePhase(runner, receiptPath, receipt, "emoji_packs.authorUsername");
};

export const runDriver = ({ options, runner, env = process.env }) => {
  assertLocalTarget(env);
  const receiptPath = resolve(options.receiptPath);
  let receipt = loadReceipt(receiptPath) ?? newReceipt();
  if (receipt.deployment !== TARGET_DEPLOYMENT) {
    throw new Error("The receipt belongs to a different deployment.");
  }
  if (options.mode === "arm") {
    const cutover = call(runner, "armWriterCutoverInternal", {
      confirmation: ARM_CONFIRMATION,
    });
    receipt.cutover = cutover;
    persist(receiptPath, receipt);
    return {
      mode: "arm",
      receiptPath,
      publicManifestDigest: receipt.publicManifestDigest,
    };
  }
  if (options.mode === "dry-run") {
    const status = call(runner, "getWriterCutoverStatusInternal");
    const audits = auditAll(runner);
    receipt.writerStatus = status;
    receipt.dryRunAudit = audits;
    receipt.manifests = collectDryRunManifests(runner, audits);
    receipt.dryRunCompleted = true;
    persist(receiptPath, receipt);
    return {
      mode: "dry-run",
      receiptPath,
      publicManifestDigest: receipt.publicManifestDigest,
      audits,
    };
  }
  if (!receipt.dryRunCompleted) {
    throw new Error(
      "Execute mode requires a previously fsynced dry-run receipt.",
    );
  }
  assertExecuteReceipt(receiptPath, receipt);
  executeCleanup(runner, receiptPath, receipt);
  const status = call(runner, "getWriterCutoverStatusInternal");
  const cutover = call(runner, "getDurableCutoverStateInternal");
  const finalAudit = auditAll(runner);
  const nonzero = Object.entries(finalAudit).filter(
    ([, value]) => value.matched !== 0,
  );
  if (!status.retiredWritesDisabled || !cutover.closed || nonzero.length > 0) {
    receipt.finalAudit = finalAudit;
    persist(receiptPath, receipt);
    throw new Error(
      `Terminal zero audit failed for: ${nonzero.map(([phase]) => phase).join(", ")}`,
    );
  }
  receipt.finalWriterStatus = status;
  receipt.finalCutover = cutover;
  receipt.finalAudit = finalAudit;
  receipt.completedAt = new Date().toISOString();
  persist(receiptPath, receipt);
  return {
    mode: "execute",
    receiptPath,
    publicManifestDigest: receipt.publicManifestDigest,
    zeroAudit: true,
  };
};
