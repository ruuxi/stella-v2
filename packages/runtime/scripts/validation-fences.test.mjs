import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { checkBoundaries } from "./check-boundary.mjs";
import {
  evaluateEffectRatchet,
  scanEffectRatchetTargets,
} from "./check-effect-ratchet.mjs";

const roots = new Set();

const createRepo = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-fence-test-"));
  roots.add(root);
  return root;
};

const put = async (root, relativePath, source) => {
  const absolutePath = path.join(root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, source, "utf8");
};

const moduleSource = (...specifiers) =>
  specifiers
    .map((specifier) => `import ${JSON.stringify(specifier)};`)
    .join("\n");

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

test("boundary fence owns both Effect-bearing cloud packages", async () => {
  const root = await createRepo();
  await put(
    root,
    "packages/runtime/kernel/index.ts",
    moduleSource("@stella/executor-cloud"),
  );
  await put(
    root,
    "packages/executor-cloud/src/index.ts",
    moduleSource("effect", "@stella/runtime", "@stella/desktop"),
  );
  await put(
    root,
    "workers/cloud-builder/src/index.ts",
    moduleSource("effect", "@stella/executor-cloud", "@stella/desktop-ui"),
  );
  await put(
    root,
    "packages/desktop/electron/main.ts",
    moduleSource("@stella/executor-cloud"),
  );
  await put(
    root,
    "packages/contracts/index.ts",
    moduleSource("@stella/cloud-builder"),
  );
  await put(root, "packages/mobile/src/index.ts", moduleSource("effect"));

  const offenders = await checkBoundaries(root);
  assert.deepEqual(offenders.map(({ file, reason }) => [file, reason]).sort(), [
    [
      "packages/contracts/index.ts",
      "Effect-bearing cloud packages are fenced from contracts",
    ],
    [
      "packages/desktop/electron/main.ts",
      "Effect-bearing cloud packages are fenced from desktop",
    ],
    [
      "packages/executor-cloud/src/index.ts",
      "cloud executor must not depend on desktop packages",
    ],
    ["packages/mobile/src/index.ts", "Effect is fenced from mobile"],
    [
      "packages/runtime/kernel/index.ts",
      "runtime must not depend on cloud execution packages",
    ],
    [
      "workers/cloud-builder/src/index.ts",
      "cloud Worker must not depend on desktop packages",
    ],
  ]);
});

test("Effect-native home service stays behind the runtime package boundary", async () => {
  const runtimePackage = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(runtimePackage.exports["./kernel/home/home-service"], null);
  assert.equal(runtimePackage.exports["./kernel/home/home-service.js"], null);

  const root = await createRepo();
  await put(
    root,
    "packages/desktop/electron/main.ts",
    moduleSource("@stella/runtime/kernel/home/home-service"),
  );
  await put(
    root,
    "packages/contracts/index.ts",
    moduleSource("@stella/runtime/kernel/home/home-service.js"),
  );
  await put(
    root,
    "packages/mobile/src/index.ts",
    moduleSource("../../runtime/kernel/home/home-service.ts"),
  );

  const offenders = await checkBoundaries(root);
  assert.deepEqual(offenders.map(({ file, reason }) => [file, reason]).sort(), [
    [
      "packages/contracts/index.ts",
      "Effect-bearing runtime internals are fenced inside packages/runtime",
    ],
    [
      "packages/desktop/electron/main.ts",
      "Effect-bearing runtime internals are fenced inside packages/runtime",
    ],
    [
      "packages/mobile/src/index.ts",
      "Effect-bearing runtime internals are fenced from mobile",
    ],
  ]);
});

test("ratchet scans runtime, executor, and cloud Worker shipped source", async () => {
  const root = await createRepo();
  await put(
    root,
    "packages/runtime/kernel/run.ts",
    "setTimeout(() => undefined, 1);\n",
  );
  await put(
    root,
    "packages/executor-cloud/src/run.ts",
    "const controller = new AbortController();\n",
  );
  await put(
    root,
    "workers/cloud-builder/src/run.ts",
    "setInterval(() => undefined, 1);\nsetTimeout(() => undefined, 1);\n",
  );
  await put(
    root,
    "workers/cloud-builder/tests/ignored.mjs",
    "setTimeout(() => undefined, 1);\n",
  );
  await put(
    root,
    "workers/cloud-builder/scripts/ignored.mjs",
    "setTimeout(() => undefined, 1);\n",
  );

  const hits = await scanEffectRatchetTargets(root);
  assert.deepEqual(
    [...hits.entries()].map(([file, entry]) => [file, entry.total]).sort(),
    [
      ["kernel/run.ts", 1],
      ["packages/executor-cloud/src/run.ts", 1],
      ["workers/cloud-builder/src/run.ts", 2],
    ],
  );
});

test("cloud pattern pins reject debt substitution at a flat file total", () => {
  const hits = new Map([
    [
      "workers/cloud-builder/src/run.ts",
      {
        total: 1,
        byPattern: new Map([["new AbortController", 1]]),
        lines: [],
      },
    ],
  ]);
  const { offenders, shrinkage } = evaluateEffectRatchet(hits, {
    "workers/cloud-builder/src/run.ts": { "setTimeout(": 1 },
  });

  assert.deepEqual(offenders[0].patternOverages, [
    { label: "new AbortController", actual: 1, allowed: 0 },
  ]);
  assert.deepEqual(shrinkage, [
    {
      file: "workers/cloud-builder/src/run.ts",
      label: "setTimeout(",
      allowed: 1,
      actual: 0,
    },
  ]);
});
