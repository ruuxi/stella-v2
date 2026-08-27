import { redactMemoryText } from "@stella/runtime/kernel/memory/redaction.js";
import {
  CloudHomeProtocolError,
  type CloudDreamClaim,
  type CloudDreamEntry,
  type CloudHomeStore,
  type CloudMemoryHead,
  utf8Bytes,
  utf8Text,
} from "./cloud-home-store.js";
import { sha256Hex } from "./hash.js";

export const DREAM_MEMORY_MAX_CHARS = 48_000;
export const DREAM_MEMORY_MAP_MAX_CHARS = 6_000;
export const DREAM_MEMORY_MAP_MAX_ENTRIES = 80;
const DREAM_ARCHIVE_MAX_CHARS = 400_000;
const DREAM_INPUT_TEXT_MAX_CHARS = 12_000;

type DreamBlock = {
  sourceHash: string;
  sourceKey: string;
  sourceRevision: number;
  title: string;
  updatedAt: number;
  body: string;
};

export type CloudDreamInput = {
  entry: CloudDreamEntry;
  bytes: Uint8Array;
};

export type DreamWritePlan = {
  memory: string;
  memoryMap: string;
  archives: Array<{ name: string; content: string }>;
  activeBlocks: number;
  rotatedBlocks: number;
};

const BEGIN_MARKER =
  /^<!-- stella:dream:([0-9a-f]{24}):begin revision=(\d+) updated=(\d+) source=([^\n]+) -->$/u;
const END_MARKER = /^<!-- stella:dream:([0-9a-f]{24}):end -->$/u;

const clampText = (value: string, limit: number): string => {
  const normalized = redactMemoryText(value)
    .replace(/<!--\s*stella:dream/giu, "[dream marker removed]")
    .replace(/\u0000/gu, "")
    .trim();
  if (normalized.length <= limit) return normalized;
  const marker = "\n...[truncated]";
  return `${normalized.slice(0, Math.max(0, limit - marker.length))}${marker}`;
};

const cleanInline = (value: string, fallback: string): string =>
  clampText(value, 180)
    .replace(/[\r\n]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim() || fallback;

const parsePayload = (bytes: Uint8Array): { body: string; title?: string } => {
  const raw = utf8Text(bytes);
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { body: clampText(raw, DREAM_INPUT_TEXT_MAX_CHARS) };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { body: clampText(String(value ?? ""), DREAM_INPUT_TEXT_MAX_CHARS) };
  }
  const row = value as Record<string, unknown>;
  const title = typeof row.title === "string" ? row.title : undefined;
  const sections: string[] = [];
  for (const field of ["summary", "text", "content"] as const) {
    if (typeof row[field] === "string" && row[field].trim()) {
      sections.push(clampText(row[field], DREAM_INPUT_TEXT_MAX_CHARS));
      break;
    }
  }
  for (const [label, field] of [
    ["Facts", "facts"],
    ["Decisions", "decisions"],
    ["Open threads", "openThreads"],
  ] as const) {
    if (!Array.isArray(row[field])) continue;
    const items = row[field]
      .filter((item): item is string => typeof item === "string")
      .map((item) => cleanInline(item, ""))
      .filter(Boolean)
      .slice(0, 32);
    if (items.length > 0) {
      sections.push(
        `### ${label}\n${items.map((item) => `- ${item}`).join("\n")}`,
      );
    }
  }
  return {
    body: clampText(sections.join("\n\n"), DREAM_INPUT_TEXT_MAX_CHARS),
    ...(title ? { title } : {}),
  };
};

const sourceHash = async (sourceKey: string): Promise<string> =>
  (await sha256Hex(sourceKey)).slice(0, 24);

const renderBlock = (block: DreamBlock): string =>
  [
    `<!-- stella:dream:${block.sourceHash}:begin revision=${block.sourceRevision} updated=${block.updatedAt} source=${encodeURIComponent(block.sourceKey)} -->`,
    `<a id="${anchorFor(block.title, block.sourceHash)}"></a>`,
    `## ${cleanInline(block.title, "Memory")}`,
    "",
    block.body,
    `<!-- stella:dream:${block.sourceHash}:end -->`,
  ].join("\n");

