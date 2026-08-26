#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(scriptDir, "../extension");
const manifest = JSON.parse(
  readFileSync(path.join(extensionDir, "manifest.json"), "utf8"),
);
const outputArgument = process.argv[2];
const outputPath = path.resolve(
  outputArgument ||
    path.join(scriptDir, `../dist/stella-browser-${manifest.version}.zip`),
);
const stagingDir = mkdtempSync(
  path.join(os.tmpdir(), `stella-browser-${manifest.version}-`),
);

const rootFiles = [
  "background.js",
  "manifest.json",
  "offscreen.html",
  "offscreen.js",
  "popup.css",
  "popup.html",
  "popup.js",
  "site-mods.js",
];

const copyRuntimeDirectory = (directory, extension) => {
  const sourceDir = path.join(extensionDir, directory);
  const destinationDir = path.join(stagingDir, directory);
  mkdirSync(destinationDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith(extension) ||
      entry.name.endsWith(".test.js") ||
      entry.name === "generate.cjs"
    ) {
      continue;
    }
    cpSync(
      path.join(sourceDir, entry.name),
      path.join(destinationDir, entry.name),
    );
  }
};

try {
  if (manifest.version !== "1.2.12") {
    throw new Error(
      `Expected extension version 1.2.12, found ${manifest.version}.`,
    );
  }
  for (const file of rootFiles) {
    cpSync(path.join(extensionDir, file), path.join(stagingDir, file));
  }
  copyRuntimeDirectory("commands", ".js");
  copyRuntimeDirectory("lib", ".js");
  copyRuntimeDirectory("icons", ".png");

  const background = readFileSync(
    path.join(stagingDir, "background.js"),
    "utf8",
  );
  for (const marker of [
    "chrome.cookies.onChanged",
    "queueCookieChange",
    "cookies_changed",
  ]) {
    if (!background.includes(marker)) {
      throw new Error(`Packaged background is missing ${marker}.`);
    }
  }

  mkdirSync(path.dirname(outputPath), { recursive: true });
  if (existsSync(outputPath)) rmSync(outputPath);
  const zipped = spawnSync("zip", ["-X", "-q", "-r", outputPath, "."], {
    cwd: stagingDir,
    encoding: "utf8",
  });
  if (zipped.status !== 0) {
    throw new Error(zipped.stderr || "zip failed");
  }

  const entries = spawnSync("unzip", ["-Z1", outputPath], {
    encoding: "utf8",
  });
  if (entries.status !== 0) throw new Error(entries.stderr || "unzip failed");
  const archiveEntries = entries.stdout.trim().split("\n").filter(Boolean);
  const forbidden = archiveEntries.filter((entry) =>
    /(^|\/)(?:\.git|node_modules|__pycache__|dist|target|coverage|cache)(?:\/|$)|(?:\.map|\.log|\.tmp|\.swp|~)$/i.test(
      entry,
    ),
  );
  if (forbidden.length > 0) {
    throw new Error(`Forbidden archive entries: ${forbidden.join(", ")}`);
  }
  if (!archiveEntries.includes("manifest.json")) {
    throw new Error("The archive has no root manifest.json.");
  }

  const bytes = statSync(outputPath).size;
  const sha256 = createHash("sha256")
    .update(readFileSync(outputPath))
    .digest("hex");
  console.log(
    JSON.stringify(
      {
        outputPath,
        version: manifest.version,
        entries: archiveEntries.length,
        bytes,
        sha256,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(stagingDir, { recursive: true, force: true });
}
