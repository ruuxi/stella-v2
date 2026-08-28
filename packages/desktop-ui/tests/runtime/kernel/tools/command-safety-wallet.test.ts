import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { isBlockedPath } from "@stella/runtime/kernel/tools/command-safety";

const roots: string[] = [];

const makeRoot = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "stella-wallet-safety-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("command-safety wallet paths", () => {
  it("blocks the Link auth file and the wallet directory", () => {
    const root = makeRoot();
    const context = { stellaDataDir: root };
    expect(
      isBlockedPath(path.join(root, "wallet", "link-auth.json"), context),
    ).toMatch(/credential|token|internal Stella state/i);
    expect(
      isBlockedPath(path.join(root, "wallet", "other.json"), context),
    ).toMatch(/credential|token|internal Stella state/i);
  });
});
