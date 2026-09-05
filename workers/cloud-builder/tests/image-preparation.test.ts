import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

const workerRoot = path.resolve(import.meta.dir, "..");
const prepareScript = path.join(workerRoot, "scripts", "prepare-image.mjs");

const prepare = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stella-image-prepare-"));
  const output = path.join(root, "image");
  const result = spawnSync(
    process.execPath,
    [prepareScript, `--output=${output}`],
    { cwd: workerRoot, encoding: "utf8" },
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return { output, root };
};

const treeDigest = async (root: string) => {
  const files: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  };
  await walk(root);
  files.sort();

  const digest = createHash("sha256");
  for (const absolute of files) {
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const bytes = await readFile(absolute);
    digest.update(relative);
    digest.update("\0");
    digest.update(String(bytes.byteLength));
    digest.update("\0");
    digest.update(createHash("sha256").update(bytes).digest("hex"));
    digest.update("\n");
  }
  return digest.digest("hex");
};

describe("Sandbox image preparation", () => {
  test("two clean preparations produce the identical locked image context", async () => {
    const [first, second] = await Promise.all([prepare(), prepare()]);
    try {
      expect(await treeDigest(first.output)).toBe(
        await treeDigest(second.output),
      );

      const metadata = JSON.parse(
        await readFile(path.join(first.output, "image-build.json"), "utf8"),
      );
      const lock = await readFile(path.join(first.output, "bun.lock"));
      const parsedLock = Bun.JSONC.parse(lock.toString()) as {
        workspaces: Record<string, unknown>;
      };
      expect(Object.keys(parsedLock.workspaces)).toEqual([
        "",
        "packages/app-template",
        "packages/apps-sdk",
        "packages/contracts",
        "packages/executor-cloud",
        "packages/model-catalog",
        "packages/runtime",
        "packages/stella-office",
      ]);
      expect(metadata).toEqual({
        schemaVersion: 1,
        sandboxSdkVersion: "0.12.9",
        sandboxBaseImage: "docker.io/cloudflare/sandbox:0.12.9",
        dependencyLockSha256: `sha256:${createHash("sha256")
          .update(lock)
          .digest("hex")}`,
      });
    } finally {
      await Promise.all(
        [first.root, second.root].map((root) =>
          rm(root, { recursive: true, force: true }),
        ),
      );
    }
  }, 30_000);
});
