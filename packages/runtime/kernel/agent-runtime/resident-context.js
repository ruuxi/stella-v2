import fs from "node:fs";
import path from "node:path";
import { redactMemoryText } from "../memory/redaction.js";
import {
  capResidentMemoryDoc,
  MEMORY_MAP_MAX_CHARS,
} from "../memory/dream-storage.js";

export const BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE = "bootstrap.startup_doc";
export const BOOTSTRAP_SKILLS_CUSTOM_TYPE = "bootstrap.skills_catalog";

export const CONTEXT_DELTA_CUSTOM_TYPE_PREFIX = "runtime.context_delta.";

export const RESIDENT_FOLD_ENTRY_ID_MARKER = "::resident:";

export const PINNED_INSTRUCTION_ENTRY_ID_MARKER = "::pinned-instruction";

export const LIFE_PERSONALITY_DISPLAY_PATH = "~/.stella/PERSONALITY.md";
export const LIFE_CORE_MEMORY_DISPLAY_PATH = "~/.stella/core-memory.md";
export const LIFE_USER_PROFILE_DISPLAY_PATH = "~/.stella/memories/profile.md";
export const LIFE_MEMORY_MAP_DISPLAY_PATH = "~/.stella/memories/memory_map.md";
export const RETIRED_MEMORY_SUMMARY_DISPLAY_PATH =
  "~/.stella/memories/memory_summary.md";

const buildStartupDocText = (displayPath, content) =>
  [`<startup_doc path="${displayPath}">`, content, "</startup_doc>"].join("\n");

export const RESIDENT_BLOCKS = [
  {
    id: "personality",
    customType: BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE,
    docPath: LIFE_PERSONALITY_DISPLAY_PATH,
    diskFile: "PERSONALITY.md",
    memoryDoc: false,
    resolve: (context) => context.personality?.trim() || undefined,
    renderDiskBody: (raw) => raw.trim() || undefined,
  },
  {
    id: "core-memory",
    customType: BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE,
    docPath: LIFE_CORE_MEMORY_DISPLAY_PATH,
    diskFile: "core-memory.md",
    memoryDoc: true,
    resolve: (context) =>
      context.coreMemory
        ? redactMemoryText(context.coreMemory.trim()) || undefined
        : undefined,
    renderDiskBody: (raw) =>
      raw.trim() ? redactMemoryText(raw.trim()) || undefined : undefined,
  },
  {
    id: "user-profile",
    customType: BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE,
    docPath: LIFE_USER_PROFILE_DISPLAY_PATH,
    diskFile: path.join("memories", "profile.md"),
    memoryDoc: true,
    resolve: (context) =>
      context.userProfile
        ? redactMemoryText(context.userProfile.trim()) || undefined
        : undefined,
    renderDiskBody: (raw) =>
      raw.trim() ? redactMemoryText(raw.trim()) || undefined : undefined,
  },
  {
    id: "memory-map",
    customType: BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE,
    docPath: LIFE_MEMORY_MAP_DISPLAY_PATH,
    diskFile: path.join("memories", "memory_map.md"),
    memoryDoc: true,
    resolve: (context) => {
      const raw = context.memoryMap
        ? redactMemoryText(context.memoryMap.trim())
        : "";
      return raw ? capResidentMemoryDoc(raw, MEMORY_MAP_MAX_CHARS) : undefined;
    },
    renderDiskBody: (raw) => {
      const redacted = raw.trim() ? redactMemoryText(raw.trim()) : "";
      return redacted
        ? capResidentMemoryDoc(redacted, MEMORY_MAP_MAX_CHARS)
        : undefined;
    },
  },
  {
    id: "skills",
    customType: BOOTSTRAP_SKILLS_CUSTOM_TYPE,

    resolve: (context) => context.skillsCatalog?.trim() || undefined,
  },
];

export const renderResidentBlockText = (block, context) => {
  const body = block.resolve(context);
  if (!body) return undefined;
  return block.docPath ? buildStartupDocText(block.docPath, body) : body;
};

export const customMessageContentText = (content) => {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((entry) => (entry.type === "text" ? entry.text : ""))
    .join("\n");
};

export const isRetiredMemorySummaryCustomMessage = (customMessage) =>
  Boolean(
    customMessage &&
      customMessageContentText(customMessage.content).includes(
        RETIRED_MEMORY_SUMMARY_DISPLAY_PATH,
      ),
  );

const hasPersistedResidentText = (context, customType, text) => {
  const needle = text.trim();
  return (
    context.threadHistory?.some((entry) => {
      const customMessage = entry.customMessage;
      if (
        entry.role !== "runtimeInternal" ||
        customMessage?.customType !== customType
      ) {
        return false;
      }

      return customMessageContentText(customMessage.content).trim() === needle;
    }) ?? false
  );
};

const createInternalPromptMessage = (text, customType) => ({
  text,
  uiVisibility: "hidden",
  messageType: "message",
  customType,
});

export const buildResidentContextMessages = (context) => {
  const messages = [];
  for (const block of RESIDENT_BLOCKS) {
    const text = renderResidentBlockText(block, context);
    if (!text) continue;
    if (hasPersistedResidentText(context, block.customType, text)) continue;
    messages.push(createInternalPromptMessage(text, block.customType));
  }
  return messages;
};

