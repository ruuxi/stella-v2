import assert from "node:assert/strict";
import test from "node:test";
import { signingPolicy } from "../sign-windows.mjs";

test("preserves the pinned upstream OfficeCLI executable at its exact packaged path", () => {
  for (const candidate of [
    "D:\\release\\win-unpacked\\resources\\stella-office\\bin\\stella-office-win32-x64.exe",
    "packages/desktop/release/win-unpacked/resources/stella-office/bin/stella-office-win32-x64.exe",
    "D:\\release\\RESOURCES\\STELLA-OFFICE\\BIN\\STELLA-OFFICE-WIN32-X64.EXE",
  ]) {
    assert.equal(signingPolicy(candidate), null);
  }
});

test("rejects unapproved Office executables and copies outside the packaged Office directory", () => {
  for (const candidate of [
    "D:/release/resources/stella-office/bin/other.exe",
    "D:/release/resources/stella-office/bin/stella-office-win32-arm64.exe",
    "D:/release/resources/stella-office/bin/nested/stella-office-win32-x64.exe",
    "D:/release/resources/stella-office/stella-office-win32-x64.exe",
    "D:/release/resources/other/bin/stella-office-win32-x64.exe",
    "D:/release/stella-office-win32-x64.exe",
  ]) {
    assert.throws(() => signingPolicy(candidate), /Unexpected Windows signing candidate/);
  }
});

test("keeps Stella-managed signing and other upstream preservation policies intact", () => {
  assert.equal(signingPolicy("D:/release/Stella.exe"), "application-executable");
  assert.equal(signingPolicy("D:/release/resources/bin/bun.exe"), "managed-cli-runtime");
  assert.equal(signingPolicy("D:/release/resources/stella-browser/out/win-x64/stella-browser.exe"), "stella-browser-helper");
  for (const candidate of [
    "D:/release/resources/runtimes/node/node.exe",
    "D:/release/resources/runtimes/python/python.exe",
    "D:/release/resources/runtimes/git/bin/git.exe",
  ]) {
    assert.equal(signingPolicy(candidate), null);
  }
});
