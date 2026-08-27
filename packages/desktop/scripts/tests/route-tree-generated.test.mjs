import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { checkRouteTree } from "../check-route-tree.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const DESKTOP_UI_ROOT = path.join(REPO_ROOT, "packages", "desktop-ui");
const EXPECTED_PATH = path.join(
  DESKTOP_UI_ROOT,
  "src",
  "routeTree.gen.ts",
);

test("route tree is reproducible without writing the checkout", () => {
  const before = readFileSync(EXPECTED_PATH);
  const result = checkRouteTree();
  const after = readFileSync(EXPECTED_PATH);

  assert.deepEqual(after, before);
  assert.match(result.sha256, /^[a-f0-9]{64}$/u);
  assert.ok(result.routeCount > 0);
});

test("route tree checker rejects a stale tracked target", () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "stella-route-tree-test-"));
  try {
    const staleTarget = path.join(temporaryRoot, "routeTree.gen.ts");
    writeFileSync(staleTarget, "// stale\n");

    assert.throws(
      () => checkRouteTree({ expectedPath: staleTarget }),
      /Generated route tree is stale/u,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
