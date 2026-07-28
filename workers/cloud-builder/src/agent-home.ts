/**
 * The cloud agent home: the owner's memory documents, stored in R2.
 *
 * Desktop Stella keeps these under `~/.stella` and push-injects them into the
 * orchestrator at session start, which is why it feels like it knows the user.
 * The cloud orchestrator has no disk, so the same three documents live in an
 * R2 bucket keyed by a hash of the owner id, and the DO reads them at turn
 * start. `profile.md` is the only one the orchestrator writes (via Remember);
 * `MEMORY.md` and `memory_map.md` are read-only here until a cloud Dream
 * exists to produce them.
 *
 * Everything in this module has to run in workerd, so the desktop's
 * `kernel/memory/*` stores (node:fs, node:crypto) cannot be imported. The
 * profile format, caps, and dedupe rules are reproduced deliberately: a future
 * sync between desktop and cloud homes has to compare byte-for-byte.
 */

import { redactMemoryText } from "@stella/runtime/kernel/memory/redaction.js";
import { sha256Hex } from "./hash.js";

export const MEMORY_DOC_NAMES = [
  "MEMORY.md",
  "profile.md",
  "memory_map.md",
] as const;

export type MemoryDocName = (typeof MEMORY_DOC_NAMES)[number];

/**
 * Display paths mirror `kernel/memory/resident-docs.ts` so the model sees the
 * same document identity it sees on the desktop. Duplicated rather than
 * imported: that module reads node:fs at load time.
 */
const DISPLAY_PATHS: Record<MemoryDocName, string> = {
  "MEMORY.md": "~/.stella/MEMORY.md",
  "profile.md": "~/.stella/memories/profile.md",
  "memory_map.md": "~/.stella/memories/memory_map.md",
};

/** Matches `MAX_USER_PROFILE_CHARS` in the desktop user-profile store. */
export const MAX_USER_PROFILE_CHARS = 6_000;

// Read-side caps. The orchestrator pays for these bytes on every single turn,
// including cheap ones, so they are deliberately tighter than the desktop's
// budgets and the total is capped again below.
const DOC_MAX_CHARS: Record<MemoryDocName, number> = {
  "MEMORY.md": 8_000,
  "profile.md": 7_000,
  "memory_map.md": 6_000,
};
const INJECTED_TOTAL_MAX_CHARS = 16_000;

const PROFILE_HEADER = [
  "# User Profile",
  "",
  "> Durable facts Stella knows about the user — written via the Remember",
  "> tool and injected into the Orchestrator at the start of every session.",
  "> Keep entries short and high-signal.",
  "",
].join("\n");

export type MemoryDocument = {
  name: MemoryDocName;
  displayPath: string;
  content: string;
};

export type ProfileAction = "add" | "replace" | "remove";

export type ProfileOperation = {
  action: ProfileAction;
  content?: string;
  oldContent?: string;
};

export type ProfileOperationResult = {
  ok: boolean;
  message: string;
  entryCount: number;
  bytes: number;
  /** Set only when this call actually rewrote the object. */
  written?: { r2Key: string; sizeBytes: number };
};

const collapseWhitespace = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

const sameEntry = (a: string, b: string): boolean =>
  a.toLocaleLowerCase() === b.toLocaleLowerCase();

const truncateAtLineBoundary = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text;
  const marker = "\n...[truncated]";
  const budget = Math.max(0, maxChars - marker.length);
  const cut = text.slice(0, budget);
  const lastBreak = cut.lastIndexOf("\n");
  return `${lastBreak > 0 ? cut.slice(0, lastBreak) : cut}${marker}`;
};

export const parseProfileEntries = (content: string): string[] => {
  const entries: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+(.*)$/);
    if (!match) continue;
    const entry = collapseWhitespace(match[1] ?? "");
    if (entry) entries.push(entry);
  }
  return entries;
};

const renderProfile = (entries: string[]): string =>
  `${PROFILE_HEADER}${entries.map((entry) => `- ${entry}`).join("\n")}\n`;

const entriesBodyLength = (entries: string[]): number =>
  entries.reduce((sum, entry) => sum + entry.length + 3, 0);

