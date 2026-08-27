import { randomUUID } from "node:crypto";
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { PiRunnerTarget } from "@stella/runtime/kernel/lifecycle-targets";
import { readConfiguredConvexSiteUrl } from "@stella/contracts/convex-urls";
import {
  deleteProtectedValue,
  protectValue,
  unprotectValue,
} from "@stella/runtime/kernel/shared/protected-storage";
import type {
  HostRuntimeAuthRefreshResult,
  RuntimeAuthRefreshSource,
} from "@stella/contracts/protocol";

const RUNTIME_AUTH_REFRESH_TIMEOUT_MS = 12_000;

const HOST_AUTH_TOKEN_REFRESH_MARGIN_MS = 60_000;
const AUTH_STORAGE_SCOPE = "desktop-better-auth-storage";
const AUTH_STORAGE_FILE = "better-auth-storage.json";

const BETTER_AUTH_SESSION_DATA_STORAGE_KEY = "better-auth_session_data";

const BETTER_AUTH_TOKEN_STORAGE_KEY = "better-auth_session_token";

const CONVEX_SITE_URL_STORAGE_KEY = "convex_site_url";
const AUTH_BASE_PATH = "/api/auth";
const DESKTOP_AUTH_ORIGIN = "http://127.0.0.1:57314";

const decodeBase64UrlJson = (value: string): unknown => {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
};

type AuthServiceOptions = {
  authProtocol: string;
  isDev: boolean;
  projectDir: string;
  sessionPartition: string;
  runnerTarget: PiRunnerTarget;
  onAuthCallback: (url: string) => void;
  onSecondInstanceFocus: () => void;
};

export class AuthService {
  private pendingConvexUrl: string | null = null;
  private pendingConvexSiteUrl: string | null = null;
  private hostAuthAuthenticated = false;
  private hostHasConnectedAccount = false;
  private hostAuthToken: string | null = null;
  private authStorageCache: Record<string, string | null> | null = null;
  private runtimeAuthRefreshPromise: Promise<HostRuntimeAuthRefreshResult> | null =
    null;
  private runtimeAuthRefreshResolve:
    | ((result: HostRuntimeAuthRefreshResult) => void)
    | null = null;
  private runtimeAuthRefreshRequestId: string | null = null;
  private runtimeAuthRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private hostAuthTokenMintPromise: Promise<string | null> | null = null;

  constructor(private readonly options: AuthServiceOptions) {}

  private getAuthStoragePath() {
    return path.join(app.getPath("userData"), AUTH_STORAGE_FILE);
  }

  private encodeAuthStorageValue(value: string): string {
    return protectValue(AUTH_STORAGE_SCOPE, value);
  }

  private decodeAuthStorageValue(value: string): string | null {
    return unprotectValue(AUTH_STORAGE_SCOPE, value);
  }

