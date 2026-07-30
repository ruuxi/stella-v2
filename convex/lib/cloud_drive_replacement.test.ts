import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  priorDriveObjectKeyForCleanup,
  shouldDeleteReplacedDriveObjectKey,
} from "./cloud_drive_replacement";

describe("Drive object replacement cleanup", () => {
  test("returns an immutable pre-link key only when a committed row moves", () => {
    assert.equal(
      priorDriveObjectKeyForCleanup({
        priorR2Key: "drive/anonymous/report.pdf",
        priorSource: "upload",
        nextR2Key: "drive/connected/report.pdf",
      }),
      "drive/anonymous/report.pdf",
    );
  });

  test("does not delete an in-place overwrite", () => {
    assert.equal(
      priorDriveObjectKeyForCleanup({
        priorR2Key: "drive/connected/report.pdf",
        priorSource: "upload",
        nextR2Key: "drive/connected/report.pdf",
      }),
      null,
    );
  });

  test("does not invent cleanup for metadata-only workspace rows", () => {
    assert.equal(
      priorDriveObjectKeyForCleanup({
        priorR2Key: "drive/anonymous/oversized.bin",
        priorSource: "workspace",
        nextR2Key: "drive/connected/oversized.bin",
      }),
      null,
    );
  });

  test("does not delete a replaced key while another Drive row references it", () => {
    assert.equal(shouldDeleteReplacedDriveObjectKey(true), false);
  });

  test("deletes a replaced key only after its final Drive reference is gone", () => {
    assert.equal(shouldDeleteReplacedDriveObjectKey(false), true);
  });
});
