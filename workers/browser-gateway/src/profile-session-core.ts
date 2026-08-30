import {
  DEVICE_CODE_TTL_MS,
  type DeviceCodeFixtureBinding,
} from "@stella/device-code-fixture/protocol";
import type {
  BrowserBackend,
  SafeObservation,
  TrustedVerification,
} from "./browser-provider.js";
import type {
  DeviceCodeFixtureClient,
  DeviceCodeGrant,
} from "./device-code-fixture-client.js";
import { GatewayError } from "./errors.js";
import {
  PROFILE_KEY_VERSION,
  decryptStorageState,
  encryptStorageState,
  type ProfileAad,
} from "./profile-crypto.js";
import {
  PROFILE_ID,
  generationDigest,
  ownerDigest,
  profileDigest,
  sha256Hex,
  stableJson,
  type InteractionEnvelope,
  type OwnerPurgeEnvelope,
  type ProfileResetEnvelope,
  type TurnAuthority,
  type TurnCommandEnvelope,
} from "./protocol.js";
import type {
  InteractionRecord,
  ProfileState,
  ProfileStore,
  SnapshotPointer,
} from "./profile-store.js";

type GeneratedBrowserGatewayEnv = Readonly<Env>;

export type BrowserGatewayEnv = Omit<
  GeneratedBrowserGatewayEnv,
  "DEVICE_CODE_FIXTURE"
> & {
  readonly DEVICE_CODE_FIXTURE?: NonNullable<
    GeneratedBrowserGatewayEnv["DEVICE_CODE_FIXTURE"]
  > &
    DeviceCodeFixtureBinding;
};

type Clock = () => number;

export type ProfileCoreDependencies = Readonly<{
  store: ProfileStore;
  browser: BrowserBackend;
  bucket: R2Bucket;
  kekV1: string;
  now?: Clock;
  randomUuid?: () => string;
  liveViewTtlMs?: number;
  handoffTimeoutMs?: number;
  deviceCodeFixture?: DeviceCodeFixtureClient;
}>;

type InteractionDetail = Readonly<{
  schemaVersion: 1;
  interactionId: string;
  conversationId: string;
  threadId: string;
  turnId: string;
  kind: "login_takeover" | "device_code";
  state:
    | "pending"
    | "human_control"
    | "resuming"
    | "completed"
    | "canceled"
    | "expired"
    | "failed";
  displayOrigin: string;
  displayTitle?: string;
  revision: number;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  verificationUri?: string;
  verificationUriComplete?: string;
  userCode?: string;
}>;

const boundedString = (
  value: unknown,
  maximum: number,
  minimum = 1,
): string => {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new GatewayError("bad_request", 400);
  }
  return value;
};

const exactObject = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GatewayError("bad_request", 400);
  }
  const result = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in result)) ||
    Object.keys(result).some((key) => !allowed.has(key))
  ) {
    throw new GatewayError("bad_request", 400);
  }
  return result;
};

const boundedInteger = (
  value: unknown,
  minimum: number,
  maximum: number,
): number => {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    throw new GatewayError("bad_request", 400);
  }
  return Number(value);
};

/**
 * Model-authored selectors are intentionally much narrower than Playwright's
 * locator language. This prevents hidden values and text from becoming a
 * success/failure oracle through attribute operators, text engines, pseudos,
 * combinators, or raw form-control selectors.
 */
const safeLocatorSelector = (value: unknown): string => {
  const selector = boundedString(value, 128);
  if (
    !/^(?:#[A-Za-z][A-Za-z0-9_-]*|\.[A-Za-z][A-Za-z0-9_-]*|\[data-testid="[A-Za-z0-9_.:-]{1,96}"\])$/u.test(
      selector,
    )
  ) {
    throw new GatewayError("bad_request", 400);
  }
  return selector;
};

const forbiddenHostname = (hostname: string): boolean => {
  const lower = hostname.toLowerCase();
  if (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower === "metadata.google.internal" ||
    lower === "metadata.internal"
  ) {
    return true;
  }
  if (/^(?:127|0|10|169\.254|192\.168)\./u.test(lower)) return true;
  const match172 = /^172\.(\d{1,3})\./u.exec(lower);
  if (match172 && Number(match172[1]) >= 16 && Number(match172[1]) <= 31) {
    return true;
  }
  return (
    lower === "::1" ||
    lower.startsWith("fe80:") ||
    lower.startsWith("fc") ||
    lower.startsWith("fd")
  );
};

const parseOrigin = (value: unknown): string => {
  const raw = boundedString(value, 512);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GatewayError("navigation_denied", 403);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.origin !== raw ||
    forbiddenHostname(url.hostname)
  ) {
    throw new GatewayError("navigation_denied", 403);
  }
  return url.origin;
};

const parseAllowedOrigins = (value: unknown): readonly string[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 24) {
    throw new GatewayError("bad_request", 400);
  }
  const origins = value.map(parseOrigin);
  if (new Set(origins).size !== origins.length) {
    throw new GatewayError("bad_request", 400);
  }
  return origins.sort();
};

const allowedUrl = (
  value: unknown,
  allowedOrigins: readonly string[],
): string => {
  const raw = boundedString(value, 4_096);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GatewayError("navigation_denied", 403);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    forbiddenHostname(url.hostname) ||
    !allowedOrigins.includes(url.origin)
  ) {
    throw new GatewayError("navigation_denied", 403);
  }
  return url.toString();
};

const digestAuthority = async (authority: TurnAuthority) => ({
  conversationDigest: await sha256Hex(
    `conversation\u0000${authority.conversationId}`,
  ),
  threadDigest: await sha256Hex(`thread\u0000${authority.threadId}`),
  turnDigest: await sha256Hex(`turn\u0000${authority.turnId}`),
});

