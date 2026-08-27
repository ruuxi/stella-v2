import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  RENDERED_CLIENT_CDP_CONTRACT,
  RenderedClientCdpSession,
  authenticateRenderedClient,
  assertIsolatedRenderedClientPath,
  beginRenderedBrowserStorageRecovery,
  beginRenderedProductMagicLinkLogin,
  composeRenderedCrossProcessIdentityRoundTrip,
  completeRenderedBrowserStorageRecovery,
  completeRenderedProductMagicLinkLogin,
  exerciseRenderedBrowserStorageRecovery,
  liveBrowserProfileMetadataSha256,
  ownedBrowserProfileContinuitySha256,
  parseLoopbackCdpListenerRecords,
  renderedProcessIdentity,
  renderedClientReceipt,
  resolveReviewedChromiumBinary,
  snapshotFullRenderedConversation,
  verifyExistingAnonymousElectronProfile,
  verifyExistingPrimaryBrowserProfile,
  verifyExistingPrimaryElectronProfile,
  verifyRenderedProductOnboardingPersistence,
  verifyRenderedProductLoginSameProfileChat,
  verifyRenderedColdProcessHydration,
} from "../scripts/rendered-client-cdp.mjs";
import {
  CloudProofError,
  REQUIRED_CLOUD_BUILDER_ORIGIN,
  REQUIRED_CONVEX,
  sha256,
} from "../scripts/cloud-proof-lib.mjs";

const temporaryDirectories = [];

const temporaryDirectory = async (prefix) => {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: false });
  }
});

class FakeCdpSocket extends EventTarget {
  sent = [];
  closed = false;

  send(payload) {
    this.sent.push(payload);
  }

  close() {
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }

  emit(method, params) {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ method, params }),
      }),
    );
  }
}

const renderedRow = (id, text, kind, listIndex) => ({
  idSha256: sha256(id),
  textSha256: sha256(text),
  contentSha256: sha256(`content:${text}`),
  kind,
  listIndex,
  streaming: false,
  visible: true,
});

class FakeVirtualizedRenderedClient {
  surface = "browser-cdp";
  index = 2;
  authSetupUseCount = 0;
  targetIdSha256 = sha256("new-renderer-target");
  endpointOwnership = null;
  rows = [
    renderedRow("row-a", "oldest", "user", 0),
    renderedRow("row-b", "middle", "assistant", 1),
    renderedRow("row-c", "newest", "user", 2),
  ];

  async evaluate(_expression, label) {
    if (label.startsWith("snapshot ")) {
      // Deliberately model LegendList's recycled containers before its
      // delayed DOM reorder: overlapping windows arrive newest-first.
      const mountedRows =
        this.index === 0
          ? [this.rows[1], this.rows[0]]
          : this.index === 1
            ? [this.rows[2], this.rows[1]]
            : [this.rows[2]];
      const userRows = mountedRows.filter((row) => row.kind === "user");
      const assistantRows = mountedRows.filter(
        (row) => row.kind === "assistant",
      );
      return {
        surface: this.surface,
        locationSha256: sha256("http://127.0.0.1:4173/"),
        conversationIdSha256: sha256("conversation"),
        activeConversationIdSha256: sha256("conversation"),
        chatSurfacePresent: true,
        chatSurfaceVisible: true,
        composerPresent: true,
        composerVisible: true,
        composerEnabled: true,
        composerInteractive: true,
        composerBusy: false,
        composerMountSha256: null,
        rowCount: mountedRows.length,
        uniqueRowCount: mountedRows.length,
        duplicateRowCount: 0,
        userRowCount: userRows.length,
        assistantRowCount: assistantRows.length,
        streamingRowCount: 0,
        visibleRowCount: mountedRows.length,
        geometryOrdered: true,
        workingIndicatorCount: 0,
        activeWorkingIndicatorCount: 0,
        rowsSha256: sha256(JSON.stringify(mountedRows)),
        rows: mountedRows,
        rowIdHashes: mountedRows.map((row) => row.idSha256),
        userRows,
        assistantRows,
        userTextHashes: userRows.map((entry) => entry.textSha256),
        assistantTextHashes: assistantRows.map((entry) => entry.textSha256),
        noticeCount: 0,
        visibleAlertCount: 0,
        visibleStatusCount: 0,
        noticesSha256: sha256("[]"),
      };
    }
    if (label.startsWith("refresh ")) {
      return {
        authenticated: true,
        identitySha256: sha256("preserved-identity"),
        identityRevision: 3,
        anonymous: false,
      };
    }
    if (label.includes("rendered timeline geometry")) {
      return {
        conversationId: "conversation",
        hasOlder: false,
        loadingOlder: false,
        scrollTop: this.index * 100,
        scrollHeight: 300,
        clientHeight: 100,
        renderedRowCount: this.rows.length,
        x: 50,
        y: 50,
        width: 100,
        height: 100,
      };
    }
    throw new Error(`Unexpected fake evaluation: ${label}`);
  }

  async command(method, params) {
    expect(method).toBe("Input.dispatchMouseEvent");
    if (params.type !== "mouseWheel") return {};
    this.index = Math.max(
      0,
      Math.min(this.rows.length - 1, this.index + (params.deltaY < 0 ? -1 : 1)),
    );
    return {};
  }
}

class FakeAuthenticationClient {
  surface = "browser-cdp";
  authSetupUseCount = 0;

  constructor(anonymous) {
    this.anonymous = anonymous;
    this.originHashes = [
      sha256(new URL(REQUIRED_CONVEX.cloudUrl).origin),
      sha256(new URL(REQUIRED_CONVEX.siteUrl).origin),
    ].sort();
  }

  async evaluate() {
    return {
      authenticated: true,
      identitySha256: sha256(
        this.anonymous ? "anonymous-secondary" : "primary-account",
      ),
      identityRevision: 1,
      anonymous: this.anonymous,
      targetSha256: sha256("reviewed-dev-target"),
      convexOriginSha256: sha256(new URL(REQUIRED_CONVEX.cloudUrl).origin),
      convexSiteOriginSha256: sha256(new URL(REQUIRED_CONVEX.siteUrl).origin),
    };
  }

  telemetry() {
    return {
      networkOriginHashes: this.originHashes,
      networkOriginsSha256: sha256(JSON.stringify(this.originHashes)),
    };
  }
}

class FakeExistingAnonymousElectronClient {
  surface = "electron-cdp";
  authSetupUseCount = 0;

  constructor({ identity = "anonymous-b", session = "session-b" } = {}) {
    this.identitySha256 = sha256(identity);
    this.sessionIdSha256 = sha256(session);
    this.ownerAccountSha256 = sha256(`owner:${identity}`);
    this.originHashes = [
      sha256(new URL(REQUIRED_CONVEX.cloudUrl).origin),
    ].sort();
  }

