import { sha256Hex } from "./hash.js";

const MEMORY_WIPE_PAGE_SIZE = 250;

export const MEMORY_WIPE_PROTOCOL_VERSION = 2;
export const MEMORY_WIPE_TARGET_COUNT = 9;

export type MemoryWipeTarget =
  | { kind: "prefix"; value: string }
  | { kind: "filtered-prefix"; value: string }
  | { kind: "key"; value: string };

/**
 * Exact product-owned memory namespaces. Inputs are identities, never object
 * locators supplied by a client. Skills deliberately live beside these under
 * the generation root and are not included.
 */
export const memoryWipeTargets = async (
  ownerId: string,
  ownerGeneration: string,
): Promise<MemoryWipeTarget[]> => {
  const [ownerHash, generationHash] = await Promise.all([
    sha256Hex(ownerId),
    sha256Hex(ownerGeneration),
  ]);
  const ownerRoot = `agent-home/${ownerHash}/`;
  const generationRoot = `${ownerRoot}generations/${generationHash}/`;
  const targets: MemoryWipeTarget[] = [
    { kind: "prefix", value: `${generationRoot}memory-versions/` },
    // Automatic memory review is retired, so nothing writes `dream-inbox/`
    // anymore. Bytes an earlier build left there still belong to the owner and
    // must still be erased, so the namespace stays a wipe target.
    { kind: "prefix", value: `${generationRoot}dream-inbox/` },
    { kind: "prefix", value: `${generationRoot}memories/` },
    { kind: "key", value: `${generationRoot}PERSONALITY.md` },
    { kind: "key", value: `${generationRoot}core-memory.md` },
    // Pre-generation imports and AgentHome keys are included for a one-way
    // migration that crashed before its authoritative version publication.
    // Account linking copies the source owner's COMPLETE Agent Home under
    // this subtree. It therefore contains imported Skills as well as Memory.
    // Sweep it structurally, never as a broad prefix.
    { kind: "filtered-prefix", value: `${ownerRoot}__stella_imported__/` },
    { kind: "prefix", value: `${ownerRoot}memories/` },
    { kind: "key", value: `${ownerRoot}PERSONALITY.md` },
    { kind: "key", value: `${ownerRoot}core-memory.md` },
  ];
  if (targets.length !== MEMORY_WIPE_TARGET_COUNT) {
    throw new Error("Memory wipe target contract drifted.");
  }
  return targets;
};

export type MemoryWipePageResult = {
  protocolVersion: number;
  targetCount: number;
  complete: boolean;
  cursor: number;
  startAfter?: string;
  deleted: number;
};

const HASH_SEGMENT = /^[0-9a-f]{64}$/u;

/**
 * An imported owner root may itself contain older imported owner roots. Strip
 * only those exact hash-scoped structural wrappers, then classify the first
 * product namespace. A Skill file named `files/memories/MEMORY.md` therefore
 * remains a Skill because its anchored namespace is `skills`, not `memories`.
 */
const isImportedMemoryObject = (prefix: string, key: string): boolean => {
  if (!key.startsWith(prefix)) return false;
  const segments = key.slice(prefix.length).split("/");
  if (!HASH_SEGMENT.test(segments[0] ?? "")) return false;
  let index = 1;
  while (
    segments[index] === "__stella_imported__" &&
    HASH_SEGMENT.test(segments[index + 1] ?? "")
  ) {
    index += 2;
  }
  if (segments[index] === "generations") {
    if (!HASH_SEGMENT.test(segments[index + 1] ?? "")) return false;
    index += 2;
  }
  const namespace = segments[index];
  if (
    namespace === "memory-versions" ||
    namespace === "dream-inbox" ||
    namespace === "memories"
  ) {
    return segments.length > index + 1;
  }
  return (
    (namespace === "PERSONALITY.md" || namespace === "core-memory.md") &&
    segments.length === index + 1
  );
};

