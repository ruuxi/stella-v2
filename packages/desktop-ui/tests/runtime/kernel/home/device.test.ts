import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearSupersededDeviceId,
  getDeviceRecordPath,
  getOrCreateDeviceIdentity,
  resetDeviceIdentity,
} from "@stella/runtime/kernel/home/device";
import {
  installTestSafeStorage,
  resetTestSafeStorage,
} from "../../../helpers/protected-storage.js";

const roots = new Set<string>();

const createTempDir = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-device-"));
  roots.add(root);
  return root;
};

const readDeviceRecord = async (root: string) =>
  JSON.parse(await readFile(getDeviceRecordPath(root), "utf-8")) as {
    deviceId: string;
    publicKey?: string;
    privateKeyProtected?: string;
  };

beforeEach(() => {
  installTestSafeStorage();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
  resetTestSafeStorage();
});

describe("device identity", () => {
  it("reuses a readable persisted identity", async () => {
    const root = await createTempDir();

    const first = await getOrCreateDeviceIdentity(root);
    const second = await getOrCreateDeviceIdentity(root);

    expect(second.deviceId).toBe(first.deviceId);
    expect(second.publicKey).toBe(first.publicKey);
    expect(second.privateKey).toBe(first.privateKey);
  });

  it("does not reuse a device id when the persisted private key is unreadable", async () => {
    const root = await createTempDir();
    await writeFile(
      getDeviceRecordPath(root),
      JSON.stringify(
        {
          deviceId: "old-device",
          publicKey: "old-public-key",
          privateKeyProtected:
            "stella-protected:device-private-key:v1:not-readable-here",
        },
        null,
        2,
      ),
    );

    const identity = await getOrCreateDeviceIdentity(root);
    const stored = await readDeviceRecord(root);

    expect(identity.deviceId).not.toBe("old-device");
    expect(stored.deviceId).toBe(identity.deviceId);
    expect(stored.publicKey).toBe(identity.publicKey);
  });

  it("resets to a fresh device id on demand", async () => {
    const root = await createTempDir();

    const first = await getOrCreateDeviceIdentity(root);
    const second = await resetDeviceIdentity(root);

    expect(second.deviceId).not.toBe(first.deviceId);
    expect(second.publicKey).not.toBe(first.publicKey);
  });
});

describe("device identity regeneration diagnostics", () => {
  const captureWarnings = () => {
    const lines: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    return lines;
  };

  it("stays quiet on a genuine first run", async () => {
    const root = await createTempDir();
    const warnings = captureWarnings();

    await getOrCreateDeviceIdentity(root);

    expect(warnings).toHaveLength(0);
  });

  it("names an undecryptable key as the reason", async () => {
    const root = await createTempDir();
    await writeFile(
      getDeviceRecordPath(root),
      JSON.stringify({
        deviceId: "old-device",
        publicKey: "old-public-key",
        privateKeyProtected:
          "stella-protected:device-private-key:v1:not-readable-here",
      }),
    );
    const warnings = captureWarnings();

    await getOrCreateDeviceIdentity(root);

    expect(warnings.join("\n")).toContain("undecryptable-private-key");
    expect(warnings.join("\n")).toContain("old-device");
  });

  it("distinguishes a malformed record from an undecryptable one", async () => {
    const root = await createTempDir();
    await writeFile(getDeviceRecordPath(root), "{ not json");
    const warnings = captureWarnings();

    await getOrCreateDeviceIdentity(root);

    expect(warnings.join("\n")).toContain("malformed-record");
    expect(warnings.join("\n")).not.toContain("undecryptable");
  });

  it("distinguishes a record that is missing fields", async () => {
    const root = await createTempDir();
    await writeFile(
      getDeviceRecordPath(root),
      JSON.stringify({ deviceId: "old-device" }),
    );
    const warnings = captureWarnings();

    await getOrCreateDeviceIdentity(root);

    expect(warnings.join("\n")).toContain("incomplete-record");
  });
});

describe("device identity succession", () => {
  const writeUnreadableRecord = async (root: string, deviceId: string) =>
    await writeFile(
      getDeviceRecordPath(root),
      JSON.stringify({
        deviceId,
        publicKey: "old-public-key",
        privateKeyProtected:
          "stella-protected:device-private-key:v1:not-readable-here",
      }),
    );

  it("remembers the id it replaced so paired phones can follow", async () => {
    const root = await createTempDir();
    await writeUnreadableRecord(root, "old-device");

    const identity = await getOrCreateDeviceIdentity(root);

    expect(identity.deviceId).not.toBe("old-device");
    expect(identity.supersededDeviceId).toBe("old-device");
  });

  it("persists the retired id so a claim survives being offline", async () => {
    const root = await createTempDir();
    await writeUnreadableRecord(root, "old-device");

    await getOrCreateDeviceIdentity(root);

    const reloaded = await getOrCreateDeviceIdentity(root);

    expect(reloaded.supersededDeviceId).toBe("old-device");
    expect((await readDeviceRecord(root)).supersededDeviceId).toBe(
      "old-device",
    );
  });

  it("clears the retired id once the claim is acknowledged", async () => {
    const root = await createTempDir();
    await writeUnreadableRecord(root, "old-device");
    const identity = await getOrCreateDeviceIdentity(root);

    await clearSupersededDeviceId(root);

    const reloaded = await getOrCreateDeviceIdentity(root);
    expect(reloaded.deviceId).toBe(identity.deviceId);
    expect(reloaded.supersededDeviceId).toBeUndefined();
  });

  it("carries the identity forward only on an involuntary rotation", async () => {
    const root = await createTempDir();
    const first = await getOrCreateDeviceIdentity(root);

    const deliberate = await resetDeviceIdentity(root);
    expect(deliberate.supersededDeviceId).toBeUndefined();

    const recovered = await resetDeviceIdentity(root, {
      preservePairings: true,
    });
    expect(recovered.supersededDeviceId).toBe(deliberate.deviceId);
    expect(recovered.supersededDeviceId).not.toBe(first.deviceId);
  });
});
