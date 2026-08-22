import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAuthSessionStore } from "@stella/runtime/kernel/auth/store";

const FIXTURE = path.resolve(
  import.meta.dirname,
  "fixtures/concurrent-writer.ts",
);
const BUN = process.env.STELLA_BUN_PATH?.trim() || "bun";

let tmpDir: string;

beforeEach(() => {
  process.env.STELLA_AUTH_DEK_DISABLE_KEYCHAIN = "1";
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "stella-auth-concurrency-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const runWriter = (key: string, iterations: number): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      BUN,
      [FIXTURE, tmpDir, key, String(iterations)],
      {
        env: { ...process.env, STELLA_AUTH_DEK_DISABLE_KEYCHAIN: "1" },
        stdio: "ignore",
      },
    );
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });

describe("auth session store — two-process write race (regression)", () => {
  it("serializes concurrent writers so neither's committed key is lost", async () => {
    // Seed first so both children share one DEK (no DEK-mint race) and there is
    // a pre-existing key both must preserve across their writes.
    const seed = createAuthSessionStore({ stellaDataDir: tmpDir });
    seed.setItem("seed", "kept");

    const iterations = 150;
    const [codeA, codeB] = await Promise.all([
      runWriter("writerA", iterations),
      runWriter("writerB", iterations),
    ]);
    expect(codeA).toBe(0);
    expect(codeB).toBe(0);

    // A correct inter-process lock means every transaction re-reads the latest
    // map, so both writers' final values survive AND the seed key is never
    // dropped by a stale rename. A check-then-act race loses updates here.
    const final = createAuthSessionStore({ stellaDataDir: tmpDir });
    expect(final.getItem("writerA")).toBe(String(iterations - 1));
    expect(final.getItem("writerB")).toBe(String(iterations - 1));
    expect(final.getItem("seed")).toBe("kept");
  }, 30_000);
});
