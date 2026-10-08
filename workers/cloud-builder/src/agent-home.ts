/**
 * The cloud agent home: the owner's memory documents, stored in R2.
 *
 * Desktop Stella keeps user-owned Markdown under `~/.stella`. Owner-fenced
 * Cloud Home import/sync copies applicable documents into generation-scoped R2
 * state, and the DO reads that authoritative cloud state at turn start.
 * Remember writes `profile.md`. Only the documents the shared resident
 * registry keeps resident are injected (`readDocuments`); `MEMORY.md`,
 * `memory_map.md` and archive documents are never injected.
 * Explicit Cloud Home sync can also materialize personality and imported
 * user-owned Markdown.
 *
 * Everything in this module has to run in workerd, so the desktop's
 * `kernel/memory/*` stores (node:fs, node:crypto) cannot be imported. The
 * profile format, caps, and dedupe rules are reproduced deliberately: a future
 * sync between desktop and cloud homes has to compare byte-for-byte.
 */

import { redactMemoryText } from "@stella/runtime/kernel/memory/redaction.js";
import { RESIDENT_MEMORY_DISPLAY_PATHS } from "@stella/runtime/kernel/agent-runtime/resident-context.js";
import { sha256Hex } from "./hash.js";
import {
  CloudHomeProtocolError,
  CloudHomeStore,
  type CloudHomeEndpoint,
  type CloudMemoryHead,
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

/** Matches `MAX_USER_PROFILE_CHARS` in the desktop user-profile store. */
export const MAX_USER_PROFILE_CHARS = 6_000;

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
   * The owner's resident memory documents (`~/.stella/core-memory.md`,
   * `memories/profile.md`, `memories/index.md`) as raw file text, keyed by
   * the display path the model sees. The shared resident registry shapes
   * them (redaction, caps) exactly as it does on the desktop; every other
   * document is opened on demand, never injected.
   */
  async readDocuments(
    snapshotHeads?: readonly CloudMemoryHead[],
  ): Promise<MemoryDocument[]> {
    if (!this.bucket || !this.cloud) return [];
    const cloud = this.cloud;
    const heads = (snapshotHeads ?? (await cloud.listMemoryHeads(100))).filter(
      (head) => RESIDENT_MEMORY_DISPLAY_PATHS.includes(head.displayPath),
    );
    // Once the owner's home advertises an authoritative head, missing or
    // corrupt bytes are a blocking integrity failure. Continuing with an
    // apparently ordinary memoryless turn would hide data loss.
    const documents = await Promise.all(
      heads.map(async (head) => ({
        name: head.name,
        displayPath: head.displayPath,
        content: utf8Text(await cloud.readMemoryHeadBytes(head)),
      })),
    );
    return documents.filter((document) => document.content.trim());
  }

  /**
   * The user's personality override, when their cloud home carries one
   * (`agent-home/<hash>/PERSONALITY.md`, sibling of `memories/`). Cloud Home
   * import/sync may materialize it; when absent, the caller falls back to the
   * canonical default personality.
   */
  async readPersonality(
    snapshotHead?: CloudMemoryHead | null,
  ): Promise<string | null> {
    if (!this.bucket || !this.cloud) return null;
    const head =
      snapshotHead !== undefined
        ? snapshotHead
        : await this.cloud.getMemoryHead("PERSONALITY.md", "personality");
    if (!head) return null;
    const content = utf8Text(await this.cloud.readMemoryHeadBytes(head));
    return content.trim() ? content : null;
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
          ? await this.cloud.readMemoryHeadBytes(head)
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