  private readAuthStorage(): Record<string, string | null> {
    if (this.authStorageCache) {
      return this.authStorageCache;
    }
    try {
      const raw = fs.readFileSync(this.getAuthStoragePath(), "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const next: Record<string, string | null> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value !== "string") {
          continue;
        }
        const decoded = this.decodeAuthStorageValue(value);
        next[key] = decoded;
      }
      this.authStorageCache = next;
      return next;
    } catch {
      this.authStorageCache = {};
      return this.authStorageCache;
    }
  }

  private readEncodedAuthStorage(): Record<string, string> {
    try {
      const raw = fs.readFileSync(this.getAuthStoragePath(), "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const encoded: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") {
          encoded[key] = value;
        }
      }
      return encoded;
    } catch {
      return {};
    }
  }

  private writeAuthStorage(values: Record<string, string | null>) {
    const previousEncoded = this.readEncodedAuthStorage();
    const encoded: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === "string") {
        const previousValue = previousEncoded[key];
        encoded[key] =
          previousValue && this.decodeAuthStorageValue(previousValue) === value
            ? previousValue
            : this.encodeAuthStorageValue(value);
      }
    }
    fs.mkdirSync(path.dirname(this.getAuthStoragePath()), { recursive: true });
    fs.writeFileSync(
      this.getAuthStoragePath(),
      JSON.stringify(encoded, null, 2),
      { mode: 0o600 },
    );
    const retained = new Set(Object.values(encoded));
    for (const previousValue of Object.values(previousEncoded)) {
      if (!retained.has(previousValue)) {
        deleteProtectedValue(AUTH_STORAGE_SCOPE, previousValue);
      }
    }
    this.authStorageCache = { ...values };
  }

  private clearStoredCredentials() {
    this.setAuthStorageItem(BETTER_AUTH_TOKEN_STORAGE_KEY, null);
    this.setAuthStorageItem(BETTER_AUTH_SESSION_DATA_STORAGE_KEY, null);
    this.hostAuthToken = null;
  }

  private getAuthStorageItem(key: string): string | null {
    const normalizedKey = typeof key === "string" ? key.trim() : "";
    if (!normalizedKey) {
      return null;
    }
    return this.readAuthStorage()[normalizedKey] ?? null;
  }

  setAuthStorageItem(key: string, value: string | null) {
    const normalizedKey = typeof key === "string" ? key.trim() : "";
    if (!normalizedKey) {
      return;
    }
    const storage = { ...this.readAuthStorage() };
    if (typeof value === "string") {
      storage[normalizedKey] = value;
    } else {
      delete storage[normalizedKey];
    }
    this.writeAuthStorage(storage);
  }

  private getBearerToken(): string {
    return (
      this.getAuthStorageItem(BETTER_AUTH_TOKEN_STORAGE_KEY)?.trim() ?? ""
    );
  }

  private applyAuthResponseToken(response: Response) {
    const token = response.headers.get("set-auth-token");
    if (!token) {
      return;
    }
    const trimmed = token.trim();
    if (trimmed && trimmed !== this.getBearerToken()) {
      this.setAuthStorageItem(BETTER_AUTH_TOKEN_STORAGE_KEY, trimmed);
    }
  }

  private async authFetch(pathname: string, init: RequestInit = {}) {
    const siteUrl = this.getConvexSiteUrl();
    if (!siteUrl) {
      throw new Error("Convex site URL is not configured.");
    }
    const headers = new Headers(init.headers);
    if (!headers.has("origin")) {
      headers.set("origin", DESKTOP_AUTH_ORIGIN);
    }
    const token = this.getBearerToken();
    if (token) {
      headers.set("authorization", `Bearer ${token}`);
    }
    const response = await fetch(`${siteUrl}${AUTH_BASE_PATH}${pathname}`, {
      ...init,
      headers,
    });
    this.applyAuthResponseToken(response);
    return response;
  }

  private async fetchBetterAuthSessionFromNetwork(): Promise<unknown | null> {
    const response = await this.authFetch("/get-session", {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (
      response.status === 401 ||
      response.status === 403 ||
      response.status === 404
    ) {
      this.setAuthStorageItem(BETTER_AUTH_SESSION_DATA_STORAGE_KEY, null);
      return null;
    }
    if (!response.ok) {
      throw new Error(`Session request failed with HTTP ${response.status}.`);
    }
    const data = await response.json().catch(() => null);
    if (data) {
      this.setAuthStorageItem(
        BETTER_AUTH_SESSION_DATA_STORAGE_KEY,
        JSON.stringify(data),
      );
    } else {

      this.setAuthStorageItem(BETTER_AUTH_SESSION_DATA_STORAGE_KEY, null);
    }
    return data;
  }

  async getBetterAuthSession(): Promise<unknown | null> {
    if (!this.getBearerToken()) {

      return null;
    }
    return await this.fetchBetterAuthSessionFromNetwork();
  }

  async signInAnonymous() {
    const response = await this.authFetch("/sign-in/anonymous", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    if (!response.ok) {
      throw new Error(`Anonymous sign-in failed with HTTP ${response.status}.`);
    }
    return await response.json().catch(() => ({ ok: true }));
  }

  async signOut() {
    const response = await this.authFetch("/sign-out", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    }).catch((error) => {
      console.debug(
        "[auth] sign-out request failed:",
        (error as Error).message,
      );
      return null;
    });
    this.clearStoredCredentials();
    this.stopAuthRefreshLoop();
    return { ok: response?.ok !== false };
  }

  async deleteUser() {
    const response = await this.authFetch("/delete-user", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ callbackURL: "/" }),
    });
    if (!response.ok) {
      throw new Error(`Account deletion failed with HTTP ${response.status}.`);
    }
    this.clearStoredCredentials();
    this.stopAuthRefreshLoop();
    return { ok: true };
  }

  applySessionToken(sessionToken: string) {
    const normalized =
      typeof sessionToken === "string" ? sessionToken.trim() : "";
    if (!normalized) {
      throw new Error("Missing session token.");
    }
    this.setAuthStorageItem(BETTER_AUTH_TOKEN_STORAGE_KEY, normalized);
    return { ok: true };
  }

  async getConvexAuthTokenResult(): Promise<
    | { ok: true; token: string }
    | { ok: false; reason: "unauthorized" | "http" | "network" }
  > {
    let response: Response;
    try {
      response = await this.authFetch("/convex/token", {
        method: "GET",
        headers: { accept: "application/json" },
      });
    } catch {
      return { ok: false, reason: "network" };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: "unauthorized" };
    }
    if (!response.ok) {
      return { ok: false, reason: "http" };
    }
    const data = (await response.json().catch(() => null)) as {
      token?: string;
    } | null;
    const token =
      typeof data?.token === "string" && data.token.trim()
        ? data.token.trim()
        : "";
    return token ? { ok: true, token } : { ok: false, reason: "http" };
  }

  async getConvexAuthToken() {
    const result = await this.getConvexAuthTokenResult();
    return result.ok ? result.token : null;
  }

  private getRuntimeAuthState(): HostRuntimeAuthRefreshResult {
    return {
      authenticated:
        this.hostAuthAuthenticated && Boolean(this.hostAuthToken?.trim()),
      token: this.hostAuthToken?.trim() || null,
      hasConnectedAccount: this.hostHasConnectedAccount,
    };
  }

  private finishRuntimeAuthRefresh(result: HostRuntimeAuthRefreshResult) {
    if (this.runtimeAuthRefreshTimer) {
      clearTimeout(this.runtimeAuthRefreshTimer);
      this.runtimeAuthRefreshTimer = null;
    }
    const resolve = this.runtimeAuthRefreshResolve;
    this.runtimeAuthRefreshResolve = null;
    this.runtimeAuthRefreshPromise = null;
    this.runtimeAuthRefreshRequestId = null;
    resolve?.(result);
  }

  private getDeepLinkUrl(argv: string[]) {
    const protocol = this.options.authProtocol.toLowerCase();
    return (
      argv.find((arg) => arg.toLowerCase().startsWith(`${protocol}://`)) || null
    );
  }

  private isTrustedAuthCallbackUrl(value: string) {
    try {
      const parsed = new URL(value);
      if (
        parsed.protocol.toLowerCase() !==
        `${this.options.authProtocol.toLowerCase()}:`
      ) {
        return false;
      }
      const host = parsed.hostname.trim().toLowerCase();
      if (host === "oauth") {
        const normalizedPath = parsed.pathname.replace(/\/+$/g, "") || "/";
        if (!normalizedPath.startsWith("/callback/")) {
          return false;
        }
        const state = parsed.searchParams.get("state");
        const code = parsed.searchParams.get("code");
        const error = parsed.searchParams.get("error");
        return Boolean(state && (code || error));
      }
      return false;
    } catch {
      return false;
    }
  }

  stopAuthRefreshLoop() {
    const runner = this.options.runnerTarget.getRunner();
    this.hostHasConnectedAccount = false;
    runner?.setHasConnectedAccount(false);
    this.hostAuthToken = null;
    runner?.setAuthToken(null);
  }

  registerAuthProtocol() {
    if (this.options.isDev) {
      const appPath = app.getAppPath();
      app.setAsDefaultProtocolClient(
        this.options.authProtocol,
        process.execPath,
        [appPath],
      );
      return;
    }
    app.setAsDefaultProtocolClient(this.options.authProtocol);
  }

  bindSingleInstanceHandler() {
    app.on("second-instance", (_event, argv) => {
      const url = this.getDeepLinkUrl(argv);
      if (url) {
        this.handleAuthCallback(url);
      }
      this.options.onSecondInstanceFocus();
    });
  }

  bindOpenUrlHandler() {
    app.on("open-url", (event, url) => {
      event.preventDefault();
      this.handleAuthCallback(url);
    });
  }

  captureInitialAuthUrl(argv: string[]) {
    const initialAuthUrl = this.getDeepLinkUrl(argv);
    if (initialAuthUrl) {
      this.handleAuthCallback(initialAuthUrl);
    }
  }

  handleAuthCallback(url: string) {
    if (!url) {
      return;
    }
    if (!this.isTrustedAuthCallbackUrl(url)) {
      console.warn("[security] Rejected untrusted auth callback URL.");
      return;
    }
    this.options.onAuthCallback(url);
  }

  setHostAuthState(
    authenticated: boolean,
    token?: string,
    hasConnectedAccount?: boolean,
  ) {
    const runner = this.options.runnerTarget.getRunner();
    const previousAuthToken = this.hostAuthToken;
    const previousHasConnectedAccount = this.hostHasConnectedAccount;
    this.hostAuthAuthenticated = authenticated;
    this.hostHasConnectedAccount = authenticated
      ? (hasConnectedAccount ?? this.hostHasConnectedAccount)
      : false;
    const normalizedToken = typeof token === "string" ? token.trim() : "";

    if (!authenticated) {
      this.stopAuthRefreshLoop();
      return;
    }

    if (normalizedToken) {
      this.hostAuthToken = normalizedToken;
      if (normalizedToken !== previousAuthToken) {
        runner?.setAuthToken(normalizedToken);
      }
    } else if (!this.hostAuthToken) {
      runner?.setAuthToken(null);
    }

    if (this.hostHasConnectedAccount !== previousHasConnectedAccount) {
      runner?.setHasConnectedAccount(this.hostHasConnectedAccount);
    }
  }

  getHostAuthAuthenticated() {
    return this.hostAuthAuthenticated;
  }

  getHostHasConnectedAccount() {
    return this.hostHasConnectedAccount;
  }

  configurePiRuntime(config: { convexUrl: string; convexSiteUrl?: string }) {
    this.pendingConvexUrl = config.convexUrl;
    this.pendingConvexSiteUrl = readConfiguredConvexSiteUrl(
      config.convexSiteUrl,
    );

    if (this.pendingConvexSiteUrl) {
      this.setAuthStorageItem(
        CONVEX_SITE_URL_STORAGE_KEY,
        this.pendingConvexSiteUrl,
      );
    }
    const runner = this.options.runnerTarget.getRunner();
    runner?.setConvexUrl(config.convexUrl);
    runner?.setConvexSiteUrl(this.getConvexSiteUrl());
    if (this.hostAuthToken) {
      runner?.setAuthToken(this.hostAuthToken);
    }
    runner?.setHasConnectedAccount(this.hostHasConnectedAccount);
  }

  getPendingConvexUrl() {
    return this.pendingConvexUrl;
  }

  getConvexSiteUrl(): string | null {
    const live = readConfiguredConvexSiteUrl(this.pendingConvexSiteUrl);
    if (live) {
      return live;
    }

    return readConfiguredConvexSiteUrl(
      this.getAuthStorageItem(CONVEX_SITE_URL_STORAGE_KEY) ?? undefined,
    );
  }

  private isHostAuthTokenFresh(token: string): boolean {
    const payload = decodeBase64UrlJson(token.split(".")[1] ?? "");
    const exp = (payload as { exp?: unknown } | null)?.exp;
    if (typeof exp !== "number") {

      return true;
    }
    return Date.now() < exp * 1000 - HOST_AUTH_TOKEN_REFRESH_MARGIN_MS;
  }

  private async mintHostAuthToken(): Promise<string | null> {
    if (this.hostAuthTokenMintPromise) {
      return await this.hostAuthTokenMintPromise;
    }
    this.hostAuthTokenMintPromise = (async () => {
      try {
        const result = await this.getConvexAuthTokenResult();
        if (result.ok) {
          if (result.token !== this.hostAuthToken) {
            this.hostAuthToken = result.token;
            this.options.runnerTarget.getRunner()?.setAuthToken(result.token);
          }
          return result.token;
        }
        if (result.reason === "unauthorized") {

          console.info("[auth] Stored session rejected; signing out locally.");
          this.clearStoredCredentials();
          this.options.runnerTarget.getRunner()?.setAuthToken(null);
          this.hostAuthAuthenticated = false;
          this.stopAuthRefreshLoop();
        }
        return null;
      } catch (error) {
        console.warn(
          "[auth] Failed to mint a fresh host auth token:",
          (error as Error).message,
        );
        return null;
      } finally {
        this.hostAuthTokenMintPromise = null;
      }
    })();
    return await this.hostAuthTokenMintPromise;
  }

  private async refreshHostAuthTokenIfStale(): Promise<void> {
    const cached = this.hostAuthToken?.trim() || null;
    if (cached && this.isHostAuthTokenFresh(cached)) {
      return;
    }
    if (!this.getBearerToken()) {
      return;
    }
    await this.mintHostAuthToken();
  }

  async getAuthToken(): Promise<string | null> {
    const cached = this.hostAuthToken?.trim() || null;
    if (cached && this.isHostAuthTokenFresh(cached)) {
      return cached;
    }
    if (!this.getBearerToken()) {

      return null;
    }
    const fresh = await this.mintHostAuthToken();
    if (fresh?.trim()) {
      return fresh.trim();
    }

    if (!this.getBearerToken()) {
      return null;
    }

    return cached;
  }

  async getScheduleScriptAuth(): Promise<{
    baseUrl: string;
    authToken: string;
  } | null> {
    const baseUrl = this.getConvexSiteUrl();
    if (!baseUrl) {
      return null;
    }
    const authToken = (await this.getAuthToken())?.trim() || null;
    return authToken && this.isHostAuthTokenFresh(authToken)
      ? { baseUrl, authToken }
      : null;
  }

  async requestRuntimeAuthRefresh(
    source: RuntimeAuthRefreshSource,
    broadcastRequest: (payload: {
      requestId: string;
      source: RuntimeAuthRefreshSource;
    }) => void,
  ): Promise<HostRuntimeAuthRefreshResult> {
    if (this.runtimeAuthRefreshPromise) {
      return await this.runtimeAuthRefreshPromise;
    }

    const requestId = randomUUID();
    this.runtimeAuthRefreshRequestId = requestId;
    this.runtimeAuthRefreshPromise = new Promise<HostRuntimeAuthRefreshResult>(
      (resolve) => {
        this.runtimeAuthRefreshResolve = resolve;
        this.runtimeAuthRefreshTimer = setTimeout(() => {
          console.warn(
            `[auth] Runtime auth refresh timed out after ${source} request.`,
          );

          void this.refreshHostAuthTokenIfStale().finally(() => {
            this.finishRuntimeAuthRefresh(this.getRuntimeAuthState());
          });
        }, RUNTIME_AUTH_REFRESH_TIMEOUT_MS);
      },
    );
    const pendingRefresh = this.runtimeAuthRefreshPromise;

    try {
      broadcastRequest({ requestId, source });
    } catch (error) {
      console.warn(
        "[auth] Failed to broadcast runtime auth refresh request.",
        error,
      );
      this.finishRuntimeAuthRefresh(this.getRuntimeAuthState());
    }

    return await pendingRefresh;
  }

  completeRuntimeAuthRefresh(payload: {
    requestId: string;
    authenticated?: boolean;
    token?: string | null;
    hasConnectedAccount?: boolean;
  }) {
    if (!this.runtimeAuthRefreshRequestId) {
      return { ok: false, accepted: false };
    }
    if (payload.requestId !== this.runtimeAuthRefreshRequestId) {
      return { ok: false, accepted: false };
    }

    this.setHostAuthState(
      Boolean(payload.authenticated),
      payload.token ?? undefined,
      payload.hasConnectedAccount,
    );
    this.finishRuntimeAuthRefresh(this.getRuntimeAuthState());
    return { ok: true, accepted: true };
  }

}
