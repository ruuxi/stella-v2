import { describe, expect, test } from "bun:test";
import {
  APP_BUILD_ROOT,
  WORLD_ROOT,
  WORLD_STELLA_ROOT,
  checkpointBackupName,
  checkpointKey,
  instanceSizeKey,
} from "../src/workspace.js";

describe("world checkpoint identity", () => {
  test("gives one owner exactly one checkpoint key", async () => {
    const first = await checkpointKey("owner-a");
    expect(first).toBe(await checkpointKey("owner-a"));
    expect(first).toMatch(/^ws:[0-9a-f]{64}$/u);
    expect(first).not.toBe(await checkpointKey("owner-b"));
  });

  test("derives the size and backup names from that one key", async () => {
    const key = await checkpointKey("owner-a");
    expect(instanceSizeKey(key)).toBe(`${key}:size`);
    expect(checkpointBackupName(key)).toBe(`stella-${key.slice(3, 27)}`);
  });

  test("keeps the interior source inside the world and app builds outside it", () => {
    expect(WORLD_ROOT).toBe("/workspace/world");
    expect(WORLD_STELLA_ROOT.startsWith(`${WORLD_ROOT}/`)).toBe(true);
    expect(APP_BUILD_ROOT.startsWith(`${WORLD_ROOT}/`)).toBe(false);
  });
});
