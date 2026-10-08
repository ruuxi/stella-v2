/**
 * ResidentBlock registry — the single owner of the "resident early-context
 * blocks never mutate mid-thread" pattern.
 *
 * A resident block is a piece of context that must sit at a byte-stable
 * position in the provider request for the lifetime of a thread so that
 * provider prompt caches keep hitting: the pinned startup docs (personality,
 * core memory, user profile) and the skill catalog.
 * Every block registers here once and gets exactly two mutation paths. The
 * registry does no I/O: each host (the desktop runtime, the cloud
 * orchestrator) reads its own files and hands the raw text in, so both shape
 * and place every block the same way.
 *
 *   1. Mid-thread delta (`buildResidentContextMessages`): each turn the
 *      block re-renders from current state and is compared byte-for-byte
 *      against the copies already persisted in the thread. Unchanged →
 *      nothing is emitted and the prompt prefix stays byte-identical.
 *      Changed → the full updated block is APPENDED as a hidden message
 *      before the next user message; the canonical copy already in history
 *      is never touched.
 *
 *   2. Compaction fold-in (`buildResidentFold` + the overlay support in
 *      `storage/session-store.js`): compaction is the one moment the cache
 *      is legitimately dead, so the fold re-renders every block from
 *      current state, pins exactly one fresh copy of each at the head of
 *      the rebuilt window, and sweeps all older copies plus accumulated
 *      `runtime.context_delta.*` notices.
 *
 * The window-gated `before_user_message` reminder hooks (connector
 * availability and stale-user) are deliberately NOT folded into
 * this registry: they are advisory, recurring notices rather than resident
 * state, and their once-per-context-window dedup
 * (`runner/reminder-window-gate.ts`) already resets on compaction. They
 * compose cleanly alongside this mechanism and stay hooks.
 */
import { shapeResidentMemoryDoc } from "../memory/resident-doc-shape.js";
import {
  CORE_MEMORY_INJECTED_MAX_CHARS,
  MEMORY_INDEX_INJECTED_MAX_CHARS,
  USER_PROFILE_INJECTED_MAX_CHARS,
} from "../memory/memory-layout.js";
import {
  renderExecutionDevices,
  renderExecutionDestination,
  renderMediaAccess,
} from "@stella/contracts/execution-context";
import { wrapSystemReminder } from "@stella/contracts/system-reminders";

export const BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE = "bootstrap.startup_doc";
export const BOOTSTRAP_SKILLS_CUSTOM_TYPE = "bootstrap.skills_catalog";
/**
 * Custom-type namespace for mid-thread resident-context change notices
 * (e.g. the frozen-tools delta note). Persisted by `run-execution` so store
 * rebuilds reproduce what the model saw, and swept wholesale by the
 * compaction fold-in once the canonical blocks have been re-rendered.
 */
export const CONTEXT_DELTA_CUSTOM_TYPE_PREFIX = "runtime.context_delta.";

/**
 * Marker inside the synthetic entryIds of fold-materialized doc messages
 * (`<overlayEntryId>::resident:<n>`). These entries exist only in the
 * materialized view — compaction span boundaries must never land on one.
 */
export const RESIDENT_FOLD_ENTRY_ID_MARKER = "::resident:";

/**
 * Marker inside the synthetic entryId of the pinned latest-user-instruction
 * message a compaction overlay re-emits right after its checkpoint
 * (`<overlayEntryId>::pinned-instruction`). Exists only in the materialized
 * view — compaction span boundaries must never land on it.
 */
export const PINNED_INSTRUCTION_ENTRY_ID_MARKER = "::pinned-instruction";

export const LIFE_PERSONALITY_DISPLAY_PATH = "~/.stella/PERSONALITY.md";
export const LIFE_CORE_MEMORY_DISPLAY_PATH = "~/.stella/core-memory.md";
export const LIFE_USER_PROFILE_DISPLAY_PATH = "~/.stella/memories/profile.md";
export const LIFE_MEMORY_INDEX_DISPLAY_PATH = "~/.stella/memories/index.md";
export const RETIRED_MEMORY_DISPLAY_PATHS = [
  "~/.stella/memories/MEMORY.md",
  "~/.stella/memories/memory_map.md",
  "~/.stella/memories/memory_summary.md",
  "~/.stella/memories/memory_index.md",
  "~/.stella/memories/memory_shadow.md",
  "~/.stella/memories/raw_memories.md",
];

const buildStartupDocText = (displayPath, content) =>
  [`<startup_doc path="${displayPath}">`, content, "</startup_doc>"].join("\n");

