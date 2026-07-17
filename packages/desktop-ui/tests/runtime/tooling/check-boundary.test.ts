import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs tool script, not part of the tsc project
import { checkBoundaries } from "../../../../runtime/scripts/check-boundary.mjs";

type Offender = { file: string; specifier: string; reason: string };

// Assembled at runtime so the scanner (which reads raw source text) never
// sees a literal effect-import sequence in THIS file — the fence scans
// desktop-ui tests too, this one included.
const EFFECT = ["eff", "ect"].join("");

/**
 * Fixture proof for THE FENCE: an `effect` import in every banned location
 * must be flagged, and the intentional allowances (Effect inside
 * packages/runtime outside tools/prompts; desktop-ui tests importing
 * @stella/runtime/worker/* internals) must not be.
 */
describe("check-boundary fence rules", () => {
  let root: string;

  const write = (relativePath: string, content: string) => {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf8");
  };

  const offendersFor = async (): Promise<Offender[]> =>
    (await checkBoundaries(root)) as Offender[];

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "stella-boundary-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("passes a clean tree with the allowed imports in place", async () => {
    // Effect inside runtime (outside tools/prompts) is the whole point.
    write(
      "packages/runtime/worker/server/index.ts",
      `import { Effect, Layer } from "${EFFECT}";\nexport const ok = Effect.void;\n`,
    );
    write(
      "packages/runtime/kernel/agent-runtime/loop.ts",
      `import { Effect } from "${EFFECT}/Effect";\n`,
    );
    // Renderer src on the contracts seam.
    write(
      "packages/desktop-ui/src/main.tsx",
      'import { METHOD_NAMES } from "@stella/contracts/protocol";\n',
    );
    // Tests may exercise runtime worker internals.
    write(
      "packages/desktop-ui/tests/runtime/worker/server/rpc.test.ts",
      'import { WorkerPeerBroker } from "@stella/runtime/worker/peer-broker";\n',
    );
    // Desktop scripts using ordinary tooling.
    write(
      "packages/desktop/scripts/build.mjs",
      'import { build } from "esbuild";\n',
    );
    await expect(offendersFor()).resolves.toEqual([]);
  });

  it("flags an effect import in every banned location", async () => {
    const banned: Array<[string, string]> = [
      ["packages/desktop-ui/src/App.tsx", `import { Effect } from "${EFFECT}";\n`],
      [
        "packages/desktop-ui/tests/runtime/some.test.ts",
        `import { Layer } from "${EFFECT}";\n`,
      ],
      [
        "packages/desktop-ui/vite/plugin.ts",
        `import { pipe } from "${EFFECT}/Function";\n`,
      ],
      [
        "packages/desktop-ui/vitest.config.ts",
        `import { Duration } from "${EFFECT}";\n`,
      ],
      [
        "packages/desktop/electron/main.ts",
        `import { Effect } from "${EFFECT}";\n`,
      ],
      [
        "packages/desktop/scripts/tool.mjs",
        `const { Effect } = await import("${EFFECT}");\n`,
      ],
      ["packages/desktop/vite/config.ts", `import * as E from "${EFFECT}";\n`],
      ["packages/contracts/protocol/index.ts", `import { Schema } from "${EFFECT}";\n`],
      [
        "packages/runtime/kernel/tools/defs/read.ts",
        `import { Effect } from "${EFFECT}";\n`,
      ],
      [
        "packages/runtime/kernel/prompts/system.ts",
        `import { Layer } from "${EFFECT}/Layer";\n`,
      ],
    ];
    for (const [file, content] of banned) {
      write(file, content);
    }
    const offenders = await offendersFor();
    const flagged = new Set(offenders.map((offender) => offender.file));
    for (const [file] of banned) {
      expect(flagged, `expected ${file} to be flagged`).toContain(file);
    }
  });

  it("still enforces the pre-Effect workspace rules where they applied", async () => {
    write(
      "packages/desktop-ui/src/bad-runtime-import.ts",
      'import { thing } from "@stella/runtime/worker/server/index";\n',
    );
    write(
      "packages/desktop/electron/bad-reach-in.ts",
      'import { kernel } from "../../runtime/kernel/runner";\n',
    );
    write(
      "packages/runtime/kernel/bad-desktop-dep.ts",
      'import { app } from "@stella/desktop/electron/main";\n',
    );
    const offenders = await offendersFor();
    expect(offenders.map((offender) => offender.file).sort()).toEqual([
      "packages/desktop-ui/src/bad-runtime-import.ts",
      "packages/desktop/electron/bad-reach-in.ts",
      "packages/runtime/kernel/bad-desktop-dep.ts",
    ]);
  });

  it("fences Effect-bearing runtime host internals while allowing the plain facades", async () => {
    // Assembled at runtime like EFFECT above: the scanner reads THIS file's
    // raw text too, so the banned specifiers must not appear literally.
    const LIFECYCLE_INTERNAL = ["@stella/runtime/host/", "lifecycle/"].join("");
    const STALENESS = ["@stella/runtime/host/", "staleness"].join("");
    const LIFECYCLE_RELATIVE = ["../../runtime/host/", "lifecycle/"].join("");
    // Blocked: modules whose exported signatures carry Effect/Scope types.
    write(
      "packages/desktop-ui/tests/runtime/host/bad-effect-internal.test.ts",
      `import { startOrAttachWorkerEffect } from "${LIFECYCLE_INTERNAL}attach";\n`,
    );
    write(
      "packages/desktop/electron/bad-staleness-import.ts",
      `import { evaluateWorkerStaleness } from "${STALENESS}";\n`,
    );
    write(
      "packages/desktop/scripts/bad-relative-lifecycle.mjs",
      `import { acquireHostLock } from "${LIFECYCLE_RELATIVE}lock.js";\n`,
    );
    write(
      "packages/contracts/bad-lifecycle-type.ts",
      `import type { LifecycleBudgets } from "${LIFECYCLE_INTERNAL}options";\n`,
    );
    // Allowed: the plain-Promise facades and non-Effect host internals.
    write(
      "packages/desktop-ui/tests/runtime/host/good-facade.test.ts",
      'import { startOrAttachWorker } from "@stella/runtime/host/lifecycle";\n' +
        'import { RuntimeWorkerLifecycleController } from "@stella/runtime/host/worker-lifecycle";\n',
    );
    const offenders = await offendersFor();
    expect(offenders.map((offender) => offender.file).sort()).toEqual([
      "packages/contracts/bad-lifecycle-type.ts",
      "packages/desktop-ui/tests/runtime/host/bad-effect-internal.test.ts",
      "packages/desktop/electron/bad-staleness-import.ts",
      "packages/desktop/scripts/bad-relative-lifecycle.mjs",
    ]);
  });

  it("catches dynamic and type-only effect imports", async () => {
    write(
      "packages/desktop-ui/src/lazy.ts",
      `const lazy = await import("${EFFECT}");\n`,
    );
    write(
      "packages/contracts/types.ts",
      `import type { Effect } from "${EFFECT}";\nexport type Leak = Effect.Effect<void>;\n`,
    );
    const offenders = await offendersFor();
    expect(offenders.map((offender) => offender.file).sort()).toEqual([
      "packages/contracts/types.ts",
      "packages/desktop-ui/src/lazy.ts",
    ]);
  });
});
