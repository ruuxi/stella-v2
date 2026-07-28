/**
 * Resident startup docs — the always-loaded files that ride an orchestrator
 * thread as pinned `bootstrap.startup_doc` messages.
 *
 * Exactly one persisted copy per display path is allowed in a cache epoch.
 * Source-file changes never append or mutate that copy mid-epoch; compaction
 * already rebuilds the provider prefix, so it is the sole refresh boundary.
 * This preserves byte-stable cache prefixes without leaving durable memory
 * stale after a rebuild. The planner below is applied by SessionStore in the
 * same SQLite transaction as the compaction overlay.
 *
 * The v1 implementation also refreshed an imperative session mirror. v2's
 * Effect-owned compaction scheduler calls `notifyCompacted`, and PiSessionCore
 * reloads the persisted thread before the next turn, so duplicating that
 * imperative mutation here would race the current session ownership model.
 */

import fs from "node:fs";
import path from "node:path";
import { redactMemoryText } from "./redaction.js";
import {
  MEMORY_MAP_MAX_CHARS,
  stripInjectedHtmlComments,
  truncateUnicodeAtLineBoundary,
  unicodeCodePointLength,
} from "./dream-storage.js";
import { USER_PROFILE_INJECTED_MAX_CHARS } from "./user-profile-store.js";
import { createRuntimeLogger } from "../debug.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import type {
  RuntimeThreadCustomMessageEntry,
  RuntimeThreadCustomMessageMutation,
} from "../storage/shared.js";

export { stripInjectedHtmlComments };

const logger = createRuntimeLogger("memory.resident-docs");

export const LIFE_REGISTRY_DISPLAY_PATH = "~/.stella/registry.md";
export const LIFE_CORE_MEMORY_DISPLAY_PATH = "~/.stella/core-memory.md";
export const LIFE_USER_PROFILE_DISPLAY_PATH = "~/.stella/memories/profile.md";
export const LIFE_MEMORY_MAP_DISPLAY_PATH = "~/.stella/memories/memory_map.md";
export const LIFE_PERSONALITY_DISPLAY_PATH = "~/.stella/PERSONALITY.md";
// Canonical definition lives in the workerd-safe run-shared module so the
// cloud loop hosts can pin startup docs without importing this file (fs).
import { BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE } from "../agent-runtime/run-shared.js";
export { BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE } from "../agent-runtime/run-shared.js";

export const RETIRED_STARTUP_DOC_DISPLAY_PATHS: ReadonlySet<string> = new Set([
  "~/.stella/memories/memory_summary.md",
  "~/.stella/memories/memory_index.md",
]);

export const buildStartupDocMessage = (
  displayPath: string,
  content: string,
): string =>
  [`<startup_doc path="${displayPath}">`, content, "</startup_doc>"].join("\n");

const STARTUP_DOC_PATH_PATTERN = /^<startup_doc path="([^"]+)">/u;

export const parseStartupDocPath = (docText: string): string | undefined =>
  STARTUP_DOC_PATH_PATTERN.exec(docText.trim())?.[1];

const capResidentMemoryDoc = (content: string, maxChars?: number): string => {
  if (!maxChars || unicodeCodePointLength(content) <= maxChars) return content;
  return truncateUnicodeAtLineBoundary(
    content,
    maxChars,
    "...[resident memory truncated]",
  );
};

