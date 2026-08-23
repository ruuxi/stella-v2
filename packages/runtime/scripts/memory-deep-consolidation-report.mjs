#!/usr/bin/env node
/**
 * Read-only supervised worklist for MEMORY.md deep consolidation.
 *
 * The runtime mechanically rotates size overflow. Near-duplicate workstream
 * merges require operator/Dream judgment, so this tool reports candidates and
 * the non-destructive supersede procedure; it never mutates memory files.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const ROTATION_THRESHOLD_BYTES = 300_000;
const ROTATION_TARGET_BYTES = 240_000;
const MIN_ACTIVE_BLOCKS = 5;
const ACTIVE_START = "<!-- DREAM:ACTIVE_BLOCKS_START -->";
const ACTIVE_END = "<!-- DREAM:ACTIVE_BLOCKS_END -->";
const ARCHIVE_START = "<!-- DREAM:ARCHIVE_START -->";
const ARCHIVE_END = "<!-- DREAM:ARCHIVE_END -->";
const BLOCK_DATE_RE = /^## (\d{4}-\d{2}-\d{2})/u;

const readOptional = (target) => {
  try {
    return fs.readFileSync(target, "utf-8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};

const sliceBetween = (raw, startMarker, endMarker) => {
  const start = raw.indexOf(startMarker);
  const end = raw.indexOf(endMarker);
  if (start < 0 || end <= start) return null;
  return raw.slice(start + startMarker.length, end);
};

const parseBlocks = (body, section) => {
  const blocks = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const text = current.join("\n").trim();
    if (text) {
      blocks.push({
        text,
        heading: text.split("\n", 1)[0],
        date: BLOCK_DATE_RE.exec(text)?.[1],
        section,
      });
    }
    current = null;
  };
  for (const line of body.split("\n")) {
    if (line.startsWith("## ")) {
      flush();
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  flush();
  return blocks;
};

const archiveForDate = (date) => {
  const [year, month] = date.split("-");
  return `MEMORY-${year}-Q${Math.floor((Number(month) - 1) / 3) + 1}.md`;
};

const normalizedTitle = (heading) =>
  heading
    .replace(/^## /u, "")
    .replace(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?\s*[—-]?\s*/u, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

const overlap = (left, right) => {
  const a = new Set(left.split(" ").filter((word) => word.length > 2));
  const b = new Set(right.split(" ").filter((word) => word.length > 2));
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.min(a.size, b.size);
};

export const buildMemoryDeepConsolidationReport = (
  memoriesDir,
  now = new Date(),
) => {
  const lines = [];
  const emit = (line = "") => lines.push(line);
  const raw = readOptional(path.join(memoriesDir, "MEMORY.md"));
  emit("# MEMORY.md deep-consolidation report");
  emit();
  emit(`- generated: ${now.toISOString()}`);
  emit(`- memories dir: ${memoriesDir}`);
  emit();
  if (raw === null) {
    emit("MEMORY.md not found — nothing to analyze.");
  } else {
    const bytes = Buffer.byteLength(raw, "utf-8");
    const activeBody = sliceBetween(raw, ACTIVE_START, ACTIVE_END);
    const archiveBody = sliceBetween(raw, ARCHIVE_START, ARCHIVE_END) ?? "";
    emit("## Size and rotation");
    emit();
    emit(
      `- active file: ${bytes.toLocaleString()} bytes (threshold ${ROTATION_THRESHOLD_BYTES.toLocaleString()}, target ${ROTATION_TARGET_BYTES.toLocaleString()})`,
    );
    if (activeBody === null) {
      emit(
        "- WARNING: active anchors are missing or out of order; runtime rotation will refuse to rewrite.",
      );
    } else {
      const active = parseBlocks(activeBody, "active");
      const staged = parseBlocks(archiveBody, "archive");
      emit(
        `- blocks: ${active.length} active, ${staged.length} staged, ${[...active, ...staged].filter((block) => !block.date).length} undated`,
      );
      let projected = bytes;
      const plan = new Map();
      for (const block of [
        ...staged.filter((item) => item.date),
        ...active
          .filter((item) => item.date)
          .slice(MIN_ACTIVE_BLOCKS)
          .reverse(),
      ]) {
        if (projected <= ROTATION_TARGET_BYTES) break;
        projected -= Buffer.byteLength(block.text, "utf-8");
        const file = archiveForDate(block.date);
        plan.set(file, (plan.get(file) ?? 0) + 1);
      }
      if (bytes <= ROTATION_THRESHOLD_BYTES) {
        emit("- under threshold: automatic rotation will not fire.");
      } else if (plan.size === 0) {
        emit("- over threshold but no dated block can rotate safely.");
      } else {
        emit("- automatic rotation preview:");
        for (const [file, count] of [...plan.entries()].sort()) {
          emit(`  - ${count} block(s) -> archive/${file}`);
        }
        emit(
          `  - projected active size: about ${projected.toLocaleString()} bytes`,
        );
      }
      emit();
      emit("## Near-duplicate merge worklist (supervised)");
      emit();
      const groups = new Map();
      for (const block of active.filter((item) => item.date)) {
        const title = normalizedTitle(block.heading);
        if (!title) continue;
        groups.set(title, [...(groups.get(title) ?? []), block]);
      }
      const repeated = [...groups.entries()].filter(
        ([, blocks]) => blocks.length > 1,
      );
      if (repeated.length === 0) emit("- no exact-title clusters.");
      for (const [title, blocks] of repeated) {
        emit(`- \"${title}\" x ${blocks.length}:`);
        for (const block of blocks) emit(`  - ${block.heading}`);
      }
      const titles = [...groups.keys()];
      const similar = [];
      for (let i = 0; i < titles.length; i += 1) {
        for (let j = i + 1; j < titles.length; j += 1) {
          if (overlap(titles[i], titles[j]) >= 0.6)
            similar.push([titles[i], titles[j]]);
        }
      }
      if (similar.length > 0) {
        emit("- similar-title pairs:");
        for (const [a, b] of similar.slice(0, 40))
          emit(`  - \"${a}\" <-> \"${b}\"`);
      }
      emit();
      emit(
        "Merge procedure: rewrite the newest active block with the current state, then remove older duplicates through Dream StrReplace. The runtime journals every removed span to archive/MEMORY-superseded.md before the active edit lands.",
      );
    }
  }
  emit();
  emit("## Retired files");
  emit();
  for (const name of ["memory_summary.md", "memory_index.md"]) {
    const value = readOptional(path.join(memoriesDir, name));
    emit(
      value === null
        ? `- ${name}: absent on this install.`
        : `- ${name}: present, ${Array.from(value).length.toLocaleString()} characters, preserved and never deleted.`,
    );
  }
  return `${lines.join("\n")}\n`;
};

const expandHome = (value) =>
  value?.startsWith("~") ? path.join(os.homedir(), value.slice(1)) : value;

export const runMemoryDeepConsolidationReportCli = (
  argv = process.argv.slice(2),
) => {
  const readArg = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const memoriesDir =
    expandHome(readArg("--memories-dir")) ??
    path.join(os.homedir(), ".stella", "memories");
  const output = expandHome(readArg("--out"));
  const report = buildMemoryDeepConsolidationReport(memoriesDir);
  if (output) {
    fs.writeFileSync(output, report, "utf-8");
    process.stdout.write(`Report written to ${output}\n`);
  } else {
    process.stdout.write(report);
  }
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runMemoryDeepConsolidationReportCli();
}
