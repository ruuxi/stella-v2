import { describe, expect, test } from "bun:test";
import { checkpointKey } from "../src/workspace.js";

describe("world checkpoint identity", () => {
  test("gives one owner exactly one checkpoint key", async () => {
    const first = await checkpointKey("owner-a");
    expect(first).toBe(await checkpointKey("owner-a"));
    expect(first).toMatch(/^ws:[0-9a-f]{64}$/u);
    expect(first).not.toBe(await checkpointKey("owner-b"));
  });
});