/**
 * Wrap a document the way the desktop prompt builder does, so the model reads
 * cloud memory with exactly the framing it reads local memory with.
 */
export const buildStartupDocBlock = (
  displayPath: string,
  content: string,
): string =>
  [`<startup_doc path="${displayPath}">`, content, "</startup_doc>"].join("\n");

export const buildResidentMemorySection = (
  documents: MemoryDocument[],
): string =>
  documents
    .map((document) =>
      buildStartupDocBlock(document.displayPath, document.content),
    )
    .join("\n\n");

export class AgentHomeUnavailableError extends Error {
  constructor() {
    super("Stella's memory isn't available in this environment yet.");
    this.name = "AgentHomeUnavailableError";
  }
}

export class AgentHome {
  private prefixPromise?: Promise<string>;

  // Serializes this DO's own read-modify-write cycles. Tool calls in one turn
  // can run in parallel, and two Remembers reading the same object would
  // otherwise race; the conditional put below is what guards writers in
  // *other* isolates.
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly bucket: R2Bucket | undefined,
    private readonly ownerId: string,
  ) {}

  get available(): boolean {
    return Boolean(this.bucket);
  }

  private prefix(): Promise<string> {
    this.prefixPromise ??= sha256Hex(this.ownerId).then(
      (hash) => `agent-home/${hash}/memories/`,
    );
    return this.prefixPromise;
  }

  private async key(name: MemoryDocName): Promise<string> {
    return `${await this.prefix()}${name}`;
  }

  private async read(
    name: MemoryDocName,
  ): Promise<{ content: string; etag?: string } | null> {
    if (!this.bucket) return null;
    const object = await this.bucket.get(await this.key(name));
    if (!object) return null;
    return { content: await object.text(), etag: object.etag };
  }

  /**
   * The resident documents, redacted and capped, newest-policy order: core
   * memory, then durable profile facts, then the routing map. Missing or
   * empty documents are simply absent — a first-time owner has none.
   */
  async readDocuments(): Promise<MemoryDocument[]> {
    if (!this.bucket) return [];
    const settled = await Promise.all(
      MEMORY_DOC_NAMES.map(async (name) => {
        try {
          return { name, stored: await this.read(name) };
        } catch {
          // A memory read must never be the reason a turn fails.
          return { name, stored: null };
        }
      }),
    );
    const documents: MemoryDocument[] = [];
    let budget = INJECTED_TOTAL_MAX_CHARS;
    for (const { name, stored } of settled) {
      const raw = stored?.content?.trim();
      if (!raw) continue;
      const capped = truncateAtLineBoundary(
        redactMemoryText(raw),
        Math.min(DOC_MAX_CHARS[name], budget),
      );
      if (!capped.trim()) continue;
      budget -= capped.length;
      documents.push({
        name,
        displayPath: DISPLAY_PATHS[name],
        content: capped,
      });
      if (budget <= 0) break;
    }
    return documents;
  }

  /**
   * The user's personality override, when their cloud home carries one
   * (`agent-home/<hash>/PERSONALITY.md`, sibling of `memories/`). Nothing
   * writes it yet — it exists so a future desktop→cloud home sync lands the
   * user's customized personality without a worker change; until then the
   * caller falls back to the canonical default personality.
   */
  async readPersonality(): Promise<string | null> {
    if (!this.bucket) return null;
    try {
      const prefix = await this.prefix();
      const object = await this.bucket.get(
        `${prefix.replace(/memories\/$/, "")}PERSONALITY.md`,
      );
      if (!object) return null;
      const content = redactMemoryText(await object.text()).trim();
      if (!content) return null;
      return truncateAtLineBoundary(content, 6_000);
    } catch {
      // Personality is context, not correctness.
      return null;
    }
  }

  /**
   * Apply one add/replace/remove against `profile.md`. The whole object is
   * rewritten atomically, guarded by the stored etag so a concurrent writer's
   * entry is re-read instead of clobbered.
   */
  applyProfileOperation(
    operation: ProfileOperation,
  ): Promise<ProfileOperationResult> {
    const run = this.writeChain.then(
      () => this.applyProfileOperationLocked(operation),
      () => this.applyProfileOperationLocked(operation),
    );
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async applyProfileOperationLocked(
    operation: ProfileOperation,
  ): Promise<ProfileOperationResult> {
    const bucket = this.bucket;
    if (!bucket) throw new AgentHomeUnavailableError();
    const key = await this.key("profile.md");
    const content = operation.content
      ? collapseWhitespace(redactMemoryText(operation.content))
      : "";
    const oldContent = operation.oldContent
      ? collapseWhitespace(redactMemoryText(operation.oldContent))
      : "";

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const stored = await this.read("profile.md");
      const entries = stored ? parseProfileEntries(stored.content) : [];
      const outcome = applyToEntries(entries, operation.action, {
        content,
        oldContent,
      });
      if (!outcome.ok || !outcome.next) {
        return { ...outcome, bytes: entriesBodyLength(entries) };
      }
      const body = renderProfile(outcome.next);
      // etagMatches pins the exact object read above; etagDoesNotMatch "*"
      // means "only if it does not exist yet", which is what a first write
      // needs. Either failing returns null — someone else wrote in between,
      // so re-read and reapply rather than overwrite their entry.
      const put = await bucket.put(key, body, {
        onlyIf: stored?.etag
          ? { etagMatches: stored.etag }
          : { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      });
      if (put) {
        return {
          ok: true,
          message: outcome.message,
          entryCount: outcome.next.length,
          bytes: entriesBodyLength(outcome.next),
          written: {
            r2Key: key,
            sizeBytes: new TextEncoder().encode(body).byteLength,
          },
        };
      }
    }
    return {
      ok: false,
      message:
        "Another update to the profile landed first; nothing was written. Try again.",
      entryCount: 0,
      bytes: 0,
    };
  }
}