const result = (
  value: Omit<MemoryWipePageResult, "protocolVersion" | "targetCount">,
): MemoryWipePageResult => ({
  protocolVersion: MEMORY_WIPE_PROTOCOL_VERSION,
  targetCount: MEMORY_WIPE_TARGET_COUNT,
  ...value,
});

/**
 * Deletes at most one bounded R2 page (or one exact legacy key), then reads the
 * same target back before advancing the durable cursor. The enclosing owner
 * activity fence guarantees no writer can recreate a key after readback.
 */
export const sweepMemoryWipePage = async (
  bucket: R2Bucket,
  args: {
    ownerId: string;
    ownerGeneration: string;
    cursor: number;
    startAfter?: string;
  },
): Promise<MemoryWipePageResult> => {
  const targets = await memoryWipeTargets(args.ownerId, args.ownerGeneration);
  if (
    !Number.isSafeInteger(args.cursor) ||
    args.cursor < 0 ||
    args.cursor > targets.length
  ) {
    throw new Error("Invalid memory wipe cursor.");
  }
  if (args.cursor === targets.length) {
    if (args.startAfter !== undefined) {
      throw new Error("Invalid terminal memory wipe scan cursor.");
    }
    return result({ complete: true, cursor: args.cursor, deleted: 0 });
  }
  const target = targets[args.cursor]!;
  if (target.kind === "key") {
    if (args.startAfter !== undefined) {
      throw new Error("Memory wipe scan cursor does not match its target.");
    }
    const existing = await bucket.head(target.value);
    if (existing) await bucket.delete(target.value);
    if (await bucket.head(target.value)) {
      return result({ complete: false, cursor: args.cursor, deleted: 0 });
    }
    const cursor = args.cursor + 1;
    return result({
      complete: cursor === targets.length,
      cursor,
      deleted: existing ? 1 : 0,
    });
  }

  if (target.kind === "filtered-prefix") {
    if (
      args.startAfter !== undefined &&
      (!args.startAfter.startsWith(target.value) ||
        args.startAfter.length > 1_024)
    ) {
      throw new Error("Invalid imported memory wipe scan cursor.");
    }
    const page = await bucket.list({
      prefix: target.value,
      limit: MEMORY_WIPE_PAGE_SIZE,
      ...(args.startAfter ? { startAfter: args.startAfter } : {}),
    });
    if (page.truncated && page.objects.length === 0) {
      throw new Error("Imported memory wipe listing made no progress.");
    }
    const selected = page.objects
      .map((object) => object.key)
      .filter((key) => isImportedMemoryObject(target.value, key));
    if (selected.length > 0) await bucket.delete(selected);
    const remaining = new Set<string>();
    for (const key of selected) {
      if (await bucket.head(key)) remaining.add(key);
    }
    const deleted = selected.length - remaining.size;
    if (remaining.size > 0) {
      return result({
        complete: false,
        cursor: args.cursor,
        ...(args.startAfter ? { startAfter: args.startAfter } : {}),
        deleted,
      });
    }
    if (page.truncated) {
      return result({
        complete: false,
        cursor: args.cursor,
        startAfter: page.objects.at(-1)!.key,
        deleted,
      });
    }
    const cursor = args.cursor + 1;
    return result({
      complete: cursor === targets.length,
      cursor,
      deleted,
    });
  }

  if (args.startAfter !== undefined) {
    throw new Error("Memory wipe scan cursor does not match its target.");
  }

  const page = await bucket.list({
    prefix: target.value,
    limit: MEMORY_WIPE_PAGE_SIZE,
  });
  const keys = page.objects.map((object) => object.key);
  if (keys.length > 0) await bucket.delete(keys);
  const readback = await bucket.list({ prefix: target.value, limit: 1 });
  if (readback.objects.length > 0) {
    return result({
      complete: false,
      cursor: args.cursor,
      deleted: keys.length,
    });
  }
  const cursor = args.cursor + 1;
  return result({
    complete: cursor === targets.length,
    cursor,
    deleted: keys.length,
  });
};
