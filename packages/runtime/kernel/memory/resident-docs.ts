/**
 * Resident startup docs — the always-loaded files that ride an orchestrator
 * thread as pinned `bootstrap.startup_doc` messages.
 *
 * Exactly one persisted copy per display path is allowed in a cache epoch.
 * Source-file changes never append or mutate that copy mid-epoch; compaction
 * already rebuilds the provider prefix, so it is the sole refresh boundary.
 * This preserves byte-stable cache prefixes without leaving durable memory
 * stale after a rebuild.
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
} from "./dream-storage.js";
import type { RuntimeStore } from "../storage/runtime-store.js";

export { stripInjectedHtmlComments };

export const LIFE_REGISTRY_DISPLAY_PATH = "~/.stella/registry.md";
export const LIFE_CORE_MEMORY_DISPLAY_PATH = "~/.stella/core-memory.md";
export const LIFE_USER_PROFILE_DISPLAY_PATH = "~/.stella/memories/profile.md";
export const LIFE_MEMORY_MAP_DISPLAY_PATH = "~/.stella/memories/memory_map.md";
export const LIFE_PERSONALITY_DISPLAY_PATH = "~/.stella/PERSONALITY.md";
export const BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE = "bootstrap.startup_doc";

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
  if (!maxChars || content.length <= maxChars) return content;
  const marker = "\n...[resident memory truncated]";
  return `${content.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
};

const readResidentMemoryDoc = (
  filePath: string,
  maxChars?: number,
): string | undefined => {
  try {
    // The retired archive/charter transport stays byte-for-byte on disk; only
    // the model-facing view drops HTML comments, before cap accounting.
    const content = stripInjectedHtmlComments(
      fs.readFileSync(filePath, "utf-8"),
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
  readResidentMemoryDoc(path.join(stellaDataDir, "memories", "profile.md"));

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
};

export type ResidentStartupDocRefreshResult = {
  refreshedDocs: number;
  removedDocs: number;
};

/**
 * Refresh and deduplicate pinned resident docs at a compaction boundary.
 * Missing sources never blank an existing pinned copy. Retired summary/index
 * entries convert only when a map body is available; otherwise the transition
 * stays frozen and retries at the next boundary.
 */
export const refreshResidentStartupDocs = (args: {
  store: RuntimeStore;
  threadKey: string;
  stellaDataDir: string;
}): ResidentStartupDocRefreshResult => {
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
      });
    }
  }

  const result: ResidentStartupDocRefreshResult = {
    refreshedDocs: 0,
    removedDocs: 0,
  };
  const writeEntry = (entry: StartupDocEntry, freshDoc: string): void => {
    if (freshDoc.trim() === entry.persistedDoc.trim()) return;
    if (
      args.store.updateThreadCustomMessageContent({
        threadKey: args.threadKey,
        entryId: entry.entryId,
        content: [{ type: "text", text: freshDoc }],
      })
    ) {
      result.refreshedDocs += 1;
    }
  };
  const removeEntry = (entry: StartupDocEntry): void => {
    if (
      args.store.removeThreadCustomMessage({
        threadKey: args.threadKey,
        entryId: entry.entryId,
      })
    ) {
      result.removedDocs += 1;
    }
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
  return result;
};