const applyToEntries = (
  entries: string[],
  action: ProfileAction,
  args: { content: string; oldContent: string },
): { ok: boolean; message: string; entryCount: number; next?: string[] } => {
  const findIndex = (needle: string): number => {
    if (!needle) return -1;
    const exact = entries.findIndex((entry) => sameEntry(entry, needle));
    if (exact !== -1) return exact;
    const lower = needle.toLocaleLowerCase();
    return entries.findIndex((entry) =>
      entry.toLocaleLowerCase().includes(lower),
    );
  };

  if (action === "add") {
    if (!args.content) {
      return {
        ok: false,
        message: "add requires content.",
        entryCount: entries.length,
      };
    }
    if (entries.some((entry) => sameEntry(entry, args.content))) {
      return {
        ok: true,
        message: "Already remembered; left unchanged.",
        entryCount: entries.length,
      };
    }
    const next = [...entries, args.content];
    if (entriesBodyLength(next) > MAX_USER_PROFILE_CHARS) {
      return {
        ok: false,
        message:
          "The profile is full. Replace or remove a stale fact before adding more.",
        entryCount: entries.length,
      };
    }
    return { ok: true, message: "Remembered.", entryCount: next.length, next };
  }

  if (action === "replace") {
    if (!args.oldContent || !args.content) {
      return {
        ok: false,
        message: "replace requires both old_content and content.",
        entryCount: entries.length,
      };
    }
    const index = findIndex(args.oldContent);
    if (index === -1) {
      return {
        ok: false,
        message: "No matching fact to replace.",
        entryCount: entries.length,
      };
    }
    const next = [...entries];
    next[index] = args.content;
    if (entriesBodyLength(next) > MAX_USER_PROFILE_CHARS) {
      return {
        ok: false,
        message: "That replacement would exceed the profile size cap.",
        entryCount: entries.length,
      };
    }
    return { ok: true, message: "Updated.", entryCount: next.length, next };
  }

  const index = findIndex(args.content);
  if (index === -1) {
    return {
      ok: false,
      message: "No matching fact to remove.",
      entryCount: entries.length,
    };
  }
  const next = entries.filter((_entry, position) => position !== index);
  return { ok: true, message: "Forgotten.", entryCount: next.length, next };
};