  async evaluate(expression) {
    this.lastExpression = expression;
    return {
      authenticated: true,
      anonymous: true,
      identityClass: "anonymous-secondary",
      identityRevision: 4,
      identitySha256: this.identitySha256,
      sessionIdSha256: this.sessionIdSha256,
      jwtSha256: sha256("ephemeral-jwt"),
      jwtIssuerSha256: sha256(REQUIRED_CONVEX.siteUrl),
      jwtSubjectSha256: this.identitySha256,
      jwtTokenIdentifierSha256: this.ownerAccountSha256,
      ownerAccountSha256: this.ownerAccountSha256,
      jwtExpirySha256: sha256("expiry"),
      sessionJwtBindingSha256: sha256("session-jwt-binding"),
      targetSha256: sha256(
        `${REQUIRED_CONVEX.cloudUrl}\n${REQUIRED_CONVEX.siteUrl}`,
      ),
      convexOriginSha256: sha256(new URL(REQUIRED_CONVEX.cloudUrl).origin),
      convexSiteOriginSha256: sha256(new URL(REQUIRED_CONVEX.siteUrl).origin),
    };
  }

  telemetry() {
    return {
      networkOriginHashes: this.originHashes,
      networkOriginsSha256: sha256(JSON.stringify(this.originHashes)),
    };
  }
}

const existingPrimaryAuthorityResult = ({
  identity = "primary-a",
  session = "primary-session",
} = {}) => {
  const identitySha256 = sha256(identity);
  const ownerAccountSha256 = sha256(`owner:${identity}`);
  return {
    authenticated: true,
    anonymous: false,
    identityClass: "non-anonymous",
    identityRevision: 7,
    identitySha256,
    sessionIdSha256: sha256(session),
    jwtSha256: sha256(`jwt:${session}`),
    jwtIssuerSha256: sha256(REQUIRED_CONVEX.siteUrl),
    jwtSubjectSha256: identitySha256,
    jwtTokenIdentifierSha256: ownerAccountSha256,
    ownerAccountSha256,
    jwtExpirySha256: sha256("primary-expiry"),
    sessionJwtBindingSha256: sha256(`binding:${identity}:${session}`),
    targetSha256: sha256(
      `${REQUIRED_CONVEX.cloudUrl}\n${REQUIRED_CONVEX.siteUrl}`,
    ),
    convexOriginSha256: sha256(new URL(REQUIRED_CONVEX.cloudUrl).origin),
    convexSiteOriginSha256: sha256(new URL(REQUIRED_CONVEX.siteUrl).origin),
  };
};

class FakeExistingPrimaryRenderedClient {
  authSetupUseCount = 0;
  targetIdSha256 = sha256("primary-renderer-target");

  constructor({
    surface = "browser-cdp",
    identity = "primary-a",
    session = "primary-session",
  } = {}) {
    this.surface = surface;
    this.authority = existingPrimaryAuthorityResult({ identity, session });
    this.originHashes = [
      sha256(new URL(REQUIRED_CONVEX.cloudUrl).origin),
      ...(surface === "browser-cdp"
        ? [sha256(new URL(REQUIRED_CONVEX.siteUrl).origin)]
        : []),
    ].sort();
  }

  async evaluate(expression) {
    this.lastExpression = expression;
    return this.authority;
  }

  telemetry() {
    return {
      networkOriginHashes: this.originHashes,
      networkOriginsSha256: sha256(JSON.stringify(this.originHashes)),
    };
  }
}

class FakeProductMagicLinkClient extends FakeExistingPrimaryRenderedClient {
  dialogOpen = true;
  email = "";
  sent = false;
  externallyCompleted = false;
  pendingClick = null;
  requestCount = 2;
  responseCount = 2;
  conversationId = "post-login-conversation";

  async evaluate(expression, label) {
    this.lastExpression = expression;
    if (label?.includes("product onboarding persistence")) {
      return {
        exactOrigin: true,
        productOriginSha256: sha256("http://127.0.0.1:57314"),
        onboardingPersisted: true,
        appShellRendered: true,
        onboardingSurfaceAbsent: true,
        crashSurfaceAbsent: true,
      };
    }
    if (label?.includes("pre-chat product login readiness")) {
      return {
        exactOrigin: true,
        productOriginSha256: sha256("http://127.0.0.1:57314"),
        onboardingPersisted: true,
        settingsAuthRoute: true,
        routeSha256: sha256("/settings?dialog=auth"),
        authDialogReady: true,
        preChatSurfaceAbsent: true,
        crashSurfaceAbsent: true,
      };
    }
    if (label?.startsWith("verify existing primary")) {
      if (!this.externallyCompleted) throw new Error("not authenticated");
      return this.authority;
    }
    if (label?.includes("pre-login authority")) {
      return { pending: false, signedIn: true, anonymous: true };
    }
    if (label?.includes("observe") && label.endsWith("auth dialog")) {
      return this.dialogOpen;
    }
    if (label?.includes("product sign-in control")) return true;
    if (
      label?.startsWith("observe ") &&
      label.includes("product magic-link form")
    )
      return this.dialogOpen;
    if (label?.startsWith("open ")) {
      this.pendingClick = "open";
      return { x: 10, y: 10 };
    }
    if (label?.startsWith("focus ")) {
      this.pendingClick = "focus";
      return { x: 12, y: 12 };
    }
    if (label?.startsWith("verify ") && label.includes("magic-link email")) {
      return sha256(this.email);
    }
    if (label?.startsWith("submit ")) {
      this.pendingClick = "submit";
      return { x: 14, y: 14 };
    }
    if (label?.includes("product magic-link request")) {
      return {
        dialogVisible: this.dialogOpen,
        emailSha256: sha256(this.email),
        sentOpen: this.sent,
        sentVisible: this.sent,
        errorVisible: false,
        errorSha256: null,
      };
    }
    if (label?.includes("product magic-link completion")) {
      return {
        pending: false,
        authenticated: this.externallyCompleted,
        anonymous: !this.externallyCompleted,
        identitySha256: this.externallyCompleted
          ? this.authority.identitySha256
          : null,
        authDialogOpen: !this.externallyCompleted,
      };
    }
    if (label?.startsWith("snapshot ")) {
      return {
        surface: this.surface,
        locationSha256: sha256("http://127.0.0.1:57314/"),
        conversationIdSha256: sha256(this.conversationId),
        activeConversationIdSha256: sha256(this.conversationId),
        chatSurfacePresent: true,
        chatSurfaceVisible: true,
        composerPresent: true,
        composerVisible: true,
        composerEnabled: true,
        composerInteractive: true,
        composerBusy: false,
        composerMountSha256: null,
        rowCount: 0,
        uniqueRowCount: 0,
        duplicateRowCount: 0,
        geometryOrdered: true,
        userRowCount: 0,
        assistantRowCount: 0,
        streamingRowCount: 0,
        visibleRowCount: 0,
        workingIndicatorCount: 0,
        activeWorkingIndicatorCount: 0,
        rowsSha256: sha256("[]"),
        rows: [],
        rowIdHashes: [],
        userRows: [],
        assistantRows: [],
        userTextHashes: [],
        assistantTextHashes: [],
        noticeCount: 0,
        visibleAlertCount: 0,
        visibleStatusCount: 0,
        noticesSha256: sha256("[]"),
      };
    }
    if (label?.includes("same-profile product chat surface")) {
      return {
        chatRoute: true,
        routeSha256: sha256("/chat"),
        authDialogAbsent: true,
        crashSurfaceAbsent: true,
      };
    }
    throw new Error(`Unexpected magic-link evaluation: ${label}`);
  }

