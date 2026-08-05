#!/usr/bin/env bun
/** Scaffold an external Vite React app under Stella's workspace/apps root. */

import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const SCRIPT_DIR = import.meta.dirname;
const TEMPLATE_DIR = resolve(SCRIPT_DIR, "..", "templates");
const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const TEMPLATE_FILES = [
  ["stella.app.json.tmpl", "stella.app.json"],
  ["package.json.tmpl", "package.json"],
  ["index.html.tmpl", "index.html"],
  ["vite.config.ts.tmpl", "vite.config.ts"],
  ["tsconfig.json.tmpl", "tsconfig.json"],
  ["App.tsx.tmpl", "src/App.tsx"],
  ["main.tsx.tmpl", "src/main.tsx"],
  ["app.css.tmpl", "src/app.css"],
  ["vite-env.d.ts.tmpl", "src/vite-env.d.ts"],
  ["gitignore.tmpl", ".gitignore"],
] as const;

function fail(message: string): never {
  throw new Error(message);
}

function parseArgs(argv: string[]) {
  if (argv.some((arg) => arg.startsWith("--"))) {
    fail("unknown flag (usage: program.ts <slug> <name words...>)");
  }
  const [slug, ...nameParts] = argv;
  if (!slug) fail("missing <slug> (usage: program.ts <slug> <name words...>)");
  if (!SLUG_PATTERN.test(slug)) {
    fail(
      `invalid slug ${JSON.stringify(slug)}: use lowercase [a-z0-9-], start with a letter, maximum 32 characters`,
    );
  }
  const name = nameParts.join(" ").trim();
  if (!name) fail("missing <name>");
  if (name.length > 120) fail("name must be 120 characters or fewer");
  return { slug, name };
}

function resolveAppsRoot() {
  const stellaDataDir = process.env.STELLA_DATA_DIR?.trim();
  return resolve(
    stellaDataDir || join(homedir(), ".stella"),
    "workspace",
    "apps",
  );
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderTemplate(templateName: string, values: Record<string, string>) {
  const template = readFileSync(join(TEMPLATE_DIR, templateName), "utf8");
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) {
      fail(`template ${templateName} uses unknown placeholder ${key}`);
    }
    return value;
  });
}

function writeTemplateTree(stagingDir: string, values: Record<string, string>) {
  for (const [templateName, relativeTarget] of TEMPLATE_FILES) {
    const target = join(stagingDir, relativeTarget);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, renderTemplate(templateName, values), "utf8");
  }
}

function scaffold(argv: string[]) {
  const { slug, name } = parseArgs(argv);
  const appsRoot = resolveAppsRoot();
  const destination = join(appsRoot, slug);
  const lockPath = join(appsRoot, `.${slug}.create.lock`);

  mkdirSync(appsRoot, { recursive: true, mode: 0o700 });
  if (existsSync(destination)) {
    fail(`refusing to overwrite existing app: ${destination}`);
  }

  let lockFd: number | null = null;
  let stagingDir: string | null = null;
  try {
    lockFd = openSync(lockPath, "wx", 0o600);
    if (existsSync(destination)) {
      fail(`refusing to overwrite existing app: ${destination}`);
    }
    stagingDir = mkdtempSync(join(appsRoot, `.${slug}.create-`));
    const createdAt = new Date().toISOString();
    writeTemplateTree(stagingDir, {
      SLUG: slug,
      NAME_JSON: JSON.stringify(name),
      NAME_HTML: escapeHtml(name),
      CREATED_AT_JSON: JSON.stringify(createdAt),
    });
    renameSync(stagingDir, destination);
    stagingDir = null;
  } finally {
    if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
    if (lockFd !== null) {
      closeSync(lockFd);
      try {
        unlinkSync(lockPath);
      } catch {
        // The acquired lock may already have been cleaned up externally.
      }
    }
  }

  console.log(`created Stella app ${JSON.stringify(name)}`);
  console.log(`path: ${destination}`);
  console.log("next:");
  console.log(`  cd ${JSON.stringify(destination)}`);
  console.log("  bun install");
  console.log("  bun run check && bun run build");
}

try {
  scaffold(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exitCode = 1;
}
