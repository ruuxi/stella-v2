import os from "node:os";
import path from "node:path";
import { readdir, readFile, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  getDeferredDeletePaths,
  listDeferredDeletes,
  purgeAllDeferredDeletes,
  purgeDeferredDelete,
  purgeExpiredDeferredDeletes,
  trashPathsForDeferredDelete,
} from "@stella/runtime/kernel/tools/deferred-delete";
import {
  buildShellCommand,
  createShellState,
  runShell,
} from "@stella/runtime/kernel/tools/shell";
import { createAsyncTempDirTracker } from "../../../helpers/temp.js";

const tempDirs = createAsyncTempDirTracker();
afterEach(async () => {
  await tempDirs.cleanup();
});

const createTempDir = async () => {
  return await tempDirs.create("stella-deferred-delete-");
};

describe("legacy deferred-delete trash", () => {
  it("moves deleted files into Stella trash with 24h metadata", async () => {
    const stellaDataDir = await createTempDir();
    const target = path.join(stellaDataDir, "victim.txt");
    await writeFile(target, "keep me for now", "utf-8");

    const result = await trashPathsForDeferredDelete([target], {
      source: "test",
      stellaDataDir,
    });

    expect(result.errors).toEqual([]);
    expect(result.trashed).toHaveLength(1);
    await expect(readFile(target, "utf-8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(result.trashed[0]!.trashPath, "utf-8")).toBe(
      "keep me for now",
    );
    expect(result.trashed[0]!.purgeAfter - result.trashed[0]!.trashedAt).toBe(
      24 * 60 * 60 * 1000,
    );
  });

  it("refuses root, home, and system-level directories before deleting", async () => {
    const stellaDataDir = await createTempDir();
    const result = await trashPathsForDeferredDelete(
      [path.parse(stellaDataDir).root, os.homedir(), "/System"],
      {
        source: "test",
        stellaDataDir,
        force: true,
      },
    );

    expect(result.trashed).toEqual([]);
    expect(result.errors.map((error) => error.error)).toEqual([
      "Refusing to delete filesystem root path.",
      "Refusing to delete protected home directory.",
      "Refusing to delete protected system directory.",
    ]);
  });

  it("purges expired trash records and leaves unexpired records alone", async () => {
    const stellaDataDir = await createTempDir();
    const expired = path.join(stellaDataDir, "expired.txt");
    const fresh = path.join(stellaDataDir, "fresh.txt");
    await writeFile(expired, "old", "utf-8");
    await writeFile(fresh, "new", "utf-8");

    const expiredResult = await trashPathsForDeferredDelete([expired], {
      source: "test",
      stellaDataDir,
    });
    const freshResult = await trashPathsForDeferredDelete([fresh], {
      source: "test",
      stellaDataDir,
    });

    const now = expiredResult.trashed[0]!.purgeAfter + 1;
    const freshMetadataPath = path.join(
      getDeferredDeletePaths(stellaDataDir).itemsDir,
      `${freshResult.trashed[0]!.id}.json`,
    );
    const freshRecord = JSON.parse(await readFile(freshMetadataPath, "utf-8"));
    freshRecord.purgeAfter = now + 60_000;
    await writeFile(freshMetadataPath, JSON.stringify(freshRecord), "utf-8");

    const sweep = await purgeExpiredDeferredDeletes({ stellaDataDir, now });

    expect(sweep).toMatchObject({ checked: 2, purged: 1, skipped: 1 });
    await expect(
      readFile(expiredResult.trashed[0]!.trashPath, "utf-8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(freshResult.trashed[0]!.trashPath, "utf-8")).toBe(
      "new",
    );
  });

  it("lists and force-deletes deferred trash records", async () => {
    const stellaDataDir = await createTempDir();
    const first = path.join(stellaDataDir, "first.txt");
    const second = path.join(stellaDataDir, "second.txt");
    await writeFile(first, "one", "utf-8");
    await writeFile(second, "two", "utf-8");

    const firstResult = await trashPathsForDeferredDelete([first], {
      source: "test",
      stellaDataDir,
    });
    const secondResult = await trashPathsForDeferredDelete([second], {
      source: "test",
      stellaDataDir,
    });

    const list = await listDeferredDeletes({ stellaDataDir });
    expect(list.errors).toEqual([]);
    expect(list.items.map((item) => item.id).sort()).toEqual(
      [firstResult.trashed[0]!.id, secondResult.trashed[0]!.id].sort(),
    );

    const one = await purgeDeferredDelete(firstResult.trashed[0]!.id, {
      stellaDataDir,
    });
    expect(one).toMatchObject({ checked: 1, purged: 1, skipped: 0 });
    await expect(
      readFile(firstResult.trashed[0]!.trashPath, "utf-8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const all = await purgeAllDeferredDeletes({ stellaDataDir });
    expect(all).toMatchObject({ checked: 1, purged: 1, skipped: 0 });
    await expect(
      readFile(secondResult.trashed[0]!.trashPath, "utf-8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("native shell deletion", () => {
  it("lets rm execute directly without creating Stella trash", async () => {
    if (process.platform === "win32") return;
    const stellaDataDir = await createTempDir();
    const target = path.join(stellaDataDir, "victim.txt");
    await writeFile(target, "native delete", "utf-8");

    const output = await runShell(
      createShellState(stellaDataDir),
      'rm -- "victim.txt"',
      stellaDataDir,
      10_000,
    );

    expect(output).toBe("Command completed successfully (no output).");
    await expect(readFile(target, "utf-8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const trashFiles = await readdir(
      getDeferredDeletePaths(stellaDataDir).trashDir,
    ).catch(() => []);
    expect(trashFiles).toEqual([]);
  });

  it("passes Windows cmd and PowerShell delete syntax through unchanged", async () => {
    const stellaDataDir = await createTempDir();
    const state = createShellState(stellaDataDir);
    const cmd =
      'if exist "%USERPROFILE%\\Documents\\old folder\\" rd /s /q "%USERPROFILE%\\Documents\\old folder\\"';
    const powershell =
      'Remove-Item -LiteralPath "$env:USERPROFILE\\Documents\\old folder" -Recurse -Force';

    expect(buildShellCommand(cmd, state, "win32")).toBe(cmd);
    expect(buildShellCommand(powershell, state, "win32")).toBe(powershell);
  });

  it("does not define delete, PowerShell, or Python interception functions on macOS", async () => {
    const stellaDataDir = await createTempDir();
    const command =
      'rm old.txt; powershell -Command "Remove-Item old.txt"; python cleanup.py';
    const built = buildShellCommand(
      command,
      createShellState(stellaDataDir),
      "darwin",
    );

    expect(built).not.toContain("__stella_dd");
    expect(built).not.toMatch(
      /(?:rm|rmdir|unlink|powershell|pwsh|python)\(\)/u,
    );
    expect(built.endsWith(`\n${command}`)).toBe(true);
  });
});