const STARTUP_DOC_PATH_RE = /^<startup_doc path="([^"]+)">/;
const STARTUP_DOC_BODY_RE =
  /^<startup_doc path="[^"]+">\n([\s\S]*)\n<\/startup_doc>$/;

export const parseStartupDocPath = (text) => {
  const match = STARTUP_DOC_PATH_RE.exec(text.trim());
  return match?.[1] ?? null;
};

const parseStartupDocBody = (text) =>
  STARTUP_DOC_BODY_RE.exec(text.trim())?.[1] ?? null;

export const residentIdentityForCustomMessage = (customMessage) => {
  if (!customMessage) return null;
  if (isRetiredMemorySummaryCustomMessage(customMessage)) return null;
  if (customMessage.customType === BOOTSTRAP_SKILLS_CUSTOM_TYPE) {
    return "skills";
  }
  if (customMessage.customType === BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE) {
    const docPath = parseStartupDocPath(
      customMessageContentText(customMessage.content),
    );
    return docPath ? `doc:${docPath}` : null;
  }
  return null;
};

const blockByDocIdentity = new Map(
  RESIDENT_BLOCKS.filter((block) => block.docPath).map((block) => [
    `doc:${block.docPath}`,
    block,
  ]),
);

const canonicalizeInThreadDocText = (identity, text) => {
  const block = blockByDocIdentity.get(identity);
  if (!block?.docPath || !block.renderDiskBody) return text;
  const body = parseStartupDocBody(text);
  const canonicalBody = body === null ? undefined : block.renderDiskBody(body);
  return canonicalBody
    ? buildStartupDocText(block.docPath, canonicalBody)
    : text;
};

const readOptionalDiskFile = (filePath) => {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
};

const MAX_FOLD_DOCS = 16;

export const buildResidentFold = (args) => {
  const newestByIdentity = new Map();
  const firstSeenOrder = [];
  for (const message of args.messages) {
    if (message.role !== "runtimeInternal" || !message.customMessage) {
      continue;
    }
    if (isRetiredMemorySummaryCustomMessage(message.customMessage)) continue;
    const identity = residentIdentityForCustomMessage(message.customMessage);
    if (!identity) continue;
    if (!newestByIdentity.has(identity)) {
      firstSeenOrder.push(identity);
    }
    newestByIdentity.set(identity, {
      customType: message.customMessage.customType,
      text: customMessageContentText(message.customMessage.content).trim(),
    });
  }
  if (newestByIdentity.size === 0) {
    return null;
  }

  const stellaDataDir = args.stellaDataDir?.trim();
  const refreshMemoryDocs = args.refreshMemoryDocsFromDisk === true;
  const docs = [];
  const emitted = new Set();
  const emit = (identity) => {
    if (emitted.has(identity) || docs.length >= MAX_FOLD_DOCS) return;
    const inThread = newestByIdentity.get(identity);
    if (!inThread?.text) return;
    const block = blockByDocIdentity.get(identity);
    let text = canonicalizeInThreadDocText(identity, inThread.text);
    if (
      block?.diskFile &&
      block.renderDiskBody &&
      stellaDataDir &&
      (!block.memoryDoc || refreshMemoryDocs)
    ) {
      const raw = readOptionalDiskFile(
        path.join(stellaDataDir, block.diskFile),
      );
      const body = raw === null ? undefined : block.renderDiskBody(raw);
      if (body) {
        text = buildStartupDocText(block.docPath, body);
      }
    }
    emitted.add(identity);
    docs.push({ customType: inThread.customType, text });
  };

  for (const block of RESIDENT_BLOCKS) {
    emit(block.docPath ? `doc:${block.docPath}` : "skills");
  }
  for (const identity of firstSeenOrder) {
    emit(identity);
  }
  return docs.length > 0 ? { docs } : null;
};

export const parseResidentFold = (details) => {
  const fold =
    details && typeof details === "object" && !Array.isArray(details)
      ? details.residentFold
      : undefined;
  const rawDocs =
    fold && typeof fold === "object" && Array.isArray(fold.docs)
      ? fold.docs
      : null;
  if (!rawDocs || rawDocs.length === 0) return null;
  const docs = [];
  const identities = new Set();
  for (const doc of rawDocs.slice(0, MAX_FOLD_DOCS)) {
    if (
      !doc ||
      typeof doc.customType !== "string" ||
      !doc.customType.trim() ||
      typeof doc.text !== "string" ||
      !doc.text.trim()
    ) {
      continue;
    }
    if (
      isRetiredMemorySummaryCustomMessage({
        customType: doc.customType,
        content: doc.text,
      })
    ) {
      continue;
    }
    const identity = residentIdentityForCustomMessage({
      customType: doc.customType,
      content: doc.text,
    });
    const text = identity
      ? canonicalizeInThreadDocText(identity, doc.text)
      : doc.text;
    docs.push({ customType: doc.customType, text });
    if (identity) identities.add(identity);
  }
  return docs.length > 0 ? { docs, identities } : null;
};
