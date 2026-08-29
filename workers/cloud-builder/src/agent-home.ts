/**
 * The cloud agent home: the owner's memory documents, stored in R2.
 *
 * Desktop Stella keeps user-owned Markdown under `~/.stella`. Owner-fenced
 * Cloud Home import/sync copies applicable documents into generation-scoped R2
 * state, and the DO reads that authoritative cloud state at turn start.
 * Remember writes `profile.md`. `MEMORY.md`, `memory_map.md` and archive
 * documents are now read-only surfaces for Recall: nothing in the cloud writes
 * them, and they exist only when desktop or mobile sync imported them.
 * Explicit Cloud Home sync can also materialize personality and imported
 * user-owned Markdown.
 *
 * Everything in this module has to run in workerd, so the desktop's
 * `kernel/memory/*` stores (node:fs, node:crypto) cannot be imported. The
 * profile format, caps, and dedupe rules are reproduced deliberately: a future
 * sync between desktop and cloud homes has to compare byte-for-byte.
 */

import { redactMemoryText } from "@stella/runtime/kernel/memory/redaction.js";
import { sha256Hex } from "./hash.js";
import {
  CloudHomeProtocolError,
  CloudHomeStore,
  type CloudHomeEndpoint,
  type CloudMemoryHead,
  type CloudMemoryPreference,
  type CloudSkillCatalogSnapshot,
  utf8Bytes,
  utf8Text,
} from "./cloud-home-store.js";

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
  "MEMORY.md": "~/.stella/memories/MEMORY.md",
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
  name: string;
  displayPath: string;
  content: string;
};

export const importedMemoryDocumentFromKey = (
  ownerRoot: string,
  key: string,
): { name: string; policyName: MemoryDocName; displayPath: string } | null => {
  const importedPrefix = `${ownerRoot}__stella_imported__/`;
  if (!key.startsWith(importedPrefix)) return null;
  const relative = key.slice(importedPrefix.length);
  const segments = relative.split("/");
  const fileName = segments.at(-1);
  if (
    segments.length < 3 ||
    segments.at(-2) !== "memories" ||
    !MEMORY_DOC_NAMES.includes(fileName as MemoryDocName)
  ) {
    return null;
  }
  const source = segments.slice(0, -2).join("/");
  return {
    name: `${fileName} (imported ${source.slice(0, 12)})`,
    policyName: fileName as MemoryDocName,
    displayPath: `~/.stella/imported/${source}/${fileName}`,
  };
};

export type ProfileAction = "add" | "replace" | "remove";