const readResidentMemoryDoc = (
  filePath: string,
  maxChars?: number,
): string | undefined => {
  try {
    // The retired archive/charter transport stays byte-for-byte on disk; only
    // the model-facing view drops HTML comments, before cap accounting.
    const bytes = fs.readFileSync(filePath);
    const content = stripInjectedHtmlComments(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    return content
      ? capResidentMemoryDoc(redactMemoryText(content), maxChars)
      : undefined;
  } catch {
    return undefined;
  }
};

export const readCoreMemory = (stellaDataDir: string): string | undefined => {
  const candidatePaths = [
    path.join(stellaDataDir, "core-memory.md"),
    path.join(stellaDataDir, "CORE_MEMORY.MD"),
  ];
  for (const filePath of candidatePaths) {
    try {
      const content = fs.readFileSync(filePath, "utf-8").trim();
      if (content) return redactMemoryText(content);
    } catch {
      continue;
    }
  }
  return undefined;
};

export const readMemoryMapDoc = (stellaDataDir: string): string | undefined =>
  readResidentMemoryDoc(
    path.join(stellaDataDir, "memories", "memory_map.md"),
    MEMORY_MAP_MAX_CHARS,
  );

export const readUserProfileDoc = (stellaDataDir: string): string | undefined =>
  readResidentMemoryDoc(
    path.join(stellaDataDir, "memories", "profile.md"),
    USER_PROFILE_INJECTED_MAX_CHARS,
  );

const readOptionalTextFileSync = (filePath: string): string | undefined => {
  try {
    const content = fs.readFileSync(filePath, "utf-8").trim();
    return content || undefined;
  } catch {
    return undefined;
  }
};

export const readStartupDocBodyFromDisk = (
  stellaDataDir: string,
  displayPath: string,
): string | undefined => {
  switch (displayPath) {
    case LIFE_PERSONALITY_DISPLAY_PATH:
      return readOptionalTextFileSync(
        path.join(stellaDataDir, "PERSONALITY.md"),
      );
    case LIFE_REGISTRY_DISPLAY_PATH:
      return readOptionalTextFileSync(path.join(stellaDataDir, "registry.md"));
    case LIFE_CORE_MEMORY_DISPLAY_PATH: {
      const coreMemory = readCoreMemory(stellaDataDir);
      return coreMemory ? redactMemoryText(coreMemory.trim()) : undefined;
    }
    case LIFE_USER_PROFILE_DISPLAY_PATH: {
      const profile = readUserProfileDoc(stellaDataDir);
      return profile ? redactMemoryText(profile.trim()) : undefined;
    }
    case LIFE_MEMORY_MAP_DISPLAY_PATH: {
      const memoryMap = readMemoryMapDoc(stellaDataDir);
      return memoryMap ? redactMemoryText(memoryMap.trim()) : undefined;
    }
    default:
      // Retired summary/index labels deliberately have no fresh body. They
      // remain frozen until a boundary can replace them with the map safely.
      return undefined;
  }
};

const customMessageText = (
  content: string | Array<{ type: string; text?: string }>,
): string =>
  typeof content === "string"
    ? content
    : content
        .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
        .join("\n");

type StartupDocEntry = {
  entryId: string;
  displayPath: string;
  persistedDoc: string;
  persistedContent: RuntimeThreadCustomMessageEntry["content"];
};

export type ResidentStartupDocRefreshPlan = {
  refreshedDocs: number;
  removedDocs: number;
  mutations: RuntimeThreadCustomMessageMutation[];
};

/**
 * Build the complete compare-and-swap mutation plan for a compaction
 * boundary. SessionStore applies every mutation atomically with the overlay.
 * Missing sources never blank an existing pinned copy. Retired summary/index
 * entries convert only when a map body is available; otherwise the transition
 * stays frozen and retries at the next boundary.
 */
export const planResidentStartupDocRefresh = (args: {
  store: RuntimeStore;
  threadKey: string;
  stellaDataDir: string;
}): ResidentStartupDocRefreshPlan => {
  const entries: StartupDocEntry[] = [];
  for (const message of args.store.loadThreadMessages(args.threadKey)) {
    const customMessage = message.customMessage;
    if (
      message.role !== "runtimeInternal" ||
      customMessage?.customType !== BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE ||
      !message.entryId
    ) {
      continue;
    }
    const persistedDoc = customMessageText(customMessage.content);
    const displayPath = parseStartupDocPath(persistedDoc);
    if (displayPath) {
      entries.push({
        entryId: message.entryId,
        displayPath,
        persistedDoc,
        persistedContent: customMessage.content,
      });
    }
  }

  const plan: ResidentStartupDocRefreshPlan = {
    refreshedDocs: 0,
    removedDocs: 0,
    mutations: [],
  };
  const writeEntry = (entry: StartupDocEntry, freshDoc: string): void => {
    if (freshDoc.trim() === entry.persistedDoc.trim()) return;
    plan.mutations.push({
      action: "replace",
      entryId: entry.entryId,
      expectedCustomType: BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE,
      expectedContent: entry.persistedContent,
      content: [{ type: "text", text: freshDoc }],
    });
    plan.refreshedDocs += 1;
  };
  const removeEntry = (entry: StartupDocEntry): void => {
    plan.mutations.push({
      action: "remove",
      entryId: entry.entryId,
      expectedCustomType: BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE,
      expectedContent: entry.persistedContent,
    });
    plan.removedDocs += 1;
  };

  const retiredEntries = entries.filter((entry) =>
    RETIRED_STARTUP_DOC_DISPLAY_PATHS.has(entry.displayPath),
  );
  const hasExistingMapEntry = entries.some(
    (entry) => entry.displayPath === LIFE_MEMORY_MAP_DISPLAY_PATH,
  );
  const mapBody = readStartupDocBodyFromDisk(
    args.stellaDataDir,
    LIFE_MEMORY_MAP_DISPLAY_PATH,
  );
  const convertedEntry =
    retiredEntries.length > 0 && mapBody && !hasExistingMapEntry
      ? retiredEntries[0]
      : undefined;

  const seenPaths = new Set<string>();
  for (const entry of entries) {
    if (entry === convertedEntry) {
      writeEntry(
        entry,
        buildStartupDocMessage(LIFE_MEMORY_MAP_DISPLAY_PATH, mapBody!),
      );
      seenPaths.add(LIFE_MEMORY_MAP_DISPLAY_PATH);
      continue;
    }
    if (RETIRED_STARTUP_DOC_DISPLAY_PATHS.has(entry.displayPath)) {
      if (hasExistingMapEntry || seenPaths.has(LIFE_MEMORY_MAP_DISPLAY_PATH)) {
        removeEntry(entry);
      }
      continue;
    }
    if (seenPaths.has(entry.displayPath)) {
      removeEntry(entry);
      continue;
    }
    seenPaths.add(entry.displayPath);
    const freshBody = readStartupDocBodyFromDisk(
      args.stellaDataDir,
      entry.displayPath,
    );
    if (freshBody) {
      writeEntry(entry, buildStartupDocMessage(entry.displayPath, freshBody));
    }
  }
  return plan;
};

export type ResidentStartupDocStat = {
  displayPath: string;
  copies: number;
  injectedChars: number;
  capChars?: number;
};

export type ResidentDocTelemetryAnomalies = {
  duplicatePaths: string[];
  capPressurePaths: string[];
};

const RESIDENT_DOC_CAPS: Readonly<Record<string, number>> = {
  [LIFE_MEMORY_MAP_DISPLAY_PATH]: MEMORY_MAP_MAX_CHARS,
  [LIFE_USER_PROFILE_DISPLAY_PATH]: USER_PROFILE_INJECTED_MAX_CHARS,
};
const RESIDENT_DOC_CAP_PRESSURE_RATIO = 0.9;

/** Per-path copy count and code-point cost in the provider-facing prefix. */
export const collectResidentStartupDocStats = (
  docTexts: readonly string[],
): ResidentStartupDocStat[] => {
  const byPath = new Map<string, ResidentStartupDocStat>();
  for (const text of docTexts) {
    const displayPath = parseStartupDocPath(text);
    if (!displayPath) continue;
    const existing = byPath.get(displayPath);
    if (existing) {
      existing.copies += 1;
      existing.injectedChars += unicodeCodePointLength(text);
      continue;
    }
    const capChars = RESIDENT_DOC_CAPS[displayPath];
    byPath.set(displayPath, {
      displayPath,
      copies: 1,
      injectedChars: unicodeCodePointLength(text),
      ...(capChars ? { capChars } : {}),
    });
  }
  return [...byPath.values()];
};

let lastResidentAnomalySignature = "";

export const resetResidentDocTelemetryForTests = (): void => {
  lastResidentAnomalySignature = "";
};

/** Structured, best-effort observability for resident-prefix regressions. */
export const emitResidentStartupDocTelemetry = (args: {
  source: "prompt-build" | "compaction-boundary";
  stats: readonly ResidentStartupDocStat[];
}): ResidentDocTelemetryAnomalies => {
  const duplicatePaths = args.stats
    .filter((stat) => stat.copies > 1)
    .map((stat) => stat.displayPath);
  const capPressurePaths = args.stats
    .filter(
      (stat) =>
        stat.copies === 1 &&
        stat.capChars !== undefined &&
        stat.injectedChars >= stat.capChars * RESIDENT_DOC_CAP_PRESSURE_RATIO,
    )
    .map((stat) => stat.displayPath);
  const payload = {
    source: args.source,
    totalChars: args.stats.reduce(
      (total, stat) => total + stat.injectedChars,
      0,
    ),
    docs: args.stats.map((stat) => ({
      path: stat.displayPath,
      copies: stat.copies,
      chars: stat.injectedChars,
      ...(stat.capChars !== undefined ? { cap: stat.capChars } : {}),
    })),
  };
  if (args.source === "compaction-boundary") {
    logger.info("resident-docs.telemetry", payload);
  } else {
    logger.debug("resident-docs.telemetry", payload);
  }

  const signature = JSON.stringify({ duplicatePaths, capPressurePaths });
  const hasAnomaly = duplicatePaths.length > 0 || capPressurePaths.length > 0;
  if (hasAnomaly && signature !== lastResidentAnomalySignature) {
    if (duplicatePaths.length > 0) {
      logger.warn("resident-docs.duplicate-copies", {
        source: args.source,
        paths: duplicatePaths,
      });
    }
    if (capPressurePaths.length > 0) {
      logger.warn("resident-docs.cap-pressure", {
        source: args.source,
        paths: capPressurePaths,
      });
    }
  }
  lastResidentAnomalySignature = hasAnomaly ? signature : "";
  return { duplicatePaths, capPressurePaths };
};