const parseVerification = (
  value: unknown,
  allowedOrigins: readonly string[],
): TrustedVerification => {
  const verification = exactObject(value, [
    "expectedOrigin",
    "authenticatedSelector",
    "loggedOutSelector",
    "resumeUrl",
  ]);
  const result: TrustedVerification = {
    expectedOrigin: parseOrigin(verification.expectedOrigin),
    authenticatedSelector: safeLocatorSelector(
      verification.authenticatedSelector,
    ),
    loggedOutSelector: safeLocatorSelector(verification.loggedOutSelector),
    resumeUrl: allowedUrl(verification.resumeUrl, allowedOrigins),
  };
  if (!allowedOrigins.includes(result.expectedOrigin)) {
    throw new GatewayError("navigation_denied", 403);
  }
  if (new URL(result.resumeUrl).origin !== result.expectedOrigin) {
    throw new GatewayError("navigation_denied", 403);
  }
  if (result.authenticatedSelector === result.loggedOutSelector) {
    throw new GatewayError("bad_request", 400);
  }
  return result;
};

const interactionTerminal = (state: InteractionRecord["state"]): boolean =>
  ["completed", "canceled", "expired", "failed"].includes(state);

export class BrowserProfileSessionCore {
  private readonly store: ProfileStore;
  private readonly browser: BrowserBackend;
  private readonly bucket: R2Bucket;
  private readonly kekV1: string;
  private readonly now: Clock;
  private readonly randomUuid: () => string;
  private readonly liveViewTtlMs: number;
  private readonly handoffTimeoutMs: number;
  private readonly deviceCodeFixture: DeviceCodeFixtureClient | undefined;
  private purgedOwnerDigest: string | undefined;

  constructor(dependencies: ProfileCoreDependencies) {
    this.store = dependencies.store;
    this.browser = dependencies.browser;
    this.bucket = dependencies.bucket;
    this.kekV1 = dependencies.kekV1;
    this.now = dependencies.now ?? Date.now;
    this.randomUuid = dependencies.randomUuid ?? (() => crypto.randomUUID());
    this.liveViewTtlMs = dependencies.liveViewTtlMs ?? 300_000;
    this.handoffTimeoutMs = dependencies.handoffTimeoutMs ?? 600_000;
    this.deviceCodeFixture = dependencies.deviceCodeFixture;
    this.store.bootstrap();
  }

  private async identity(authority: {
    ownerId: string;
    ownerGeneration: string;
  }): Promise<{
    ownerDigest: string;
    ownerGenerationDigest: string;
    profileDigest: string;
  }> {
    const [owner, generation, profile] = await Promise.all([
      ownerDigest(authority.ownerId),
      generationDigest(authority.ownerGeneration),
      profileDigest(PROFILE_ID),
    ]);
    return {
      ownerDigest: owner,
      ownerGenerationDigest: generation,
      profileDigest: profile,
    };
  }

  private deviceCodeAad(state: ProfileState): ProfileAad {
    return {
      schemaVersion: 1,
      keyVersion: PROFILE_KEY_VERSION,
      ownerDigest: state.ownerDigest,
      profileDigest: state.profileDigest,
      profileEpoch: state.profileEpoch,
      snapshotRevision: 1,
    };
  }

