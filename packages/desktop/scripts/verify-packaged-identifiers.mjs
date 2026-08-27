import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Linter } from "eslint";
import globals from "globals";

const scriptDir = import.meta.dirname;
const repoRootDir = path.resolve(scriptDir, "..", "..", "..");
const toPosix = (value) => value.split(path.sep).join("/");

const bundleProbeGlobals = {
  AsyncIterator: "readonly",
  EdgeRuntime: "readonly",
  __UNDICI_IS_NODE__: "readonly",
  __non_webpack_require__: "readonly",
  __webpack_require__: "readonly",
  define: "readonly",
  document: "readonly",
  esbuildDetection: "readonly",
  window: "readonly",
};

const languageGlobals = {
  ...globals.node,
  ...globals.nodeBuiltin,
  ...globals.bunBuiltin,
  ...globals.denoBuiltin,
  ...bundleProbeGlobals,
};

const linter = new Linter({ configType: "flat" });
const noUndefConfig = [
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: languageGlobals,
    },
    rules: {
      "no-undef": ["error", { typeof: true }],
    },
  },
];

const walkFiles = (rootDir) => {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  };
  visit(rootDir);
  return files;
};

export const findUndeclaredIdentifiers = ({ code, filePath }) =>
  linter
    .verify(code, noUndefConfig, { filename: path.basename(filePath) })
    .filter((message) => message.ruleId === "no-undef")
    .map((message) => ({
      filePath,
      line: message.line,
      column: message.column,
      message: message.message,
    }));

const throwIdentifierFailures = (failures, label) => {
  if (failures.length === 0) {
    return;
  }
  throw new Error(
    `${label} contains undeclared identifiers:\n${failures
      .map(
        ({ filePath, line, column, message }) =>
          `- ${toPosix(path.relative(repoRootDir, filePath))}:${line}:${column} ${message}`,
      )
      .join("\n")}`,
  );
};

export const verifyConvertedSourceIdentifiers = ({
  rootDir = repoRootDir,
} = {}) => {
  const files = [
    ...walkFiles(path.join(rootDir, "packages", "runtime")),
    ...walkFiles(path.join(rootDir, "packages", "desktop", "electron")),
  ].filter((file) => file.endsWith(".js"));
  const failures = files.flatMap((filePath) =>
    findUndeclaredIdentifiers({
      code: readFileSync(filePath, "utf8"),
      filePath,
    }),
  );
  throwIdentifierFailures(failures, "Converted Stella application source");
  return files.length;
};

export const verifyPackagedIdentifierFiles = ({ filePaths }) => {
  const failures = filePaths.flatMap((filePath) =>
    findUndeclaredIdentifiers({
      code: readFileSync(filePath, "utf8"),
      filePath,
    }),
  );
  throwIdentifierFailures(failures, "Packaged Electron main/runtime output");
  return filePaths.length;
};

export const collectExistingPackagedApplicationFiles = (rootDir) => {
  const mainPath = path.join(
    rootDir,
    "packages",
    "desktop",
    "dist-electron",
    "electron",
    "main.js",
  );
  const workerDir = path.join(
    rootDir,
    "packages",
    "desktop",
    "dist-electron",
    "runtime",
    "worker",
  );
  const files = [mainPath];
  for (const filePath of walkFiles(workerDir).filter((file) =>
    file.endsWith(".js"),
  )) {
    const code = readFileSync(filePath, "utf8");
    if (/^\/\/ packages\/(?:runtime|desktop)\//m.test(code)) {
      files.push(filePath);
    }
  }
  return files;
};

export const verifyExistingPackagedIdentifiers = ({
  rootDir = repoRootDir,
} = {}) => {
  const files = collectExistingPackagedApplicationFiles(rootDir);
  const failures = files.flatMap((filePath) =>
    findUndeclaredIdentifiers({
      code: readFileSync(filePath, "utf8"),
      filePath,
    }),
  );
  throwIdentifierFailures(failures, "Packaged Electron main/runtime output");
  return files.length;
};

const isRunDirectly = (() => {
  try {
    return (
      path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
})();

if (isRunDirectly) {
  try {
    const rootIndex = process.argv.indexOf("--root");
    const rootDir =
      rootIndex === -1
        ? repoRootDir
        : path.resolve(process.argv[rootIndex + 1] ?? "");
    let sourceCount = null;
    let outputCount = null;
    if (process.argv.includes("--source")) {
      sourceCount = verifyConvertedSourceIdentifiers({ rootDir });
    }
    const filesJsonIndex = process.argv.indexOf("--files-json");
    if (filesJsonIndex !== -1) {
      const filePaths = JSON.parse(process.argv[filesJsonIndex + 1] ?? "[]");
      if (!Array.isArray(filePaths)) {
        throw new Error("--files-json must contain a JSON array of paths.");
      }
      outputCount = verifyPackagedIdentifierFiles({ filePaths });
    } else if (
      process.argv.includes("--packaged") ||
      !process.argv.includes("--source")
    ) {
      outputCount = verifyExistingPackagedIdentifiers({ rootDir });
    }
    if (sourceCount !== null) {
      console.log(
        `[verify-packaged-identifiers] ${sourceCount} converted source file(s) have declared identifiers.`,
      );
    }
    if (outputCount !== null) {
      console.log(
        `[verify-packaged-identifiers] ${outputCount} packaged application output file(s) have declared identifiers.`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