/**
 * The registry. Order is the canonical head order for new threads and for
 * the compaction fold-in. Each block declares:
 *
 *   - `id`          stable identity used in logs and fold bookkeeping;
 *   - `customType`  the persisted custom-message type (all `bootstrap.*`
 *                   so compaction head-protection and run-execution
 *                   persistence keep working unchanged);
 *   - `docPath`     display path when the block renders as a
 *                   `<startup_doc>` wrapper (absent for the skills block,
 *                   which carries its own `<skills>` envelope);
 *   - `resolve`     canonical body from the per-turn agent context
 *                   (deterministic — same state, same bytes);
 *   - `diskFile`    optional data-dir-relative file the compaction fold-in
 *                   re-reads for a fresh render (`renderDiskBody` applies
 *                   the same shaping as `resolve`).
 */
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
        ? shapeResidentMemoryDoc(context.coreMemory, CORE_MEMORY_INJECTED_MAX_CHARS)
        : undefined,
    renderDiskBody: (raw) =>
      shapeResidentMemoryDoc(raw, CORE_MEMORY_INJECTED_MAX_CHARS),
  },
  {
    id: "user-profile",
    customType: BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE,
    docPath: LIFE_USER_PROFILE_DISPLAY_PATH,
    diskFile: "memories/profile.md",
    memoryDoc: true,
    resolve: (context) =>
      context.userProfile
        ? shapeResidentMemoryDoc(context.userProfile, USER_PROFILE_INJECTED_MAX_CHARS)
        : undefined,
    renderDiskBody: (raw) =>
      shapeResidentMemoryDoc(raw, USER_PROFILE_INJECTED_MAX_CHARS),
  },
  {
    // The routing index: one line per nested memory file. Resident because an
    // index the agent cannot see cannot tell it when to go look, which is the
    // whole point of keeping the rest of memory on demand.
    id: "memory-index",
    customType: BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE,
    docPath: LIFE_MEMORY_INDEX_DISPLAY_PATH,
    diskFile: "memories/index.md",
    memoryDoc: true,
    resolve: (context) =>
      context.memoryIndex
        ? shapeResidentMemoryDoc(context.memoryIndex, MEMORY_INDEX_INJECTED_MAX_CHARS)
        : undefined,
    renderDiskBody: (raw) =>
      shapeResidentMemoryDoc(raw, MEMORY_INDEX_INJECTED_MAX_CHARS),
  },
  {
    id: "skills",
    customType: BOOTSTRAP_SKILLS_CUSTOM_TYPE,
    // The catalog carries its own `<skills>` envelope; no startup_doc wrap.
    resolve: (context) => context.skillsCatalog?.trim() || undefined,
  },
  {
    id: "execution-devices",
    customType: BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE,
    docPath: "stella://context/execution-devices",
    resolve: (context) =>
      context.executionContext
        ? renderExecutionDevices(context.executionContext)
        : undefined,
  },
  {
    id: "execution-destination",
    customType: BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE,
    docPath: "stella://context/execution-destination",
    resolve: (context) =>
      context.executionContext
        ? renderExecutionDestination(context.executionContext)
        : undefined,
    changeReminder: (context) =>
      wrapSystemReminder(
        `The execution destination changed. ${renderExecutionDestination(context.executionContext)} Existing agents keep their own execution locations.`,
      ),
  },
  {
    // Whether the user can generate media right now. Rides the execution
    // context snapshot stamped on each user message, so a plan or key change
    // mid-thread lands as a delta and compaction folds in the latest copy.
    id: "media-access",
    customType: BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE,
    docPath: "stella://context/media-access",
    resolve: (context) =>
      context.executionContext
        ? renderMediaAccess(context.executionContext)
        : undefined,
    changeReminder: (context) =>
      wrapSystemReminder(
        `What the user can generate changed:\n${renderMediaAccess(context.executionContext)}`,
      ),
  },
];

/** Full message text for a block, or undefined when the block is absent. */
export const renderResidentBlockText = (block, context) => {
  const body = block.resolve(context);
  if (!body) return undefined;
  return block.docPath ? buildStartupDocText(block.docPath, body) : body;
};

/** The memory documents kept resident, by the display path the model sees. */
export const RESIDENT_MEMORY_DISPLAY_PATHS = [
  LIFE_CORE_MEMORY_DISPLAY_PATH,
  LIFE_USER_PROFILE_DISPLAY_PATH,
  LIFE_MEMORY_INDEX_DISPLAY_PATH,
];

const MEMORY_FIELD_BY_DISPLAY_PATH = new Map([
  [LIFE_CORE_MEMORY_DISPLAY_PATH, "coreMemory"],
  [LIFE_USER_PROFILE_DISPLAY_PATH, "userProfile"],
  [LIFE_MEMORY_INDEX_DISPLAY_PATH, "memoryIndex"],
]);

/**
 * The resident memory fields from a host's documents, keyed by the display
 * path the model sees (`~/.stella/core-memory.md`, ...). Documents at any
 * other path are not resident; they are read on demand.
 */
export const residentMemoryFromDocs = (docs) => {
  const fields = {};
  for (const doc of docs) {
    const field = MEMORY_FIELD_BY_DISPLAY_PATH.get(doc.displayPath);
    if (field && doc.content.trim()) fields[field] = doc.content;
  }
  return fields;
};

export const customMessageContentText = (content) => {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((entry) => (entry.type === "text" ? entry.text : ""))
    .join("\n");
};

/** Startup messages for retired automatic-memory artifacts must never replay. */
export const isRetiredMemoryCustomMessage = (customMessage) => {
  if (!customMessage) return false;
  const text = customMessageContentText(customMessage.content);
  return RETIRED_MEMORY_DISPLAY_PATHS.some((displayPath) =>
    text.includes(displayPath),
  );
};

