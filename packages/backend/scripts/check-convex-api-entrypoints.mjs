#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY_POINT_EXTENSIONS = [
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".jsx",
];

const RESERVED_MODULE_IDENTIFIERS = new Set([
  "fullApi",
  "api",
  "internal",
  "components",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "let",
  "static",
  "yield",
  "await",
  "enum",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
]);

const backendRoot = path.resolve(import.meta.dirname, "..");
const defaultFunctionsDir = path.join(backendRoot, "convex");
const defaultApiPath = path.join(defaultFunctionsDir, "_generated", "api.d.ts");

const hasModuleSyntax = (filePath) =>
  /^\s{0,100}(?:import|export)/m.test(readFileSync(filePath, "utf8"));

const compareModulePaths = (left, right) =>
  left < right ? -1 : left > right ? 1 : 0;

const extensionForEntryPoint = (relativePath) =>
  ENTRY_POINT_EXTENSIONS.find((extension) => relativePath.endsWith(extension));

// Mirrors Convex's codegen `moduleIdentifier()` transformation. Checking the
// alias as well as the import target prevents a mapping from silently binding a
// module path to some other module's `typeof` import.
const moduleIdentifier = (modulePath) => {
  let identifier = modulePath.replaceAll("/", "_").replaceAll("-", "_");
  if (RESERVED_MODULE_IDENTIFIERS.has(identifier)) identifier += "_";
  return identifier;
};

/**
 * Mirrors Convex 1.45's local `entryPoints()` discovery rules. The generated
 * api.d.ts stores this inventory in imports and an ApiFromModules mapping;
 * function signatures stay live through its `typeof import` references.
 */
export const findConvexEntryPointModules = (functionsDir) => {
  const modules = [];

  const walk = (directory, depth) => {
    if (depth > 0 && existsSync(path.join(directory, "convex.config.ts"))) {
      return;
    }

    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => compareModulePaths(left.name, right.name),
    )) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(functionsDir, absolutePath);
      if (entry.isDirectory()) {
        if (relativePath === "_generated") continue;
        walk(absolutePath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      // Convex rejects files it encounters within `_deps`, but its walker does
      // not reject the directory itself. This distinction matters for an empty
      // `_deps` directory and component directories pruned by convex.config.ts.
      if (relativePath.startsWith(`_deps${path.sep}`)) {
        throw new Error(
          `The path "${absolutePath}" is within the "_deps" directory, which is reserved for dependencies. Please move your code to another directory.`,
        );
      }

      const extension = extensionForEntryPoint(relativePath);
      const base = path.basename(absolutePath);
      if (!extension) continue;
      if (relativePath.startsWith(`_generated${path.sep}`)) continue;
      if (base.startsWith(".") || base.startsWith("#")) continue;
      if (base === "schema.ts" || base === "schema.js") continue;
      if ((base.match(/\./g) ?? []).length > 1) continue;
      if (relativePath.includes(" ")) continue;
      if (
        (extension === ".ts" || extension === ".tsx") &&
        !hasModuleSyntax(absolutePath)
      ) {
        continue;
      }

      modules.push(
        relativePath.slice(0, -extension.length).split(path.sep).join("/"),
      );
    }
  };

  walk(functionsDir, 0);
  return modules.sort(compareModulePaths);
};

const readGeneratedApiSurface = (apiPath) => {
  const source = readFileSync(apiPath, "utf8");
  const imports = [];
  const parseErrors = [];

  for (const [index, sourceLine] of source.split(/\r?\n/u).entries()) {
    const line = sourceLine.trim();
    if (!line.startsWith("import type * as ")) continue;
    const match = line.match(
      /^import type \* as ([A-Za-z_$][A-Za-z0-9_$]*) from "\.\.\/(.+)\.js";$/u,
    );
    if (!match) {
      parseErrors.push(
        `malformed generated module import on line ${index + 1}`,
      );
      continue;
    }
    imports.push({ identifier: match[1], modulePath: match[2] });
  }

  const fullApiPattern =
    /(?:declare\s+)?const\s+fullApi\s*:\s*ApiFromModules\s*<\s*\{([\s\S]*?)\}\s*>\s*(?:=\s*anyApi\s+as\s+any\s*)?;/gu;
  const fullApiMatches = [...source.matchAll(fullApiPattern)];
  const mappings = [];
  if (fullApiMatches.length !== 1) {
    parseErrors.push(
      fullApiMatches.length === 0
        ? "missing fullApi ApiFromModules mapping"
        : `found ${fullApiMatches.length} fullApi ApiFromModules mappings`,
    );
  } else {
    const blockStartLine = source
      .slice(0, fullApiMatches[0].index)
      .split(/\r?\n/u).length;
    for (const [index, sourceLine] of fullApiMatches[0][1]
      .split(/\r?\n/u)
      .entries()) {
      const line = sourceLine.trim();
      if (line.length === 0) continue;
      const match = line.match(
        /^("(?:[^"\\]|\\.)*"|[A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*typeof\s+([A-Za-z_$][A-Za-z0-9_$]*);$/u,
      );
      if (!match) {
        parseErrors.push(
          `malformed fullApi mapping on line ${blockStartLine + index}`,
        );
        continue;
      }
      let modulePath;
      try {
        modulePath = match[1].startsWith('"') ? JSON.parse(match[1]) : match[1];
      } catch {
        parseErrors.push(
          `invalid quoted fullApi key on line ${blockStartLine + index}`,
        );
        continue;
      }
      mappings.push({ identifier: match[2], modulePath });
    }
  }

  return { imports, mappings, parseErrors };
};

