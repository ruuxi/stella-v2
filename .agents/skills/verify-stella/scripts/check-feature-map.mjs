#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS, resolveCommand } from "../cli/registry.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDir, "..");
const featureDir = path.join(skillRoot, "features");
const indexPath = path.join(featureDir, "README.md");
const failures = [];
const featureFiles = readdirSync(featureDir)
  .filter((name) => name.endsWith(".md") && name !== "README.md")
  .sort();
const index = readFileSync(indexPath, "utf8");
const linkedFiles = [...index.matchAll(/\]\(\.\/([^)]+\.md)\)/g)].map(
  (match) => match[1],
);

for (const file of featureFiles) {
  const count = linkedFiles.filter((linked) => linked === file).length;
  if (count !== 1) failures.push(`${file} is linked ${count} times from features/README.md; expected once.`);
}
for (const linked of linkedFiles) {
  if (!featureFiles.includes(linked)) failures.push(`features/README.md links missing file ${linked}.`);
}

const commandPattern = /node \.agents\/skills\/verify-stella\/control-stella\.mjs\s+([a-z-]+)(?:\s+([a-z-]+))?/g;
for (const file of featureFiles) {
  const source = readFileSync(path.join(featureDir, file), "utf8");
  const h1 = source.match(/^# (.+)$/m);
  if (!h1) failures.push(`${file} needs one H1 title.`);
  for (const match of source.matchAll(commandPattern)) {
    const parts = match[2] ? [match[1], match[2]] : [match[1]];
    if (!resolveCommand(parts)) failures.push(`${file} references unknown desktop command: ${parts.join(" ")}.`);
  }
}

const ids = COMMANDS.map((entry) => entry.id);
if (new Set(ids).size !== ids.length) failures.push("The control command registry contains duplicate command ids.");
const aliases = COMMANDS.flatMap((entry) => entry.aliases);
if (new Set(aliases).size !== aliases.length) failures.push("The control command registry contains duplicate aliases.");

if (failures.length > 0) {
  process.stderr.write(`${JSON.stringify({ ok: false, failures }, null, 2)}\n`);
  process.exit(1);
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    featureFiles: featureFiles.length,
    indexedLinks: linkedFiles.length,
    commandIds: ids.length,
  })}\n`,
);
