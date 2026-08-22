import { mkdtempSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BETTER_AUTH_COOKIE_STORAGE_KEY } from "@stella/runtime/kernel/auth/auth-core";

const mocks = vi.hoisted(() => ({
  userDataDir: "" as string,
}));

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name === "userData") return mocks.userDataDir;
      return mocks.userDataDir;
    },
  },
}));

// safeStorage isn't available in the test process; the legacy store's
// protection is identity so we can seed/read it directly.
vi.mock("@stella/runtime/kernel/shared/protected-storage", () => ({
  protectValue: (_scope: string, value: string) => value,
  unprotectValue: (_scope: string, value: string) => value,
  deleteProtectedValue: () => {},
}));

const { AuthService } = await import(
  "@stella/desktop/electron/services/auth-service.js"
);

const makeJwt = (payload: Record<string, unknown>) =>
  `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

const MIGRATION_MARKER_FILE = "better-auth-runtime-migration.json";
const AUTH_STORAGE_FILE = "better-auth-storage.json";

let tmpDir: string;

const seedLegacyCookie = () => {
  fs.writeFileSync(
    path.join(tmpDir, AUTH_STORAGE_FILE),
    JSON.stringify({ [BETTER_AUTH_COOKIE_STORAGE_KEY]: "legacy-cookie" }),
  );
};

const seedMigrationMarker = () => {
  fs.writeFileSync(
    path.join(tmpDir, MIGRATION_MARKER_FILE),
    JSON.stringify({ migratedAt: Date.now(), desktopDirty: false }),
  );
};

const buildService = (runner: unknown) =>
  new AuthService({
    authProtocol: "stella",
    isDev: false,
    projectDir: tmpDir,
    sessionPartition: "persist:test",
    runnerTarget: { getRunner: () => runner as never },
    onAuthCallback: () => {},
    onSecondInstanceFocus: () => {},
  });

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "stella-auth-service-"));
  mocks.userDataDir = tmpDir;
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("AuthService.syncRuntimeAuthStore — migration is one-way", () => {
  it("does not re-import when the runtime store has a live session but minting returned null", async () => {
    seedLegacyCookie();
    seedMigrationMarker();
    const importAuthSession = vi.fn(async () => ({
      ok: true,
      authenticated: true,
      hasConnectedAccount: true,
    }));
    const runner = {
      getWorkerGeneration: () => 1,
      importAuthSession,
      // Transient mint failure: null token, but the runtime store is live.
      getRuntimeConvexToken: async () => ({
        token: null,
        hasConnectedAccount: false,
        hasSession: true,
      }),
    };
    const service = buildService(runner);

    await service.syncRuntimeAuthStore();

    // A null token must NOT be misread as "empty runtime store" and trigger a
    // stale re-import over the worker's newer session.
    expect(importAuthSession).not.toHaveBeenCalled();
    expect(service.isRuntimeAuthOwnerActive()).toBe(true);
  });

  it("never re-imports after migration is complete, even if the runtime appears empty", async () => {
    seedLegacyCookie();
    seedMigrationMarker();
    const importAuthSession = vi.fn(async () => ({
      ok: true,
      authenticated: true,
      hasConnectedAccount: true,
    }));
    const runner = {
      getWorkerGeneration: () => 1,
      importAuthSession,
      // Even if the runtime reports empty (which may be a lie: a transient
      // unreadable store, or a legitimate sign-out), migration is one-way and
      // complete — we must NOT resurrect the stale desktop artifact.
      getRuntimeConvexToken: async () => ({
        token: null,
        hasConnectedAccount: false,
        hasSession: false,
      }),
    };
    const service = buildService(runner);

    await service.syncRuntimeAuthStore();

    expect(importAuthSession).not.toHaveBeenCalled();
    expect(service.isRuntimeAuthOwnerActive()).toBe(true);
  });

  it("first migration imports with the atomic import-if-empty flag", async () => {
    seedLegacyCookie();
    // No migration marker yet → first migration.
    const importAuthSession = vi.fn(async () => ({
      ok: true,
      authenticated: true,
      hasConnectedAccount: true,
    }));
    const runner = {
      getWorkerGeneration: () => 1,
      importAuthSession,
      getRuntimeConvexToken: async () => ({
        token: null,
        hasConnectedAccount: false,
        hasSession: false,
      }),
    };
    const service = buildService(runner);

    await service.syncRuntimeAuthStore();

    expect(importAuthSession).toHaveBeenCalledTimes(1);
    expect(importAuthSession.mock.calls[0]?.[0]).toMatchObject({
      onlyIfEmpty: true,
    });
  });
});

describe("AuthService.syncRuntimeAuthStore — version-skew ownership", () => {
  it("re-evaluates ownership after a stale worker is replaced instead of latching legacy", async () => {
    let generation = 1;
    let importThrows = true;
    const importAuthSession = vi.fn(async () => {
      if (importThrows) {
        throw new Error("Method not found: internal.worker.auth.import");
      }
      return { ok: true, authenticated: true, hasConnectedAccount: false };
    });
    const runner = {
      getWorkerGeneration: () => generation,
      importAuthSession,
      getRuntimeConvexToken: async () => ({
        token: null,
        hasConnectedAccount: false,
        hasSession: false,
      }),
    };
    const service = buildService(runner);

    // Old detached worker (no auth RPCs) → latch legacy for this generation.
    await service.syncRuntimeAuthStore();
    expect(service.isRuntimeAuthOwnerActive()).toBe(false);

    // Stale worker restarts into the new build: new generation, RPCs present.
    generation = 2;
    importThrows = false;
    await service.syncRuntimeAuthStore();
    expect(service.isRuntimeAuthOwnerActive()).toBe(true);
  });
});

describe("AuthService.signOut — failure is surfaced", () => {
  const baseRunner = () => ({
    getWorkerGeneration: () => 1,
    importAuthSession: async () => ({
      ok: true,
      authenticated: true,
      hasConnectedAccount: true,
    }),
    getRuntimeConvexToken: async () => ({
      token: null,
      hasConnectedAccount: false,
      hasSession: true,
    }),
    setAuthToken: vi.fn(),
    setHasConnectedAccount: vi.fn(),
    setConvexUrl: vi.fn(),
    setConvexSiteUrl: vi.fn(),
  });

  it("does not clear local state or report success when runtime sign-out fails", async () => {
    seedLegacyCookie();
    seedMigrationMarker();
    const runner = { ...baseRunner(), authSignOut: async () => ({ ok: false }) };
    const service = buildService(runner);

    const result = await service.signOut();

    expect(result.ok).toBe(false);
    // The legacy mirror must not be wiped (the authoritative session survives).
    const legacy = JSON.parse(
      fs.readFileSync(path.join(tmpDir, AUTH_STORAGE_FILE), "utf8"),
    );
    expect(legacy[BETTER_AUTH_COOKIE_STORAGE_KEY]).toBeTruthy();
    expect(runner.setAuthToken).not.toHaveBeenCalled();
  });

  it("clears local state when runtime sign-out succeeds", async () => {
    seedLegacyCookie();
    seedMigrationMarker();
    const runner = { ...baseRunner(), authSignOut: async () => ({ ok: true }) };
    const service = buildService(runner);

    const result = await service.signOut();

    expect(result.ok).toBe(true);
    expect(runner.setAuthToken).toHaveBeenCalledWith(null);
  });

  it("treats a missing runner sign-out method as failure (no false success)", async () => {
    seedLegacyCookie();
    seedMigrationMarker();
    // Runner present for ensureRuntimeAuthMode, but no authSignOut method
    // (e.g. an old worker / version skew).
    const runner = {
      getWorkerGeneration: () => 1,
      importAuthSession: async () => ({
        ok: true,
        authenticated: true,
        hasConnectedAccount: true,
      }),
      getRuntimeConvexToken: async () => ({
        token: null,
        hasConnectedAccount: false,
        hasSession: true,
      }),
      setAuthToken: vi.fn(),
      setHasConnectedAccount: vi.fn(),
      setConvexUrl: vi.fn(),
      setConvexSiteUrl: vi.fn(),
    };
    const service = buildService(runner);

    const result = await service.signOut();

    expect(result.ok).toBe(false);
    const legacy = JSON.parse(
      fs.readFileSync(path.join(tmpDir, AUTH_STORAGE_FILE), "utf8"),
    );
    expect(legacy[BETTER_AUTH_COOKIE_STORAGE_KEY]).toBeTruthy();
    expect(runner.setAuthToken).not.toHaveBeenCalled();
  });
});

describe("AuthService.getConvexAuthToken — 401 recovery", () => {
  it("never serves the rejected last-known token on a force-refresh", async () => {
    const rejectedJwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 1800 });
    const runner = {
      getWorkerGeneration: () => 1,
      importAuthSession: async () => ({
        ok: true,
        authenticated: true,
        hasConnectedAccount: false,
      }),
      getRuntimeConvexToken: async (opts?: { forceRefresh?: boolean }) => {
        if (opts?.forceRefresh) {
          // 401 recovery mint fails.
          return { token: null, hasConnectedAccount: false, hasSession: true };
        }
        return {
          token: rejectedJwt,
          hasConnectedAccount: false,
          hasSession: true,
        };
      },
    };
    const service = buildService(runner);

    // Prime the desktop's last-known-token cache with the (soon-rejected) JWT.
    const primed = await service.getConvexAuthToken();
    expect(primed).toBe(rejectedJwt);

    // Force refresh (401 recovery): mint fails, and we must NOT hand back the
    // rejected cached token.
    const recovered = await service.getConvexAuthToken({ forceRefresh: true });
    expect(recovered).toBeNull();
  });
});