const parseBlocks = (
  content: string,
): { prefix: string; blocks: DreamBlock[] } => {
  const lines = content.replace(/\r\n?/gu, "\n").split("\n");
  const prefix: string[] = [];
  const blocks: DreamBlock[] = [];
  for (let index = 0; index < lines.length; ) {
    const begin = lines[index]?.match(BEGIN_MARKER);
    if (!begin) {
      prefix.push(lines[index] ?? "");
      index += 1;
      continue;
    }
    const endIndex = lines.findIndex(
      (line, position) =>
        position > index && line.match(END_MARKER)?.[1] === begin[1],
    );
    if (endIndex < 0) {
      prefix.push(lines[index] ?? "");
      index += 1;
      continue;
    }
    const bodyLines = lines.slice(index + 1, endIndex);
    const headingIndex = bodyLines.findIndex((line) => /^##\s+/u.test(line));
    const heading =
      (headingIndex >= 0
        ? bodyLines[headingIndex]?.replace(/^##\s+/u, "").trim()
        : "") || "Memory";
    const body = bodyLines
      .slice(headingIndex + 1)
      .join("\n")
      .trim();
    let decodedSource = begin[4] ?? "unknown";
    try {
      decodedSource = decodeURIComponent(decodedSource);
    } catch {
      // Keep the encoded source only as a display label; the hash is authority.
    }
    blocks.push({
      sourceHash: begin[1]!,
      sourceKey: decodedSource,
      sourceRevision: Number.parseInt(begin[2]!, 10),
      updatedAt: Number.parseInt(begin[3]!, 10),
      title: heading,
      body,
    });
    index = endIndex + 1;
  }
  return {
    prefix: prefix.join("\n").trim(),
    blocks,
  };
};

const memoryContent = (prefix: string, blocks: DreamBlock[]): string => {
  const header = prefix || "# Stella Memory";
  return `${header}\n\n${blocks.map(renderBlock).join("\n\n")}\n`;
};

const monthName = (updatedAt: number): string => {
  const date = new Date(Number.isFinite(updatedAt) ? updatedAt : 0);
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  return `archive/${year}-${month}.md`;
};

const anchorFor = (title: string, sourceHashValue: string): string => {
  const slug = title
    .toLocaleLowerCase()
    .replace(/[^a-z0-9\s-]/gu, "")
    .trim()
    .replace(/\s+/gu, "-")
    .slice(0, 60);
  return `${slug || "memory"}-${sourceHashValue.slice(0, 8)}`;
};

const renderMemoryMap = (
  active: DreamBlock[],
  archived: Array<DreamBlock & { archiveName: string }>,
): string => {
  const rows = [
    ...active.map((block) => ({
      ...block,
      path: "~/.stella/memories/MEMORY.md",
    })),
    ...archived.map((block) => ({
      ...block,
      path: `~/.stella/memories/${block.archiveName}`,
    })),
  ]
    .sort(
      (a, b) =>
        b.updatedAt - a.updatedAt || a.sourceHash.localeCompare(b.sourceHash),
    )
    .slice(0, DREAM_MEMORY_MAP_MAX_ENTRIES);
  const lines = [
    "# Memory Map",
    "",
    "> Pointers only. Dream rotates full content into MEMORY.md and archive documents.",
    "",
  ];
  for (const row of rows) {
    const title = cleanInline(row.title, "Memory");
    const source = cleanInline(row.sourceKey, "unknown source");
    const line = `- [${title}](${row.path}#${anchorFor(title, row.sourceHash)}) — ${source} @ revision ${row.sourceRevision}`;
    if (`${lines.join("\n")}\n${line}\n`.length > DREAM_MEMORY_MAP_MAX_CHARS) {
      break;
    }
    lines.push(line);
  }
  return `${lines.join("\n")}\n`;
};

export const buildDreamWritePlan = async (args: {
  memory?: string;
  archives?: Readonly<Record<string, string>>;
  inputs: CloudDreamInput[];
}): Promise<DreamWritePlan> => {
  const parsedMemory = parseBlocks(args.memory ?? "# Stella Memory");
  const bySource = new Map(
    parsedMemory.blocks.map((block) => [block.sourceHash, block]),
  );
  for (const input of args.inputs) {
    const hash = await sourceHash(input.entry.sourceKey);
    const current = bySource.get(hash);
    if (current && current.sourceRevision > input.entry.sourceRevision)
      continue;
    const payload = parsePayload(input.bytes);
    const body = payload.body || "No durable details were recorded.";
    bySource.set(hash, {
      sourceHash: hash,
      sourceKey: input.entry.sourceKey,
      sourceRevision: input.entry.sourceRevision,
      title: cleanInline(
        input.entry.title ?? payload.title ?? input.entry.sourceKey,
        "Memory",
      ),
      updatedAt: input.entry.updatedAt,
      body,
    });
  }
  const active = [...bySource.values()].sort(
    (a, b) =>
      a.updatedAt - b.updatedAt || a.sourceHash.localeCompare(b.sourceHash),
  );
  const rotated: DreamBlock[] = [];
  while (
    active.length > 1 &&
    memoryContent(parsedMemory.prefix, active).length > DREAM_MEMORY_MAX_CHARS
  ) {
    rotated.push(active.shift()!);
  }
  let memory = memoryContent(parsedMemory.prefix, active);
  if (memory.length > DREAM_MEMORY_MAX_CHARS) {
    const only = active[0]!;
    only.body = clampText(
      only.body,
      Math.max(1_000, DREAM_MEMORY_MAX_CHARS - 1_000),
    );
    memory = memoryContent(parsedMemory.prefix, active);
  }

  const archiveGroups = new Map<string, DreamBlock[]>();
  for (const block of rotated) {
    const name = monthName(block.updatedAt);
    const group = archiveGroups.get(name) ?? [];
    group.push(block);
    archiveGroups.set(name, group);
  }
  const archives: Array<{ name: string; content: string }> = [];
  const archivedForMap: Array<DreamBlock & { archiveName: string }> = [];
  for (const [name, newlyRotated] of [...archiveGroups].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const parsed = parseBlocks(
      args.archives?.[name] ?? `# Stella Memory Archive ${name.slice(8, -3)}`,
    );
    const combined = new Map(
      parsed.blocks.map((block) => [block.sourceHash, block]),
    );
    for (const block of newlyRotated) combined.set(block.sourceHash, block);
    const ordered = [...combined.values()].sort(
      (a, b) =>
        a.updatedAt - b.updatedAt || a.sourceHash.localeCompare(b.sourceHash),
    );
    let content = memoryContent(parsed.prefix, ordered);
    while (ordered.length > 1 && content.length > DREAM_ARCHIVE_MAX_CHARS) {
      ordered.shift();
      content = memoryContent(parsed.prefix, ordered);
    }
    archives.push({ name, content });
    archivedForMap.push(
      ...newlyRotated.map((block) => ({ ...block, archiveName: name })),
    );
  }
  const existingArchived = Object.entries(args.archives ?? {}).flatMap(
    ([archiveName, content]) =>
      parseBlocks(content).blocks.map((block) => ({ ...block, archiveName })),
  );
  return {
    memory,
    memoryMap: renderMemoryMap(active, [
      ...existingArchived,
      ...archivedForMap,
    ]),
    archives,
    activeBlocks: active.length,
    rotatedBlocks: rotated.length,
  };
};

type ExistingDocument = {
  head: CloudMemoryHead | null;
  content: string;
};

export class CloudDreamWriter {
  constructor(private readonly home: CloudHomeStore) {}

  private async readDocument(
    name: string,
    kind: CloudMemoryHead["kind"],
  ): Promise<ExistingDocument> {
    const head = await this.home.getMemoryHead(name, kind);
    if (!head) return { head: null, content: "" };
    const bytes = head.sha256
      ? await this.home.readMemoryHeadBytes(head)
      : await this.home.readLegacyMemoryHeadBytes(head);
    return { head, content: utf8Text(bytes) };
  }

  private async publishIfChanged(args: {
    runId: string;
    name: string;
    kind: CloudMemoryHead["kind"];
    existing: ExistingDocument;
    content: string;
  }): Promise<string | undefined> {
    if (args.existing.content === args.content) {
      return args.existing.head?.versionId;
    }
    const nameHash = (await sha256Hex(args.name)).slice(0, 20);
    const receipt = await this.home.publishMemory({
      name: args.name,
      kind: args.kind,
      source: "cloud_dream",
      expectedRevision: args.existing.head?.revision ?? 0,
      bytes: utf8Bytes(args.content),
      writer: "dream",
      idempotencyKey: `dream:${args.runId}:${nameHash}:${
        args.existing.head?.revision ?? 0
      }`,
    });
    if (receipt.status === "conflict") {
      throw new CloudHomeProtocolError(
        "Dream output changed concurrently.",
        409,
        "CLOUD_HOME_REVISION_CONFLICT",
      );
    }
    if (receipt.status !== "committed") {
      throw new CloudHomeProtocolError(
        `Dream output write ended as ${receipt.status}.`,
      );
    }
    return receipt.versionId;
  }

  async runClaim(claim: CloudDreamClaim): Promise<{
    processedCount: number;
    supersededCount: number;
    memoryVersionId?: string;
    memoryMapVersionId?: string;
    archiveVersionIds: string[];
    attemptCount: number;
    conflictRetryCount: number;
    conflictRetryObserved: boolean;
  }> {
    if (claim.status !== "running") {
      return {
        processedCount: 0,
        supersededCount: 0,
        archiveVersionIds: [],
        attemptCount: 0,
        conflictRetryCount: 0,
        conflictRetryObserved: false,
      };
    }
    const inputs = await Promise.all(
      claim.entries.map(async (entry) => ({
        entry,
        bytes: await this.home.readDreamInput(entry),
      })),
    );
    // A pass may retry after one output committed but before completion. Three
    // rebuilds are enough to absorb ordinary Remember/desktop-sync CAS races;
    // every rebuild starts from the new authoritative heads.
    let lastError: unknown;
    let attemptCount = 0;
    let conflictRetryCount = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      attemptCount = attempt + 1;
      try {
        await this.home.renewDreamRun(
          claim.runId,
          claim.leaseId,
          claim.memoryEpoch,
        );
        const [memory, memoryMap] = await Promise.all([
          this.readDocument("MEMORY.md", "memory"),
          this.readDocument("memories/memory_map.md", "memory_map"),
        ]);
        const preliminary = await buildDreamWritePlan({
          memory: memory.content,
          inputs,
        });
        const archiveExisting = Object.fromEntries(
          await Promise.all(
            preliminary.archives.map(async ({ name }) => {
              const existing = await this.readDocument(name, "archive");
              return [name, existing] as const;
            }),
          ),
        );
        const plan = await buildDreamWritePlan({
          memory: memory.content,
          archives: Object.fromEntries(
            Object.entries(archiveExisting).map(([name, value]) => [
              name,
              value.content,
            ]),
          ),
          inputs,
        });
        const archiveVersionIds: string[] = [];
        for (const archive of plan.archives) {
          const versionId = await this.publishIfChanged({
            runId: claim.runId,
            name: archive.name,
            kind: "archive",
            existing: archiveExisting[archive.name]!,
            content: archive.content,
          });
          if (versionId) archiveVersionIds.push(versionId);
        }
        const memoryVersionId = await this.publishIfChanged({
          runId: claim.runId,
          name: "MEMORY.md",
          kind: "memory",
          existing: memory,
          content: plan.memory,
        });
        const memoryMapVersionId = await this.publishIfChanged({
          runId: claim.runId,
          name: "memories/memory_map.md",
          kind: "memory_map",
          existing: memoryMap,
          content: plan.memoryMap,
        });
        const completed = await this.home.completeDreamRun({
          runId: claim.runId,
          leaseId: claim.leaseId,
          memoryEpoch: claim.memoryEpoch,
          processed: claim.entries.map((entry) => ({
            inboxId: entry.inboxId,
            sourceRevision: entry.sourceRevision,
          })),
          ...(memoryVersionId ? { memoryVersionId } : {}),
          ...(memoryMapVersionId ? { memoryMapVersionId } : {}),
          ...(archiveVersionIds.length > 0 ? { archiveVersionIds } : {}),
        });
        return {
          ...completed,
          ...(memoryVersionId ? { memoryVersionId } : {}),
          ...(memoryMapVersionId ? { memoryMapVersionId } : {}),
          archiveVersionIds,
          attemptCount,
          conflictRetryCount,
          conflictRetryObserved: conflictRetryCount > 0,
        };
      } catch (error) {
        lastError = error;
        if (
          !(error instanceof CloudHomeProtocolError) ||
          error.code !== "CLOUD_HOME_REVISION_CONFLICT"
        ) {
          break;
        }
        conflictRetryCount += 1;
      }
    }
    await this.home
      .failDreamRun(
        claim.runId,
        claim.leaseId,
        claim.memoryEpoch,
        lastError instanceof Error ? lastError.message : "Dream pass failed.",
      )
      .catch(() => undefined);
    throw lastError instanceof Error
      ? lastError
      : new CloudHomeProtocolError("Dream pass failed.");
  }

  async claimAndRun(args?: {
    memoryEpoch?: string;
    runId?: string;
    leaseId?: string;
    limit?: number;
  }) {
    const runId = args?.runId ?? `dreamrun-${crypto.randomUUID()}`;
    const leaseId = args?.leaseId ?? `dreamlease-${crypto.randomUUID()}`;
    const memoryEpoch = args?.memoryEpoch;
    if (!memoryEpoch) {
      throw new CloudHomeProtocolError("Dream memory epoch was required.");
    }
    const claim = await this.home.claimDreamRun({
      memoryEpoch,
      runId,
      leaseId,
      ...(args?.limit ? { limit: args.limit } : {}),
    });
    return await this.runClaim(claim);
  }
}
