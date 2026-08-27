import { describe, expect, it } from "vitest";
import {
  driveFinalUploadObjectKey,
  driveUploadObjectKey,
  normalizeDriveFileReport,
} from "../cloud_drive";

describe("cloud drive object and report invariants", () => {
  it("never installs bytes at the client-writable staging key", async () => {
    const ownerId = "user:drive-owner";
    const uploadId = "upload-123";
    const path = "reports/annual.txt";
    const staging = await driveUploadObjectKey(ownerId, uploadId, path);
    const first = await driveFinalUploadObjectKey(
      ownerId,
      uploadId,
      "finalize-1",
      path,
    );
    const retry = await driveFinalUploadObjectKey(
      ownerId,
      uploadId,
      "finalize-2",
      path,
    );

    expect(first).not.toBe(staging);
    expect(retry).not.toBe(staging);
    expect(retry).not.toBe(first);
    expect(first).toMatch(
      /\/files\/upload-123\/finalize-1\/reports\/annual\.txt$/,
    );
  });

  it("rejects duplicate normalized paths before quota or object writes", () => {
    expect(() =>
      normalizeDriveFileReport([
        { path: "reports\\annual.txt", contentBase64: "YQ==" },
        { path: "reports/annual.txt", contentBase64: "Yg==" },
      ]),
    ).toThrow(/appears more than once/);
  });
});