export const readGeneratedApiModules = (apiPath) =>
  readGeneratedApiSurface(apiPath).imports.map(({ modulePath }) => modulePath);

const duplicateModulePaths = (entries) =>
  entries
    .map(({ modulePath }) => modulePath)
    .filter((modulePath, index, paths) => paths.indexOf(modulePath) !== index);

const compareSurface = (expected, actual) => {
  const expectedPaths = expected.map(({ modulePath }) => modulePath);
  const actualPaths = actual.map(({ modulePath }) => modulePath);
  const expectedSet = new Set(expectedPaths);
  const actualSet = new Set(actualPaths);
  const missing = expectedPaths.filter(
    (modulePath) => !actualSet.has(modulePath),
  );
  const extra = actualPaths.filter(
    (modulePath) => !expectedSet.has(modulePath),
  );
  const duplicates = duplicateModulePaths(actual);
  const orderMismatch =
    missing.length === 0 &&
    extra.length === 0 &&
    duplicates.length === 0 &&
    expectedPaths.join("\n") !== actualPaths.join("\n");
  const bindingMismatches = actual.flatMap((entry) => {
    const expectedEntry = expected.find(
      ({ modulePath }) => modulePath === entry.modulePath,
    );
    return expectedEntry && expectedEntry.identifier !== entry.identifier
      ? [
          {
            modulePath: entry.modulePath,
            expected: expectedEntry.identifier,
            actual: entry.identifier,
          },
        ]
      : [];
  });
  return {
    missing,
    extra,
    duplicates,
    orderMismatch,
    bindingMismatches,
  };
};

export const checkConvexApiEntryPoints = ({ apiPath, functionsDir }) => {
  const expected = findConvexEntryPointModules(functionsDir).map(
    (modulePath) => ({
      identifier: moduleIdentifier(modulePath),
      modulePath,
    }),
  );
  const { imports, mappings, parseErrors } = readGeneratedApiSurface(apiPath);
  const importComparison = compareSurface(expected, imports);
  const mappingComparison = compareSurface(expected, mappings);
  return {
    ok:
      parseErrors.length === 0 &&
      importComparison.missing.length === 0 &&
      importComparison.extra.length === 0 &&
      importComparison.duplicates.length === 0 &&
      !importComparison.orderMismatch &&
      importComparison.bindingMismatches.length === 0 &&
      mappingComparison.missing.length === 0 &&
      mappingComparison.extra.length === 0 &&
      mappingComparison.duplicates.length === 0 &&
      !mappingComparison.orderMismatch &&
      mappingComparison.bindingMismatches.length === 0,
    expectedCount: expected.length,
    actualCount: imports.length,
    mappingCount: mappings.length,
    missing: importComparison.missing,
    extra: importComparison.extra,
    duplicates: importComparison.duplicates,
    orderMismatch: importComparison.orderMismatch,
    importBindingMismatches: importComparison.bindingMismatches,
    mappingMissing: mappingComparison.missing,
    mappingExtra: mappingComparison.extra,
    mappingDuplicates: mappingComparison.duplicates,
    mappingOrderMismatch: mappingComparison.orderMismatch,
    mappingBindingMismatches: mappingComparison.bindingMismatches,
    parseErrors,
  };
};

const isMain =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (process.argv.length !== 2) {
    throw new Error("Usage: check-convex-api-entrypoints.mjs");
  }
  const result = checkConvexApiEntryPoints({
    apiPath: defaultApiPath,
    functionsDir: defaultFunctionsDir,
  });
  if (!result.ok) {
    const details = [
      ...result.missing.map((modulePath) => `  missing: ${modulePath}`),
      ...result.extra.map((modulePath) => `  unexpected: ${modulePath}`),
      ...result.duplicates.map((modulePath) => `  duplicate: ${modulePath}`),
      ...(result.orderMismatch ? ["  module import ordering differs"] : []),
      ...result.importBindingMismatches.map(
        ({ modulePath, expected, actual }) =>
          `  import alias mismatch: ${modulePath} expected ${expected}, found ${actual}`,
      ),
      ...result.mappingMissing.map(
        (modulePath) => `  mapping missing: ${modulePath}`,
      ),
      ...result.mappingExtra.map(
        (modulePath) => `  mapping unexpected: ${modulePath}`,
      ),
      ...result.mappingDuplicates.map(
        (modulePath) => `  mapping duplicate: ${modulePath}`,
      ),
      ...(result.mappingOrderMismatch
        ? ["  ApiFromModules mapping ordering differs"]
        : []),
      ...result.mappingBindingMismatches.map(
        ({ modulePath, expected, actual }) =>
          `  mapping binding mismatch: ${modulePath} expected typeof ${expected}, found typeof ${actual}`,
      ),
      ...result.parseErrors.map((error) => `  parse error: ${error}`),
    ].join("\n");
    console.error(
      `Convex generated API surface is stale (${result.actualCount} imports, ${result.mappingCount} mappings, ${result.expectedCount} expected).\n${details}\nRun \`bunx convex codegen --typecheck disable\` from packages/backend.`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `Verified Convex generated API imports and ApiFromModules mappings (${result.actualCount} modules).`,
    );
  }
}
