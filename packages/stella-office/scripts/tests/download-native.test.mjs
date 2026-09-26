import assert from "node:assert/strict";
import test from "node:test";
import {
  getBinaryTargetName,
  getOfficeCliAssetName,
  normalizeOfficePlatform,
} from "../shared.js";

test("OfficeCLI platform aliases map onto GitHub release asset names", () => {
  assert.equal(normalizeOfficePlatform("win-x64").key, "win32-x64");
  assert.equal(getOfficeCliAssetName("darwin-arm64"), "officecli-mac-arm64");
  assert.equal(getOfficeCliAssetName("linux-x64"), "officecli-linux-x64");
  assert.equal(getOfficeCliAssetName("win-x64"), "officecli-win-x64.exe");
  assert.equal(
    getBinaryTargetName("darwin-arm64"),
    "stella-office-darwin-arm64",
  );
  assert.equal(getBinaryTargetName("linux-x64"), "stella-office-linux-x64");
  assert.equal(getBinaryTargetName("win-x64"), "stella-office-win32-x64.exe");
});