  private async encryptDeviceCode(
    state: ProfileState,
    interactionId: string,
    deviceCode: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    const encrypted = await encryptStorageState({
      storageState: { interactionId, deviceCode },
      aad: this.deviceCodeAad(state),
      kekV1: this.kekV1,
    });
    try {
      const envelope = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(encrypted.bytes),
      ) as unknown;
      if (
        typeof envelope !== "object" ||
        envelope === null ||
        Array.isArray(envelope)
      ) {
        throw new Error("invalid encrypted device code");
      }
      return envelope as Readonly<Record<string, unknown>>;
    } catch {
      throw new GatewayError("internal_error", 500);
    }
  }

  private async decryptDeviceGrant(
    state: ProfileState,
    interaction: InteractionRecord,
  ): Promise<DeviceCodeGrant> {
    const encrypted = interaction.verification?.deviceCodeCiphertext;
    const userCode = interaction.publicDetails?.userCode;
    if (
      typeof encrypted !== "object" ||
      encrypted === null ||
      Array.isArray(encrypted) ||
      typeof userCode !== "string" ||
      !/^[BCDFGHJKLMNPQRSTVWXYZ23456789]{4}-[BCDFGHJKLMNPQRSTVWXYZ23456789]{4}$/u.test(
        userCode,
      )
    ) {
      throw new GatewayError("verification_failed", 409);
    }
    let plaintext: unknown;
    try {
      plaintext = await decryptStorageState({
        bytes: new TextEncoder().encode(stableJson(encrypted)),
        aad: this.deviceCodeAad(state),
        kekV1: this.kekV1,
      });
    } catch {
      throw new GatewayError("verification_failed", 409);
    }
    if (
      typeof plaintext !== "object" ||
      plaintext === null ||
      Array.isArray(plaintext)
    ) {
      throw new GatewayError("verification_failed", 409);
    }
    const value = plaintext as Record<string, unknown>;
    if (
      Object.keys(value).length !== 2 ||
      value.interactionId !== interaction.interactionId ||
      typeof value.deviceCode !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(value.deviceCode)
    ) {
      throw new GatewayError("verification_failed", 409);
    }
    return { userCode, deviceCode: value.deviceCode };
  }

  private async stateFor(
    authority: { ownerId: string; ownerGeneration: string },
    options: Readonly<{ destructive?: boolean }> = {},
  ): Promise<ProfileState> {
    const identity = await this.identity(authority);
    if (this.purgedOwnerDigest === identity.ownerDigest) {
      throw new GatewayError("profile_conflict", 409);
    }
    const existing = this.store.getState();
    if (!existing) {
      const state: ProfileState = {
        ...identity,
        profileEpoch: 1,
        phase: "AGENT_CONTROL",
        allowedOrigins: [],
        updatedAt: this.now(),
      };
      this.store.putState(state);
      return state;
    }
    if (
      existing.ownerDigest !== identity.ownerDigest ||
      existing.profileDigest !== identity.profileDigest
    ) {
      throw new GatewayError("profile_conflict", 409);
    }
    if (
      existing.ownerGenerationDigest !== identity.ownerGenerationDigest &&
      !options.destructive
    ) {
      throw new GatewayError("profile_conflict", 409);
    }
    return existing;
  }

  private aad(state: ProfileState, revision: number): ProfileAad {
    return {
      schemaVersion: 1,
      keyVersion: PROFILE_KEY_VERSION,
      ownerDigest: state.ownerDigest,
      profileDigest: state.profileDigest,
      profileEpoch: state.profileEpoch,
      snapshotRevision: revision,
    };
  }

  private profilePrefix(state: ProfileState): string {
    return `browser-profiles/${state.ownerDigest}/${state.profileDigest}/`;
  }

  private async deletePrefix(prefix: string): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix, cursor, limit: 1_000 });
      if (page.objects.length > 0) {
        await this.bucket.delete(page.objects.map((object) => object.key));
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  private async loadSnapshot(
    state: ProfileState,
  ): Promise<unknown | undefined> {
    if (!state.snapshot) return undefined;
    const object = await this.bucket.get(state.snapshot.key);
    if (!object) throw new GatewayError("snapshot_unavailable", 409);
    const bytes = new Uint8Array(await object.arrayBuffer());
    return decryptStorageState({
      bytes,
      aad: this.aad(state, state.snapshot.revision),
      kekV1: this.kekV1,
      expectedObjectSha256: state.snapshot.objectSha256,
    });
  }

  private async ensureBrowser(state: ProfileState): Promise<ProfileState> {
    if (state.allowedOrigins.length < 1) {
      throw new GatewayError("bad_request", 400);
    }
    const storageState = await this.loadSnapshot(state);
    let current = state;
    await this.browser.ensure({
      sessionId: state.browserSessionId,
      storageState,
      allowedOrigins: state.allowedOrigins,
      onSessionAcquired: (sessionId, policyDigest) => {
        current = {
          ...current,
          browserSessionId: sessionId,
          browserPolicyDigest: policyDigest,
          updatedAt: this.now(),
        };
        this.store.putState(current);
      },
    });
    const sessionId = this.browser.sessionId();
    const policyDigest = this.browser.policyDigest();
    if (
      sessionId &&
      (current.browserSessionId !== sessionId ||
        current.browserPolicyDigest !== policyDigest)
    ) {
      current = {
        ...current,
        browserSessionId: sessionId,
        ...(policyDigest ? { browserPolicyDigest: policyDigest } : {}),
        updatedAt: this.now(),
      };
      this.store.putState(current);
    }
    return current;
  }

  private async checkpoint(state: ProfileState): Promise<ProfileState> {
    const storageState = await this.browser.storageState();
    const revision = (state.snapshot?.revision ?? 0) + 1;
    const encrypted = await encryptStorageState({
      storageState,
      aad: this.aad(state, revision),
      kekV1: this.kekV1,
    });
    const key = `${this.profilePrefix(state)}epochs/${state.profileEpoch}/snapshots/${revision}-${encrypted.objectSha256}.json.enc`;
    await this.bucket.put(key, encrypted.bytes, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: {
        schema: "1",
        keyVersion: PROFILE_KEY_VERSION,
        objectSha256: encrypted.objectSha256,
      },
    });
    const written = await this.bucket.get(key);
    if (!written) throw new GatewayError("snapshot_unavailable", 409);
    const writtenBytes = new Uint8Array(await written.arrayBuffer());
    if ((await sha256Hex(writtenBytes)) !== encrypted.objectSha256) {
      await this.bucket.delete(key).catch(() => undefined);
      throw new GatewayError("snapshot_unavailable", 409);
    }
    const pointer: SnapshotPointer = {
      key,
      revision,
      objectSha256: encrypted.objectSha256,
    };
    const previous = state.snapshot;
    const updated: ProfileState = {
      ...state,
      snapshot: pointer,
      updatedAt: this.now(),
    };
    this.store.putState(updated);
    if (previous && previous.key !== key) {
      await this.bucket.delete(previous.key).catch(() => undefined);
    }
    return updated;
  }

  private async closeBrowser(state: ProfileState): Promise<ProfileState> {
    await this.browser.closeRemote(state.browserSessionId);
    const updated: ProfileState = {
      ...state,
      browserSessionId: undefined,
      browserPolicyDigest: undefined,
      updatedAt: this.now(),
    };
    this.store.putState(updated);
    return updated;
  }

  private assertAgentControl(state: ProfileState): void {
    if (state.phase === "HUMAN_CONTROL") {
      throw new GatewayError("human_control_active", 409);
    }
  }

  private async configure(
    state: ProfileState,
    allowedOrigins: readonly string[],
  ): Promise<ProfileState> {
    if (stableJson(state.allowedOrigins) === stableJson(allowedOrigins)) {
      return state;
    }
    let updated = state;
    if (state.browserSessionId) updated = await this.closeBrowser(state);
    updated = {
      ...updated,
      allowedOrigins,
      browserPolicyDigest: undefined,
      updatedAt: this.now(),
    };
    this.store.putState(updated);
    return updated;
  }

  private validateObservation(
    observation: SafeObservation,
    allowedOrigins: readonly string[],
  ): SafeObservation {
    if (!observation.url) return observation;
    const origin = new URL(observation.url).origin;
    if (!allowedOrigins.includes(origin)) {
      throw new GatewayError("navigation_denied", 403);
    }
    return observation;
  }

  async turn(envelope: TurnCommandEnvelope): Promise<unknown> {
    const now = this.now();
    let state = await this.stateFor(envelope.authority);
    if (state.activeInteractionId) {
      const active = this.store.getInteraction(state.activeInteractionId);
      if (active) {
        ({ state } = await this.expireIfNeeded(state, active));
      }
    }
    const requestDigest = await sha256Hex(stableJson(envelope.command));
    const existing = this.store.getReceipt(envelope.command.requestId);
    if (existing) {
      if (existing.requestDigest !== requestDigest) {
        throw new GatewayError("profile_conflict", 409);
      }
      return existing.response;
    }
    this.assertAgentControl(state);
    const completed = (data?: unknown) => ({
      schemaVersion: 1 as const,
      outcome: "completed" as const,
      requestId: envelope.command.requestId,
      ...(data === undefined ? {} : { data }),
    });

    let response: unknown;
    const params = envelope.command.params;
    switch (envelope.command.action) {
      case "browser.open": {
        const value = exactObject(params, ["allowedOrigins"], ["startUrl"]);
        state = await this.configure(
          state,
          parseAllowedOrigins(value.allowedOrigins),
        );
        state = await this.ensureBrowser(state);
        let observation: SafeObservation | undefined;
        if (value.startUrl !== undefined) {
          const url = allowedUrl(value.startUrl, state.allowedOrigins);
          observation = this.validateObservation(
            await this.browser.navigate(url),
            state.allowedOrigins,
          );
        }
        response = completed({
          profileId: PROFILE_ID,
          profileEpoch: state.profileEpoch,
          restored: Boolean(state.snapshot),
          ...(observation ? { observation } : {}),
        });
        break;
      }
      case "browser.navigate": {
        const value = exactObject(params, ["url"]);
        state = await this.ensureBrowser(state);
        const url = allowedUrl(value.url, state.allowedOrigins);
        try {
          response = completed({
            observation: this.validateObservation(
              await this.browser.navigate(url),
              state.allowedOrigins,
            ),
          });
        } catch (error) {
          if (
            error instanceof GatewayError &&
            error.code === "navigation_denied"
          ) {
            await this.closeBrowser(state);
          }
          throw error;
        }
        break;
      }
      case "browser.observe": {
        exactObject(params, []);
        state = await this.ensureBrowser(state);
        response = completed({
          observation: this.validateObservation(
            await this.browser.observe(),
            state.allowedOrigins,
          ),
        });
        break;
      }
      case "browser.click": {
        const value = exactObject(params, ["selector"]);
        state = await this.ensureBrowser(state);
        await this.browser.click(safeLocatorSelector(value.selector));
        response = completed({ clicked: true });
        break;
      }
      case "browser.fill": {
        const value = exactObject(params, ["selector", "value", "sensitivity"]);
        if (value.sensitivity !== "non_secret") {
          throw new GatewayError("bad_request", 400);
        }
        state = await this.ensureBrowser(state);
        await this.browser.fillNonSecret(
          safeLocatorSelector(value.selector),
          boundedString(value.value, 4_096),
        );
        response = completed({ filled: true });
        break;
      }
      case "browser.press": {
        const value = exactObject(params, ["selector", "key"]);
        state = await this.ensureBrowser(state);
        await this.browser.press(
          safeLocatorSelector(value.selector),
          boundedString(value.key, 64),
        );
        response = completed({ pressed: true });
        break;
      }
      case "browser.select": {
        const value = exactObject(params, ["selector", "value"]);
        state = await this.ensureBrowser(state);
        await this.browser.select(
          safeLocatorSelector(value.selector),
          boundedString(value.value, 1_024),
        );
        response = completed({ selected: true });
        break;
      }
      case "browser.wait": {
        const value = exactObject(params, ["selector"], ["timeoutMs"]);
        state = await this.ensureBrowser(state);
        await this.browser.wait(
          safeLocatorSelector(value.selector),
          value.timeoutMs === undefined
            ? 10_000
            : boundedInteger(value.timeoutMs, 100, 30_000),
        );
        response = completed({ ready: true });
        break;
      }
      case "browser.tabs": {
        exactObject(params, []);
        state = await this.ensureBrowser(state);
        response = completed({ tabs: await this.browser.tabs() });
        break;
      }
      case "browser.focus_tab": {
        const value = exactObject(params, ["tabId"]);
        state = await this.ensureBrowser(state);
        await this.browser.focusTab(boundedString(value.tabId, 32));
        response = completed({ focused: true });
        break;
      }
      case "browser.checkpoint": {
        exactObject(params, []);
        state = await this.ensureBrowser(state);
        state = await this.checkpoint(state);
        response = completed({
          snapshotRevision: state.snapshot!.revision,
        });
        break;
      }
      case "browser.close": {
        exactObject(params, []);
        if (state.browserSessionId) state = await this.closeBrowser(state);
        response = completed({ closed: true });
        break;
      }
      case "browser.login_takeover": {
        const value = exactObject(
          params,
          ["allowedOrigins", "displayOrigin", "verification"],
          ["displayTitle", "startUrl", "expiresInMs"],
        );
        const allowedOrigins = parseAllowedOrigins(value.allowedOrigins);
        const displayOrigin = parseOrigin(value.displayOrigin);
        // Password entry is deliberately same-origin in v1. Cross-origin SSO
        // needs a separate handoff that displays the actual IdP origin.
        if (
          allowedOrigins.length !== 1 ||
          allowedOrigins[0] !== displayOrigin
        ) {
          throw new GatewayError("navigation_denied", 403);
        }
        const verification = parseVerification(
          value.verification,
          allowedOrigins,
        );
        if (verification.expectedOrigin !== displayOrigin) {
          throw new GatewayError("navigation_denied", 403);
        }
        state = await this.configure(state, allowedOrigins);
        state = await this.ensureBrowser(state);
        try {
          const observation = this.validateObservation(
            value.startUrl === undefined
              ? await this.browser.observe()
              : await this.browser.navigate(
                  allowedUrl(value.startUrl, allowedOrigins),
                ),
            allowedOrigins,
          );
          if (new URL(observation.url).origin !== displayOrigin) {
            throw new GatewayError("navigation_denied", 403);
          }
          if (!(await this.browser.trustedVerify(verification, "logged_out"))) {
            throw new GatewayError("verification_failed", 409);
          }
        } catch (error) {
          state = await this.closeBrowser(state);
          throw error;
        }
        const handoff = await this.browser.startHandoff({
          handoffTimeoutMs: this.handoffTimeoutMs,
          expectedOrigin: displayOrigin,
        });
        const expiresInMs =
          value.expiresInMs === undefined
            ? this.handoffTimeoutMs
            : boundedInteger(value.expiresInMs, 60_000, 30 * 60_000);
        const interactionId = this.randomUuid();
        const authorityDigests = await digestAuthority(envelope.authority);
        const interaction: InteractionRecord = {
          interactionId,
          revision: 1,
          kind: "login_takeover",
          state: "human_control",
          ...authorityDigests,
          attemptGeneration: envelope.authority.attemptGeneration,
          // Neutral broker request identity only. Convex binds the suspension
          // to the authoritative outer Code tool-call identity.
          toolCallId: envelope.command.requestId,
          requestDigest,
          displayOrigin,
          ...(value.displayTitle === undefined
            ? {}
            : { displayTitle: boundedString(value.displayTitle, 256) }),
          expiresAt: now + expiresInMs,
          createdAt: now,
          updatedAt: now,
          verification,
          handoffId: handoff.handoffId,
          targetId: handoff.targetId,
        };
        this.store.putInteraction(interaction);
        state = {
          ...state,
          phase: "HUMAN_CONTROL",
          activeInteractionId: interactionId,
          updatedAt: now,
        };
        this.store.putState(state);
        response = {
          schemaVersion: 1,
          outcome: "suspended",
          suspension: {
            schemaVersion: 1,
            outcome: "waiting_for_user",
            interactionId,
            interactionRevision: 1,
            interactionKind: "login_takeover",
            toolCallId: interaction.toolCallId,
            requestDigest,
            profileId: PROFILE_ID,
            profileEpoch: state.profileEpoch,
            displayOrigin,
            ...(interaction.displayTitle
              ? { displayTitle: interaction.displayTitle }
              : {}),
            expiresAt: interaction.expiresAt,
          },
        };
        break;
      }
      case "device_code.fixture_start": {
        const value = exactObject(params, [], ["expiresInMs"]);
        if (
          value.expiresInMs !== undefined &&
          value.expiresInMs !== DEVICE_CODE_TTL_MS
        ) {
          throw new GatewayError("bad_request", 400);
        }
        if (!this.deviceCodeFixture) {
          throw new GatewayError("browser_unavailable", 503);
        }
        const interactionId = this.randomUuid();
        const authorization = await this.deviceCodeFixture.authorize(
          envelope.command.requestId,
        );
        const deviceCodeCiphertext = await this.encryptDeviceCode(
          state,
          interactionId,
          authorization.deviceCode,
        );
        const displayOrigin = new URL(authorization.verificationUri).origin;
        const authorityDigests = await digestAuthority(envelope.authority);
        const interaction: InteractionRecord = {
          interactionId,
          revision: 1,
          kind: "device_code",
          state: "pending",
          ...authorityDigests,
          attemptGeneration: envelope.authority.attemptGeneration,
          toolCallId: envelope.command.requestId,
          requestDigest,
          displayOrigin,
          displayTitle: "Device authorization",
          expiresAt: authorization.expiresAt,
          createdAt: now,
          updatedAt: now,
          publicDetails: {
            verificationUri: authorization.verificationUri,
            verificationUriComplete: authorization.verificationUriComplete,
            userCode: authorization.userCode,
          },
          verification: { deviceCodeCiphertext },
        };
        this.store.putInteraction(interaction);
        state = {
          ...state,
          phase: "HUMAN_CONTROL",
          activeInteractionId: interactionId,
          updatedAt: now,
        };
        this.store.putState(state);
        response = {
          schemaVersion: 1,
          outcome: "suspended",
          suspension: {
            schemaVersion: 1,
            outcome: "waiting_for_user",
            interactionId,
            interactionRevision: 1,
            interactionKind: "device_code",
            toolCallId: interaction.toolCallId,
            requestDigest,
            profileId: PROFILE_ID,
            profileEpoch: state.profileEpoch,
            displayOrigin,
            displayTitle: interaction.displayTitle,
            expiresAt: interaction.expiresAt,
          },
        };
        break;
      }
    }

    this.store.putReceipt({
      requestId: envelope.command.requestId,
      requestDigest,
      response,
      createdAt: now,
    });
    return response;
  }

  private async exactInteraction(
    envelope: InteractionEnvelope,
  ): Promise<{ state: ProfileState; interaction: InteractionRecord }> {
    const exact = await this.ownedInteraction(envelope);
    if (exact.interaction.revision !== envelope.interactionRevision) {
      throw new GatewayError("stale_interaction", 409);
    }
    return exact;
  }

  private async ownedInteraction(
    envelope: InteractionEnvelope,
  ): Promise<{ state: ProfileState; interaction: InteractionRecord }> {
    const state = await this.stateFor(envelope.authority);
    if (
      envelope.profileId !== PROFILE_ID ||
      envelope.profileEpoch !== state.profileEpoch
    ) {
      throw new GatewayError("stale_interaction", 409);
    }
    const interaction = this.store.getInteraction(envelope.interactionId);
    if (!interaction) {
      throw new GatewayError("stale_interaction", 409);
    }
    const digests = await digestAuthority(envelope.authority);
    if (
      interaction.conversationDigest !== digests.conversationDigest ||
      interaction.threadDigest !== digests.threadDigest ||
      interaction.turnDigest !== digests.turnDigest ||
      interaction.attemptGeneration !== envelope.authority.attemptGeneration
    ) {
      throw new GatewayError("stale_interaction", 409);
    }
    return { state, interaction };
  }

  private detail(
    authority: TurnAuthority,
    interaction: InteractionRecord,
  ): InteractionDetail {
    return {
      schemaVersion: 1,
      interactionId: interaction.interactionId,
      conversationId: authority.conversationId,
      threadId: authority.threadId,
      turnId: authority.turnId,
      kind: interaction.kind,
      state: interaction.state,
      displayOrigin: interaction.displayOrigin,
      ...(interaction.displayTitle
        ? { displayTitle: interaction.displayTitle }
        : {}),
      revision: interaction.revision,
      expiresAt: interaction.expiresAt,
      createdAt: interaction.createdAt,
      updatedAt: interaction.updatedAt,
      ...(interaction.kind === "device_code"
        ? {
            verificationUri: String(
              interaction.publicDetails?.verificationUri ?? "",
            ),
            ...(typeof interaction.publicDetails?.verificationUriComplete ===
            "string"
              ? {
                  verificationUriComplete:
                    interaction.publicDetails.verificationUriComplete,
                }
              : {}),
            userCode: String(interaction.publicDetails?.userCode ?? ""),
          }
        : {}),
    };
  }

  private async expireIfNeeded(
    state: ProfileState,
    interaction: InteractionRecord,
  ): Promise<{ state: ProfileState; interaction: InteractionRecord }> {
    const ownsHumanControl =
      state.activeInteractionId === interaction.interactionId;
    if (
      !ownsHumanControl &&
      (interactionTerminal(interaction.state) ||
        interaction.expiresAt > this.now())
    ) {
      return { state, interaction };
    }
    if (
      !interactionTerminal(interaction.state) &&
      interaction.expiresAt > this.now()
    ) {
      return { state, interaction };
    }
    const expired: InteractionRecord = interactionTerminal(interaction.state)
      ? interaction
      : {
          ...interaction,
          revision: interaction.revision + 1,
          state: "expired",
          updatedAt: this.now(),
          ...(interaction.kind === "device_code"
            ? { verification: undefined }
            : {}),
        };
    if (expired !== interaction) this.store.putInteraction(expired);
    let updated = state;
    if (ownsHumanControl) {
      // Expiry is persisted before remote teardown. If teardown fails, the
      // interaction is terminal while activeInteractionId remains set; alarm
      // retries must keep attempting this branch rather than treating the
      // terminal record as fully cleaned up.
      if (state.browserSessionId) updated = await this.closeBrowser(state);
      updated = {
        ...updated,
        phase: "AGENT_CONTROL",
        activeInteractionId: undefined,
        updatedAt: this.now(),
      };
      this.store.putState(updated);
    }
    return { state: updated, interaction: expired };
  }

  async interactionStatus(envelope: InteractionEnvelope): Promise<unknown> {
    let exact = await this.exactInteraction(envelope);
    exact = await this.expireIfNeeded(exact.state, exact.interaction);
    return {
      schemaVersion: 1,
      interaction: this.detail(envelope.authority, exact.interaction),
    };
  }

  async expireActive(): Promise<void> {
    const state = this.store.getState();
    if (!state?.activeInteractionId) return;
    const interaction = this.store.getInteraction(state.activeInteractionId);
    if (!interaction) return;
    await this.expireIfNeeded(state, interaction);
  }

  hasActiveCleanupDebt(): boolean {
    return this.store.getState()?.activeInteractionId !== undefined;
  }

  async liveView(envelope: InteractionEnvelope): Promise<unknown> {
    let { state, interaction } = await this.exactInteraction(envelope);
    ({ state, interaction } = await this.expireIfNeeded(state, interaction));
    if (
      interaction.kind !== "login_takeover" ||
      interaction.state !== "human_control" ||
      state.phase !== "HUMAN_CONTROL" ||
      state.activeInteractionId !== interaction.interactionId
    ) {
      throw new GatewayError("stale_interaction", 409);
    }
    state = await this.ensureBrowser(state);
    const handoffState = await this.browser.handoffState();
    if (
      !handoffState.active ||
      handoffState.handoffId !== interaction.handoffId
    ) {
      throw new GatewayError("stale_interaction", 409);
    }
    const url = await this.browser.renewLiveView(
      this.liveViewTtlMs,
      interaction.targetId,
    );
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new GatewayError("browser_unavailable", 503);
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "live.browser.run" ||
      parsed.username ||
      parsed.password
    ) {
      throw new GatewayError("browser_unavailable", 503);
    }
    return {
      schemaVersion: 1,
      interactionId: interaction.interactionId,
      revision: interaction.revision,
      url,
      expiresAt: Math.min(
        this.now() + this.liveViewTtlMs,
        interaction.expiresAt,
      ),
    };
  }

  private resumeReceipt(
    interaction: InteractionRecord,
    result: "approved" | "canceled" | "expired" | "failed",
    interactionRevision = interaction.revision,
  ) {
    const safeMessage =
      result === "approved"
        ? "Browser access is ready."
        : result === "canceled"
          ? "Browser access was canceled."
          : result === "expired"
            ? "Browser access expired."
            : "Browser access could not be verified.";
    const state = this.store.getState();
    if (!state) throw new GatewayError("profile_conflict", 409);
    return {
      schemaVersion: 1 as const,
      interactionId: interaction.interactionId,
      // This is the revision atomically claimed by the control plane, not an
      // internal transition counter advanced while completing the decision.
      interactionRevision,
      profileId: PROFILE_ID,
      profileEpoch: state.profileEpoch,
      toolCallId: interaction.toolCallId,
      requestDigest: interaction.requestDigest,
      result,
      safeMessage,
    };
  }

  async decide(envelope: InteractionEnvelope): Promise<unknown> {
    if (!envelope.decision) throw new GatewayError("bad_request", 400);
    let { state, interaction } = await this.ownedInteraction(envelope);
    if (interaction.revision < envelope.interactionRevision) {
      throw new GatewayError("stale_interaction", 409);
    }
    if (interaction.revision > envelope.interactionRevision) {
      const compatibleReplay =
        (interaction.state === "completed" && envelope.decision === "done") ||
        (interaction.state === "canceled" && envelope.decision === "cancel") ||
        (interaction.state === "failed" && envelope.decision === "done") ||
        interaction.state === "expired";
      if (compatibleReplay) {
        const result =
          interaction.state === "completed"
            ? "approved"
            : interaction.state === "canceled"
              ? "canceled"
              : interaction.state === "expired"
                ? envelope.decision === "cancel"
                  ? "canceled"
                  : "expired"
                : "failed";
        return {
          schemaVersion: 1,
          receipt: this.resumeReceipt(
            interaction,
            result,
            envelope.interactionRevision,
          ),
        };
      }
      if (interaction.state !== "resuming" || envelope.decision !== "done") {
        throw new GatewayError("stale_interaction", 409);
      }
    } else {
      ({ state, interaction } = await this.expireIfNeeded(state, interaction));
    }
    if (interaction.state === "expired") {
      return {
        schemaVersion: 1,
        receipt: this.resumeReceipt(
          interaction,
          envelope.decision === "cancel" ? "canceled" : "expired",
          envelope.interactionRevision,
        ),
      };
    }
    if (interactionTerminal(interaction.state)) {
      const result =
        interaction.state === "completed"
          ? "approved"
          : interaction.state === "canceled"
            ? "canceled"
            : "failed";
      return {
        schemaVersion: 1,
        receipt: this.resumeReceipt(
          interaction,
          result,
          envelope.interactionRevision,
        ),
      };
    }

    if (envelope.decision === "cancel") {
      if (interaction.kind === "login_takeover") {
        state = await this.ensureBrowser(state);
        await this.browser.completeHandoff(false).catch(() => undefined);
        state = await this.closeBrowser(state);
      }
      interaction = {
        ...interaction,
        revision: interaction.revision + 1,
        state: "canceled",
        updatedAt: this.now(),
        ...(interaction.kind === "device_code"
          ? { verification: undefined }
          : {}),
      };
      this.store.putInteraction(interaction);
      state = {
        ...state,
        phase: "AGENT_CONTROL",
        activeInteractionId: undefined,
        updatedAt: this.now(),
      };
      this.store.putState(state);
      return {
        schemaVersion: 1,
        receipt: this.resumeReceipt(
          interaction,
          "canceled",
          envelope.interactionRevision,
        ),
      };
    }

    if (interaction.kind === "device_code") {
      if (!this.deviceCodeFixture) {
        throw new GatewayError("browser_unavailable", 503);
      }
      const grant = await this.decryptDeviceGrant(state, interaction);
      const providerStatus = await this.deviceCodeFixture.status(grant);
      if (providerStatus.status === "authorization_pending") {
        throw new GatewayError("verification_failed", 409);
      }
      let terminalState: InteractionRecord["state"];
      let receiptResult: "approved" | "canceled" | "expired" | "failed";
      if (
        providerStatus.status === "approved" ||
        providerStatus.status === "already_consumed"
      ) {
        const consumed = await this.deviceCodeFixture.consume(
          grant,
          interaction.interactionId,
        );
        if (consumed.outcome === "approved") {
          terminalState = "completed";
          receiptResult = "approved";
        } else if (consumed.outcome === "access_denied") {
          terminalState = "canceled";
          receiptResult = "canceled";
        } else if (consumed.outcome === "expired_token") {
          terminalState = "expired";
          receiptResult = "expired";
        } else {
          terminalState = "failed";
          receiptResult = "failed";
        }
      } else if (providerStatus.status === "access_denied") {
        terminalState = "canceled";
        receiptResult = "canceled";
      } else if (providerStatus.status === "expired_token") {
        terminalState = "expired";
        receiptResult = "expired";
      } else {
        // An invalid grant must never be treated as proof that this interaction
        // owns a successful authorization.
        terminalState = "failed";
        receiptResult = "failed";
      }
      interaction = {
        ...interaction,
        revision: interaction.revision + 1,
        state: terminalState,
        updatedAt: this.now(),
        verification: undefined,
      };
      this.store.putInteraction(interaction);
      state = {
        ...state,
        phase: "AGENT_CONTROL",
        activeInteractionId: undefined,
        updatedAt: this.now(),
      };
      this.store.putState(state);
      return {
        schemaVersion: 1,
        receipt: this.resumeReceipt(
          interaction,
          receiptResult,
          envelope.interactionRevision,
        ),
      };
    }

    state = await this.ensureBrowser(state);
    await this.browser.completeHandoff(true);
    interaction = {
      ...interaction,
      revision: interaction.revision + 1,
      state: "resuming",
      updatedAt: this.now(),
    };
    this.store.putInteraction(interaction);
    const verified = await this.browser.trustedVerify(
      interaction.verification as TrustedVerification,
      "authenticated",
    );
    if (!verified) {
      state = await this.closeBrowser(state);
      interaction = {
        ...interaction,
        revision: interaction.revision + 1,
        state: "failed",
        updatedAt: this.now(),
      };
      this.store.putInteraction(interaction);
      this.store.putState({
        ...state,
        phase: "AGENT_CONTROL",
        activeInteractionId: undefined,
        updatedAt: this.now(),
      });
      return {
        schemaVersion: 1,
        receipt: this.resumeReceipt(
          interaction,
          "failed",
          envelope.interactionRevision,
        ),
      };
    }

    state = await this.checkpoint(state);
    state = await this.closeBrowser(state);
    // Deliberately acquire a new Browser Run session and restore only the
    // encrypted storage snapshot before automation regains control.
    state = await this.ensureBrowser(state);
    const verification = interaction.verification as TrustedVerification;
    this.validateObservation(
      await this.browser.navigate(
        allowedUrl(verification.resumeUrl, state.allowedOrigins),
      ),
      state.allowedOrigins,
    );
    const restoredVerified = await this.browser.trustedVerify(
      verification,
      "authenticated",
    );
    if (!restoredVerified) {
      const failedSnapshot = state.snapshot;
      state = await this.closeBrowser(state);
      if (failedSnapshot) {
        await this.bucket.delete(failedSnapshot.key).catch(() => undefined);
      }
      state = {
        ...state,
        snapshot: undefined,
        phase: "AGENT_CONTROL",
        activeInteractionId: undefined,
        updatedAt: this.now(),
      };
      this.store.putState(state);
      interaction = {
        ...interaction,
        revision: interaction.revision + 1,
        state: "failed",
        updatedAt: this.now(),
      };
      this.store.putInteraction(interaction);
      return {
        schemaVersion: 1,
        receipt: this.resumeReceipt(
          interaction,
          "failed",
          envelope.interactionRevision,
        ),
      };
    }
    interaction = {
      ...interaction,
      revision: interaction.revision + 1,
      state: "completed",
      updatedAt: this.now(),
    };
    this.store.putInteraction(interaction);
    this.store.putState({
      ...state,
      phase: "AGENT_CONTROL",
      activeInteractionId: undefined,
      updatedAt: this.now(),
    });
    return {
      schemaVersion: 1,
      receipt: this.resumeReceipt(
        interaction,
        "approved",
        envelope.interactionRevision,
      ),
    };
  }

  async reset(envelope: ProfileResetEnvelope): Promise<unknown> {
    const resetDigest = await sha256Hex(stableJson(envelope));
    const existingReceipt = this.store.getReceipt(envelope.requestId);
    if (existingReceipt) {
      if (existingReceipt.requestDigest !== resetDigest) {
        throw new GatewayError("profile_conflict", 409);
      }
      return existingReceipt.response;
    }
    const identity = await this.identity(envelope.authority);
    const state = await this.stateFor(envelope.authority, {
      destructive: true,
    });
    const epoch = state.profileEpoch + 1;
    if (!Number.isSafeInteger(epoch)) {
      throw new GatewayError("internal_error", 500);
    }
    const updated: ProfileState = {
      ...identity,
      profileEpoch: epoch,
      phase: "AGENT_CONTROL",
      allowedOrigins: [],
      updatedAt: this.now(),
    };
    // Revoke the old epoch and every pending handoff synchronously before any
    // browser or R2 I/O can yield.
    this.store.putState(updated);
    this.store.deleteReceipts();
    this.store.deleteInteractions();
    if (state.browserSessionId) {
      await this.browser.closeRemote(state.browserSessionId);
    }
    await this.deletePrefix(this.profilePrefix(state));
    const response = {
      schemaVersion: 1,
      requestId: envelope.requestId,
      profileId: PROFILE_ID,
      profileEpoch: epoch,
      reset: true,
    };
    this.store.putReceipt({
      requestId: envelope.requestId,
      requestDigest: resetDigest,
      response,
      createdAt: this.now(),
    });
    return response;
  }

  async purge(envelope: OwnerPurgeEnvelope): Promise<unknown> {
    const [owner, profile] = await Promise.all([
      ownerDigest(envelope.ownerId),
      profileDigest(PROFILE_ID),
    ]);
    if (this.purgedOwnerDigest === owner) {
      return {
        schemaVersion: 1,
        requestId: envelope.requestId,
        profileId: PROFILE_ID,
        purged: true,
      };
    }
    const state = this.store.getState();
    if (state && state.ownerDigest !== owner) {
      throw new GatewayError("profile_conflict", 409);
    }
    if (state?.browserSessionId) {
      await this.browser.closeRemote(state.browserSessionId);
    }
    await this.deletePrefix(`browser-profiles/${owner}/${profile}/`);
    await this.store.destroy();
    this.purgedOwnerDigest = owner;
    return {
      schemaVersion: 1,
      requestId: envelope.requestId,
      profileId: PROFILE_ID,
      purged: true,
    };
  }
}
