import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { collectSourcePackageExportErrors } from "../verify-source-package-exports.mjs";
import { collectLocalNamedImportErrors } from "../verify-local-named-imports.mjs";
import {
  collectExistingPackagedApplicationFiles,
  findUndeclaredIdentifiers,
} from "../verify-packaged-identifiers.mjs";
import { collectRootAbsoluteRendererAssetReferences } from "../verify-renderer-asset-paths.mjs";
import {
  copyPackagedRuntimeAssets,
  packagedOAuthProviderCatalogRelativePath,
  packagedRuntimeAssetCopies,
  smokeTestNodeCliEntry,
  verifyPackagedOAuthProviderCatalog,
} from "../dev-electron-build.mjs";

test("renderer asset gate catches file-root paths without rejecting relative or remote assets", () => {
  const tempDir = mkdtempSync(
    path.join(os.tmpdir(), "stella-renderer-assets-"),
  );
  mkdirSync(path.join(tempDir, "assets"), { recursive: true });
  writeFileSync(
    path.join(tempDir, "assets", "app.js"),
    [
      'const broken = "/pets/stella.webp";',
      'const packaged = "./pets/stella.webp";',
      'const remote = "https://example.com/pet.webp";',
      'const endpoint = "/api/media/v1/generate";',
    ].join("\n"),
  );
  writeFileSync(
    path.join(tempDir, "assets", "app.css"),
    ".broken { background: url(/images/background.png); }",
  );

  const failures = collectRootAbsoluteRendererAssetReferences({
    distDir: tempDir,
  });

  assert.deepEqual(failures.map(({ reference }) => reference).sort(), [
    "/images/background.png",
    "/pets/stella.webp",
  ]);
});

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

test("packaged output selector excludes vendor-only worker chunks", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "stella-output-select-"));
  const mainDir = path.join(
    tempDir,
    "packages",
    "desktop",
    "dist-electron",
    "electron",
  );
  const workerDir = path.join(
    tempDir,
    "packages",
    "desktop",
    "dist-electron",
    "runtime",
    "worker",
  );
  mkdirSync(mainDir, { recursive: true });
  mkdirSync(workerDir, { recursive: true });
  const mainPath = path.join(mainDir, "main.js");
  const applicationPath = path.join(workerDir, "application.js");
  const vendorPath = path.join(workerDir, "vendor.js");
  writeFileSync(mainPath, "export {};\n");
  writeFileSync(
    applicationPath,
    "// packages/runtime/worker/server.ts\nexport {};\n",
  );
  writeFileSync(vendorPath, "// node_modules/vendor/index.js\nexport {};\n");

  const selected = collectExistingPackagedApplicationFiles(tempDir);

  assert.deepEqual(selected, [mainPath, applicationPath]);
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

test("source plus packaged CLI mode catches an emitted-only identifier failure", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "stella-output-gate-"));
  mkdirSync(path.join(tempDir, "packages", "runtime"), { recursive: true });
  mkdirSync(path.join(tempDir, "packages", "desktop", "electron"), {
    recursive: true,
  });
  mkdirSync(
    path.join(tempDir, "packages", "desktop", "dist-electron", "electron"),
    { recursive: true },
  );
  mkdirSync(
    path.join(
      tempDir,
      "packages",
      "desktop",
      "dist-electron",
      "runtime",
      "worker",
    ),
    { recursive: true },
  );
  writeFileSync(
    path.join(tempDir, "packages", "runtime", "valid.js"),
    "export const valid = true;\n",
  );
  writeFileSync(
    path.join(
      tempDir,
      "packages",
      "desktop",
      "dist-electron",
      "electron",
      "main.js",
    ),
    "emittedOnlyMissingIdentifier();\n",
  );

  const verifierPath = fileURLToPath(
    new URL("../verify-packaged-identifiers.mjs", import.meta.url),
  );
  const result = spawnSync(
    process.execPath,
    [verifierPath, "--source", "--packaged", "--root", tempDir],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /emittedOnlyMissingIdentifier/);
  assert.doesNotMatch(result.stderr, /Converted Stella application source/);
});

test("Node CLI smoke gate rejects duplicate bundle-banner bindings", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "stella-cli-smoke-"));
  const validCli = path.join(tempDir, "valid.mjs");
  const invalidCli = path.join(tempDir, "invalid.mjs");
  writeFileSync(validCli, 'console.log("stella-computer - control");\n');
  writeFileSync(
    invalidCli,
    "const __dirname = '/banner';\nvar __dirname = import.meta.dirname;\n",
  );

  assert.match(smokeTestNodeCliEntry(validCli), /stella-computer - control/);
  assert.throws(
    () => smokeTestNodeCliEntry(invalidCli),
    /Node CLI smoke test failed[\s\S]*__dirname/,
  );
});

test("packaged runtime asset contract copies and validates the OAuth catalog", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "stella-runtime-assets-"));
  const sourceRoot = path.join(tempDir, "source");
  const outputRoot = path.join(tempDir, "output");
  const catalogCopy = packagedRuntimeAssetCopies.find(
    ({ to }) => to === packagedOAuthProviderCatalogRelativePath,
  );

  assert.deepEqual(catalogCopy, {
    from: "packages/runtime/kernel/connectors/oauth-provider-catalog.json",
    to: "runtime/kernel/connectors/oauth-provider-catalog.json",
  });

  for (const { from } of packagedRuntimeAssetCopies) {
    const sourcePath = path.join(sourceRoot, from);
    if (from.endsWith(".json")) {
      mkdirSync(path.dirname(sourcePath), { recursive: true });
      writeFileSync(sourcePath, JSON.stringify([{ id: "gmail", tools: [] }]));
    } else {
      mkdirSync(sourcePath, { recursive: true });
      writeFileSync(path.join(sourcePath, "README.md"), "metadata");
    }
  }

  await copyPackagedRuntimeAssets({ sourceRoot, outputRoot });
  const verified = await verifyPackagedOAuthProviderCatalog({ outputRoot });

  assert.equal(verified.providerCount, 1);
  assert.deepEqual(
    JSON.parse(
      readFileSync(
        path.join(outputRoot, packagedOAuthProviderCatalogRelativePath),
        "utf8",
      ),
    ),
    [{ id: "gmail", tools: [] }],
  );
});

test("electron-builder ships the assembled runtime tree beside app.asar", () => {
  const rootPackage = JSON.parse(
    readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"),
  );

  assert.ok(
    rootPackage.build.extraResources.some(
      (entry) =>
        entry.from === "packages/desktop/dist-electron/runtime" &&
        entry.to === "runtime" &&
        entry.filter?.includes("**/*"),
    ),
  );
});

test("packaged runtime verification fails clearly when the OAuth catalog is missing", async () => {
  const outputRoot = mkdtempSync(
    path.join(os.tmpdir(), "stella-runtime-assets-missing-"),
  );

  await assert.rejects(
    verifyPackagedOAuthProviderCatalog({ outputRoot }),
    /Required packaged OAuth provider catalog is missing.*runtime[\\/]kernel[\\/]connectors[\\/]oauth-provider-catalog\.json/,
  );
});