  async command(method, params) {
    if (method === "Input.insertText") {
      this.email = params.text;
      return {};
    }
    if (
      method === "Input.dispatchMouseEvent" &&
      params.type === "mouseReleased"
    ) {
      if (this.pendingClick === "open") this.dialogOpen = true;
      if (this.pendingClick === "submit") {
        this.sent = true;
        this.requestCount += 1;
        this.responseCount += 1;
      }
      this.pendingClick = null;
    }
    return {};
  }

  telemetry() {
    return {
      networkOriginHashes: this.originHashes,
      networkOriginsSha256: sha256(JSON.stringify(this.originHashes)),
      requestCount: this.requestCount,
      requestsSha256: sha256(`requests:${this.requestCount}`),
      responseCount: this.responseCount,
      responsesSha256: sha256(`responses:${this.responseCount}`),
    };
  }
}

const canonicalizeForTest = (value) => {
  if (Array.isArray(value)) return value.map(canonicalizeForTest);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeForTest(value[key])]),
    );
  }
  return value;
};

class FakeBrowserStorageRecoveryClient extends FakeExistingPrimaryRenderedClient {
  surface = "browser-cdp";
  state = "authenticated";

  constructor() {
    super({ surface: "browser-cdp" });
    this.origin = "http://127.0.0.1:4173";
    this.conversationId = "conversation-storage-recovery";
    this.row = renderedRow("storage-row", "canonical answer", "assistant", 0);
    const { visible: _visible, ...canonicalRow } = this.row;
    this.expectedProjectionSha256 = sha256(
      JSON.stringify(canonicalizeForTest([canonicalRow])),
    );
  }

  snapshot() {
    const authenticated = this.state !== "cleared";
    const rows = authenticated ? [this.row] : [];
    const rowIds = rows.map((row) => row.idSha256);
    return {
      surface: this.surface,
      locationSha256: sha256(`${this.origin}/`),
      conversationIdSha256: authenticated ? sha256(this.conversationId) : null,
      activeConversationIdSha256: authenticated
        ? sha256(this.conversationId)
        : null,
      chatSurfacePresent: authenticated,
      chatSurfaceVisible: authenticated,
      composerPresent: authenticated,
      composerVisible: authenticated,
      composerEnabled: authenticated,
      composerInteractive: authenticated,
      composerBusy: false,
      composerMountSha256: null,
      rowCount: rows.length,
      uniqueRowCount: new Set(rowIds).size,
      duplicateRowCount: 0,
      geometryOrdered: true,
      userRowCount: 0,
      assistantRowCount: rows.length,
      streamingRowCount: 0,
      visibleRowCount: rows.length,
      workingIndicatorCount: 0,
      activeWorkingIndicatorCount: 0,
      rowsSha256: sha256("fake-mounted-rows"),
      rows,
      rowIdHashes: rowIds,
      userRows: [],
      assistantRows: rows,
      userTextHashes: [],
      assistantTextHashes: rows.map((row) => row.textSha256),
      noticeCount: 0,
      visibleAlertCount: 0,
      visibleStatusCount: 0,
      noticesSha256: sha256("no-notices"),
    };
  }

  async evaluate(expression, label) {
    this.lastExpression = expression;
    if (label?.startsWith("verify existing primary browser profile")) {
      if (this.state === "cleared") throw new Error("signed out");
      return this.authority;
    }
    if (label === "snapshot browser-cdp conversation") return this.snapshot();
    if (label === "observe browser-cdp rendered timeline geometry") {
      return {
        conversationId: this.conversationId,
        hasOlder: false,
        loadingOlder: false,
        scrollTop: 0,
        scrollHeight: 600,
        clientHeight: 600,
        renderedRowCount: 1,
        x: 100,
        y: 100,
        width: 600,
        height: 600,
      };
    }
    if (label === "observe rendered browser storage origin") return this.origin;
    if (label === "verify rendered browser storage deletion") {
      return {
        originMatches: true,
        localStorageCount: 0,
        sessionStorageCount: 0,
        cookieCount: 0,
        indexedDbCount: 0,
        cacheCount: 0,
      };
    }
    if (label === "observe cleared browser identity") {
      return {
        pending: false,
        signedIn: true,
        anonymous: true,
        identitySha256: sha256("cleared-anonymous"),
        originSha256: sha256(this.origin),
        readyState: "complete",
      };
    }
    if (label === "snapshot browser-cdp rendered outbox") {
      return {
        count: 0,
        keyHashes: [],
        accountScopeHashes: [],
        ownerGenerationHashes: [],
        keysSha256: sha256("empty-outbox"),
      };
    }
    throw new Error(`Unexpected storage evaluation: ${label}`);
  }

  async command(method) {
    if (method === "Storage.clearDataForOrigin") return {};
    throw new Error(`Unexpected storage command: ${method}`);
  }

  async reload() {
    this.state = "cleared";
  }

  completeProductLogin() {
    this.state = "recovered";
    this.authority = existingPrimaryAuthorityResult({
      identity: "primary-a",
      session: "rotated-primary-session",
    });
  }
}

