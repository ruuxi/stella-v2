import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadExtensions } from "@stella/runtime/kernel/extensions/loader";

const scratchPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((scratchPath) =>
        fs.rm(scratchPath, { recursive: true, force: true }),
      ),
  );
});

describe("packaged extension entries", () => {
  it("loads compiled index.js before a source index.ts", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "stella-extension-loader-"),
    );
    scratchPaths.push(root);
    const extensionDir = path.join(root, "compiled-extension");
    await fs.mkdir(extensionDir, { recursive: true });
    await fs.writeFile(
      path.join(extensionDir, "index.js"),
      `export default (api) => api.registerPrompt({ name: "compiled", description: "", template: "ok", filePath: import.meta.url });`,
    );
    await fs.writeFile(
      path.join(extensionDir, "index.ts"),
      `throw new Error("source entry must not load when index.js exists");`,
    );

    const loaded = await loadExtensions(root, {
      stellaDataDir: root,
      stellaAppDir: root,
      store: {} as never,
    });

    expect(loaded.prompts.map((prompt) => prompt.name)).toEqual(["compiled"]);
  });
});
