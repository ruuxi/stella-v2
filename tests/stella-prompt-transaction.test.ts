import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";

import {
  promptDefaultsTransactionMarkerPath,
  promptDefaultsTransactionPaths,
  recoverPromptDefaultsTransaction,
  type PromptDefaultsTransactionMarker,
} from "../scripts/lib/stella-prompt-defaults-transaction";

const roots = new Set<string>();
const tempDir = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-prompt-txn-"));
  roots.add(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    [...roots].map((root) => rm(root, { recursive: true, force: true })),
  );
  roots.clear();
});

describe("prompt-default generation transaction", () => {
  it("recovers the previous matching artifacts after a mid-swap termination", async () => {
    const root = await tempDir();
    const spec = {
      destinationRoot: path.join(root, "prompts", "stella-runtime"),
      generatedPath: path.join(root, "convex", "defaults.generated.ts"),
    };
    await mkdir(spec.destinationRoot, { recursive: true });
    await mkdir(path.dirname(spec.generatedPath), { recursive: true });
    await writeFile(path.join(spec.destinationRoot, "version.txt"), "old-dir");
    await writeFile(spec.generatedPath, "old-generated");

    const nonce = "crash-test";
    const paths = promptDefaultsTransactionPaths(spec, nonce);
    await rename(spec.destinationRoot, paths.destinationBackup);
    await rename(spec.generatedPath, paths.generatedBackup);
    await mkdir(paths.stagingRoot, { recursive: true });
    await writeFile(path.join(paths.stagingRoot, "version.txt"), "new-dir");
    await writeFile(paths.generatedTemp, "new-generated");
    await rename(paths.stagingRoot, spec.destinationRoot);
    const marker: PromptDefaultsTransactionMarker = {
      version: 1,
      nonce,
      phase: "destination-installed",
      hadDestination: true,
      hadGenerated: true,
    };
    await writeFile(
      promptDefaultsTransactionMarkerPath(spec),
      JSON.stringify(marker),
    );

    await expect(recoverPromptDefaultsTransaction(spec)).resolves.toBe(
      "rolled-back",
    );
    await expect(
      readFile(path.join(spec.destinationRoot, "version.txt"), "utf-8"),
    ).resolves.toBe("old-dir");
    await expect(readFile(spec.generatedPath, "utf-8")).resolves.toBe(
      "old-generated",
    );
  });

  it("surfaces an incomplete rollback instead of hiding missing backups", async () => {
    const root = await tempDir();
    const spec = {
      destinationRoot: path.join(root, "prompts", "stella-runtime"),
      generatedPath: path.join(root, "convex", "defaults.generated.ts"),
    };
    await mkdir(path.dirname(promptDefaultsTransactionMarkerPath(spec)), {
      recursive: true,
    });
    const marker: PromptDefaultsTransactionMarker = {
      version: 1,
      nonce: "missing-backups",
      phase: "both-backed-up",
      hadDestination: true,
      hadGenerated: true,
    };
    await writeFile(
      promptDefaultsTransactionMarkerPath(spec),
      JSON.stringify(marker),
    );

    await expect(recoverPromptDefaultsTransaction(spec)).rejects.toBeInstanceOf(
      AggregateError,
    );
  });
});
