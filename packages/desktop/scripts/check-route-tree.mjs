import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");
const DESKTOP_UI_ROOT = path.join(REPO_ROOT, "packages", "desktop-ui");

function hashTree(root) {
  const hash = createHash("sha256");

  const visit = (directory, relativeDirectory = "") => {
    const names = readdirSync(directory).sort();
    for (const name of names) {
      const absolute = path.join(directory, name);
      const relative = path.posix.join(relativeDirectory, name);
      const stat = statSync(absolute);
      if (stat.isDirectory()) {
        hash.update(`d\0${relative}\0`);
        visit(absolute, relative);
      } else if (stat.isFile()) {
        hash.update(`f\0${relative}\0${stat.size}\0`);
        hash.update(readFileSync(absolute));
      } else {
        throw new Error(`Route source is not a regular file: ${relative}`);
      }
    }
  };

  visit(root);
  return hash.digest("hex");
}

function firstDifferentLine(actual, expected) {
  const actualLines = actual.split("\n");
  const expectedLines = expected.split("\n");
  const count = Math.max(actualLines.length, expectedLines.length);
  for (let index = 0; index < count; index += 1) {
    if (actualLines[index] !== expectedLines[index]) return index + 1;
  }
  return null;
}

export function checkRouteTree({
  routesDirectory = path.join(DESKTOP_UI_ROOT, "src", "routes"),
  configPath = path.join(DESKTOP_UI_ROOT, "tsr.config.json"),
  expectedPath = path.join(DESKTOP_UI_ROOT, "src", "routeTree.gen.ts"),
  cliPath = path.join(
    REPO_ROOT,
    "node_modules",
    "@tanstack",
    "router-cli",
    "bin",
    "tsr.cjs",
  ),
} = {}) {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "stella-route-tree-check-"));
  try {
    const temporaryRoutes = path.join(temporaryRoot, "src", "routes");
    const temporaryConfig = path.join(temporaryRoot, "tsr.config.json");
    cpSync(routesDirectory, temporaryRoutes, { recursive: true });
    writeFileSync(temporaryConfig, readFileSync(configPath));

    const sourceHashBefore = hashTree(temporaryRoutes);
    const result = spawnSync(process.execPath, [cliPath, "generate"], {
      cwd: temporaryRoot,
      encoding: "utf8",
      env: { ...process.env, CI: "1" },
    });
    if (result.status !== 0) {
      throw new Error(
        `Route generation failed (${result.status ?? "signal"}): ${[
          result.stdout,
          result.stderr,
        ]
          .filter(Boolean)
          .join("\n")}`,
      );
    }

    const sourceHashAfter = hashTree(temporaryRoutes);
    if (sourceHashAfter !== sourceHashBefore) {
      throw new Error("Route generator modified canonical route source files");
    }

    const generatedPath = path.join(temporaryRoot, "src", "routeTree.gen.ts");
    const actual = readFileSync(generatedPath, "utf8");
    const expected = readFileSync(expectedPath, "utf8");
    if (actual !== expected) {
      const line = firstDifferentLine(actual, expected);
      throw new Error(
        `Generated route tree is stale${line ? ` (first difference at line ${line})` : ""}. Run bun run routes:generate.`,
      );
    }

    return {
      routeCount: readdirSync(routesDirectory, { recursive: true }).filter(
        (entry) => typeof entry === "string" && /\.(?:t|j)sx?$/u.test(entry),
      ).length,
      sha256: createHash("sha256").update(actual).digest("hex"),
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  try {
    const result = checkRouteTree();
    console.log(
      `Route tree current: ${result.routeCount} route files, ${result.sha256.slice(0, 12)}...`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
