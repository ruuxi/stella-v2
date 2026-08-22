import { mkdtempSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Simulated OS keychain. The store shells out to `/usr/bin/security`; we mock
// that boundary so we can exercise the transient-error path deterministically
// on any platform.
const keychain = {
  value: null as string | null,
  mode: "ok" as "ok" | "error",
};

vi.mock("node:child_process", () => ({
  execFileSync: (_bin: string, args: string[]) => {
    const op = args[0];
    if (op === "find-generic-password") {
      if (keychain.mode === "error") {
        // A locked keychain / timeout / spawn failure — NOT "item not found".
        throw Object.assign(new Error("keychain is locked"), { status: 51 });
      }
      if (keychain.value == null) {
        throw Object.assign(new Error("item not found"), { status: 44 });
      }
      return Buffer.from(keychain.value, "utf8");
    }
    if (op === "add-generic-password") {
      // The value is the last argument after "-w".
      keychain.value = args[args.length - 1];
      return Buffer.from("");
    }
    throw new Error(`unexpected security op: ${op}`);
  },
}));

const { createAuthSessionStore } = await import(
  "@stella/runtime/kernel/auth/store"
);
const { BETTER_AUTH_COOKIE_STORAGE_KEY, BETTER_AUTH_SESSION_DATA_STORAGE_KEY } =
  await import("@stella/runtime/kernel/auth/auth-core");

const sessionCookie = JSON.stringify({
  "better-auth.session_token": { value: "cookie-token" },
});

let tmpDir: string;
let originalPlatform: PropertyDescriptor | undefined;

beforeEach(() => {
  // Use the real (mocked) keychain path, not the file fallback.
  delete process.env.STELLA_AUTH_DEK_DISABLE_KEYCHAIN;
  originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    value: "darwin",
    configurable: true,
  });
  keychain.value = null;
  keychain.mode = "ok";
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "stella-auth-dek-"));
});

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("auth session store — DEK custody (regression)", () => {
  it("a transient keychain error preserves the existing session (no DEK replacement)", () => {
    // Run 1: fresh install — mint a DEK into the keychain and seal a session.
    const first = createAuthSessionStore({ stellaDataDir: tmpDir });
    first.setItem(BETTER_AUTH_COOKIE_STORAGE_KEY, sessionCookie);
    expect(keychain.value).not.toBeNull();
    const storedDek = keychain.value;

    // Run 2: a fresh store instance hits a transient keychain error. It must
    // NOT mint a replacement DEK (which would orphan the encrypted session);
    // the read simply yields nothing this cycle.
    keychain.mode = "error";
    const during = createAuthSessionStore({ stellaDataDir: tmpDir });
    expect(during.getItem(BETTER_AUTH_COOKIE_STORAGE_KEY)).toBeNull();
    expect(keychain.value).toBe(storedDek);

    // Run 3: the keychain recovers — the original session decrypts again.
    keychain.mode = "ok";
    const after = createAuthSessionStore({ stellaDataDir: tmpDir });
    expect(after.getItem(BETTER_AUTH_COOKIE_STORAGE_KEY)).toBe(sessionCookie);
  });

  it("refuses to write through a DEK-poisoned store instance (no session erase)", () => {
    // Seed a session with a healthy keychain.
    const first = createAuthSessionStore({ stellaDataDir: tmpDir });
    first.setItem(BETTER_AUTH_COOKIE_STORAGE_KEY, sessionCookie);
    const storedDek = keychain.value;

    // A fresh instance whose keychain read fails: an unrelated write MUST throw
    // rather than persist an empty map over the valid (undecryptable-right-now)
    // session, and must not replace the DEK.
    keychain.mode = "error";
    const poisoned = createAuthSessionStore({ stellaDataDir: tmpDir });
    expect(() =>
      poisoned.setItem(
        BETTER_AUTH_SESSION_DATA_STORAGE_KEY,
        '{"user":{"id":"u1"}}',
      ),
    ).toThrow();
    expect(keychain.value).toBe(storedDek);

    // After recovery the original session is intact and the poisoned write
    // never landed.
    keychain.mode = "ok";
    const after = createAuthSessionStore({ stellaDataDir: tmpDir });
    expect(after.getItem(BETTER_AUTH_COOKIE_STORAGE_KEY)).toBe(sessionCookie);
    expect(after.getItem(BETTER_AUTH_SESSION_DATA_STORAGE_KEY)).toBeNull();
  });
});
