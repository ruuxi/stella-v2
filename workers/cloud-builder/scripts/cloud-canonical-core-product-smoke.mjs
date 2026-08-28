#!/usr/bin/env node

/**
 * Focused real-product proof for Stella's cloud-canonical chat contract.
 *
 * This deliberately covers only four representative scenarios:
 *  1. an anonymous conversation survives account upgrade;
 *  2. one desktop-local Stella turn lands in the canonical cloud journal;
 *  3. one same-account mobile turn runs in cloud and appears on desktop;
 *  4. a restarted profile and a clean same-account profile hydrate that view.
 *
 * Authentication is a sequential two-link human handoff for one email
 * address. Each link is consumed and its exact ownership migration is proven
 * before the next is sent. The runner never reads an inbox, cookie store, or
 * password/token database.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CloudProofError,
  FORBIDDEN_TARGET_PATTERN,
  REQUIRED_CLOUD_BUILDER_ORIGIN,
  REQUIRED_CONVEX,
  REQUIRED_REAL_PRODUCT_CONFIRMATION,
  assert,
  sha256,
} from "./cloud-proof-lib.mjs";
import { CORE_PRODUCT_SMOKE_DRIVER_PRIMITIVES as driver } from "./cloud-canonical-real-product-driver.mjs";
import {
  beginRenderedProductMagicLinkLogin,
  completeRenderedProductMagicLinkLogin,
  connectRenderedClientCdp,
  refreshRenderedClientIdentity,
  sendRenderedPrompt,
  selectRenderedConversation,
  snapshotFullRenderedConversation,
  snapshotRenderedConversation,
  verifyExistingPrimaryElectronProfile,
  verifyRenderedColdProcessHydration,
} from "./rendered-client-cdp.mjs";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = realpathSync(
  path.resolve(path.dirname(SCRIPT_FILE), "../../.."),
);
const PRODUCT_ORIGIN = "http://127.0.0.1:57314";
const CONTRACT = "stella-cloud-canonical-core-product-smoke-v2";
const STATE_FILE = "core-product-smoke-state.json";
const REPORT_FILE = "core-product-smoke-report.json";
const LOCK_FILE = "core-product-smoke.lock";
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const AUTH_DOCUMENT_PROOF_KEY = "__stellaCoreAuthTransitionProofV2";
const LOCAL_TURN_OBSERVER_KEY = "__stellaCoreLocalTurnObserverV2";
const AUTH_PHASES = new Set([
  "awaiting-primary-link",
  "primary-auth-complete",
  "awaiting-clean-link",
  "clean-auth-complete",
  "auth-complete",
  "complete",
]);
const STELLA_MANAGED_RELAY_PROVIDERS = new Set([
  "anthropic",
  "crof",
  "deepseek",
  "fireworks",
  "google",
  "openai",
  "openrouter",
  "wafer",
]);

export const CORE_PRODUCT_SCENARIOS = Object.freeze([
  "anonymous_upgrade_preserves_conversation",
  "desktop_local_turn_is_cloud_canonical",
  "mobile_cloud_turn_syncs_to_desktop",
  "restart_and_clean_client_hydrate",
]);

const stableJson = (value) => {
  const normalize = (entry) => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (!entry || typeof entry !== "object") return entry;
    return Object.fromEntries(
      Object.entries(entry)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]),
    );
  };
  return JSON.stringify(normalize(value));
};

const inspectExpectedMobileTextTail = ({ textRows, legacyRunId, attempts }) => {
  let cursor = 0;
  const expectedListIndex = () => cursor + 2;
  const takeUser = (runId) => {
    const row = textRows[cursor];
    if (
      row?.kind !== "user" ||
      row.listIndex !== expectedListIndex() ||
      row.textSha256 !== sha256(`Reply exactly MOBILE-CORE-${runId}.`)
    ) {
      return false;
    }
    cursor += 1;
    return true;
  };
  const takeAssistant = (allowedHashes) => {
    const row = textRows[cursor];
    if (
      row?.kind !== "assistant" ||
      row.listIndex !== expectedListIndex() ||
      !allowedHashes.includes(row.textSha256)
    ) {
      return false;
    }
    cursor += 1;
    return true;
  };

  // A pre-ledger retry may have admitted the original run once. Recognize
  // only its exact marker, never arbitrary historical tail content.
  if (
    textRows[cursor]?.textSha256 ===
    sha256(`Reply exactly MOBILE-CORE-${legacyRunId}.`)
  ) {
    if (!takeUser(legacyRunId)) return { valid: false };
    const legacyMarker = `MOBILE-CORE-${legacyRunId}`;
    if (textRows[cursor]?.kind === "assistant") {
      if (!takeAssistant([sha256(legacyMarker), sha256(`${legacyMarker}.`)])) {
        return { valid: false };
      }
    }
  }

  let activeAttemptRendered = false;
  for (const [index, attempt] of attempts.entries()) {
    const hasUser = takeUser(attempt.runId);
    if (!hasUser) {
      if (attempt.status === "pending" && index === attempts.length - 1) break;
      return { valid: false };
    }
    if (attempt.status === "completed") {
      if (!takeAssistant([attempt.receipt.assistantSha256])) {
        return { valid: false };
      }
      if (index === attempts.length - 1) activeAttemptRendered = true;
      continue;
    }
    if (attempt.status === "pending") {
      const assistant = textRows[cursor];
      if (assistant?.kind === "assistant") {
        if (
          assistant.listIndex !== expectedListIndex() ||
          !SHA256_PATTERN.test(assistant.textSha256)
        ) {
          return { valid: false };
        }
        cursor += 1;
        if (index === attempts.length - 1) activeAttemptRendered = true;
      }
    }
  }
  return {
    valid: cursor === textRows.length,
    activeAttemptRendered,
  };
};

const target = Object.freeze({
  deployment: REQUIRED_CONVEX.deployment,
  convexUrl: REQUIRED_CONVEX.cloudUrl,
  convexSiteUrl: REQUIRED_CONVEX.siteUrl,
  cloudBuilderUrl: REQUIRED_CLOUD_BUILDER_ORIGIN,
});

const targetSha256 = sha256(stableJson(target));

const isInside = (candidate, root) =>
  candidate === root || candidate.startsWith(`${root}${path.sep}`);

export const resolveCoreSmokeRoot = (rawRoot) => {
  assert(
    typeof rawRoot === "string" && path.isAbsolute(rawRoot),
    "--root must be absolute.",
  );
  const root = realpathSync(rawRoot);
  assert(statSync(root).isDirectory(), "--root must be an existing directory.");
  const allowedRoots = [tmpdir(), "/tmp", "/private/tmp", "/var/tmp"].map(
    (entry) => {
      try {
        return realpathSync(entry);
      } catch {
        return path.resolve(entry);
      }
    },
  );
  assert(
    allowedRoots.some(
      (allowed) => root !== allowed && isInside(root, allowed),
    ) &&
      !isInside(root, REPO_ROOT) &&
      !isInside(root, path.resolve(homedir(), ".stella")) &&
      !FORBIDDEN_TARGET_PATTERN.test(root),
    "--root must be a narrow disposable directory under a temporary root.",
  );
  return root;
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
    stateFile: path.join(stateDirectory, STATE_FILE),
    reportFile: path.join(evidenceDirectory, REPORT_FILE),
    lockFile: path.join(stateDirectory, LOCK_FILE),
  });
};

const sealState = (body) => ({
  ...body,
  stateSha256: sha256(stableJson(body)),
});

const stateBody = (state) =>
  Object.fromEntries(
    Object.entries(state).filter(([key]) => key !== "stateSha256"),
  );

const checkpointState = async (paths, state, patch) => {
  const next = sealState({ ...stateBody(state), ...patch });
  await writePrivateJson(paths.stateFile, next);
  return next;
};

const writePrivateJson = async (file, value) => {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, file);
};

const loadState = async (paths) => {
  const metadata = await stat(paths.stateFile);
  assert(
    metadata.isFile() && metadata.size > 0 && metadata.size <= MAX_STATE_BYTES,
    "Core smoke state is invalid.",
  );
  const parsed = JSON.parse(await readFile(paths.stateFile, "utf8"));
  const { stateSha256, ...body } = parsed;
  assert(
    SHA256_PATTERN.test(stateSha256) &&
      stateSha256 === sha256(stableJson(body)) &&
      body.version === 2 &&
      body.contract === CONTRACT &&
      body.root === paths.root &&
      body.targetSha256 === targetSha256 &&
      UUID_PATTERN.test(body.runId) &&
      AUTH_PHASES.has(body.phase),
    "Core smoke state failed its integrity or target check.",
  );
  return parsed;
};

const acquireLock = async (paths) => {
  let handle;
  try {
    handle = await open(paths.lockFile, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new CloudProofError("Another core smoke process owns this root.");
    }
    throw error;
  }
  await handle.writeFile(`${process.pid}\n`);
  return async () => {
    await handle.close().catch(() => undefined);
    await unlink(paths.lockFile).catch(() => undefined);
  };
};

const contextFor = (runId) => Object.freeze({ runId, target });

const requireEnvironment = () => {
  assert(
    process.env.STELLA_CLOUD_ACCEPTANCE_CONFIRM ===
      REQUIRED_REAL_PRODUCT_CONFIRMATION,
    `Set STELLA_CLOUD_ACCEPTANCE_CONFIRM=${REQUIRED_REAL_PRODUCT_CONFIRMATION}.`,
  );
  return driver.loadSecrets();
};

const connect = async (electron) =>
  await driver.connectElectronRenderedClient(electron);

const connectArmedElectronDocument = async (
  electron,
  expectedTargetIdSha256,
) => {
  assert(
    SHA256_PATTERN.test(expectedTargetIdSha256 ?? ""),
    "An armed rendered target hash is required.",
  );
  const response = await fetch(
    `http://127.0.0.1:${electron.debugPort}/json/list`,
    { signal: AbortSignal.timeout(5_000) },
  );
  assert(response.ok, "The armed Electron CDP target list is unavailable.");
  const raw = await response.text();
  assert(
    Buffer.byteLength(raw, "utf8") <= 256_000,
    "The armed Electron CDP target list exceeded its bound.",
  );
  const list = JSON.parse(raw);
  const matching = Array.isArray(list)
    ? list.filter(
        (entry) =>
          entry?.type === "page" &&
          typeof entry.id === "string" &&
          sha256(entry.id) === expectedTargetIdSha256 &&
          typeof entry.url === "string",
      )
    : [];
  assert(
    matching.length === 1,
    "The armed Electron document target is not uniquely available.",
  );
  const currentUrl = new URL(matching[0].url);
  assert(
    currentUrl.origin === PRODUCT_ORIGIN &&
      !currentUrl.username &&
      !currentUrl.password &&
      !["token", "ott", "code", "requestId", "session"].some((key) =>
        currentUrl.searchParams.has(key),
      ),
    "The armed Electron document target URL is unsafe.",
  );
  const client = await connectRenderedClientCdp({
    debugPort: electron.debugPort,
    expectedUrl: currentUrl.href,
    surface: "electron-cdp",
    expectedProcess: {
      pid: electron.pid,
      processFingerprintSha256: electron.processFingerprintSha256,
    },
    timeoutMs: 30_000,
  });
  assert(
    client.targetIdSha256 === expectedTargetIdSha256,
    "The armed Electron document changed targets.",
  );
  return Object.freeze({ client, currentUrl: currentUrl.href });
};

const renderedElectronIsReachable = async (electron) => {
  try {
    const client = await connect(electron);
    client.close();
    return true;
  } catch {
    return false;
  }
};

const appUrl = (pathname) => new URL(pathname, PRODUCT_ORIGIN).href;

const withRenderedUrl = (electron, url) => ({
  ...electron,
  expectedProductRoute: url,
});

const authTransitionNonce = (runId, label) =>
  sha256(`stella-core-auth-transition-v2\n${runId}\n${label}`);

const armRenderedAuthTransitionProof = async (client, { runId, label }) => {
  const nonce = authTransitionNonce(runId, label);
  const proof = await client.evaluate(
    `(async () => {
      const key = ${JSON.stringify(AUTH_DOCUMENT_PROOF_KEY)};
      if (Object.hasOwn(globalThis, key)) throw new Error("auth proof already armed");
      const hash = async (value) => {
        const bytes = new TextEncoder().encode(String(value));
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      };
      const fatalCrashVisible = () =>
        [...document.querySelectorAll('h2')].some((node) => (node.textContent ?? '').trim() === 'Something went wrong');
      const migrationRecoveryVisible = () =>
        [...document.querySelectorAll('h1,h2,h3,p,span,div')].some((node) =>
          (node.textContent ?? '').trim().includes('Finishing sign-in')
        );
      const state = {
        nonce: ${JSON.stringify(nonce)},
        documentIdentity: document,
        fatalCrashObserved: fatalCrashVisible(),
        migrationRecoveryObserved: migrationRecoveryVisible(),
        observer: null
      };
      state.observer = new MutationObserver(() => {
        state.fatalCrashObserved ||= fatalCrashVisible();
        state.migrationRecoveryObserved ||= migrationRecoveryVisible();
      });
      state.observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'hidden', 'aria-hidden']
      });
      Object.defineProperty(globalThis, key, {
        value: state,
        configurable: false,
        enumerable: false,
        writable: false
      });
      return {
        armed: true,
        nonceSha256: await hash(state.nonce),
        fatalCrashObserved: state.fatalCrashObserved,
        targetUrlSha256: await hash(location.href)
      };
    })()`,
    `arm ${label} same-document auth transition proof`,
  );
  assert(
    proof?.armed === true &&
      proof.nonceSha256 === sha256(nonce) &&
      proof.fatalCrashObserved === false &&
      SHA256_PATTERN.test(proof.targetUrlSha256 ?? ""),
    `The ${label} same-document auth transition proof could not be armed.`,
  );
  return Object.freeze({
    nonceSha256: proof.nonceSha256,
    targetIdSha256: client.targetIdSha256,
    targetUrlSha256: proof.targetUrlSha256,
  });
};

const waitForProductOwnedAuthTransition = async (
  client,
  { runId, label, timeoutMs = 120_000 },
) => {
  const expectedNonceSha256 = sha256(authTransitionNonce(runId, label));
  const deadline = Date.now() + timeoutMs;
  let stableSinceMs = null;
  let last;
  while (Date.now() < deadline) {
    last = await client.evaluate(
      `(async () => {
        const hash = async (value) => {
          const bytes = new TextEncoder().encode(String(value));
          const digest = await crypto.subtle.digest("SHA-256", bytes);
          return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        };
        const proof = globalThis[${JSON.stringify(AUTH_DOCUMENT_PROOF_KEY)}];
        const { getAuthSessionSnapshot } = await import("/src/global/auth/services/auth-session.ts");
        const { resolveAuthSessionCacheScope } = await import("/src/global/auth/lib/auth-session-scope.ts");
        const snapshot = getAuthSessionSnapshot();
        const user = snapshot.data?.user;
        const accountScope = resolveAuthSessionCacheScope(snapshot.data);
        const fatalCrashVisible =
          [...document.querySelectorAll('h2')].some((node) => (node.textContent ?? '').trim() === 'Something went wrong');
        const migrationRecoveryVisible =
          [...document.querySelectorAll('h1,h2,h3,p,span,div')].some((node) =>
            (node.textContent ?? '').trim().includes('Finishing sign-in')
          );
        return {
          proofPresent: Boolean(proof),
          sameDocument: proof?.documentIdentity === document,
          nonceSha256: proof?.nonce ? await hash(proof.nonce) : null,
          fatalCrashObserved: proof?.fatalCrashObserved === true,
          migrationRecoveryObserved: proof?.migrationRecoveryObserved === true,
          fatalCrashVisible,
          migrationRecoveryVisible,
          pending: snapshot.isPending === true,
          authenticated: Boolean(user?.id),
          anonymous: user?.isAnonymous === true,
          identitySha256: user?.id ? await hash(user.id) : null,
          accountScopeIsConnected: accountScope.startsWith('account:'),
          accountScopeSha256: await hash(accountScope),
          authDialogOpen: Boolean(document.querySelector('.auth-dialog-content')),
          productUrl: location.href,
          productUrlSha256: await hash(location.href)
        };
      })()`,
      `observe ${label} product-owned auth transition`,
      60_000,
    );
    const ready =
      last?.proofPresent === true &&
      last.sameDocument === true &&
      last.nonceSha256 === expectedNonceSha256 &&
      last.fatalCrashObserved === false &&
      last.fatalCrashVisible === false &&
      last.migrationRecoveryVisible === false &&
      last.pending === false &&
      last.authenticated === true &&
      last.anonymous === false &&
      last.accountScopeIsConnected === true &&
      SHA256_PATTERN.test(last.identitySha256 ?? "") &&
      SHA256_PATTERN.test(last.accountScopeSha256 ?? "") &&
      last.authDialogOpen === false &&
      SHA256_PATTERN.test(last.productUrlSha256 ?? "");
    if (ready) {
      stableSinceMs ??= Date.now();
      if (Date.now() - stableSinceMs >= 400) break;
    } else {
      stableSinceMs = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(
    stableSinceMs !== null && last,
    `The ${label} product did not recover its connected session in the armed document.`,
  );
  const productUrl = new URL(last.productUrl);
  assert(
    productUrl.origin === PRODUCT_ORIGIN &&
      !productUrl.username &&
      !productUrl.password &&
      !productUrl.searchParams.has("token") &&
      !productUrl.searchParams.has("ott"),
    `The ${label} product recovered to an unsafe URL.`,
  );
  return Object.freeze({ state: last, productUrl: productUrl.href });
};

const completeAndAttestAuthTransition = async (
  client,
  { runId, label, requestReceipt },
) => {
  const productOwned = await waitForProductOwnedAuthTransition(client, {
    runId,
    label,
  });
  // The product-owned session transition and recovery have already completed
  // without refresh/reload/navigation. This verifier may now refresh solely to
  // mint the strict authority receipt used by later proof phases.
  const completion = await completeRenderedProductMagicLinkLogin(client, {
    requestReceipt,
    convexUrl: target.convexUrl,
    convexSiteUrl: target.convexSiteUrl,
    timeoutMs: 120_000,
  });
  const final = await client.evaluate(
    `(async () => {
      const hash = async (value) => {
        const bytes = new TextEncoder().encode(String(value));
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      };
      const proof = globalThis[${JSON.stringify(AUTH_DOCUMENT_PROOF_KEY)}];
      proof?.observer?.disconnect();
      return {
        proofPresent: Boolean(proof),
        sameDocument: proof?.documentIdentity === document,
        nonceSha256: proof?.nonce ? await hash(proof.nonce) : null,
        fatalCrashObserved: proof?.fatalCrashObserved === true,
        migrationRecoveryObserved: proof?.migrationRecoveryObserved === true,
        fatalCrashVisible:
          [...document.querySelectorAll('h2')].some((node) => (node.textContent ?? '').trim() === 'Something went wrong'),
        migrationRecoveryVisible:
          [...document.querySelectorAll('h1,h2,h3,p,span,div')].some((node) =>
            (node.textContent ?? '').trim().includes('Finishing sign-in')
          ),
        productUrlSha256: await hash(location.href)
      };
    })()`,
    `seal ${label} same-document auth transition proof`,
  );
  assert(
    final?.proofPresent === true &&
      final.sameDocument === true &&
      final.nonceSha256 === sha256(authTransitionNonce(runId, label)) &&
      final.fatalCrashObserved === false &&
      final.fatalCrashVisible === false &&
      final.migrationRecoveryVisible === false &&
      final.productUrlSha256 === productOwned.state.productUrlSha256 &&
      completion.identitySha256 === productOwned.state.identitySha256 &&
      completion.credentialMaterialReturned === false,
    `The ${label} same-document auth transition attestation failed.`,
  );
  const body = Object.freeze({
    outcome: "product-owned-same-document-auth-transition",
    targetIdSha256: client.targetIdSha256,
    requestReceiptSha256: requestReceipt.requestReceiptSha256,
    completionReceiptSha256: completion.completionReceiptSha256,
    nonceSha256: final.nonceSha256,
    productUrlSha256: final.productUrlSha256,
    accountScopeSha256: productOwned.state.accountScopeSha256,
    identitySha256: productOwned.state.identitySha256,
    migrationRecoveryObserved: final.migrationRecoveryObserved,
    sameDocument: true,
    fatalCrashObserved: false,
    fatalCrashVisible: false,
    migrationRecoveryVisible: false,
    productPollAppliedSession: true,
    credentialMaterialReturned: false,
  });
  return Object.freeze({
    completion,
    productUrl: productOwned.productUrl,
    receipt: Object.freeze({
      ...body,
      receiptSha256: sha256(stableJson(body)),
    }),
  });
};

const dismissOptionalNicknamePrompt = async (client, label) => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const visible = await client.evaluate(
      `Boolean(document.querySelector('.sidebar-nickname-dialog'))`,
      `observe ${label} optional nickname prompt`,
    );
    if (visible === true) {
      await focusNativeWindow(client, `${label} optional nickname prompt`);
      await driver.trustedRenderedClick(
        client,
        ".sidebar-nickname-dialog .sidebar-confirm-actions button:first-child",
        `dismiss ${label} optional nickname prompt`,
      );
      while (Date.now() < deadline) {
        const closed = await client.evaluate(
          `!document.querySelector('.sidebar-nickname-dialog')`,
          `observe ${label} optional nickname prompt dismissal`,
        );
        if (closed === true) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new CloudProofError(
        `The ${label} optional nickname prompt did not close.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
};

const focusNativeWindow = async (client, label) => {
  await client.evaluate(
    `(() => { window.electronAPI.window.show("full"); return true; })()`,
    `show ${label} native window`,
  );
  await client.command("Page.bringToFront");
  const focused = await client.evaluate(
    `(async () => {
      const deadline = Date.now() + 5000;
      while (!document.hasFocus() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return document.hasFocus();
    })()`,
    `focus ${label} native window`,
  );
  assert(focused === true, `The ${label} native window did not focus.`);
};

const runVisibleLocalTurn = async (client, conversationId, prompt, rawLog) => {
  const observerKey = JSON.stringify(LOCAL_TURN_OBSERVER_KEY);
  const expectedConversationId = JSON.stringify(conversationId);
  const armed = await client.evaluate(
    `(async () => {
      const key = ${observerKey};
      if (window[key]) throw new Error("local turn observer already armed");
      const activeRun = await window.electronAPI.agent.getActiveRun();
      if (activeRun) throw new Error("local turn observer found an active run");
      const observer = {
        conversationId: ${expectedConversationId},
        events: [],
        off: null
      };
      observer.off = window.electronAPI.agent.onStream((event) => {
        if (observer.events.length < 10000) observer.events.push(event);
      });
      window[key] = observer;
      return { armed: true, eventCount: 0, activeRunAbsent: true };
    })()`,
    "arm visible local core turn observer",
  );
  assert(
    armed?.armed === true &&
      armed.eventCount === 0 &&
      armed.activeRunAbsent === true,
    "The visible local turn observer did not arm cleanly.",
  );

  try {
    const submission = await sendRenderedPrompt(client, {
      prompt,
      timeoutMs: 120_000,
    });
    const expectedUserMessageIdSha256 = JSON.stringify(
      submission.userRowIdSha256,
    );
    const result = await client.evaluate(
      `(async () => {
        const key = ${observerKey};
        const observer = window[key];
        if (!observer || observer.conversationId !== ${expectedConversationId}) {
          throw new Error("local turn observer missing");
        }
        const hash = async (value) => {
          const bytes = new TextEncoder().encode(String(value));
          const digest = await crypto.subtle.digest("SHA-256", bytes);
          return [...new Uint8Array(digest)]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
        };
        const deadline = Date.now() + ${10 * 60_000};
        while (Date.now() < deadline) {
          const starts = [];
          for (const event of observer.events) {
            if (
              event?.type === "run-started" &&
              event.conversationId === observer.conversationId &&
              await hash(event.userMessageId ?? "") === ${expectedUserMessageIdSha256}
            ) {
              starts.push(event);
            }
          }
          if (starts.length > 1) {
            observer.off?.();
            delete window[key];
            throw new Error("multiple visible local runs started");
          }
          const runId = starts[0]?.runId;
          const requestId = starts[0]?.requestId;
          const terminal = runId
            ? observer.events.find((event) =>
                event?.type === "run-finished" &&
                event.runId === runId &&
                event.conversationId === observer.conversationId &&
                event.requestId === requestId
              )
            : null;
          if (runId && requestId && terminal) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            const mismatched = observer.events.some((event) =>
              event?.runId === runId && (
                event.conversationId !== observer.conversationId ||
                event.requestId !== requestId
              )
            );
            if (mismatched) {
              observer.off?.();
              delete window[key];
              throw new Error("visible local run event fence changed");
            }
            const events = observer.events.filter(
              (event) =>
                event?.runId === runId &&
                event.conversationId === observer.conversationId &&
                event.requestId === requestId
            );
            observer.off?.();
            delete window[key];
            return { runId, requestId, terminal, events };
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        observer.off?.();
        delete window[key];
        throw new Error("visible local run never reached a terminal");
      })()`,
      "await visible local core turn",
      11 * 60_000,
    );
    assert(
      typeof result?.runId === "string" && result.runId.length > 0,
      "The visible local core turn omitted its run id.",
    );
    assert(
      typeof result.requestId === "string" && result.requestId.length > 0,
      "The visible local core turn omitted its request id.",
    );
    assert(
      Array.isArray(result.events) && result.events.length > 0,
      "The visible local core turn omitted its runtime events.",
    );
    assert(
      result.terminal?.outcome === "completed",
      `The visible local core turn ended as ${String(result.terminal?.outcome)}.`,
    );
    rawLog.push(
      driver.rawReceipt("local-runtime", "local.visible-turn.complete", {
        outcome: result.terminal.outcome,
        resourceIdSha256: sha256(result.runId),
        requestIdSha256: sha256(result.requestId),
        responseSha256: sha256(stableJson(result.events)),
        stateSha256: sha256(stableJson(submission)),
        count: result.events.length,
      }),
    );
    return { ...result, submission };
  } catch (error) {
    await client
      .evaluate(
        `(() => {
          const key = ${observerKey};
          const observer = window[key];
          observer?.off?.();
          delete window[key];
          return true;
        })()`,
        "discard visible local core turn observer",
      )
      .catch(() => undefined);
    throw error;
  }
};

const waitForAnonymousConversation = async (client, timeoutMs = 120_000) => {
  const deadline = Date.now() + timeoutMs;
  let stableSinceMs = null;
  while (Date.now() < deadline) {
    const value = await client.evaluate(
      `(async () => {
        const hash = async (value) => {
          const bytes = new TextEncoder().encode(String(value));
          const digest = await crypto.subtle.digest("SHA-256", bytes);
          return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        };
        const { getAuthSessionSnapshot } = await import("/src/global/auth/services/auth-session.ts");
        const { router } = await import("/src/router.tsx");
        const { convexClient } = await import("/src/platform/convex/convex-client.ts");
        const { cloudApi } = await import("/src/features/cloud/cloud-api.ts");
        const snapshot = getAuthSessionSnapshot();
        const conversationId = router.state.location.search?.c ?? null;
        const mainUiState = await window.electronAPI.ui.getState();
        const conversations = await convexClient.query(cloudApi.listMyConversations, {});
        return {
          pending: snapshot.isPending === true,
          anonymous: snapshot.data?.user?.isAnonymous === true,
          conversationId,
          mainConversationId: mainUiState?.conversationId ?? null,
          canonicalConversationPresent: Array.isArray(conversations) && conversations.some((row) => row?.conversationId === conversationId),
          canonicalConversationSetSha256: await hash(JSON.stringify(conversations.map((row) => row?.conversationId).filter(Boolean).sort())),
          crash: Boolean(document.querySelector('.error-boundary'))
        };
      })()`,
      "wait for anonymous core conversation",
      60_000,
    );
    const ready =
      value?.pending === false &&
      value.anonymous === true &&
      UUID_PATTERN.test(value.conversationId ?? "") &&
      value.mainConversationId === value.conversationId &&
      value.canonicalConversationPresent === true &&
      SHA256_PATTERN.test(value.canonicalConversationSetSha256 ?? "") &&
      value.crash === false;
    if (ready) {
      stableSinceMs ??= Date.now();
      if (Date.now() - stableSinceMs >= 400) return value;
    } else {
      stableSinceMs = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new CloudProofError(
    "The anonymous product conversation did not become ready.",
  );
};

const prepareLogin = async ({
  client,
  electron,
  email,
  onboarding,
  preLoginSha256,
  runId,
  label,
}) => {
  await focusNativeWindow(client, `${label} auth`);
  await driver.trustedRenderedClick(
    client,
    ".shell-topbar-account-signin",
    "open core auth handoff",
  );
  const authRoute = await client.evaluate(
    `(async () => {
      const { router } = await import("/src/router.tsx");
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        if (
          router.state.location.search?.dialog === "auth" &&
          document.querySelector(".auth-dialog-content")
        ) {
          return { href: router.state.location.href };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return null;
    })()`,
    "observe core auth handoff",
  );
  assert(
    typeof authRoute?.href === "string" && authRoute.href.startsWith("/"),
    "The visible core sign-in control did not open the product auth dialog.",
  );
  const authUrl = appUrl(authRoute.href);
  const documentProof = await armRenderedAuthTransitionProof(client, {
    runId,
    label,
  });
  const request = await beginRenderedProductMagicLinkLogin(client, {
    email,
    productOnboardingReceipt: onboarding.productReceipt,
    driverZeroConversationAttestationSha256: preLoginSha256,
    timeoutMs: 120_000,
  });
  assert(
    documentProof.targetIdSha256 === request.targetIdSha256,
    `The ${label} auth request changed the armed rendered target.`,
  );
  return {
    electron: withRenderedUrl(electron, authUrl),
    request,
    documentProof,
  };
};

export const parseCoreSmokeArguments = (argv) => {
  assert(
    Array.isArray(argv) && argv.length >= 1,
    "A core smoke mode is required.",
  );
  const mode = argv[0];
  assert(
    ["--list", "--check", "--prepare-auth", "--advance-auth", "--run"].includes(
      mode,
    ),
    "Use --list, --check, --prepare-auth --root <path> --email <email>, --advance-auth --root <path> [--email <email>], or --run --root <path>.",
  );
  if (mode === "--list" || mode === "--check") {
    assert(argv.length === 1, `${mode} accepts no additional arguments.`);
    return { mode };
  }
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    assert(
      ["--root", "--email"].includes(key) && typeof value === "string",
      "Core smoke options must be key/value pairs.",
    );
    assert(!values.has(key), `Duplicate ${key}.`);
    values.set(key, value);
  }
  assert(values.has("--root"), "--root is required.");
  if (mode === "--prepare-auth") {
    const email = values.get("--email")?.trim().toLowerCase();
    assert(
      email === values.get("--email") &&
        email.length <= 320 &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email),
      "--email must already be normalized.",
    );
    return { mode, root: values.get("--root"), email };
  }
  if (mode === "--advance-auth") {
    const rawEmail = values.get("--email");
    const email = rawEmail?.trim().toLowerCase();
    assert(
      rawEmail === undefined ||
        (email === rawEmail &&
          email.length <= 320 &&
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)),
      "--email must already be normalized when supplied.",
    );
    return { mode, root: values.get("--root"), ...(email ? { email } : {}) };
  }
  assert(!values.has("--email"), `${mode} does not accept --email.`);
  return { mode, root: values.get("--root") };
};

const prepareAuth = async ({ root, email }) => {
  const secrets = requireEnvironment();
  const resolvedRoot = resolveCoreSmokeRoot(root);
  const paths = await pathsFor(resolvedRoot);
  const release = await acquireLock(paths);
  const rawLog = [];
  try {
    try {
      const existing = await loadState(paths);
      assert(
        AUTH_PHASES.has(existing.phase) &&
          existing.emailSha256 === sha256(email),
        "This core smoke root is already bound to another run or email.",
      );
      return {
        status: existing.phase,
        runIdSha256: sha256(existing.runId),
        emailSha256: existing.emailSha256,
        magicLinkCount: existing.auth?.cleanRequest ? 2 : 1,
        liveMutationPerformed: false,
      };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const runId = randomUUID();
    const context = contextFor(runId);
    await driver.buildElectron(rawLog);
    const vite = await driver.launchVite(context, paths);
    let primary = await driver.launchElectron(
      context,
      Object.freeze({}),
      paths,
      "primary",
      vite,
      rawLog,
    );
    let clean = await driver.launchElectron(
      context,
      Object.freeze({}),
      paths,
      "clean-client",
      vite,
      rawLog,
    );

    const primaryClient = await connect(primary);
    let primaryOnboarding;
    let conversationId;
    let anonymousProjection;
    let anonymousTurn;
    let primaryRequest;
    let primaryDocumentProof;
    let primarySourceOwnerSha256;
    try {
      primaryOnboarding = await driver.driveVisibleProductOnboarding(
        primaryClient,
        {
          profileSha256: primary.profileSha256,
          rawLog,
        },
      );
      await driver.navigateRenderedProduct(
        primaryClient,
        appUrl("/chat"),
        "open anonymous core chat",
      );
      const anonymousReady = await waitForAnonymousConversation(primaryClient);
      conversationId = anonymousReady.conversationId;
      const identity = await refreshRenderedClientIdentity(primaryClient);
      assert(
        identity.anonymous === true,
        "The core source profile is not anonymous.",
      );
      const beforeTurnProjection =
        await snapshotRenderedConversation(primaryClient);
      assert(
        beforeTurnProjection.rowCount === 0,
        "The fresh anonymous conversation was not empty before its proof turn.",
      );
      const anonymousAuthority = await driver.readAnonymousElectronAuthority(
        context,
        secrets,
        primary,
        rawLog,
        "core primary pre-upgrade",
      );
      primarySourceOwnerSha256 = sha256(
        anonymousAuthority.jwtIdentity.tokenIdentifier,
      );
      const desktopPrompt = `Reply exactly DESKTOP-CORE-${runId}.`;
      const desktop = await runVisibleLocalTurn(
        primaryClient,
        conversationId,
        desktopPrompt,
        rawLog,
      );
      const localCanonical = await waitForLocalCanonicalTurn(
        context,
        anonymousAuthority.secrets,
        conversationId,
        desktop.runId,
        desktopPrompt,
        rawLog,
      );
      await dismissOptionalNicknamePrompt(
        primaryClient,
        "primary anonymous core",
      );
      anonymousProjection = await waitForRenderedConversationGrowth(
        primaryClient,
        beforeTurnProjection,
      );
      anonymousTurn = {
        localRunId: desktop.runId,
        promptSha256: sha256(desktopPrompt),
        journalBeforeSha256: sha256(stableJson([])),
        journalAfterSha256: localCanonical.journal.historySha256,
        ...localCanonical.evidence,
        projectionSha256: anonymousProjection.rowsSha256,
        projectionTextSha256: anonymousProjection.textRowsSha256,
      };
      const prepared = await prepareLogin({
        client: primaryClient,
        electron: primary,
        email,
        onboarding: primaryOnboarding,
        preLoginSha256: sha256(
          stableJson({
            identitySha256: identity.identitySha256,
            conversationIdSha256: sha256(conversationId),
            conversationListSha256:
              anonymousReady.canonicalConversationSetSha256,
            rowsSha256: anonymousProjection.rowsSha256,
            textRowsSha256: anonymousProjection.textRowsSha256,
            turnRowsSha256: anonymousTurn.rowsSha256,
          }),
        ),
        runId,
        label: "primary",
      });
      primary = prepared.electron;
      primaryRequest = prepared.request;
      primaryDocumentProof = prepared.documentProof;
    } finally {
      primaryClient.close();
    }

    const cleanClient = await connect(clean);
    let cleanOnboarding;
    let cleanPreLoginSha256;
    let cleanSourceOwnerSha256;
    try {
      cleanOnboarding = await driver.driveVisibleProductOnboarding(
        cleanClient,
        {
          profileSha256: clean.profileSha256,
          rawLog,
        },
      );
      const cleanIdentity = await refreshRenderedClientIdentity(cleanClient);
      assert(
        cleanIdentity.anonymous === true,
        "The clean core profile is not anonymous.",
      );
      const cleanAuthority = await driver.readAnonymousElectronAuthority(
        context,
        secrets,
        clean,
        rawLog,
        "core clean pre-upgrade",
      );
      cleanSourceOwnerSha256 = sha256(
        cleanAuthority.jwtIdentity.tokenIdentifier,
      );
      cleanPreLoginSha256 = sha256(
        stableJson({
          identitySha256: cleanIdentity.identitySha256,
          profileSha256: clean.profileSha256,
          cleanConversationState: true,
        }),
      );
    } finally {
      cleanClient.close();
    }

    const state = sealState({
      version: 2,
      contract: CONTRACT,
      phase: "awaiting-primary-link",
      runId,
      root: paths.root,
      targetSha256,
      emailSha256: sha256(email),
      conversationId,
      anonymousProjectionSha256: anonymousProjection.rowsSha256,
      anonymousTurn,
      primary,
      clean,
      auth: {
        primaryRequest,
        primaryDocumentProof,
        primarySourceOwnerSha256,
        cleanPreparation: {
          onboarding: cleanOnboarding,
          preLoginSha256: cleanPreLoginSha256,
          sourceOwnerSha256: cleanSourceOwnerSha256,
        },
      },
      preparationReceiptsSha256: sha256(stableJson(rawLog)),
    });
    await writePrivateJson(paths.stateFile, state);
    return {
      status: state.phase,
      runIdSha256: sha256(runId),
      emailSha256: state.emailSha256,
      conversationIdSha256: sha256(conversationId),
      magicLinkCount: 1,
      nextAction: "consume-primary-link-then-run-advance-auth",
      externalInboxCompletionRequired: true,
    };
  } finally {
    await release();
  }
};

const waitForMigratedConversation = async (
  context,
  secrets,
  conversationId,
  rawLog,
  timeoutMs = 180_000,
) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await driver.convexCall(
        context,
        secrets,
        "query",
        "cloud_apps:getMyConversation",
        { conversationId },
        "read upgraded core conversation",
        rawLog,
      );
      if (value?.conversationId === conversationId) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new CloudProofError(
    "The upgraded conversation did not become readable.",
    {
      lastErrorSha256: sha256(String(lastError ?? "none")),
    },
  );
};

const waitForExactOwnershipMigrationCompletion = async ({
  context,
  secrets,
  electron,
  completion,
  sourceOwnerSha256,
  afterUpdatedAt,
  conversationId = null,
  rawLog,
  label,
}) => {
  assert(
    SHA256_PATTERN.test(completion?.completionReceiptSha256 ?? "") &&
      SHA256_PATTERN.test(completion?.identitySha256 ?? "") &&
      SHA256_PATTERN.test(completion?.sessionIdSha256 ?? "") &&
      SHA256_PATTERN.test(completion?.ownerAccountSha256 ?? "") &&
      SHA256_PATTERN.test(sourceOwnerSha256 ?? "") &&
      Number.isSafeInteger(afterUpdatedAt) &&
      afterUpdatedAt >= 0,
    `The ${label} migration inputs are invalid.`,
  );
  const authority = await driver.readElectronSessionAuthority(
    context,
    secrets,
    electron,
    null,
    rawLog,
    `${label} migration authority`,
    {
      expectedIdentitySha256: completion.identitySha256,
      expectedSessionIdSha256: completion.sessionIdSha256,
      expectedOwnerAccountSha256: completion.ownerAccountSha256,
    },
  );
  assert(
    sha256(authority.tokenIdentity.tokenIdentifier) ===
      completion.ownerAccountSha256,
    `The ${label} migration authority changed owners.`,
  );
  const userSecrets = driver.ephemeralJwtSecrets(
    secrets,
    authority.token,
    `${label} migration authority`,
  );
  const deadline = Date.now() + 180_000;
  let migration;
  while (Date.now() < deadline) {
    migration = await driver.convexCall(
      context,
      userSecrets,
      "query",
      "auth_migration:getMyOwnershipMigrationStatus",
      {},
      `read ${label} exact ownership migration`,
      rawLog,
    );
    if (migration?.status === "failed") {
      throw new CloudProofError(`The ${label} ownership migration failed.`, {
        migrationSha256: sha256(stableJson(migration)),
      });
    }
    if (
      migration?.status === "complete" &&
      Number.isSafeInteger(migration.updatedAt) &&
      migration.updatedAt > afterUpdatedAt
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert(
    migration?.status === "complete" &&
      Number.isSafeInteger(migration.updatedAt) &&
      migration.updatedAt > afterUpdatedAt,
    `The ${label} ownership migration did not reach its exact terminal checkpoint.`,
  );
  let migratedConversationSha256 = null;
  if (conversationId) {
    const migrated = await waitForMigratedConversation(
      context,
      userSecrets,
      conversationId,
      rawLog,
    );
    assert(
      migrated.ownerId === authority.tokenIdentity.tokenIdentifier,
      `The ${label} migration did not transfer the bound conversation.`,
    );
    migratedConversationSha256 = sha256(migrated.conversationId);
  }
  const body = Object.freeze({
    outcome: "exact-ownership-migration-complete",
    sourceOwnerSha256,
    destinationOwnerSha256: completion.ownerAccountSha256,
    completionReceiptSha256: completion.completionReceiptSha256,
    status: "complete",
    updatedAt: migration.updatedAt,
    priorUpdatedAt: afterUpdatedAt,
    migrationStateSha256: sha256(stableJson(migration)),
    migratedConversationSha256,
    credentialMaterialReturned: false,
  });
  return Object.freeze({
    ...body,
    receiptSha256: sha256(stableJson(body)),
  });
};

const advanceAuth = async ({ root, email }) => {
  const secrets = requireEnvironment();
  const resolvedRoot = resolveCoreSmokeRoot(root);
  const paths = await pathsFor(resolvedRoot);
  const release = await acquireLock(paths);
  const rawLog = [];
  try {
    let state = await loadState(paths);
    assert(
      [
        "awaiting-primary-link",
        "primary-auth-complete",
        "awaiting-clean-link",
        "clean-auth-complete",
        "auth-complete",
      ].includes(state.phase),
      "Core auth cannot advance from this phase.",
    );
    if (email) {
      assert(
        sha256(email) === state.emailSha256,
        "--email does not match the prepared core auth handoff.",
      );
    }
    if (state.phase === "auth-complete") {
      return {
        status: state.phase,
        runIdSha256: sha256(state.runId),
        emailSha256: state.emailSha256,
        magicLinkCount: 2,
        liveMutationPerformed: false,
      };
    }
    const context = contextFor(state.runId);

    if (state.phase === "awaiting-primary-link") {
      const armed = await connectArmedElectronDocument(
        state.primary,
        state.auth?.primaryDocumentProof?.targetIdSha256,
      );
      let transition;
      try {
        transition = await completeAndAttestAuthTransition(armed.client, {
          runId: state.runId,
          label: "primary",
          requestReceipt: state.auth?.primaryRequest,
        });
      } finally {
        armed.client.close();
      }
      const primary = withRenderedUrl(state.primary, transition.productUrl);
      state = await checkpointState(paths, state, {
        primary,
        phase: "primary-auth-complete",
        auth: {
          ...state.auth,
          primaryCompletion: transition.completion,
          primaryTransition: transition.receipt,
        },
      });
    }

    if (state.phase === "primary-auth-complete") {
      let primaryMigration = state.auth?.primaryMigration;
      if (!primaryMigration) {
        primaryMigration = await waitForExactOwnershipMigrationCompletion({
          context,
          secrets,
          electron: state.primary,
          completion: state.auth?.primaryCompletion,
          sourceOwnerSha256: state.auth?.primarySourceOwnerSha256,
          afterUpdatedAt: 0,
          conversationId: state.conversationId,
          rawLog,
          label: "primary",
        });
        state = await checkpointState(paths, state, {
          auth: { ...state.auth, primaryMigration },
        });
      }
      assert(
        typeof email === "string" && sha256(email) === state.emailSha256,
        "The first --advance-auth invocation requires the prepared --email so it can send only the clean link after primary migration completes.",
      );
      assert(
        await renderedElectronIsReachable(state.clean),
        "The prepared clean Electron document is no longer reachable.",
      );
      const cleanClient = await connect(state.clean);
      let prepared;
      try {
        prepared = await prepareLogin({
          client: cleanClient,
          electron: state.clean,
          email,
          onboarding: state.auth?.cleanPreparation?.onboarding,
          preLoginSha256: state.auth?.cleanPreparation?.preLoginSha256,
          runId: state.runId,
          label: "clean",
        });
      } finally {
        cleanClient.close();
      }
      state = await checkpointState(paths, state, {
        clean: prepared.electron,
        phase: "awaiting-clean-link",
        auth: {
          ...state.auth,
          cleanRequest: prepared.request,
          cleanDocumentProof: prepared.documentProof,
        },
      });
      return {
        status: state.phase,
        runIdSha256: sha256(state.runId),
        emailSha256: state.emailSha256,
        primaryTransitionReceiptSha256:
          state.auth.primaryTransition.receiptSha256,
        primaryMigrationReceiptSha256:
          state.auth.primaryMigration.receiptSha256,
        magicLinkCount: 2,
        nextAction: "consume-clean-link-then-run-advance-auth",
        externalInboxCompletionRequired: true,
      };
    }

    if (state.phase === "awaiting-clean-link") {
      const armed = await connectArmedElectronDocument(
        state.clean,
        state.auth?.cleanDocumentProof?.targetIdSha256,
      );
      let transition;
      try {
        transition = await completeAndAttestAuthTransition(armed.client, {
          runId: state.runId,
          label: "clean",
          requestReceipt: state.auth?.cleanRequest,
        });
      } finally {
        armed.client.close();
      }
      const clean = withRenderedUrl(state.clean, transition.productUrl);
      state = await checkpointState(paths, state, {
        clean,
        phase: "clean-auth-complete",
        auth: {
          ...state.auth,
          cleanCompletion: transition.completion,
          cleanTransition: transition.receipt,
        },
      });
    }

    if (state.phase === "clean-auth-complete") {
      const cleanMigration = await waitForExactOwnershipMigrationCompletion({
        context,
        secrets,
        electron: state.clean,
        completion: state.auth?.cleanCompletion,
        sourceOwnerSha256: state.auth?.cleanPreparation?.sourceOwnerSha256,
        afterUpdatedAt: state.auth?.primaryMigration?.updatedAt,
        rawLog,
        label: "clean",
      });
      assert(
        state.auth.primaryCompletion.identitySha256 ===
          state.auth.cleanCompletion.identitySha256 &&
          state.auth.primaryCompletion.ownerAccountSha256 ===
            state.auth.cleanCompletion.ownerAccountSha256 &&
          state.auth.primaryCompletion.sessionIdSha256 !==
            state.auth.cleanCompletion.sessionIdSha256 &&
          state.auth.primaryCompletion.credentialMaterialReturned === false &&
          state.auth.cleanCompletion.credentialMaterialReturned === false,
        "The two staged product links did not establish one account with distinct sessions.",
      );
      const receiptSetSha256 = sha256(
        stableJson({
          primaryCompletion:
            state.auth.primaryCompletion.completionReceiptSha256,
          primaryTransition: state.auth.primaryTransition.receiptSha256,
          primaryMigration: state.auth.primaryMigration.receiptSha256,
          cleanCompletion: state.auth.cleanCompletion.completionReceiptSha256,
          cleanTransition: state.auth.cleanTransition.receiptSha256,
          cleanMigration: cleanMigration.receiptSha256,
        }),
      );
      state = await checkpointState(paths, state, {
        phase: "auth-complete",
        auth: {
          ...state.auth,
          cleanMigration,
          receiptSetSha256,
        },
        authReceiptsSha256: sha256(stableJson(rawLog)),
      });
    }

    return {
      status: state.phase,
      runIdSha256: sha256(state.runId),
      emailSha256: state.emailSha256,
      authReceiptSetSha256: state.auth.receiptSetSha256,
      magicLinkCount: 2,
      externalInboxCompletionRequired: false,
      credentialMaterialReturned: false,
    };
  } finally {
    await release();
  }
};

const messageText = (record) =>
  Array.isArray(record?.payload?.content)
    ? record.payload.content
        .filter(
          (block) => block?.type === "text" && typeof block.text === "string",
        )
        .map((block) => block.text)
        .join("\n")
    : "";

const waitForLocalCanonicalTurn = async (
  context,
  secrets,
  conversationId,
  localRunId,
  prompt,
  rawLog,
) => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const journal = await driver.loadWholeJournal(
      context,
      secrets,
      conversationId,
      rawLog,
    );
    const rows = journal.records.filter(
      (record) =>
        typeof record?.turnId === "string" &&
        record.turnId.endsWith(`:${localRunId}`),
    );
    const terminal = rows.find(
      (record) => record.kind === "turn" && record.phase === "completed",
    );
    const userMessages = rows
      .filter((record) => record.kind === "message" && record.role === "user")
      .map(messageText);
    const assistantText = rows
      .filter(
        (record) => record.kind === "message" && record.role === "assistant",
      )
      .map(messageText)
      .join("\n");
    if (
      terminal &&
      userMessages.includes(prompt) &&
      assistantText.trim().length > 0
    ) {
      const assistantMessages = rows.filter(
        (record) => record.kind === "message" && record.role === "assistant",
      );
      const providerRoutes = assistantMessages.map((record) => ({
        provider: record.payload?.provider,
        model: record.payload?.model,
      }));
      assert(
        assistantMessages.length > 0 &&
          providerRoutes.every(
            (route) =>
              typeof route.model === "string" &&
              route.model.startsWith("stella/") &&
              STELLA_MANAGED_RELAY_PROVIDERS.has(route.provider),
          ),
        `The canonical desktop turn recorded a non-Stella provider route (${providerRoutes
          .map((route) => `${String(route.provider)}/${String(route.model)}`)
          .join(", ")}).`,
      );
      return {
        journal,
        rows,
        evidence: {
          rowsSha256: sha256(stableJson(rows)),
          promptSha256: sha256(prompt),
          assistantSha256: sha256(assistantText),
          providerRoutesSha256: sha256(stableJson(providerRoutes)),
          terminalSha256: sha256(stableJson(terminal)),
        },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new CloudProofError(
    "The desktop-local turn did not reach the cloud journal.",
  );
};

const waitForRenderedConversationGrowth = async (
  client,
  before,
  minimumAdditionalRows = 2,
  timeoutMs = 120_000,
) => {
  const deadline = Date.now() + timeoutMs;
  let stableSinceMs = null;
  let lastSnapshot = null;
  while (Date.now() < deadline) {
    const snapshot = await snapshotRenderedConversation(client);
    lastSnapshot = snapshot;
    const terminalGrowth =
      snapshot.rowsSha256 !== before.rowsSha256 &&
      snapshot.rowCount >= before.rowCount + minimumAdditionalRows &&
      snapshot.chatSurfaceVisible === true &&
      snapshot.conversationIdSha256 !== null &&
      snapshot.conversationIdSha256 === snapshot.activeConversationIdSha256 &&
      snapshot.duplicateRowCount === 0 &&
      snapshot.streamingRowCount === 0 &&
      snapshot.activeWorkingIndicatorCount === 0 &&
      snapshot.composerBusy === false;
    if (terminalGrowth) {
      stableSinceMs ??= Date.now();
      if (Date.now() - stableSinceMs >= 400) {
        return await snapshotFullRenderedConversation(client, { timeoutMs });
      }
    } else {
      stableSinceMs = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new CloudProofError("The rendered desktop turn did not settle.", {
    rowCount: lastSnapshot?.rowCount ?? null,
    rowGrowth:
      lastSnapshot === null ? null : lastSnapshot.rowCount - before.rowCount,
    rowsChanged:
      lastSnapshot === null
        ? null
        : lastSnapshot.rowsSha256 !== before.rowsSha256,
    chatSurfaceVisible: lastSnapshot?.chatSurfaceVisible ?? null,
    conversationMatches:
      lastSnapshot === null
        ? null
        : lastSnapshot.conversationIdSha256 !== null &&
          lastSnapshot.conversationIdSha256 ===
            lastSnapshot.activeConversationIdSha256,
    duplicateRowCount: lastSnapshot?.duplicateRowCount ?? null,
    streamingRowCount: lastSnapshot?.streamingRowCount ?? null,
    activeWorkingIndicatorCount:
      lastSnapshot?.activeWorkingIndicatorCount ?? null,
    composerBusy: lastSnapshot?.composerBusy ?? null,
  });
};

const runCommandJson = async (binary, args, env, timeoutMs) =>
  await new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) child.kill("SIGKILL");
      else target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString("utf8").trim();
      if (code !== 0) {
        const stderrBytes = Buffer.concat(stderr);
        const stderrText = stderrBytes.toString("utf8").trim();
        let failureSha256;
        let failureEvidence;
        try {
          const parsed = JSON.parse(stderrText.split("\n").at(-1));
          if (SHA256_PATTERN.test(parsed?.errorSha256 ?? "")) {
            failureSha256 = parsed.errorSha256;
          }
          const evidence = parsed?.evidence;
          if (
            evidence &&
            typeof evidence === "object" &&
            ["completed", "failed", "canceled", "running", "pending"].includes(
              evidence.terminalState,
            ) &&
            [null, "cloud", "computer"].includes(evidence.placement) &&
            typeof evidence.conversationMatches === "boolean" &&
            typeof evidence.hasCloudTurnId === "boolean" &&
            SHA256_PATTERN.test(evidence.dispatchIdSha256 ?? "") &&
            (evidence.cloudTurnIdSha256 === undefined ||
              SHA256_PATTERN.test(evidence.cloudTurnIdSha256)) &&
            SHA256_PATTERN.test(evidence.errorCodeSha256 ?? "") &&
            SHA256_PATTERN.test(evidence.errorMessageSha256 ?? "")
          ) {
            failureEvidence = evidence;
          }
        } catch {
          // The complete stderr remains hash-only below.
        }
        reject(
          new CloudProofError("The focused mobile product process failed.", {
            exitCode: code,
            stdoutSha256: sha256(output),
            stderrSha256: sha256(stderrBytes),
            ...(failureSha256 ? { failureSha256 } : {}),
            ...(failureEvidence ? { failureEvidence } : {}),
          }),
        );
        return;
      }
      try {
        resolve(JSON.parse(output.split("\n").at(-1)));
      } catch {
        reject(
          new CloudProofError(
            "The focused mobile process returned invalid JSON.",
          ),
        );
      }
    });
  });

const mobileCoreTurn = async ({
  context,
  authority,
  conversationId,
  mobileRunId,
}) => {
  const declared = process.env.STELLA_CLOUD_ACCEPTANCE_BUN_1_4_BINARY?.trim();
  assert(
    declared && path.isAbsolute(declared),
    "A pinned Bun 1.4 binary is required.",
  );
  const bun = realpathSync(declared);
  assert(statSync(bun).isFile(), "The pinned Bun binary is unavailable.");
  const script = realpathSync(
    path.join(
      REPO_ROOT,
      "packages/mobile/scripts/cloud-canonical-real-acceptance.ts",
    ),
  );
  const systemKeys = [
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
  ];
  const environment = Object.fromEntries(
    systemKeys
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
  const result = await runCommandJson(
    bun,
    [script],
    {
      ...environment,
      STELLA_MOBILE_ACCEPTANCE_PHASE: "core",
      STELLA_MOBILE_ACCEPTANCE_RUN_ID: mobileRunId,
      STELLA_MOBILE_ACCEPTANCE_JWT: authority.token,
      STELLA_MOBILE_ACCEPTANCE_SESSION_SUBJECT: authority.subject,
      STELLA_MOBILE_ACCEPTANCE_SESSION_ID: authority.sessionId,
      STELLA_MOBILE_ACCEPTANCE_OWNER_GENERATION: authority.ownerGeneration,
      STELLA_MOBILE_ACCEPTANCE_CONVERSATION_ID: conversationId,
      STELLA_MOBILE_ACCEPTANCE_CONVEX_ORIGIN: context.target.convexUrl,
      STELLA_MOBILE_ACCEPTANCE_CONVEX_SITE_ORIGIN: context.target.convexSiteUrl,
      STELLA_MOBILE_ACCEPTANCE_BUILDER_ORIGIN: context.target.cloudBuilderUrl,
      STELLA_MOBILE_ACCEPTANCE_TIMEOUT_MS: String(12 * 60_000),
    },
    15 * 60_000,
  );
  assert(
    result?.phase === "core" &&
      result.passed === true &&
      result.providerRoute === "stella-managed-default" &&
      result.placement === "cloud" &&
      result.projectedOnCleanSocket === true &&
      result.conversationIdSha256 === sha256(conversationId),
    "The focused mobile result did not prove same-conversation cloud execution.",
  );
  for (const [key, value] of Object.entries(result)) {
    if (key.endsWith("Sha256"))
      assert(SHA256_PATTERN.test(value), `${key} is invalid.`);
  }
  const serialized = stableJson(result);
  for (const sensitive of [
    authority.token,
    authority.subject,
    authority.sessionId,
    authority.ownerGeneration,
    conversationId,
    ...Object.values(context.target),
  ]) {
    assert(
      !serialized.includes(sensitive),
      "The mobile result exposed raw authority.",
    );
  }
  return result;
};

export const validateCoreSmokeReport = (report) => {
  assert(
    report?.version === 2 &&
      report.contract === CONTRACT &&
      report.passed === true &&
      report.targetSha256 === targetSha256 &&
      Object.keys(report.scenarios ?? {})
        .sort()
        .join(",") === [...CORE_PRODUCT_SCENARIOS].sort().join(",") &&
      Object.values(report.scenarios).every(
        (scenario) => scenario?.passed === true,
      ),
    "Core smoke report is incomplete.",
  );
  const visit = (value, key = "") => {
    if (key.endsWith("Sha256")) {
      assert(
        typeof value === "string" && SHA256_PATTERN.test(value),
        `${key} is invalid.`,
      );
    }
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

const runCoreSmoke = async ({ root }) => {
  const secrets = requireEnvironment();
  const resolvedRoot = resolveCoreSmokeRoot(root);
  const paths = await pathsFor(resolvedRoot);
  const release = await acquireLock(paths);
  const rawLog = [];
  let primary;
  let clean;
  try {
    let state = await loadState(paths);
    assert(
      state.phase === "auth-complete",
      "Core auth must reach auth-complete through both --advance-auth phases before --run.",
    );
    const storedMobileProof = state.mobileProof ?? {
      version: 1,
      attempts: [],
    };
    assert(
      storedMobileProof.version === 1 &&
        Array.isArray(storedMobileProof.attempts) &&
        storedMobileProof.attempts.length <= 3,
      "The stored mobile proof ledger is invalid.",
    );
    const mobileRunIds = new Set();
    for (const attempt of storedMobileProof.attempts) {
      assert(
        UUID_PATTERN.test(attempt?.runId ?? "") &&
          !mobileRunIds.has(attempt.runId) &&
          ["pending", "failed", "completed"].includes(attempt.status) &&
          attempt.promptSha256 ===
            sha256(`Reply exactly MOBILE-CORE-${attempt.runId}.`) &&
          (attempt.status !== "completed" ||
            (attempt.receipt?.phase === "core" &&
              attempt.receipt.passed === true &&
              SHA256_PATTERN.test(attempt.receipt.assistantSha256 ?? "") &&
              SHA256_PATTERN.test(attempt.receipt.cloudTurnIdSha256 ?? ""))),
        "The stored mobile proof attempt is invalid.",
      );
      mobileRunIds.add(attempt.runId);
    }
    const priorAttempt = storedMobileProof.attempts.at(-1);
    let attempts = [...storedMobileProof.attempts];
    if (!priorAttempt || priorAttempt.status === "failed") {
      assert(
        attempts.length < 3,
        "The focused mobile proof exhausted its terminal retry limit.",
      );
      const runId = randomUUID();
      attempts.push({
        runId,
        status: "pending",
        promptSha256: sha256(`Reply exactly MOBILE-CORE-${runId}.`),
      });
      state = await checkpointState(paths, state, {
        mobileProof: { version: 1, attempts },
      });
    }
    let activeMobileAttempt = attempts.at(-1);
    assert(
      activeMobileAttempt?.status === "pending" ||
        activeMobileAttempt?.status === "completed",
      "The focused mobile proof has no resumable attempt.",
    );
    const context = contextFor(state.runId);
    primary = state.primary;
    clean = state.clean;

    if (!(await renderedElectronIsReachable(primary))) {
      primary = await driver.relaunchElectron(
        context,
        secrets,
        paths,
        { electron: primary },
        "primary",
        rawLog,
      );
    }
    if (!(await renderedElectronIsReachable(clean))) {
      clean = await driver.relaunchElectron(
        context,
        secrets,
        paths,
        {
          electron: {
            ...clean,
            vitePid: primary.vitePid,
            devServerPort: primary.devServerPort,
            viteProcessFingerprintSha256: primary.viteProcessFingerprintSha256,
            viteListenerAddressesSha256: primary.viteListenerAddressesSha256,
          },
        },
        "clean-client",
        rawLog,
      );
    }

    const primaryCompletion = state.auth?.primaryCompletion;
    const cleanCompletion = state.auth?.cleanCompletion;
    const primaryTransition = state.auth?.primaryTransition;
    const cleanTransition = state.auth?.cleanTransition;
    const primaryMigration = state.auth?.primaryMigration;
    const cleanMigration = state.auth?.cleanMigration;
    const expectedAuthReceiptSetSha256 = sha256(
      stableJson({
        primaryCompletion: primaryCompletion?.completionReceiptSha256,
        primaryTransition: primaryTransition?.receiptSha256,
        primaryMigration: primaryMigration?.receiptSha256,
        cleanCompletion: cleanCompletion?.completionReceiptSha256,
        cleanTransition: cleanTransition?.receiptSha256,
        cleanMigration: cleanMigration?.receiptSha256,
      }),
    );
    assert(
      SHA256_PATTERN.test(primaryCompletion?.completionReceiptSha256 ?? "") &&
        SHA256_PATTERN.test(cleanCompletion?.completionReceiptSha256 ?? "") &&
        primaryTransition?.sameDocument === true &&
        primaryTransition.fatalCrashObserved === false &&
        primaryTransition.fatalCrashVisible === false &&
        primaryTransition.migrationRecoveryVisible === false &&
        cleanTransition?.sameDocument === true &&
        cleanTransition.fatalCrashObserved === false &&
        cleanTransition.fatalCrashVisible === false &&
        cleanTransition.migrationRecoveryVisible === false &&
        primaryMigration?.status === "complete" &&
        cleanMigration?.status === "complete" &&
        Number.isSafeInteger(primaryMigration.updatedAt) &&
        Number.isSafeInteger(cleanMigration.updatedAt) &&
        cleanMigration.updatedAt > primaryMigration.updatedAt &&
        state.auth?.receiptSetSha256 === expectedAuthReceiptSetSha256,
      "The stored staged auth receipts are incomplete.",
    );
    const primaryClient = await connect(primary);
    const cleanClient = await connect(clean);
    try {
      // Native Electron windows share one macOS focus owner. Keep this
      // deliberately sequential so a clean-device proof cannot steal focus
      // from the primary window while a trusted click is in flight.
      await dismissOptionalNicknamePrompt(primaryClient, "primary core");
      await dismissOptionalNicknamePrompt(cleanClient, "clean core");
    } finally {
      primaryClient.close();
      cleanClient.close();
    }
    assert(
      primaryCompletion.identitySha256 === cleanCompletion.identitySha256 &&
        primaryCompletion.ownerAccountSha256 ===
          cleanCompletion.ownerAccountSha256 &&
        primaryCompletion.sessionIdSha256 !== cleanCompletion.sessionIdSha256 &&
        primaryCompletion.credentialMaterialReturned === false &&
        cleanCompletion.credentialMaterialReturned === false,
      "The two product links did not establish one account with distinct sessions.",
    );

    const primaryAuthority = await driver.readElectronSessionAuthority(
      context,
      secrets,
      primary,
      null,
      rawLog,
      "core primary",
      {
        expectedIdentitySha256: primaryCompletion.identitySha256,
        expectedSessionIdSha256: primaryCompletion.sessionIdSha256,
        expectedOwnerAccountSha256: primaryCompletion.ownerAccountSha256,
      },
    );
    const userSecrets = driver.ephemeralJwtSecrets(
      secrets,
      primaryAuthority.token,
      "core primary",
    );
    const migrated = await waitForMigratedConversation(
      context,
      userSecrets,
      state.conversationId,
      rawLog,
    );
    const placementIdentity = await driver.convexCall(
      context,
      userSecrets,
      "query",
      "execution_placement:getMyExecutionPlacementIdentity",
      {},
      "read core placement identity",
      rawLog,
    );
    assert(
      migrated.ownerId === primaryAuthority.tokenIdentity.tokenIdentifier &&
        placementIdentity.ownerId === migrated.ownerId &&
        typeof placementIdentity.ownerGeneration === "string",
      "The upgraded conversation is not owned by the signed-in account.",
    );
    primaryAuthority.ownerGeneration = placementIdentity.ownerGeneration;

    const desktopPrompt = `Reply exactly DESKTOP-CORE-${state.runId}.`;
    assert(
      typeof state.anonymousTurn?.localRunId === "string" &&
        state.anonymousTurn.promptSha256 === sha256(desktopPrompt) &&
        SHA256_PATTERN.test(state.anonymousTurn.rowsSha256 ?? "") &&
        SHA256_PATTERN.test(state.anonymousTurn.assistantSha256 ?? "") &&
        SHA256_PATTERN.test(state.anonymousTurn.terminalSha256 ?? ""),
      "The pre-upgrade desktop-turn receipt is invalid.",
    );
    const transferredDesktop = await waitForLocalCanonicalTurn(
      context,
      userSecrets,
      state.conversationId,
      state.anonymousTurn.localRunId,
      desktopPrompt,
      rawLog,
    );
    assert(
      transferredDesktop.evidence.rowsSha256 ===
        state.anonymousTurn.rowsSha256 &&
        transferredDesktop.evidence.promptSha256 ===
          state.anonymousTurn.promptSha256 &&
        transferredDesktop.evidence.assistantSha256 ===
          state.anonymousTurn.assistantSha256 &&
        transferredDesktop.evidence.terminalSha256 ===
          state.anonymousTurn.terminalSha256,
      "The anonymous desktop messages changed during account ownership transfer.",
    );
    const expectedTransferredTextRows = [
      {
        kind: "user",
        listIndex: 0,
        textSha256: state.anonymousTurn.promptSha256,
      },
      {
        kind: "assistant",
        listIndex: 1,
        textSha256: state.anonymousTurn.assistantSha256,
      },
    ];
    const expectedTransferredTextProjectionSha256 = sha256(
      stableJson(expectedTransferredTextRows),
    );

    const chatUrl = appUrl(
      `/chat?c=${encodeURIComponent(state.conversationId)}`,
    );
    let primaryChat = await connect(primary);
    let afterUpgradeProjection;
    let activeMobileAttemptRenderedBefore = false;
    try {
      await focusNativeWindow(primaryChat, "primary upgraded chat");
      await driver.navigateRenderedProduct(
        primaryChat,
        chatUrl,
        "open upgraded core chat",
      );
      primary = withRenderedUrl(primary, chatUrl);
      await selectRenderedConversation(primaryChat, {
        conversationId: state.conversationId,
        timeoutMs: 120_000,
      });
      afterUpgradeProjection = await snapshotFullRenderedConversation(
        primaryChat,
        {
          timeoutMs: 120_000,
        },
      );
      const transferredPrefix = afterUpgradeProjection.textRows.slice(0, 2);
      const priorMobileTail = afterUpgradeProjection.textRows.slice(2);
      const mobileTail = inspectExpectedMobileTextTail({
        textRows: priorMobileTail,
        legacyRunId: state.runId,
        attempts,
      });
      activeMobileAttemptRenderedBefore =
        mobileTail.activeAttemptRendered === true;
      if (
        sha256(stableJson(transferredPrefix)) !==
          expectedTransferredTextProjectionSha256 ||
        !mobileTail.valid
      ) {
        throw new CloudProofError(
          "The rendered anonymous messages changed during account ownership transfer.",
          {
            expectedTextProjectionSha256:
              expectedTransferredTextProjectionSha256,
            actualTextProjectionSha256: sha256(stableJson(transferredPrefix)),
            expectedUserTextSha256: state.anonymousTurn.promptSha256,
            actualUserTextSha256:
              afterUpgradeProjection.userTextHashes[0] ?? sha256(""),
            expectedAssistantTextSha256: state.anonymousTurn.assistantSha256,
            actualAssistantTextSha256:
              afterUpgradeProjection.assistantTextHashes[0] ?? sha256(""),
            userTextHashesSha256: sha256(
              stableJson(afterUpgradeProjection.userTextHashes),
            ),
            assistantTextHashesSha256: sha256(
              stableJson(afterUpgradeProjection.assistantTextHashes),
            ),
            rowCount: afterUpgradeProjection.rowCount,
            priorMobileTailCount: priorMobileTail.length,
            userRowCount: afterUpgradeProjection.userRowCount,
            assistantRowCount: afterUpgradeProjection.assistantRowCount,
          },
        );
      }
    } finally {
      primaryChat.close();
    }

    await driver.configureElectronSession(
      context,
      userSecrets,
      primary,
      state.conversationId,
      rawLog,
    );

    let mobile;
    let syncedProjection;
    if (activeMobileAttempt.status === "completed") {
      mobile = activeMobileAttempt.receipt;
      syncedProjection = afterUpgradeProjection;
      assert(
        activeMobileAttemptRenderedBefore &&
          syncedProjection.rowsSha256 ===
            activeMobileAttempt.desktopProjectionSha256,
        "The completed mobile proof projection changed before restart verification.",
      );
    } else {
      try {
        mobile = await mobileCoreTurn({
          context,
          authority: primaryAuthority,
          conversationId: state.conversationId,
          mobileRunId: activeMobileAttempt.runId,
        });
      } catch (error) {
        const terminalState = error?.details?.failureEvidence?.terminalState;
        if (terminalState === "failed" || terminalState === "canceled") {
          attempts = attempts.map((attempt) =>
            attempt.runId === activeMobileAttempt.runId
              ? {
                  ...attempt,
                  status: "failed",
                  failureReceipt: error.details.failureEvidence,
                }
              : attempt,
          );
          state = await checkpointState(paths, state, {
            mobileProof: { version: 1, attempts },
          });
        }
        throw error;
      }
      assert(
        mobile.promptSha256 === activeMobileAttempt.promptSha256,
        "The focused mobile result belongs to another attempt.",
      );
      if (activeMobileAttemptRenderedBefore) {
        syncedProjection = afterUpgradeProjection;
      } else {
        primaryChat = await connect(primary);
        try {
          await focusNativeWindow(primaryChat, "primary synchronized chat");
          await selectRenderedConversation(primaryChat, {
            conversationId: state.conversationId,
            timeoutMs: 120_000,
          });
          syncedProjection = await waitForRenderedConversationGrowth(
            primaryChat,
            afterUpgradeProjection,
          );
        } finally {
          primaryChat.close();
        }
      }
      const completedAttempt = {
        ...activeMobileAttempt,
        status: "completed",
        receipt: mobile,
        desktopProjectionSha256: syncedProjection.rowsSha256,
      };
      const completedTail = inspectExpectedMobileTextTail({
        textRows: syncedProjection.textRows.slice(2),
        legacyRunId: state.runId,
        attempts: attempts.map((attempt) =>
          attempt.runId === completedAttempt.runId ? completedAttempt : attempt,
        ),
      });
      assert(
        completedTail.valid === true &&
          completedTail.activeAttemptRendered === true &&
          (activeMobileAttemptRenderedBefore ||
            (syncedProjection.rowsSha256 !==
              afterUpgradeProjection.rowsSha256 &&
              syncedProjection.rowCount >=
                afterUpgradeProjection.rowCount + 2)),
        "Desktop did not render the exact mobile canonical turn.",
      );
      attempts = attempts.map((attempt) =>
        attempt.runId === completedAttempt.runId ? completedAttempt : attempt,
      );
      state = await checkpointState(paths, state, {
        mobileProof: { version: 1, attempts },
      });
      activeMobileAttempt = completedAttempt;
    }

    const previousPrimary = primary;
    const previousProjection = syncedProjection;
    const targetProbe = await connect(previousPrimary);
    const exactPreviousTargetIdSha256 = targetProbe.targetIdSha256;
    targetProbe.close();
    const stopped = await driver.stopRenderedElectron(
      previousPrimary,
      "electron.core-primary",
      rawLog,
    );
    primary = await driver.relaunchElectron(
      context,
      userSecrets,
      paths,
      { electron: previousPrimary },
      "primary",
      rawLog,
    );
    const restartedClient = await connect(primary);
    let restarted;
    try {
      await focusNativeWindow(restartedClient, "restarted primary hydration");
      restarted = await verifyRenderedColdProcessHydration(restartedClient, {
        conversationId: state.conversationId,
        expectedProjectionSha256: previousProjection.rowsSha256,
        previousProcessIdentity: previousPrimary.processIdentity,
        currentProcessIdentity: primary.processIdentity,
        previousStopReceipt: stopped,
        previousTargetIdSha256: exactPreviousTargetIdSha256,
        expectedIdentitySha256: primaryCompletion.identitySha256,
        timeoutMs: 120_000,
      });
    } finally {
      restartedClient.close();
    }

    const cleanChat = await connect(clean);
    let cleanProjection;
    try {
      await focusNativeWindow(cleanChat, "clean-client hydration");
      await verifyExistingPrimaryElectronProfile(cleanChat, {
        convexUrl: target.convexUrl,
        convexSiteUrl: target.convexSiteUrl,
        expectedIdentitySha256: cleanCompletion.identitySha256,
        expectedSessionIdSha256: cleanCompletion.sessionIdSha256,
        expectedOwnerAccountSha256: cleanCompletion.ownerAccountSha256,
      });
      await driver.navigateRenderedProduct(
        cleanChat,
        chatUrl,
        "open clean core chat",
      );
      clean = withRenderedUrl(clean, chatUrl);
      await selectRenderedConversation(cleanChat, {
        conversationId: state.conversationId,
        timeoutMs: 120_000,
      });
      cleanProjection = await snapshotFullRenderedConversation(cleanChat, {
        timeoutMs: 120_000,
      });
      assert(
        cleanProjection.rowsSha256 === restarted.canonicalRowsSha256,
        "The clean same-account client hydrated another projection.",
      );
    } finally {
      cleanChat.close();
    }

    const report = validateCoreSmokeReport({
      version: 2,
      contract: CONTRACT,
      passed: true,
      targetSha256,
      runIdSha256: sha256(state.runId),
      emailSha256: state.emailSha256,
      conversationIdSha256: sha256(state.conversationId),
      ownerGenerationSha256: sha256(placementIdentity.ownerGeneration),
      authReceiptSetSha256: state.auth.receiptSetSha256,
      receiptSetSha256: sha256(stableJson(rawLog)),
      scenarios: {
        anonymous_upgrade_preserves_conversation: {
          passed: true,
          beforeConversationSha256: sha256(state.conversationId),
          afterConversationSha256: sha256(migrated.conversationId),
          beforeProjectionSha256:
            state.anonymousTurn.projectionTextSha256 ??
            expectedTransferredTextProjectionSha256,
          afterProjectionSha256: expectedTransferredTextProjectionSha256,
          transferredTurnRowsSha256: transferredDesktop.evidence.rowsSha256,
          primaryTransitionReceiptSha256:
            state.auth.primaryTransition.receiptSha256,
          primaryMigrationReceiptSha256:
            state.auth.primaryMigration.receiptSha256,
          cleanTransitionReceiptSha256:
            state.auth.cleanTransition.receiptSha256,
          cleanMigrationReceiptSha256: state.auth.cleanMigration.receiptSha256,
        },
        desktop_local_turn_is_cloud_canonical: {
          passed: true,
          provider: "stella",
          localRunIdSha256: sha256(state.anonymousTurn.localRunId),
          promptSha256: state.anonymousTurn.promptSha256,
          journalBeforeSha256: state.anonymousTurn.journalBeforeSha256,
          journalAfterSha256: state.anonymousTurn.journalAfterSha256,
          turnRowsSha256: state.anonymousTurn.rowsSha256,
          assistantSha256: state.anonymousTurn.assistantSha256,
        },
        mobile_cloud_turn_syncs_to_desktop: {
          passed: true,
          provider: "stella",
          placement: "cloud",
          mobileAttemptSha256: sha256(activeMobileAttempt.runId),
          mobileSummarySha256: sha256(stableJson(mobile)),
          mobileTurnSha256: mobile.cloudTurnIdSha256,
          desktopProjectionSha256: syncedProjection.rowsSha256,
        },
        restart_and_clean_client_hydrate: {
          passed: true,
          restartedProjectionSha256: restarted.canonicalRowsSha256,
          cleanProjectionSha256: cleanProjection.rowsSha256,
          previousProcessSha256:
            previousPrimary.processIdentity.processInstanceSha256,
          restartedProcessSha256: primary.processIdentity.processInstanceSha256,
          cleanProcessSha256: clean.processIdentity.processInstanceSha256,
        },
      },
    });
    await writePrivateJson(paths.reportFile, report);
    await writePrivateJson(
      paths.stateFile,
      sealState({
        ...Object.fromEntries(
          Object.entries(state).filter(([key]) => key !== "stateSha256"),
        ),
        primary,
        clean,
        phase: "complete",
        reportSha256: sha256(stableJson(report)),
      }),
    );
    return { reportFile: paths.reportFile, report };
  } finally {
    for (const [electron, label] of [
      [primary, "electron.core-primary.final"],
      [clean, "electron.core-clean.final"],
    ]) {
      if (!electron?.pid) continue;
      await driver
        .stopProcess(electron.pid, label, rawLog, {
          expectedProcessFingerprintSha256: electron.processFingerprintSha256,
        })
        .catch(() => undefined);
    }
    const vite = primary ?? clean;
    if (vite?.vitePid) {
      await driver
        .stopProcess(vite.vitePid, "vite.core.final", rawLog, {
          expectedProcessFingerprintSha256: vite.viteProcessFingerprintSha256,
        })
        .catch(() => undefined);
    }
    await release();
  }
};

const check = () => {
  const expectedPrimitives = [
    "buildElectron",
    "configureElectronSession",
    "connectElectronRenderedClient",
    "convexCall",
    "driveVisibleProductOnboarding",
    "electronLocalTurn",
    "ephemeralJwtSecrets",
    "launchElectron",
    "launchVite",
    "loadSecrets",
    "loadWholeJournal",
    "navigateRenderedProduct",
    "readAnonymousElectronAuthority",
    "readElectronSessionAuthority",
    "relaunchElectron",
    "stopProcess",
    "stopRenderedElectron",
  ];
  assert(
    expectedPrimitives.every((name) => typeof driver[name] === "function"),
    "A reviewed core product primitive is unavailable.",
  );
  assert(
    statSync(
      path.join(
        REPO_ROOT,
        "packages/mobile/scripts/cloud-canonical-real-acceptance.ts",
      ),
    ).isFile(),
    "The reviewed mobile core path is unavailable.",
  );
  return {
    contract: CONTRACT,
    targetSha256,
    scenarios: CORE_PRODUCT_SCENARIOS,
    authPhases: [
      "awaiting-primary-link",
      "primary-auth-complete",
      "awaiting-clean-link",
      "clean-auth-complete",
      "auth-complete",
    ],
    emailCount: 1,
    magicLinkCount: 2,
    liveMutationPerformed: false,
  };
};

export const runCoreSmokeCli = async (argv = process.argv.slice(2)) => {
  const parsed = parseCoreSmokeArguments(argv);
  if (parsed.mode === "--list") {
    process.stdout.write(`${CORE_PRODUCT_SCENARIOS.join("\n")}\n`);
    return;
  }
  if (parsed.mode === "--check") {
    process.stdout.write(`${JSON.stringify(check())}\n`);
    return;
  }
  const result =
    parsed.mode === "--prepare-auth"
      ? await prepareAuth(parsed)
      : parsed.mode === "--advance-auth"
        ? await advanceAuth(parsed)
        : await runCoreSmoke(parsed);
  process.stdout.write(`${JSON.stringify(result)}\n`);
};

const invokedDirectly = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === SCRIPT_FILE;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  runCoreSmokeCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`CORE PRODUCT SMOKE FAILED: ${message}\n`);
    if (error instanceof CloudProofError && error.details) {
      process.stderr.write(
        `CORE PRODUCT SMOKE DETAILS: ${stableJson(error.details)}\n`,
      );
    }
    process.exitCode = 1;
  });
}
