import path from "node:path";
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { readImageFileSettled } from "@stella/runtime/kernel/shared/read-image-file";
import { createSyncTempDirTracker } from "../../../helpers/temp.js";

const tempDirs = createSyncTempDirTracker();
afterEach(() => tempDirs.cleanup());

const COMPLETE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
  "base64",
);

const TRUNCATED_PNG = COMPLETE_PNG.subarray(0, COMPLETE_PNG.length - 16);

describe("readImageFileSettled", () => {
  it("returns a fully written image on the first read with no waiting", async () => {
    const dir = tempDirs.create("settle-complete-");
    const imgPath = path.join(dir, "snap.png");
    writeFileSync(imgPath, COMPLETE_PNG);

    let sleeps = 0;
    const buf = await readImageFileSettled(imgPath, {
      sleep: async () => {
        sleeps += 1;
      },
    });

    expect(buf.equals(COMPLETE_PNG)).toBe(true);
    expect(sleeps).toBe(0);
  });

  it("re-reads until a screenshot still flushing to disk becomes complete", async () => {
    const dir = tempDirs.create("settle-race-");
    const imgPath = path.join(dir, "snap.png");

    writeFileSync(imgPath, TRUNCATED_PNG);

    let sleeps = 0;
    const buf = await readImageFileSettled(imgPath, {

      sleep: async () => {
        sleeps += 1;
        writeFileSync(imgPath, COMPLETE_PNG);
      },
    });

    expect(buf.equals(COMPLETE_PNG)).toBe(true);
    expect(sleeps).toBe(1);
  });

  it("stops early (does not spin the budget) when the file is truncated on disk", async () => {
    const dir = tempDirs.create("settle-corrupt-");
    const imgPath = path.join(dir, "snap.png");
    writeFileSync(imgPath, TRUNCATED_PNG);

    let sleeps = 0;
    const buf = await readImageFileSettled(imgPath, {
      maxAttempts: 6,

      sleep: async () => {
        sleeps += 1;
      },
    });

    expect(buf.equals(TRUNCATED_PNG)).toBe(true);
    expect(sleeps).toBe(1);
  });
});
