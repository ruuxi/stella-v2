import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectSourcePackageExportErrors } from "../verify-source-package-exports.mjs";
import { collectLocalNamedImportErrors } from "../verify-local-named-imports.mjs";
import { findUndeclaredIdentifiers } from "../verify-source-identifiers.mjs";
import {
  assertMainBundleStartupBoundary,
  mainStartupDeferredExternals,
  mainStartupDeferredInputs,
} from "../dev-electron-build.mjs";

test("identifier gate catches app names while accepting legitimate cross-runtime globals", () => {
  const failures = findUndeclaredIdentifiers({
    filePath: "/fixture/application.js",
    code: `
      if (typeof window !== "undefined") window.location.href;
      if (typeof Deno !== "undefined") Deno.version;
      if (typeof Bun !== "undefined") Bun.version;
      if (typeof define !== "undefined") define(() => ({}));
      if (typeof EdgeRuntime !== "undefined") String(EdgeRuntime);
      safeLaunchError(error);
    `,
  });

  assert.equal(failures.length, 2);
  assert.match(failures[0].message, /safeLaunchError/);
  assert.match(failures[1].message, /error/);
});

test("source export gate detects a converted JS file routed to a stale TS target", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "stella-export-gate-"));
  mkdirSync(path.join(tempDir, "lib"));
  writeFileSync(path.join(tempDir, "lib", "converted.js"), "export {};");
  writeFileSync(
    path.join(tempDir, "package.json"),
    JSON.stringify({
      exports: {
        "./lib/*.js": "./lib/*.ts",
        "./lib/*": "./lib/*.ts",
      },
    }),
  );

  const failures = collectSourcePackageExportErrors({
    packageDir: tempDir,
    sourceRoot: path.join(tempDir, "lib"),
    requireExtensionless: true,
  });

  assert.equal(failures.length, 2);
  assert.match(failures[0], /converted\.js/);
  assert.match(failures[1], /converted/);
});

test("local named-import gate validates JS and TS-backed relative modules", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "stella-import-gate-"));
  const jsTarget = path.join(tempDir, "converted.js");
  const tsTarget = path.join(tempDir, "typed.ts");
  const importer = path.join(tempDir, "importer.ts");
  writeFileSync(jsTarget, "export const available = true;\n");
  writeFileSync(tsTarget, "export type TypedValue = string;\n");
  writeFileSync(
    importer,
    [
      'import { available, missing } from "./converted.js";',
      'import type { TypedValue } from "./typed.js";',
    ].join("\n"),
  );

  const failures = collectLocalNamedImportErrors({ sourceFiles: [importer] });

  assert.equal(failures.length, 1);
  assert.equal(failures[0].importedName, "missing");
  assert.equal(failures[0].targetPath, jsTarget);
});

test("local named-import gate rejects value imports of type-only exports", () => {
  const tempDir = mkdtempSync(
    path.join(os.tmpdir(), "stella-type-import-gate-"),
  );
  const target = path.join(tempDir, "types.ts");
  const importer = path.join(tempDir, "importer.ts");
  writeFileSync(
    target,
    [
      "export interface InterfaceOnly { value: string }",
      "type Alias = string;",
      "export type { Alias };",
    ].join("\n"),
  );
  writeFileSync(
    importer,
    'import { InterfaceOnly, Alias } from "./types.js";\n',
  );

  const failures = collectLocalNamedImportErrors({ sourceFiles: [importer] });

  assert.deepEqual(
    failures.map((failure) => failure.importedName),
    ["InterfaceOnly", "Alias"],
  );
});

const mainStartupMetafile = ({
  mainImports = [],
  launchInputs = ["packages/desktop/electron/launch.ts"],
  bootstrapImports = [],
} = {}) => ({
  inputs: {
    "packages/desktop/electron/main.ts": {
      imports: [
        {
          path: "packages/desktop/electron/bootstrap.ts",
          kind: "dynamic-import",
        },
      ],
    },
    "packages/desktop/electron/bootstrap.ts": { imports: bootstrapImports },
    "packages/desktop/electron/ipc/system-handlers.js": {
      imports: [
        {
          path: mainStartupDeferredInputs[0],
          kind: "dynamic-import",
        },
      ],
    },
  },
  outputs: {
    "packages/desktop/dist-electron/electron/launch.js": {
      imports: [],
      inputs: Object.fromEntries(
        launchInputs.map((input) => [input, { bytesInOutput: 1 }]),
      ),
    },
    "packages/desktop/dist-electron/electron/main.js": {
      imports: mainImports,
      inputs: { "packages/desktop/electron/main.ts": { bytesInOutput: 1 } },
    },
  },
});

test("main cold-start gate accepts deferred externals loaded on first use", () => {
  assert.doesNotThrow(() =>
    assertMainBundleStartupBoundary(
      mainStartupMetafile({
        mainImports: [
          { path: "electron", kind: "import-statement", external: true },
          { path: "node:module", kind: "import-statement", external: true },
        ],
      }),
    ),
  );
});

test("main cold-start gate rejects a static import of a deferred external", () => {
  for (const external of mainStartupDeferredExternals) {
    assert.throws(
      () =>
        assertMainBundleStartupBoundary(
          mainStartupMetafile({
            mainImports: [
              { path: external, kind: "import-statement", external: true },
            ],
          }),
        ),
      new RegExp(`statically imports ${external}`),
    );
  }
});

test("main cold-start gate rejects launch.js inlining the main bundle", () => {
  assert.throws(
    () =>
      assertMainBundleStartupBoundary(
        mainStartupMetafile({
          launchInputs: [
            "packages/desktop/electron/launch.ts",
            "packages/desktop/electron/main.ts",
          ],
        }),
      ),
    /launch\.js inlines packages\/desktop\/electron\/main\.ts/,
  );
});

test("main cold-start gate allows deferred modules behind a dynamic import", () => {
  assert.doesNotThrow(() =>
    assertMainBundleStartupBoundary(
      mainStartupMetafile({
        bootstrapImports: [
          {
            path: "packages/desktop/electron/ipc/system-handlers.js",
            kind: "import-statement",
          },
        ],
      }),
    ),
  );
});

test("main cold-start gate rejects a deferred module in the static startup graph", () => {
  for (const input of mainStartupDeferredInputs) {
    assert.throws(
      () =>
        assertMainBundleStartupBoundary(
          mainStartupMetafile({
            bootstrapImports: [{ path: input, kind: "import-statement" }],
          }),
        ),
      /is statically reachable from startup/,
    );
  }
});
