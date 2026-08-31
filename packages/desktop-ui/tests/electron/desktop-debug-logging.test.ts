import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BlobReader,
  TextWriter,
  ZipReader,
} from "../../../desktop/node_modules/@zip.js/zip.js/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getName: () => "Stella",
    getPath: () => tmpdir(),
    getVersion: () => "0.0.0-test",
    setPath: vi.fn(),
  },
  crashReporter: { start: vi.fn() },
  netLog: {
    currentlyLogging: false,
    startLogging: vi.fn(),
    stopLogging: vi.fn(),
  },
  shell: { showItemInFolder: vi.fn() },
}));

vi.mock("electron-log/main.js", () => ({
  default: {
    initialize: vi.fn(),
    scope: () => ({ info: vi.fn(), warn: vi.fn() }),
    transports: {
      console: { level: "info", writeFn: vi.fn() },
      file: { maxSize: 0, resolvePathFn: vi.fn() },
    },
  },
}));

import {
  collectDebugRoot,
  selectDebugExportEntries,
  writeDebugZip,
} from "@stella/desktop/electron/observability/desktop-debug-logging.js";

const temporaryDirectories: string[] = [];

const makeTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), "stella-debug-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("desktop debug export", () => {
  it("collects recent regular files and rejects stale, heap, and symlink entries", async () => {
    const root = await makeTemporaryDirectory();
    const nested = path.join(root, "run");
    await mkdir(nested);
    const current = path.join(nested, "main.log");
    await writeFile(current, "current log");

    const stale = path.join(root, "stale.log");
    await writeFile(stale, "stale log");
    const old = new Date(Date.now() - 48 * 60 * 60 * 1_000);
    await utimes(stale, old, old);

    await writeFile(path.join(root, "memory.heapsnapshot"), "heap");
    await symlink(current, path.join(root, "linked.log"));

    const entries = await collectDebugRoot(
      root,
      "logs",
      Date.now() - 24 * 60 * 60 * 1_000,
    );

    expect(entries.map((entry) => entry.name)).toEqual(["logs/run/main.log"]);
  });

  it("orders newest evidence first and writes a readable zip manifest", async () => {
    const root = await makeTemporaryDirectory();
    const olderPath = path.join(root, "older.log");
    const newerPath = path.join(root, "newer.log");
    await writeFile(olderPath, "older");
    await writeFile(newerPath, "newer");

    const entries = selectDebugExportEntries([
      { name: "logs/older.log", filePath: olderPath, size: 5, mtimeMs: 1 },
      { name: "logs/newer.log", filePath: newerPath, size: 5, mtimeMs: 2 },
    ]);
    expect(entries.map((entry) => entry.name)).toEqual([
      "logs/newer.log",
      "logs/older.log",
    ]);

    const output = path.join(root, "debug.zip");
    await writeDebugZip(output, { version: "test" }, entries);
    const bytes = await readFile(output);
    const reader = new ZipReader(
      new BlobReader(new Blob([new Uint8Array(bytes)])),
    );
    const zipEntries = await reader.getEntries();
    expect(zipEntries.map((entry) => entry.filename)).toEqual([
      "manifest.json",
      "logs/newer.log",
      "logs/older.log",
    ]);
    const manifestEntry = zipEntries.find(
      (entry) => entry.filename === "manifest.json",
    );
    expect(manifestEntry).toBeDefined();
    const manifest = await manifestEntry!.getData!(new TextWriter());
    expect(JSON.parse(manifest)).toEqual({ version: "test" });
    await reader.close();
  });
});