describe("rendered client path and browser ownership fences", () => {
  test("rejects a nonexistent child whose existing parent symlink escapes the harness", async () => {
    const root = await temporaryDirectory("stella-rendered-path-");
    const harness = path.join(root, "harness");
    const outside = path.join(root, "outside");
    await mkdir(harness);
    await mkdir(outside);
    await symlink(outside, path.join(harness, "escape"));

    expect(() =>
      assertIsolatedRenderedClientPath(
        path.join(harness, "escape", "not-created", "profile"),
        harness,
        {
          repoRoot: path.join(root, "repo"),
          homeDir: path.join(root, "home"),
          liveStellaRoot: path.join(root, "home", ".stella"),
        },
      ),
    ).toThrow(CloudProofError);

    expect(
      assertIsolatedRenderedClientPath(
        path.join(harness, "owned", "profile"),
        harness,
        {
          repoRoot: path.join(root, "repo"),
          homeDir: path.join(root, "home"),
          liveStellaRoot: path.join(root, "home", ".stella"),
        },
      ),
    ).toBe(path.join(await realpath(harness), "owned", "profile"));
  });

  test("accepts only an executable from the exact reviewed binary allowlist", async () => {
    const root = await temporaryDirectory("stella-rendered-binary-");
    const binary = path.join(root, "reviewed-browser");
    await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await chmod(binary, 0o700);
    const candidate = {
      flavor: "test-chromium",
      binary,
      liveProfile: path.join(root, "live-profile"),
    };

    expect(
      resolveReviewedChromiumBinary({
        env: { STELLA_CLOUD_ACCEPTANCE_BROWSER_BINARY: binary },
        candidates: [candidate],
      }),
    ).toMatchObject({
      flavor: "test-chromium",
      binary: await realpath(binary),
    });
    expect(() =>
      resolveReviewedChromiumBinary({
        env: {
          STELLA_CLOUD_ACCEPTANCE_BROWSER_BINARY: path.join(root, "other"),
        },
        candidates: [candidate],
      }),
    ).toThrow(CloudProofError);
  });

  test("fingerprints the complete profile metadata without opening secret-bearing files", async () => {
    const root = await temporaryDirectory("stella-rendered-live-profile-");
    const nested = path.join(root, "Arbitrary", "Nested");
    await mkdir(nested, { recursive: true });
    const secretFile = path.join(nested, "not-a-hardcoded-sentinel.db");
    await writeFile(secretFile, "secret-one", { mode: 0o000 });
    const before = liveBrowserProfileMetadataSha256(root);
    expect(before).toMatch(/^[a-f0-9]{64}$/u);

    await chmod(secretFile, 0o600);
    await writeFile(secretFile, "secret-two-with-a-different-size");
    await chmod(secretFile, 0o000);
    const after = liveBrowserProfileMetadataSha256(root);
    expect(after).toMatch(/^[a-f0-9]{64}$/u);
    expect(after).not.toBe(before);
  });

  test("binds disposable profile continuity while ignoring only volatile browser files", async () => {
    const root = await temporaryDirectory("stella-rendered-owned-profile-");
    const nested = path.join(root, "Default", "IndexedDB");
    await mkdir(nested, { recursive: true });
    const durable = path.join(nested, "opaque-storage.db");
    await writeFile(durable, "secret-profile-state", { mode: 0o000 });
    const before = ownedBrowserProfileContinuitySha256(root);

    await writeFile(
      path.join(root, "DevToolsActivePort"),
      "9222\n/devtools/browser/id\n",
    );
    await writeFile(path.join(root, "SingletonLock"), "volatile");
    expect(ownedBrowserProfileContinuitySha256(root)).toBe(before);

    await chmod(durable, 0o600);
    await rm(path.join(root, "Default"), { recursive: true, force: false });
    expect(ownedBrowserProfileContinuitySha256(root)).not.toBe(before);
  });

  test("accepts only exact loopback lsof listeners owned by the expected pid", () => {
    const options = { pid: 321, port: 9222 };
    const ipv4 = parseLoopbackCdpListenerRecords(
      "p321\nn127.0.0.1:9222\n",
      options,
    );
    expect(ipv4.listenerAddressCount).toBe(1);
    expect(ipv4.listenerAddressesSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      parseLoopbackCdpListenerRecords("p321\nn[::1]:9222\n", options)
        .listenerAddressCount,
    ).toBe(1);

    for (const invalid of [
      "p321\nn*:9222\n",
      "p321\nn0.0.0.0:9222\n",
      "p321\nn[::]:9222\n",
      "p321\nn127.0.0.1:9223\n",
      "p321\nn127.0.0.1:9222\np999\nn127.0.0.1:9222\n",
      "p321\n",
      "n127.0.0.1:9222\n",
    ]) {
      expect(() => parseLoopbackCdpListenerRecords(invalid, options)).toThrow(
        CloudProofError,
      );
    }
  });
});