export type ProfileOperation = {
  action: ProfileAction;
  content?: string;
  oldContent?: string;
  /** Stable for one tool call; conflict retries append their attempt number. */
  idempotencyKey?: string;
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

export const agentHomeOwnerRoot = async (ownerId: string): Promise<string> =>
  `agent-home/${await sha256Hex(ownerId)}/`;

export const agentHomeGenerationRoot = async (
  ownerId: string,
  ownerGeneration: string,
): Promise<string> => {
  const [ownerRoot, generationHash] = await Promise.all([
    agentHomeOwnerRoot(ownerId),
    sha256Hex(ownerGeneration),
  ]);
  return `${ownerRoot}generations/${generationHash}/`;
};

export class AgentHome {
  private ownerRootPromise?: Promise<string>;
  private prefixPromise?: Promise<string>;
  private readonly cloud?: CloudHomeStore;

  // Serializes this DO's own read-modify-write cycles. Tool calls in one turn
  // can run in parallel, and two Remembers reading the same object would
  // otherwise race; the conditional put below is what guards writers in
  // *other* isolates.
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly bucket: R2Bucket | undefined,
    private readonly ownerId: string,
    private readonly ownerGeneration: string,
    endpoint?: Omit<CloudHomeEndpoint, "ownerId">,
  ) {
    if (bucket && endpoint) {
      this.cloud = new CloudHomeStore(bucket, { ...endpoint, ownerId });
    }
  }

  get available(): boolean {
    return Boolean(this.bucket && this.cloud);
  }

  async loadSkillCatalog(
    agentType: "orchestrator" | "general",
  ): Promise<CloudSkillCatalogSnapshot> {
    if (!this.cloud) throw new AgentHomeUnavailableError();
    return await this.cloud.loadSkillCatalog(agentType);
  }

  cloudStore(): CloudHomeStore {
    if (!this.cloud) throw new AgentHomeUnavailableError();
    return this.cloud;
  }

  async getMemoryPreference(): Promise<CloudMemoryPreference> {
    if (!this.cloud) throw new AgentHomeUnavailableError();
    return await this.cloud.getMemoryPreference();
  }

  private ownerRoot(): Promise<string> {
    this.ownerRootPromise ??= agentHomeOwnerRoot(this.ownerId);
    return this.ownerRootPromise;
  }

  private prefix(): Promise<string> {
    this.prefixPromise ??= agentHomeGenerationRoot(
      this.ownerId,
      this.ownerGeneration,
    ).then((root) => `${root}memories/`);
    return this.prefixPromise;
  }

  private async key(name: MemoryDocName): Promise<string> {
    return `${await this.prefix()}${name}`;
  }

  private async readKey(
    key: string,
  ): Promise<{ content: string; etag?: string } | null> {
    if (!this.bucket) return null;
    const object = await this.bucket.get(key);
    if (!object) return null;
    return { content: await object.text(), etag: object.etag };
  }

  private async read(
    name: MemoryDocName,
  ): Promise<{ content: string; etag?: string } | null> {
    return await this.readKey(await this.key(name));
  }

  /**
   * The resident documents, redacted and capped, newest-policy order: core
   * memory, then durable profile facts, then the routing map. Missing or
   * empty documents are simply absent — a first-time owner has none.
   */
  async readDocuments(): Promise<MemoryDocument[]> {
    if (!this.bucket) return [];
    if (this.cloud) {
      const heads = await this.cloud.listMemoryHeads(100);
      const canonicalOrder = new Map([
        ["core-memory.md", 0],
        ["MEMORY.md", 1],
        ["memories/profile.md", 2],
        ["memories/memory_map.md", 3],
      ]);
      const candidates = heads
        .filter(
          (head) =>
            head.kind !== "personality" && head.name !== "PERSONALITY.md",
        )
        .sort(
          (a, b) =>
            (canonicalOrder.get(a.name) ?? 10) -
              (canonicalOrder.get(b.name) ?? 10) ||
            b.updatedAt - a.updatedAt ||
            a.name.localeCompare(b.name),
        );
      const documents: MemoryDocument[] = [];
      let budget = INJECTED_TOTAL_MAX_CHARS;
      for (const head of candidates) {
        if (budget <= 0) break;
        // Once Convex advertises an authoritative head, missing/corrupt bytes
        // are a blocking integrity failure. Continuing with an apparently
        // ordinary memoryless turn would hide data loss from the owner.
        const bytes = head.sha256
          ? await this.cloud.readMemoryHeadBytes(head)
          : await this.readAndUpgradeLegacyHead(head);
        const raw = utf8Text(bytes).trim();
        if (!raw) continue;
        const perDocumentMax =
          head.kind === "memory"
            ? DOC_MAX_CHARS["MEMORY.md"]
            : head.kind === "profile"
              ? DOC_MAX_CHARS["profile.md"]
              : head.kind === "memory_map"
                ? DOC_MAX_CHARS["memory_map.md"]
                : head.kind === "core_memory"
                  ? 6_000
                  : 4_000;
        const capped = truncateAtLineBoundary(
          redactMemoryText(raw),
          Math.min(perDocumentMax, budget),
        );
        if (!capped.trim()) continue;
        budget -= capped.length;
        documents.push({
          name: head.name,
          displayPath: head.displayPath,
          content: capped,
        });
      }
      // An empty authoritative catalog is the only valid memoryless state.
      return documents;
    }
    const canonicalPrefix = await this.prefix();
    const ownerRoot = await this.ownerRoot();
    const imported = await this.bucket
      .list({
        prefix: `${ownerRoot}__stella_imported__/`,
        limit: 20,
      })
      .catch(() => ({ objects: [] as R2Object[] }));
    const candidates = [
      ...MEMORY_DOC_NAMES.map((name) => ({
        name,
        policyName: name,
        displayPath: DISPLAY_PATHS[name],
        key: `${canonicalPrefix}${name}`,
      })),
      ...imported.objects.flatMap((object) => {
        const parsed = importedMemoryDocumentFromKey(ownerRoot, object.key);
        return parsed ? [{ ...parsed, key: object.key }] : [];
      }),
    ];
    const settled = await Promise.all(
      candidates.map(async (candidate) => {
        try {
          return {
            ...candidate,
            stored: await this.readKey(candidate.key),
          };
        } catch {
          // A memory read must never be the reason a turn fails.
          return { ...candidate, stored: null };
        }
      }),
    );
    const documents: MemoryDocument[] = [];
    let budget = INJECTED_TOTAL_MAX_CHARS;
    for (const { name, policyName, displayPath, stored } of settled) {
      const raw = stored?.content?.trim();
      if (!raw) continue;
      const capped = truncateAtLineBoundary(
        redactMemoryText(raw),
        Math.min(DOC_MAX_CHARS[policyName], budget),
      );
      if (!capped.trim()) continue;
      budget -= capped.length;
      documents.push({
        name,
        displayPath,
        content: capped,
      });
      if (budget <= 0) break;
    }
    return documents;
  }

  /**
   * The user's personality override, when their cloud home carries one
   * (`agent-home/<hash>/PERSONALITY.md`, sibling of `memories/`). Cloud Home
   * import/sync may materialize it; when absent, the caller falls back to the
   * canonical default personality.
   */
  async readPersonality(): Promise<string | null> {
    if (!this.bucket) return null;
    if (this.cloud) {
      const head = await this.cloud.getMemoryHead(
        "PERSONALITY.md",
        "personality",
      );
      if (head) {
        const bytes = head.sha256
          ? await this.cloud.readMemoryHeadBytes(head)
          : await this.readAndUpgradeLegacyHead(head);
        const content = redactMemoryText(utf8Text(bytes)).trim();
        return content ? truncateAtLineBoundary(content, 6_000) : null;
      }
      return null;
    }
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
      // Legacy, control-plane-free readers retain their compatibility behavior.
      return null;
    }
  }

  private async readAndUpgradeLegacyHead(
    head: CloudMemoryHead,
  ): Promise<Uint8Array> {
    if (!this.cloud) throw new AgentHomeUnavailableError();
    const bytes = await this.cloud.readLegacyMemoryHeadBytes(head);
    // Only known normalized paths can advance through the new plane. Imported
    // rows from an older owner-transfer implementation remain safely readable
    // until the migration batch gives them an `imports/...` name.
    const normalized =
      head.name === "profile.md"
        ? { name: "memories/profile.md", kind: "profile" as const }
        : head.name === "memory_map.md"
          ? { name: "memories/memory_map.md", kind: "memory_map" as const }
          : {
              name: head.name,
              kind: head.kind,
            };
    try {
      const digest = await sha256Hex(utf8Text(bytes));
      await this.cloud.publishMemory({
        name: normalized.name,
        kind: normalized.kind,
        source: "legacy_local",
        expectedRevision: head.revision,
        bytes,
        writer: "system_seed",
        idempotencyKey: `legacy-${head.documentId}-${digest.slice(0, 24)}`,
      });
    } catch {
      // The body was validated against its owner-scoped row and is safe to use
      // for this turn. A later turn retries the one-way metadata upgrade.
    }
    return bytes;
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

    if (this.cloud) {
      const baseIdempotencyKey = (
        operation.idempotencyKey?.trim() || crypto.randomUUID()
      )
        .replace(/[^A-Za-z0-9._:-]/gu, "-")
        .slice(0, 112);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const head = await this.cloud.getMemoryHead(
          "memories/profile.md",
          "profile",
        );
        const storedBytes = head
          ? head.sha256
            ? await this.cloud.readMemoryHeadBytes(head)
            : await this.cloud.readLegacyMemoryHeadBytes(head)
          : null;
        const entries = storedBytes
          ? parseProfileEntries(utf8Text(storedBytes))
          : [];
        const outcome = applyToEntries(entries, operation.action, {
          content,
          oldContent,
        });
        if (!outcome.ok || !outcome.next) {
          return { ...outcome, bytes: entriesBodyLength(entries) };
        }
        const body = renderProfile(outcome.next);
        const receipt = await this.cloud.publishMemory({
          name: "memories/profile.md",
          kind: "profile",
          source: "remember",
          expectedRevision: head?.revision ?? 0,
          bytes: utf8Bytes(body),
          writer: "remember",
          idempotencyKey: `${baseIdempotencyKey}:${attempt}`,
        });
        if (receipt.status === "conflict") continue;
        if (receipt.status !== "committed") {
          throw new CloudHomeProtocolError(
            `Cloud profile write ended as ${receipt.status}.`,
          );
        }
        return {
          ok: true,
          message: outcome.message,
          entryCount: outcome.next.length,
          bytes: entriesBodyLength(outcome.next),
          written: {
            r2Key: receipt.r2Key,
            sizeBytes: receipt.sizeBytes,
          },
        };
      }
      return {
        ok: false,
        message:
          "Another update to the profile landed first; nothing was written. Try again.",
        entryCount: 0,
        bytes: 0,
      };
    }

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
