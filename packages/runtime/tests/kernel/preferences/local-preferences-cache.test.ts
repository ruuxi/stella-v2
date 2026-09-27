import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getModelOverride,
  loadLocalPreferences,
  saveLocalPreferences,
} from "@stella/runtime/kernel/preferences/local-preferences";
import { createSyncTempDirTracker } from "../../helpers/temp.js";

const tempDirs = createSyncTempDirTracker();
afterEach(() => tempDirs.cleanup());

const prefsFile = (dir: string) => path.join(dir, "preferences.json");

/** Write the file in place, the way Electron main's `saveLocalPreferences` does. */
const writeInPlace = (dir: string, model: string) => {
  fs.writeFileSync(
    prefsFile(dir),
    JSON.stringify({ modelOverrides: { orchestrator: model } }),
  );
};

const setMtime = (dir: string, mtimeMs: number) => {
  const seconds = mtimeMs / 1000;
  fs.utimesSync(prefsFile(dir), seconds, seconds);
};

describe("local preferences cache", () => {
  it("applies a preference saved by another process before the next turn", () => {
    const dir = tempDirs.create("stella-prefs-cache-");
    const tick = Date.now();
    writeInPlace(dir, "anthropic/one");
    setMtime(dir, tick);
    expect(getModelOverride(dir, "orchestrator")).toBe("anthropic/one");

    // Another process (Electron main) rewrites the file between two turns:
    // same byte length, same inode, and — worst case for a coarse-clock
    // filesystem — the exact same mtime.
    const before = fs.statSync(prefsFile(dir));
    writeInPlace(dir, "anthropic/two");
    setMtime(dir, tick);
    const after = fs.statSync(prefsFile(dir));
    expect(after.size).toBe(before.size);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);

    expect(getModelOverride(dir, "orchestrator")).toBe("anthropic/two");
  });

  it("serves a settled file from cache and re-reads when size, mtime or inode changes", () => {
    const dir = tempDirs.create("stella-prefs-cache-");
    writeInPlace(dir, "anthropic/one");
    // A file last written well before it was read is trusted.
    const settled = Date.now() - 60_000;
    setMtime(dir, settled);

    const first = loadLocalPreferences(dir);
    expect(loadLocalPreferences(dir)).toBe(first);

    // Size change, mtime restored.
    writeInPlace(dir, "anthropic/three-longer");
    setMtime(dir, settled);
    expect(loadLocalPreferences(dir).modelOverrides.orchestrator).toBe(
      "anthropic/three-longer",
    );

    // Same size, older mtime restored but a different mtime than cached.
    writeInPlace(dir, "anthropic/four-longerr");
    setMtime(dir, settled - 1_000);
    expect(loadLocalPreferences(dir).modelOverrides.orchestrator).toBe(
      "anthropic/four-longerr",
    );

    // Replace by rename: new inode, identical size and mtime.
    const replacement = path.join(dir, "preferences.next.json");
    fs.writeFileSync(
      replacement,
      JSON.stringify({ modelOverrides: { orchestrator: "anthropic/five-longerr" } }),
    );
    const seconds = (settled - 1_000) / 1000;
    fs.utimesSync(replacement, seconds, seconds);
    fs.renameSync(replacement, prefsFile(dir));
    expect(loadLocalPreferences(dir).modelOverrides.orchestrator).toBe(
      "anthropic/five-longerr",
    );
  });

  it("keys the cache on the file path, not just its stat", () => {
    const a = tempDirs.create("stella-prefs-cache-a-");
    const b = tempDirs.create("stella-prefs-cache-b-");
    writeInPlace(a, "anthropic/aaa");
    writeInPlace(b, "anthropic/bbb");
    const settled = Date.now() - 60_000;
    setMtime(a, settled);
    setMtime(b, settled);

    expect(getModelOverride(a, "orchestrator")).toBe("anthropic/aaa");
    expect(getModelOverride(b, "orchestrator")).toBe("anthropic/bbb");
    expect(getModelOverride(a, "orchestrator")).toBe("anthropic/aaa");
  });

  it("reflects this process's own save immediately", () => {
    const dir = tempDirs.create("stella-prefs-cache-");
    writeInPlace(dir, "anthropic/one");
    const prefs = loadLocalPreferences(dir);
    saveLocalPreferences(dir, {
      ...prefs,
      modelOverrides: { orchestrator: "anthropic/saved" },
    });
    expect(getModelOverride(dir, "orchestrator")).toBe("anthropic/saved");

    // And a same-size external rewrite right after that save still wins.
    const tick = Date.now();
    setMtime(dir, tick);
    const raw = fs.readFileSync(prefsFile(dir), "utf-8");
    fs.writeFileSync(
      prefsFile(dir),
      raw.replace("anthropic/saved", "anthropic/other"),
    );
    setMtime(dir, tick);
    expect(getModelOverride(dir, "orchestrator")).toBe("anthropic/other");
  });
});
