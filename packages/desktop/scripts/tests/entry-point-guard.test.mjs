import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isEntryPoint } from "../../../../scripts/lib/entry-point.mjs";

/**
 * A script that is both a library and a command decides which it is being
 * used as from `process.argv[1]`. When that decision is wrong in the "I am
 * not the entry" direction, a check exits 0 having verified nothing — a green
 * result that means nothing and is indistinguishable from a real one. One of
 * these was found doing exactly that, so both halves are pinned here: the
 * helper behaves, and nothing goes back to hand-rolling the comparison.
 */

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../../../../..");
const helper = path.join(repoRoot, "scripts/lib/entry-point.mjs");

const temp = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "entry-point-"));
  return { dir, clean: () => rmSync(dir, { recursive: true, force: true }) };
};

test("tells the module that is the entry from one that is not", () => {
  // `node --test` spawns each test file as its own entry, so this file is it.
  assert.equal(isEntryPoint(import.meta.url), true);
  // The helper is imported here, never the entry.
  assert.equal(isEntryPoint(pathToFileURL(helper).href), false);
});

test("answers false rather than throwing on a url it cannot read", () => {
  assert.equal(isEntryPoint("not a url"), false);
  assert.equal(isEntryPoint("https://example.com/x.mjs"), false);
  assert.equal(isEntryPoint(pathToFileURL("/nonexistent/x.mjs").href), false);
});

test("a script run as the entry point recognises itself", (t) => {
  const { dir, clean } = temp();
  t.after(clean);
  const script = path.join(dir, "cmd.mjs");
  writeFileSync(
    script,
    `import { isEntryPoint } from ${JSON.stringify(pathToFileURL(helper).href)};\n` +
      `process.stdout.write(isEntryPoint(import.meta.url) ? "entry" : "library");\n`,
  );
  const run = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(run.stdout, "entry");
});

/**
 * The failure that was live. `/tmp` is a symlink to `/private/tmp` on macOS,
 * as is `/var`, under which every system temp directory lives — so this is
 * the shape of any worktree or scratch checkout, not an exotic case. Node
 * leaves an absolute `argv[1]` exactly as given while `import.meta.url` is
 * always fully resolved, so comparing them directly answers "no".
 */
test("a script run through a symlinked directory still recognises itself", (t) => {
  const { dir, clean } = temp();
  t.after(clean);
  const real = path.join(dir, "real");
  mkdirSync(real);
  const link = path.join(dir, "link");
  symlinkSync(real, link);
  const script = path.join(real, "cmd.mjs");
  writeFileSync(
    script,
    `import { isEntryPoint } from ${JSON.stringify(pathToFileURL(helper).href)};\n` +
      `import path from "node:path";\n` +
      `import { fileURLToPath } from "node:url";\n` +
      `const naive = path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);\n` +
      `process.stdout.write(JSON.stringify({ helper: isEntryPoint(import.meta.url), naive }));\n`,
  );
  const run = spawnSync(process.execPath, [path.join(link, "cmd.mjs")], {
    encoding: "utf8",
  });
  const result = JSON.parse(run.stdout);
  assert.equal(result.helper, true, "the helper must recognise the entry");
  // If this ever becomes true, Node started resolving argv[1] and the bug
  // this guards against would no longer be reachable that way. Worth
  // knowing, but the helper stays either way.
  assert.equal(result.naive, false, "the hand-rolled comparison is why this exists");
});

test("a script imported by another is not the entry point", (t) => {
  const { dir, clean } = temp();
  t.after(clean);
  const lib = path.join(dir, "lib.mjs");
  writeFileSync(
    lib,
    `import { isEntryPoint } from ${JSON.stringify(pathToFileURL(helper).href)};\n` +
      `export const wasEntry = isEntryPoint(import.meta.url);\n`,
  );
  const main = path.join(dir, "main.mjs");
  writeFileSync(
    main,
    `import { wasEntry } from "./lib.mjs";\nprocess.stdout.write(String(wasEntry));\n`,
  );
  const run = spawnSync(process.execPath, [main], { encoding: "utf8" });
  assert.equal(run.stdout, "false");
});

test("no script hand-rolls the entry-point comparison", () => {
  const tracked = spawnSync(
    "git",
    ["ls-files", "-z", "*.mjs", "*.js", "*.ts", "*.mts", "*.cjs"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  assert.equal(tracked.status, 0, tracked.stderr);
  const files = tracked.stdout.split("\0").filter(Boolean);
  assert.ok(files.length > 100, "expected to be scanning the repository");
  const allowed = new Set([
    // The helper itself, and the test that proves the naive form is wrong.
    "scripts/lib/entry-point.mjs",
    "packages/desktop/scripts/tests/entry-point-guard.test.mjs",
    // Not an entry-point guard: it reports the CLI path it was invoked by.
    "packages/runtime/kernel/cli/stella-computer.ts",
    // Not an entry-point guard: the worker stamps the entry the host spawned.
    "packages/runtime/worker/entry.ts",
  ]);
  const offenders = [];
  for (const file of files) {
    if (allowed.has(file)) continue;
    let source;
    try {
      source = readFileSync(path.join(repoRoot, file), "utf8");
    } catch {
      // Tracked but not present (a sparse checkout): nothing to read.
      continue;
    }
    if (!source.includes("argv[1]")) continue;
    if (/import\.meta\.(url|filename)|__filename/.test(source)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `These compare process.argv[1] against their own module path by hand. ` +
      `Use isEntryPoint from scripts/lib/entry-point.mjs instead: the ` +
      `comparison is wrong for an absolute argv[1] under a symlinked ` +
      `directory, and a check whose guard is wrong passes without checking. ` +
      `Offenders: ${offenders.join(", ")}`,
  );
});