describe("hash-only CDP transport evidence", () => {
  test("keeps anonymous identity opt-in limited to an explicit secondary", async () => {
    const authentication = {
      sessionCookie: "in-memory-only-cookie",
      convexUrl: REQUIRED_CONVEX.cloudUrl,
      convexSiteUrl: REQUIRED_CONVEX.siteUrl,
    };
    const defaultClient = new FakeAuthenticationClient(true);
    await expect(
      authenticateRenderedClient(defaultClient, authentication),
    ).rejects.toThrow(CloudProofError);
    expect(defaultClient.authSetupUseCount).toBe(1);

    const secondaryClient = new FakeAuthenticationClient(true);
    const accepted = await authenticateRenderedClient(secondaryClient, {
      ...authentication,
      expectedIdentityClass: "anonymous-secondary",
    });
    expect(accepted).toMatchObject({
      anonymous: true,
      identityClass: "anonymous-secondary",
      identitySha256: sha256("anonymous-secondary"),
    });
    expect(JSON.stringify(accepted)).not.toContain("in-memory-only-cookie");
  });

  test("verifies an existing anonymous Electron profile without returning credentials", async () => {
    const target = {
      convexUrl: REQUIRED_CONVEX.cloudUrl,
      convexSiteUrl: REQUIRED_CONVEX.siteUrl,
    };
    const firstClient = new FakeExistingAnonymousElectronClient();
    const first = await verifyExistingAnonymousElectronProfile(
      firstClient,
      target,
    );
    expect(first).toMatchObject({
      authenticated: true,
      anonymous: true,
      identityClass: "anonymous-secondary",
      existingProfileContinuityVerified: false,
      credentialMaterialReturned: false,
    });
    expect(firstClient.authSetupUseCount).toBe(0);
    expect(firstClient.lastExpression).toContain("getConvexAuthToken");
    for (const forbiddenKey of [
      "token",
      "sessionCookie",
      "subject",
      "sessionId",
    ]) {
      expect(Object.keys(first)).not.toContain(forbiddenKey);
    }
    for (const forbiddenValue of [
      "anonymous-b",
      "session-b",
      "ephemeral-jwt",
    ]) {
      expect(JSON.stringify(first)).not.toContain(forbiddenValue);
    }

    const relaunched = new FakeExistingAnonymousElectronClient();
    const continued = await verifyExistingAnonymousElectronProfile(relaunched, {
      ...target,
      expectedIdentitySha256: first.identitySha256,
      expectedSessionIdSha256: first.sessionIdSha256,
      expectedOwnerAccountSha256: first.ownerAccountSha256,
    });
    expect(continued.existingProfileContinuityVerified).toBe(true);
    expect(continued.identitySha256).toBe(first.identitySha256);
    expect(continued.sessionIdSha256).toBe(first.sessionIdSha256);

    await expect(
      verifyExistingAnonymousElectronProfile(
        new FakeExistingAnonymousElectronClient(),
        {
          ...target,
          expectedIdentitySha256: sha256("wrong-owner"),
          expectedSessionIdSha256: first.sessionIdSha256,
          expectedOwnerAccountSha256: first.ownerAccountSha256,
        },
      ),
    ).rejects.toThrow(CloudProofError);
    await expect(
      verifyExistingAnonymousElectronProfile(
        new FakeExistingAnonymousElectronClient(),
        {
          ...target,
          expectedIdentitySha256: first.identitySha256,
        },
      ),
    ).rejects.toThrow(CloudProofError);
  });

  test("verifies existing primary browser and Electron profiles without exporting authority material", async () => {
    const target = {
      convexUrl: REQUIRED_CONVEX.cloudUrl,
      convexSiteUrl: REQUIRED_CONVEX.siteUrl,
    };
    const browser = new FakeExistingPrimaryRenderedClient();
    const browserAuthority = await verifyExistingPrimaryBrowserProfile(
      browser,
      target,
    );
    expect(browserAuthority).toMatchObject({
      authenticated: true,
      anonymous: false,
      identityClass: "non-anonymous",
      existingProfileContinuityVerified: false,
      credentialMaterialReturned: false,
    });
    expect(browser.lastExpression).toContain("getConvexToken");
    expect(browser.lastExpression).not.toContain(
      "applyBrowserAuthSessionCookie",
    );

    const electron = new FakeExistingPrimaryRenderedClient({
      surface: "electron-cdp",
    });
    const electronAuthority = await verifyExistingPrimaryElectronProfile(
      electron,
      {
        ...target,
        expectedIdentitySha256: browserAuthority.identitySha256,
        expectedSessionIdSha256: browserAuthority.sessionIdSha256,
        expectedOwnerAccountSha256: browserAuthority.ownerAccountSha256,
      },
    );
    expect(electronAuthority.existingProfileContinuityVerified).toBe(true);
    expect(electron.lastExpression).toContain("getConvexAuthToken");
    expect(electron.authSetupUseCount).toBe(0);
    for (const forbidden of [
      "primary-a",
      "primary-session",
      "sessionCookie",
      "jwt:primary-session",
    ]) {
      expect(JSON.stringify(browserAuthority)).not.toContain(forbidden);
      expect(JSON.stringify(electronAuthority)).not.toContain(forbidden);
    }
  });

  test("drives a hash-only product magic-link handoff and verifies the internally applied session", async () => {
    const email = "rendered-primary@example.test";
    const profileSha256 = sha256("primary-rendered-profile");
    const driverZeroConversationAttestationSha256 = sha256(
      "driver-zero-conversation-attestation",
    );
    const driverVisibleOnboardingAttestationSha256 = sha256(
      "driver-visible-onboarding-attestation",
    );
    const client = new FakeProductMagicLinkClient();
    const productOnboardingReceipt =
      await verifyRenderedProductOnboardingPersistence(client, {
        productOrigin: "http://127.0.0.1:57314",
        profileSha256,
        driverVisibleOnboardingAttestationSha256,
        timeoutMs: 1_000,
      });
    expect(productOnboardingReceipt).toMatchObject({
      surface: "browser-cdp",
      targetIdSha256: client.targetIdSha256,
      profileSha256,
      productOriginSha256: sha256("http://127.0.0.1:57314"),
      driverVisibleOnboardingAttestationSha256,
      onboardingPersisted: true,
      appShellRendered: true,
      onboardingSurfaceAbsent: true,
      crashSurfaceAbsent: true,
      credentialMaterialReturned: false,
    });
    const requestReceipt = await beginRenderedProductMagicLinkLogin(client, {
      email,
      productOnboardingReceipt,
      driverZeroConversationAttestationSha256,
    });
    expect(requestReceipt).toMatchObject({
      surface: "browser-cdp",
      profileSha256,
      productOriginSha256: sha256("http://127.0.0.1:57314"),
      driverZeroConversationAttestationSha256,
      driverVisibleOnboardingAttestationSha256,
      onboardingReceiptSha256: productOnboardingReceipt.onboardingReceiptSha256,
      emailSha256: sha256(email),
      productDomDriven: true,
      externalCompletionRequired: true,
      onboardingPersistenceVerified: true,
      settingsAuthRouteVerified: true,
      authDialogReady: true,
      preChatSurfaceAbsent: true,
      crashSurfaceAbsent: true,
      credentialMaterialReturned: false,
    });
    expect(JSON.stringify(requestReceipt)).not.toContain(email);
    expect(client.authSetupUseCount).toBe(0);

    client.externallyCompleted = true;
    const completed = await completeRenderedProductMagicLinkLogin(client, {
      requestReceipt,
      convexUrl: REQUIRED_CONVEX.cloudUrl,
      convexSiteUrl: REQUIRED_CONVEX.siteUrl,
      timeoutMs: 1_000,
    });
    expect(completed).toMatchObject({
      outcome: "product-magic-link-completed",
      productPollAppliedSession: true,
      credentialMaterialReturned: false,
      identitySha256: client.authority.identitySha256,
      profileSha256,
      driverZeroConversationAttestationSha256,
      driverVisibleOnboardingAttestationSha256,
      onboardingReceiptSha256: productOnboardingReceipt.onboardingReceiptSha256,
    });
    expect(client.authSetupUseCount).toBe(0);
    const chat = await verifyRenderedProductLoginSameProfileChat(client, {
      completedLoginReceipt: completed,
      profileSha256,
      conversationId: client.conversationId,
      timeoutMs: 1_000,
    });
    expect(chat).toMatchObject({
      outcome: "product-login-same-profile-chat-rendered",
      targetIdSha256: client.targetIdSha256,
      profileSha256,
      identitySha256: client.authority.identitySha256,
      conversationIdSha256: sha256(client.conversationId),
      driverZeroConversationAttestationSha256,
      driverVisibleOnboardingAttestationSha256,
      onboardingReceiptSha256: productOnboardingReceipt.onboardingReceiptSha256,
      chatSurfaceRendered: true,
      composerRendered: true,
      crashSurfaceAbsent: true,
      sameTarget: true,
      sameProfile: true,
      credentialMaterialReturned: false,
    });
    expect(chat.chatReceiptSha256).toMatch(/^[a-f0-9]{64}$/u);
    await expect(
      beginRenderedProductMagicLinkLogin(client, {
        email,
        productOnboardingReceipt: {
          ...productOnboardingReceipt,
          profileSha256: sha256("tampered-onboarding-profile"),
        },
        driverZeroConversationAttestationSha256,
      }),
    ).rejects.toThrow(CloudProofError);
    await expect(
      verifyRenderedProductLoginSameProfileChat(client, {
        completedLoginReceipt: completed,
        profileSha256: sha256("wrong-profile"),
        conversationId: client.conversationId,
        timeoutMs: 25,
      }),
    ).rejects.toThrow(CloudProofError);
    await expect(
      completeRenderedProductMagicLinkLogin(client, {
        requestReceipt: {
          ...requestReceipt,
          emailSha256: sha256("tampered@example.test"),
        },
        convexUrl: REQUIRED_CONVEX.cloudUrl,
        convexSiteUrl: REQUIRED_CONVEX.siteUrl,
        timeoutMs: 25,
      }),
    ).rejects.toThrow(CloudProofError);
  });

  test("pauses browser storage recovery signed out and resumes only after product login", async () => {
    const client = new FakeBrowserStorageRecoveryClient();
    const options = {
      origin: client.origin,
      conversationId: client.conversationId,
      expectedProjectionSha256: client.expectedProjectionSha256,
      convexUrl: REQUIRED_CONVEX.cloudUrl,
      convexSiteUrl: REQUIRED_CONVEX.siteUrl,
      timeoutMs: 1_000,
    };
    const checkpoint = await beginRenderedBrowserStorageRecovery(
      client,
      options,
    );
    expect(checkpoint).toMatchObject({
      localRowsAbsentBeforeReauth: true,
      outboxEmptyBeforeReauth: true,
      priorAuthoritySignedOutOrAnonymous: true,
      credentialMaterialReturned: false,
      authSetupUseCount: 0,
    });
    expect(client.state).toBe("cleared");
    await expect(
      completeRenderedBrowserStorageRecovery(client, {
        checkpoint,
        conversationId: client.conversationId,
        convexUrl: REQUIRED_CONVEX.cloudUrl,
        convexSiteUrl: REQUIRED_CONVEX.siteUrl,
        timeoutMs: 25,
      }),
    ).rejects.toThrow();

    client.completeProductLogin();
    const recovered = await completeRenderedBrowserStorageRecovery(client, {
      checkpoint,
      conversationId: client.conversationId,
      convexUrl: REQUIRED_CONVEX.cloudUrl,
      convexSiteUrl: REQUIRED_CONVEX.siteUrl,
      timeoutMs: 1_000,
    });
    expect(recovered).toMatchObject({
      outcome: "browser-storage-recovered-after-product-login",
      canonicalRowsSha256: client.expectedProjectionSha256,
      accountAuthorityPreserved: true,
      productLoginRequired: true,
      credentialMaterialReturned: false,
      noDuplicateRows: true,
    });
    expect(recovered.priorSessionIdSha256).not.toBe(
      recovered.reauthenticatedSessionIdSha256,
    );
    expect(client.authSetupUseCount).toBe(0);

    const callbackClient = new FakeBrowserStorageRecoveryClient();
    const callbackRecovered = await exerciseRenderedBrowserStorageRecovery(
      callbackClient,
      {
        ...options,
        origin: callbackClient.origin,
        conversationId: callbackClient.conversationId,
        expectedProjectionSha256: callbackClient.expectedProjectionSha256,
        resumeProductLogin: async ({ checkpoint: paused }) => {
          expect(paused.credentialMaterialReturned).toBe(false);
          callbackClient.completeProductLogin();
          return { completed: true, method: "product-ui" };
        },
      },
    );
    expect(callbackRecovered.accountAuthorityPreserved).toBe(true);

    const forbiddenClient = new FakeBrowserStorageRecoveryClient();
    await expect(
      exerciseRenderedBrowserStorageRecovery(forbiddenClient, {
        ...options,
        origin: forbiddenClient.origin,
        conversationId: forbiddenClient.conversationId,
        expectedProjectionSha256: forbiddenClient.expectedProjectionSha256,
        resumeProductLogin: async () => {
          forbiddenClient.completeProductLogin();
          forbiddenClient.authSetupUseCount += 1;
          return { completed: true, method: "product-ui" };
        },
      }),
    ).rejects.toThrow(CloudProofError);
  });

  test("captures pinned ready/replay/backfill and request-response hashes without headers, tokens, ids, or payload text", async () => {
    const socket = new FakeCdpSocket();
    const session = new RenderedClientCdpSession({
      socket,
      surface: "browser-cdp",
      targetUrlSha256: sha256("http://127.0.0.1:4173/"),
    });
    const requestId = "request-secret-id";
    const conversationId = "conversation-secret-id";
    const socketUrl = `${REQUIRED_CLOUD_BUILDER_ORIGIN.replace("https:", "wss:")}/conversations/${conversationId}/socket?protocol=1&since=10&epoch=7`;

    socket.emit("Network.requestWillBeSent", {
      requestId,
      type: "Fetch",
      request: {
        url: "https://impartial-crab-34.convex.site/api/auth/get-session",
        method: "GET",
        headers: {
          Authorization: "Bearer raw-jwt-must-not-land",
          Cookie: "session=raw-cookie-must-not-land",
        },
      },
    });
    socket.emit("Network.responseReceived", {
      requestId,
      type: "Fetch",
      response: {
        url: "https://impartial-crab-34.convex.site/api/auth/get-session",
        status: 200,
        mimeType: "application/json",
        headers: { "Set-Cookie": "raw-cookie-must-not-land" },
      },
    });
    socket.emit("Network.webSocketCreated", { requestId, url: socketUrl });
    socket.emit("Network.webSocketFrameReceived", {
      requestId,
      response: {
        payloadData: JSON.stringify({
          type: "ready",
          protocol: 1,
          conversationId,
          epoch: 7,
          headSeq: 13,
          windowStartSeq: 11,
          floorSeq: 0,
        }),
      },
    });
    socket.emit("Network.webSocketFrameReceived", {
      requestId,
      response: {
        payloadData: JSON.stringify({
          type: "record",
          seq: 11,
          kind: "message",
          role: "user",
          payload: { text: "raw prompt must not land" },
        }),
      },
    });
    socket.emit("Network.webSocketFrameReceived", {
      requestId,
      response: {
        payloadData: JSON.stringify({
          type: "backfill",
          requestId: "backfill-secret-id",
          fromSeq: 12,
          toSeq: 13,
          complete: true,
          records: [
            { seq: 12, kind: "message", payload: { text: "secret-a" } },
            { seq: 13, kind: "turn", payload: { text: "secret-b" } },
          ],
        }),
      },
    });
    socket.emit("Network.webSocketFrameSent", {
      requestId,
      response: {
        payloadData: JSON.stringify({
          type: "backfill",
          requestId: "backfill-secret-id",
          fromSeq: 12,
          toSeq: 13,
        }),
      },
    });
    socket.emit("Network.webSocketFrameSent", {
      requestId,
      response: {
        payloadData: JSON.stringify({
          type: "auth.refresh",
          token: "raw-refresh-jwt-must-not-land",
        }),
      },
    });
    const unknownType = "raw-type-secret-must-not-land";
    socket.emit("Network.webSocketFrameReceived", {
      requestId,
      response: {
        payloadData: JSON.stringify({
          type: unknownType,
          payload: "unknown-frame-secret-must-not-land",
        }),
      },
    });

    await session.drainMessages();
    const telemetry = session.telemetry();
    expect(telemetry.requestCount).toBe(1);
    expect(telemetry.responseCount).toBe(1);
    expect(telemetry.sockets).toHaveLength(1);
    expect(telemetry.sockets[0].recordSeqs).toEqual([11, 12, 13]);
    expect(telemetry.sockets[0].readyFrames).toEqual([
      expect.objectContaining({
        protocol: 1,
        conversationIdSha256: sha256(conversationId),
        epoch: 7,
        headSeq: 13,
      }),
    ]);
    expect(telemetry.sockets[0].backfillRequests).toEqual([
      expect.objectContaining({ fromSeq: 12, toSeq: 13 }),
    ]);

    const serialized = JSON.stringify(telemetry);
    for (const forbidden of [
      requestId,
      conversationId,
      "raw-jwt-must-not-land",
      "raw-cookie-must-not-land",
      "raw prompt must not land",
      "secret-a",
      "secret-b",
      "raw-refresh-jwt-must-not-land",
      "backfill-secret-id",
      unknownType,
      "unknown-frame-secret-must-not-land",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(session.webSockets[0].frames.at(-1)).toEqual({
      payloadSha256: sha256(
        JSON.stringify({
          type: unknownType,
          payload: "unknown-frame-secret-must-not-land",
        }),
      ),
      type: "opaque",
      frameTypeSha256: sha256(unknownType),
    });
    expect(JSON.stringify(session.webSockets[0].frames)).not.toContain(
      unknownType,
    );
    session.close();
  });

  test("rejects wrong-origin, wrong-protocol conversation sockets", () => {
    const socket = new FakeCdpSocket();
    const session = new RenderedClientCdpSession({
      socket,
      surface: "electron-cdp",
      targetUrlSha256: sha256("http://127.0.0.1:4173/"),
    });
    socket.emit("Network.webSocketCreated", {
      requestId: "wrong-origin",
      url: "wss://attacker.example/conversations/c/socket?protocol=1",
    });
    socket.emit("Network.webSocketCreated", {
      requestId: "wrong-protocol",
      url: `${REQUIRED_CLOUD_BUILDER_ORIGIN.replace("https:", "wss:")}/conversations/c/socket?protocol=99`,
    });
    expect(session.telemetry().sockets).toEqual([]);
    session.close();
  });

  test("decodes real WebSocket Blob and ArrayBuffer CDP response frames", async () => {
    const socket = new FakeCdpSocket();
    const session = new RenderedClientCdpSession({
      socket,
      surface: "browser-cdp",
      targetUrlSha256: sha256("about:blank"),
    });

    const blobCommand = session.command("Runtime.enable");
    const blobId = JSON.parse(socket.sent.at(-1)).id;
    await session.handleMessage({
      data: new Blob([JSON.stringify({ id: blobId, result: { blob: true } })]),
    });
    expect(await blobCommand).toEqual({ blob: true });

    const bufferCommand = session.command("Page.enable");
    const bufferId = JSON.parse(socket.sent.at(-1)).id;
    const encoded = new TextEncoder().encode(
      JSON.stringify({ id: bufferId, result: { buffer: true } }),
    );
    await session.handleMessage({ data: encoded.buffer });
    expect(await bufferCommand).toEqual({ buffer: true });
    session.close();
  });

  test("emits deterministic hash-only receipts", () => {
    const identity = renderedProcessIdentity({
      pid: 123,
      processFingerprintSha256: sha256("process-fingerprint"),
      profileSha256: sha256("profile"),
      binarySha256: sha256("binary"),
      versionSha256: sha256("version"),
      cdpBrowserSha256: sha256("cdp-build"),
      applicationIdentitySha256: sha256("test-application"),
    });
    const input = {
      surface: "browser-cdp",
      operation: "rendered.send-terminal",
      processIdentity: identity,
      observation: {
        prompt: "this raw observation is hashed, not returned",
        terminal: true,
      },
    };
    const receipt = renderedClientReceipt(input);
    expect(receipt.contract).toBe(RENDERED_CLIENT_CDP_CONTRACT);
    expect(receipt.outcome).toBe("passed");
    expect(receipt.receiptSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(receipt)).not.toContain("raw observation");
    expect(renderedClientReceipt(input)).toEqual(receipt);
    expect(() =>
      renderedClientReceipt({
        ...input,
        processIdentity: { ...input.processIdentity, processIdSha256: "raw" },
      }),
    ).toThrow(CloudProofError);
  });
});

describe("full rendered projection and cold ownership proof", () => {
  test("composes a hash-only cross-process A-B-A proof across secondary restart", () => {
    const accountACanarySha256 = sha256("account-a-canary");
    const accountBCanarySha256 = sha256("account-b-canary");
    const processIdentity = ({ pid, fingerprint, profile, application }) =>
      renderedProcessIdentity({
        pid,
        processFingerprintSha256: sha256(fingerprint),
        profileSha256: sha256(profile),
        binarySha256: sha256("electron-binary"),
        versionSha256: sha256("electron-version"),
        cdpBrowserSha256: sha256("electron-cdp-build"),
        applicationIdentitySha256: sha256(application),
      });
    const projection = ({ conversation, row, canary }) => ({
      conversationIdSha256: sha256(conversation),
      rowsSha256: sha256(`${conversation}:rows`),
      completeHistory: true,
      atNewestTail: true,
      rowCount: 1,
      rowIdHashes: [sha256(row)],
      userTextHashes: [canary],
      assistantTextHashes: [],
    });
    const primaryIdentity = {
      ...existingPrimaryAuthorityResult(),
      identityRevision: 8,
      existingProfileContinuityVerified: false,
      credentialMaterialReturned: false,
    };
    const secondaryAuthority = {
      authenticated: true,
      anonymous: true,
      identityClass: "anonymous-secondary",
      identitySha256: sha256("anonymous-secondary"),
      sessionIdSha256: sha256("secondary-session"),
      jwtSha256: sha256("secondary-jwt-before"),
      ownerAccountSha256: sha256("secondary-owner"),
      sessionJwtBindingSha256: sha256("secondary-binding"),
      credentialMaterialReturned: false,
      existingProfileContinuityVerified: false,
    };
    const primaryProcess = processIdentity({
      pid: 101,
      fingerprint: "primary-process",
      profile: "primary-profile",
      application: "primary-application",
    });
    const secondaryProcessBefore = processIdentity({
      pid: 202,
      fingerprint: "secondary-process-before",
      profile: "secondary-profile",
      application: "secondary-application",
    });
    const secondaryProcessAfter = processIdentity({
      pid: 303,
      fingerprint: "secondary-process-after",
      profile: "secondary-profile",
      application: "secondary-application",
    });
    const primaryView = projection({
      conversation: "conversation-a",
      row: "row-a",
      canary: accountACanarySha256,
    });
    const secondaryView = projection({
      conversation: "conversation-b",
      row: "row-b",
      canary: accountBCanarySha256,
    });
    const input = {
      primaryBefore: {
        identity: primaryIdentity,
        processIdentity: primaryProcess,
        targetIdSha256: sha256("primary-target"),
        view: primaryView,
      },
      secondaryBefore: {
        authority: secondaryAuthority,
        processIdentity: secondaryProcessBefore,
        targetIdSha256: sha256("secondary-target-before"),
        view: secondaryView,
      },
      secondaryStopReceipt: {
        stopped: true,
        processInstanceSha256: secondaryProcessBefore.processInstanceSha256,
        profileSha256: secondaryProcessBefore.profileSha256,
        applicationIdentitySha256:
          secondaryProcessBefore.applicationIdentitySha256,
      },
      secondaryAfter: {
        authority: {
          ...secondaryAuthority,
          jwtSha256: sha256("secondary-jwt-after"),
          existingProfileContinuityVerified: true,
        },
        processIdentity: secondaryProcessAfter,
        targetIdSha256: sha256("secondary-target-after"),
        view: secondaryView,
      },
      primaryAfter: {
        identity: {
          ...primaryIdentity,
          identityRevision: 9,
          jwtSha256: sha256("primary-jwt-after"),
          existingProfileContinuityVerified: true,
        },
        processIdentity: primaryProcess,
        targetIdSha256: sha256("primary-target"),
        view: primaryView,
      },
      accountACanarySha256,
      accountBCanarySha256,
    };
    const receipt = composeRenderedCrossProcessIdentityRoundTrip(input);
    expect(receipt).toMatchObject({
      outcome: "cross-process-identity-round-trip",
      identityASha256: primaryIdentity.identitySha256,
      identityBSha256: secondaryAuthority.identitySha256,
      primarySessionIdSha256: primaryIdentity.sessionIdSha256,
      primaryOwnerAccountSha256: primaryIdentity.ownerAccountSha256,
      secondaryExistingProfilePreserved: true,
      secondaryRelaunched: true,
      primaryRemainedMounted: true,
      staleContentRejected: true,
      credentialMaterialReturned: false,
    });
    expect(JSON.stringify(receipt)).not.toContain("secondary-session");
    expect(() =>
      composeRenderedCrossProcessIdentityRoundTrip({
        ...input,
        secondaryAfter: {
          ...input.secondaryAfter,
          authority: {
            ...input.secondaryAfter.authority,
            sessionIdSha256: sha256("different-session"),
          },
        },
      }),
    ).toThrow(CloudProofError);
  });

  test("sweeps a virtualized timeline in rendered oldest-to-newest order", async () => {
    const client = new FakeVirtualizedRenderedClient();
    const projection = await snapshotFullRenderedConversation(client);
    expect(projection.rowIdHashes).toEqual([
      sha256("row-a"),
      sha256("row-b"),
      sha256("row-c"),
    ]);
    expect(projection.rowCount).toBe(3);
    expect(projection.completeHistory).toBe(true);
    expect(projection.atNewestTail).toBe(true);
  });

  test("rejects recycled containers that map different rows to one list index", async () => {
    const client = new FakeVirtualizedRenderedClient();
    client.rows[2] = { ...client.rows[2], listIndex: 1 };
    await expect(snapshotFullRenderedConversation(client)).rejects.toThrow(
      CloudProofError,
    );
  });

  test("binds cold hydration to a different process and renderer target", async () => {
    const client = new FakeVirtualizedRenderedClient();
    const previousProcessIdentity = renderedProcessIdentity({
      pid: 101,
      processFingerprintSha256: sha256("old-process"),
      profileSha256: sha256("profile"),
      binarySha256: sha256("binary"),
      versionSha256: sha256("version"),
      cdpBrowserSha256: sha256("cdp-build"),
      applicationIdentitySha256: sha256("test-application"),
    });
    const currentFingerprint = sha256("new-process");
    const profileContinuitySha256 = sha256("stopped-profile-metadata");
    const currentProcessIdentity = renderedProcessIdentity({
      pid: 202,
      processFingerprintSha256: currentFingerprint,
      profileSha256: sha256("profile"),
      binarySha256: sha256("binary"),
      versionSha256: sha256("version"),
      cdpBrowserSha256: sha256("cdp-build"),
      applicationIdentitySha256: sha256("test-application"),
      profileContinuityBeforeLaunchSha256: profileContinuitySha256,
    });
    client.endpointOwnership = {
      processIdSha256: sha256("202"),
      processFingerprintSha256: currentFingerprint,
      listenerPortSha256: sha256("9222"),
    };
    const expected = await snapshotFullRenderedConversation(client);
    const receipt = await verifyRenderedColdProcessHydration(client, {
      conversationId: "conversation",
      expectedProjectionSha256: expected.rowsSha256,
      previousProcessIdentity,
      currentProcessIdentity,
      previousStopReceipt: {
        stopped: true,
        processInstanceSha256: previousProcessIdentity.processInstanceSha256,
        profileSha256: previousProcessIdentity.profileSha256,
        profileContinuityAfterStopSha256: profileContinuitySha256,
      },
      previousTargetIdSha256: sha256("old-renderer-target"),
      expectedIdentitySha256: sha256("preserved-identity"),
    });
    expect(receipt.newProcess).toBe(true);
    expect(receipt.newTarget).toBe(true);
    expect(receipt.profileReused).toBe(true);
    expect(receipt.identityObservedBeforeAuth).toBe(true);
    expect(receipt.profileContinuitySha256).toBe(profileContinuitySha256);
  });

  test("rejects cold hydration after auth setup or with the wrong persisted identity", async () => {
    const processIdentity = renderedProcessIdentity({
      pid: 202,
      processFingerprintSha256: sha256("new-process"),
      profileSha256: sha256("profile"),
      binarySha256: sha256("binary"),
      versionSha256: sha256("version"),
      cdpBrowserSha256: sha256("cdp-build"),
      applicationIdentitySha256: sha256("test-application"),
      profileContinuityBeforeLaunchSha256: sha256("profile-continuity"),
    });
    const previousProcessIdentity = renderedProcessIdentity({
      pid: 101,
      processFingerprintSha256: sha256("old-process"),
      profileSha256: sha256("profile"),
      binarySha256: sha256("binary"),
      versionSha256: sha256("version"),
      cdpBrowserSha256: sha256("cdp-build"),
      applicationIdentitySha256: sha256("test-application"),
    });
    const args = {
      conversationId: "conversation",
      expectedProjectionSha256: sha256("projection"),
      previousProcessIdentity,
      currentProcessIdentity: processIdentity,
      previousStopReceipt: {
        stopped: true,
        processInstanceSha256: previousProcessIdentity.processInstanceSha256,
        profileSha256: previousProcessIdentity.profileSha256,
        profileContinuityAfterStopSha256: sha256("profile-continuity"),
      },
      previousTargetIdSha256: sha256("old-renderer-target"),
      expectedIdentitySha256: sha256("preserved-identity"),
    };

    const alreadyAuthenticated = new FakeVirtualizedRenderedClient();
    alreadyAuthenticated.endpointOwnership = {
      processIdSha256: sha256("202"),
      processFingerprintSha256: sha256("new-process"),
    };
    alreadyAuthenticated.authSetupUseCount = 1;
    await expect(
      verifyRenderedColdProcessHydration(alreadyAuthenticated, args),
    ).rejects.toThrow(CloudProofError);

    const wrongIdentity = new FakeVirtualizedRenderedClient();
    wrongIdentity.endpointOwnership = {
      processIdSha256: sha256("202"),
      processFingerprintSha256: sha256("new-process"),
    };
    await expect(
      verifyRenderedColdProcessHydration(wrongIdentity, {
        ...args,
        expectedIdentitySha256: sha256("wrong-identity"),
      }),
    ).rejects.toThrow(CloudProofError);

    const wipedProfile = new FakeVirtualizedRenderedClient();
    wipedProfile.endpointOwnership = {
      processIdSha256: sha256("202"),
      processFingerprintSha256: sha256("new-process"),
    };
    await expect(
      verifyRenderedColdProcessHydration(wipedProfile, {
        ...args,
        previousStopReceipt: {
          ...args.previousStopReceipt,
          profileContinuityAfterStopSha256: sha256("pre-wipe-profile"),
        },
      }),
    ).rejects.toThrow(CloudProofError);
  });
});
