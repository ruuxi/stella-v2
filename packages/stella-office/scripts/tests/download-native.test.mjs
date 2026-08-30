import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
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

test("native OfficeCLI binaries are gitignored and extraResources still copies bin/", () => {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../..",
  );
  const gitignore = readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
  assert.match(gitignore, /stella-office-darwin-\*/u);
  assert.match(gitignore, /stella-office-linux-\*/u);
  assert.match(gitignore, /stella-office-win32-\*/u);

  const rootPackage = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  const officeResource = rootPackage.build.extraResources.find(
    (entry) => entry.from === "packages/stella-office",
  );
  assert.ok(officeResource);
  assert.deepEqual(officeResource.filter, [
    "package.json",
    "bin/**",
    "scripts/**",
  ]);
  assert.equal(
    rootPackage.scripts["stella-office:download"],
    "node packages/stella-office/scripts/download-native.js",
  );
});