const latestResidentText = (context, block) => {
  const identity = block.docPath ? `doc:${block.docPath}` : block.id;
  const history = context.threadHistory ?? [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (
      entry.role !== "runtimeInternal" ||
      residentIdentityForCustomMessage(entry.customMessage) !== identity
    )
      continue;
    return customMessageContentText(entry.customMessage.content).trim();
  }
  return undefined;
};

const createInternalPromptMessage = (text, customType) => ({
  text,
  uiVisibility: "hidden",
  messageType: "message",
  customType,
});

/**
 * The single mid-thread mutation path: render every registered block from
 * the current agent context and emit an appended copy for each block whose
 * exact bytes are not already present in the thread. First turn → the full
 * canonical head; later turns → only the blocks that actually changed.
 */
export const buildResidentContextMessages = (context) => {
  const messages = [];
  for (const block of RESIDENT_BLOCKS) {
    const text = renderResidentBlockText(block, context);
    if (!text) continue;
    // Compare with the latest copy, not any historical match: A → B → A
    // is still a change and must restore A before the next user message.
    const previous = latestResidentText(context, block);
    if (previous === text.trim()) continue;
    messages.push(createInternalPromptMessage(text, block.customType));
    if (previous && block.changeReminder) {
      messages.push(
        createInternalPromptMessage(
          block.changeReminder(context),
          `${CONTEXT_DELTA_CUSTOM_TYPE_PREFIX}${block.id}`,
        ),
      );
    }
  }
  return messages;
};

const STARTUP_DOC_PATH_RE = /^<startup_doc path="([^"]+)">/;
const STARTUP_DOC_BODY_RE =
  /^<startup_doc path="[^"]+">\n([\s\S]*)\n<\/startup_doc>$/;

/** Display path from a rendered `<startup_doc>` body, or null. */
export const parseStartupDocPath = (text) => {
  const match = STARTUP_DOC_PATH_RE.exec(text.trim());
  return match?.[1] ?? null;
};

const parseStartupDocBody = (text) =>
  STARTUP_DOC_BODY_RE.exec(text.trim())?.[1] ?? null;

/**
 * Stable fold identity for a persisted resident-block custom message:
 * `skills` for the skill catalog, `doc:<display path>` for startup docs
 * (including legacy docs this registry no longer renders, e.g. the old
 * registry.md doc — they still fold as themselves). Null for anything that
 * is not a resident block.
 */
export const residentIdentityForCustomMessage = (customMessage) => {
  if (!customMessage) return null;
  if (isRetiredMemoryCustomMessage(customMessage)) return null;
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

/** Upper bound on folded docs; guards against a pathological thread. */
const MAX_FOLD_DOCS = 16;

/**
 * Compaction-time fold plan. Scans the materialized thread for resident
 * blocks (newest copy wins per identity — this is what heals legacy threads
 * that accumulated duplicate appends), then re-renders registered docs from
 * current disk state where possible:
 *
 *   - personality/core-memory/profile/index re-read their files through
 *     the host's `readDiskFile` (memory docs only when
 *     `refreshMemoryDocsFromDisk`), falling back to the newest in-thread
 *     copy when the file is missing/empty;
 *   - the skills block keeps the newest in-thread copy — its render options
 *     (engine-specific omissions) are unknown at compaction time, and the
 *     per-turn delta path re-appends a fresh catalog next turn if disk
 *     state drifted.
 *
 * Returns `{ docs: [{ customType, text }] }` in canonical head order (plus
 * unknown legacy docs in first-seen order), or null when the thread has no
 * resident blocks. The result rides the compaction entry's `details` and is
 * applied by the overlay materializer in `storage/session-store.js`.
 */
export const buildResidentFold = (args) => {
  const newestByIdentity = new Map();
  const firstSeenOrder = [];
  for (const message of args.messages) {
    if (message.role !== "runtimeInternal" || !message.customMessage) {
      continue;
    }
    if (isRetiredMemoryCustomMessage(message.customMessage)) continue;
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

  const readDiskFile = args.readDiskFile;
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
      readDiskFile &&
      (!block.memoryDoc || refreshMemoryDocs)
    ) {
      const raw = readDiskFile(block.diskFile);
      const body = raw === null ? undefined : block.renderDiskBody(raw);
      if (body) {
        text = buildStartupDocText(block.docPath, body);
      }
    }
    emitted.add(identity);
    docs.push({ customType: inThread.customType, text });
  };

  // Canonical order first, then unknown legacy identities as encountered.
  for (const block of RESIDENT_BLOCKS) {
    emit(block.docPath ? `doc:${block.docPath}` : "skills");
  }
  for (const identity of firstSeenOrder) {
    emit(identity);
  }
  return docs.length > 0 ? { docs } : null;
};

/**
 * Validate a `residentFold` recovered from a persisted compaction entry's
 * `details`. Returns `{ docs, identities }` or null when malformed.
 */
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
      isRetiredMemoryCustomMessage({
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
