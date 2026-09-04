import AsyncStorage from "@react-native-async-storage/async-storage";
import { diffTranscriptSnapshot } from "./transcript-snapshot";

const PAGE_SIZE = 128;
const ORDER_STEP = 1_000_000;
const PREFIX = "stella-mobile-chat-transcript-pages-v1";

export type AsyncTranscriptRow = {
  id: string;
  orderKey: number;
  messageJson: string;
};

export type AsyncTranscriptSaveRow = Omit<AsyncTranscriptRow, "orderKey"> & {
  canonicalId?: string;
};

export type AsyncTranscriptCursor = { orderKey: number; id: string };

export type AsyncTranscriptPage = {
  rows: AsyncTranscriptRow[];
  hasOlder: boolean;
  hasNewer: boolean;
};

type PageDescriptor = {
  id: number;
  minOrderKey: number;
  maxOrderKey: number;
  count: number;
};

type TranscriptMeta = {
  version: 1;
  nextPageId: number;
  pages: PageDescriptor[];
  garbagePageIds: number[];
  garbageRowIds: string[];
};

type RowLocator = { pageId: number; orderKey: number };

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function metaKey(threadId: string): string {
  return `${PREFIX}:${encoded(threadId)}:meta`;
}

function pageKey(threadId: string, pageId: number): string {
  return `${PREFIX}:${encoded(threadId)}:page:${pageId}`;
}

function locatorKey(threadId: string, messageId: string): string {
  return `${PREFIX}:${encoded(threadId)}:row:${encoded(messageId)}`;
}

function compareRows(a: AsyncTranscriptRow, b: AsyncTranscriptRow): number {
  return a.orderKey - b.orderKey || a.id.localeCompare(b.id);
}

function compareCursor(
  row: AsyncTranscriptRow,
  cursor: AsyncTranscriptCursor,
): number {
  return row.orderKey - cursor.orderKey || row.id.localeCompare(cursor.id);
}

async function readMeta(threadId: string): Promise<TranscriptMeta> {
  const raw = await AsyncStorage.getItem(metaKey(threadId));
  if (!raw) {
    return {
      version: 1,
      nextPageId: 0,
      pages: [],
      garbagePageIds: [],
      garbageRowIds: [],
    };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<TranscriptMeta>;
    if (parsed.version !== 1 || !Array.isArray(parsed.pages)) {
      throw new Error("Unsupported transcript fallback metadata");
    }
    const meta: TranscriptMeta = {
      version: 1,
      nextPageId: typeof parsed.nextPageId === "number" ? parsed.nextPageId : 0,
      pages: parsed.pages
        .filter(
          (page): page is PageDescriptor =>
            typeof page?.id === "number" &&
            typeof page.minOrderKey === "number" &&
            typeof page.maxOrderKey === "number" &&
            typeof page.count === "number",
        )
        .sort((a, b) => a.minOrderKey - b.minOrderKey || a.id - b.id),
      garbagePageIds: Array.isArray(parsed.garbagePageIds)
        ? parsed.garbagePageIds.filter(
            (pageId): pageId is number => typeof pageId === "number",
          )
        : [],
      garbageRowIds: Array.isArray(parsed.garbageRowIds)
        ? parsed.garbageRowIds.filter(
            (rowId): rowId is string => typeof rowId === "string",
          )
        : [],
    };
    if (meta.garbagePageIds.length > 0 || meta.garbageRowIds.length > 0) {
      const garbageKeys = [
        ...meta.garbagePageIds.map((pageId) => pageKey(threadId, pageId)),
        ...meta.garbageRowIds.map((rowId) => locatorKey(threadId, rowId)),
      ];
      for (let offset = 0; offset < garbageKeys.length; offset += 500) {
        await AsyncStorage.multiRemove(garbageKeys.slice(offset, offset + 500));
      }
      meta.garbagePageIds = [];
      meta.garbageRowIds = [];
      await AsyncStorage.setItem(metaKey(threadId), JSON.stringify(meta));
    }
    return meta;
  } catch (error) {
    throw new Error("Could not read incremental transcript fallback metadata", {
      cause: error,
    });
  }
}

async function readPage(
  threadId: string,
  pageId: number,
): Promise<AsyncTranscriptRow[]> {
  const raw = await AsyncStorage.getItem(pageKey(threadId, pageId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as AsyncTranscriptRow[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (row) =>
          typeof row?.id === "string" &&
          typeof row.orderKey === "number" &&
          typeof row.messageJson === "string",
      )
      .sort(compareRows);
  } catch (error) {
    throw new Error("Could not read incremental transcript fallback page", {
      cause: error,
    });
  }
}

async function readLocators(
  threadId: string,
  ids: Iterable<string>,
): Promise<Map<string, RowLocator>> {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  if (uniqueIds.length === 0) return new Map();
  const pairs = await AsyncStorage.multiGet(
    uniqueIds.map((id) => locatorKey(threadId, id)),
  );
  const locators = new Map<string, RowLocator>();
  for (let index = 0; index < pairs.length; index += 1) {
    const raw = pairs[index]?.[1];
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as RowLocator;
      if (
        typeof parsed.pageId === "number" &&
        typeof parsed.orderKey === "number"
      ) {
        locators.set(uniqueIds[index]!, parsed);
      }
    } catch {
      // A missing/corrupt locator is repaired the next time its page is saved.
    }
  }
  return locators;
}

function descriptorForOrder(
  pages: PageDescriptor[],
  orderKey: number,
): PageDescriptor | undefined {
  if (pages.length === 0) return undefined;
  if (orderKey <= pages[0]!.maxOrderKey) return pages[0];
  for (let index = 1; index < pages.length; index += 1) {
    if (orderKey <= pages[index]!.maxOrderKey) return pages[index];
  }
  return pages[pages.length - 1];
}

async function commitDirtyPages(args: {
  threadId: string;
  meta: TranscriptMeta;
  dirtyPages: Map<number, AsyncTranscriptRow[]>;
  removedIds: Set<string>;
}): Promise<void> {
  const { threadId, meta, dirtyPages, removedIds } = args;
  const descriptors: PageDescriptor[] = [];
  const writes: [string, string][] = [];
  const pageRemovals = new Set<number>();
  const rewrittenIds = new Set<string>();

  for (const descriptor of meta.pages) {
    const dirty = dirtyPages.get(descriptor.id);
    if (!dirty) {
      descriptors.push(descriptor);
      continue;
    }
    pageRemovals.add(descriptor.id);
    const rows = [...dirty].sort(compareRows);
    for (let offset = 0; offset < rows.length; offset += PAGE_SIZE) {
      const chunk = rows.slice(offset, offset + PAGE_SIZE);
      // Dirty pages are copy-on-write. Until the new manifest commits, the old
      // manifest must continue to reference an untouched complete page.
      const pageId = meta.nextPageId++;
      writes.push([pageKey(threadId, pageId), JSON.stringify(chunk)]);
      descriptors.push({
        id: pageId,
        minOrderKey: chunk[0]!.orderKey,
        maxOrderKey: chunk[chunk.length - 1]!.orderKey,
        count: chunk.length,
      });
      for (const row of chunk) {
        rewrittenIds.add(row.id);
        writes.push([
          locatorKey(threadId, row.id),
          JSON.stringify({
            pageId,
            orderKey: row.orderKey,
          } satisfies RowLocator),
        ]);
      }
    }
  }

  descriptors.sort((a, b) => a.minOrderKey - b.minOrderKey || a.id - b.id);
  meta.pages = descriptors;
  for (const id of rewrittenIds) removedIds.delete(id);
  meta.garbagePageIds = [...new Set([...meta.garbagePageIds, ...pageRemovals])];
  meta.garbageRowIds = [...new Set([...meta.garbageRowIds, ...removedIds])];

  // Page payloads and row locators land before the small manifest. An
  // interrupted write therefore never advertises a page that does not exist.
  for (let offset = 0; offset < writes.length; offset += 500) {
    await AsyncStorage.multiSet(writes.slice(offset, offset + 500));
  }
  await AsyncStorage.setItem(metaKey(threadId), JSON.stringify(meta));
  const removals = [
    ...meta.garbagePageIds.map((pageId) => pageKey(threadId, pageId)),
    ...meta.garbageRowIds.map((id) => locatorKey(threadId, id)),
  ];
  for (let offset = 0; offset < removals.length; offset += 500) {
    await AsyncStorage.multiRemove(removals.slice(offset, offset + 500));
  }
  meta.garbagePageIds = [];
  meta.garbageRowIds = [];
  await AsyncStorage.setItem(metaKey(threadId), JSON.stringify(meta));
}

async function rebalanceOrderKeys(
  threadId: string,
  meta: TranscriptMeta,
): Promise<void> {
  const rows = (
    await Promise.all(
      meta.pages.map((descriptor) => readPage(threadId, descriptor.id)),
    )
  )
    .flat()
    .sort(compareRows)
    .map((row, index) => ({ ...row, orderKey: index * ORDER_STEP }));
  if (rows.length === 0) return;

  const dirtyPages = new Map<number, AsyncTranscriptRow[]>();
  dirtyPages.set(meta.pages[0]!.id, rows);
  for (const descriptor of meta.pages.slice(1)) {
    dirtyPages.set(descriptor.id, []);
  }
  await commitDirtyPages({
    threadId,
    meta,
    dirtyPages,
    removedIds: new Set(),
  });
}

export async function saveAsyncTranscriptRows(
  threadId: string,
  incomingRows: readonly AsyncTranscriptSaveRow[],
  allowRebalance = true,
): Promise<AsyncTranscriptRow[]> {
  if (incomingRows.length === 0) return [];
  const deduped = new Map<string, AsyncTranscriptSaveRow>();
  for (const row of incomingRows) deduped.set(row.id, row);
  const incoming = [...deduped.values()];
  const canonicalIds = incoming
    .map((row) => row.canonicalId?.trim())
    .filter((id): id is string => Boolean(id));
  const locators = await readLocators(threadId, [
    ...incoming.map((row) => row.id),
    ...canonicalIds,
  ]);
  const meta = await readMeta(threadId);
  const currentPageIds = new Set(meta.pages.map((page) => page.id));
  const recoveryPages = new Map<number, AsyncTranscriptRow[]>();
  const loadRecoveryPage = async (pageId: number) => {
    let rows = recoveryPages.get(pageId);
    if (!rows) {
      rows = await readPage(threadId, pageId);
      recoveryPages.set(pageId, rows);
    }
    return rows;
  };
  for (const [id, locator] of locators) {
    const candidatePageIds: number[] = [];
    if (currentPageIds.has(locator.pageId)) {
      candidatePageIds.push(locator.pageId);
    }
    const likelyDescriptor = descriptorForOrder(meta.pages, locator.orderKey);
    if (likelyDescriptor && !candidatePageIds.includes(likelyDescriptor.id)) {
      candidatePageIds.push(likelyDescriptor.id);
    }
    for (const descriptor of meta.pages) {
      if (!candidatePageIds.includes(descriptor.id)) {
        candidatePageIds.push(descriptor.id);
      }
    }
    let recovered: AsyncTranscriptRow | undefined;
    let recoveredPageId: number | undefined;
    for (const pageId of candidatePageIds) {
      recovered = (await loadRecoveryPage(pageId)).find((row) => row.id === id);
      if (recovered) {
        recoveredPageId = pageId;
        break;
      }
    }
    if (recovered) {
      locators.set(id, {
        pageId: recoveredPageId!,
        orderKey: recovered.orderKey,
      });
    } else {
      locators.delete(id);
    }
  }

  const maximum = meta.pages[meta.pages.length - 1]?.maxOrderKey ?? null;
  const knownOrders = incoming.map((row) => {
    const own = locators.get(row.id);
    const canonical = row.canonicalId?.trim();
    return own ?? (canonical ? locators.get(canonical) : undefined);
  });
  const assigned: AsyncTranscriptRow[] = [];
  let previousKnownOrder: number | null = null;
  let index = 0;
  while (index < incoming.length) {
    const known = knownOrders[index];
    if (known) {
      const row = incoming[index]!;
      assigned.push({
        id: row.id,
        orderKey: known.orderKey,
        messageJson: row.messageJson,
      });
      previousKnownOrder = known.orderKey;
      index += 1;
      continue;
    }

    const runStart = index;
    while (index < incoming.length && !knownOrders[index]) index += 1;
    const runLength = index - runStart;
    const followingKnownOrder = knownOrders[index]?.orderKey ?? null;
    for (let runIndex = 0; runIndex < runLength; runIndex += 1) {
      let orderKey: number;
      if (
        previousKnownOrder !== null &&
        followingKnownOrder !== null &&
        followingKnownOrder > previousKnownOrder
      ) {
        const step =
          (followingKnownOrder - previousKnownOrder) / (runLength + 1);
        orderKey = previousKnownOrder + step * (runIndex + 1);
        const priorOrder =
          runIndex === 0
            ? previousKnownOrder
            : assigned[assigned.length - 1]!.orderKey;
        if (!(orderKey > priorOrder && orderKey < followingKnownOrder)) {
          if (!allowRebalance) {
            throw new Error("Could not allocate stable transcript order keys");
          }
          await rebalanceOrderKeys(threadId, meta);
          return saveAsyncTranscriptRows(threadId, incomingRows, false);
        }
      } else if (previousKnownOrder !== null) {
        orderKey = previousKnownOrder + ORDER_STEP * (runIndex + 1);
      } else if (followingKnownOrder !== null) {
        orderKey = followingKnownOrder - ORDER_STEP * (runLength - runIndex);
      } else if (maximum !== null) {
        orderKey = maximum + ORDER_STEP * (runIndex + 1);
      } else {
        orderKey = ORDER_STEP * runIndex;
      }
      const row = incoming[runStart + runIndex]!;
      assigned.push({ id: row.id, orderKey, messageJson: row.messageJson });
    }
    if (runLength > 0) {
      previousKnownOrder = assigned[assigned.length - 1]!.orderKey;
    }
  }

  if (meta.pages.length === 0) {
    meta.pages.push({
      id: meta.nextPageId++,
      minOrderKey: 0,
      maxOrderKey: 0,
      count: 0,
    });
  }
  const dirtyPages = new Map<number, AsyncTranscriptRow[]>();
  const removedIds = new Set<string>();
  const loadDirty = async (pageId: number) => {
    let rows = dirtyPages.get(pageId);
    if (!rows) {
      rows = await readPage(threadId, pageId);
      dirtyPages.set(pageId, rows);
    }
    return rows;
  };

  for (let index = 0; index < assigned.length; index += 1) {
    const row = assigned[index]!;
    const saveRow = incoming[index]!;
    const existing = locators.get(row.id);
    if (existing) {
      const rows = await loadDirty(existing.pageId);
      const at = rows.findIndex((candidate) => candidate.id === row.id);
      if (at >= 0) rows.splice(at, 1);
    }
    const canonicalId = saveRow.canonicalId?.trim();
    if (canonicalId && canonicalId !== row.id) {
      const canonical = locators.get(canonicalId);
      if (canonical) {
        const rows = await loadDirty(canonical.pageId);
        const at = rows.findIndex((candidate) => candidate.id === canonicalId);
        if (at >= 0) rows.splice(at, 1);
        removedIds.add(canonicalId);
      }
    }
    const destination =
      (existing && meta.pages.find((page) => page.id === existing.pageId)) ||
      descriptorForOrder(meta.pages, row.orderKey) ||
      meta.pages[0]!;
    (await loadDirty(destination.id)).push(row);
  }

  await commitDirtyPages({ threadId, meta, dirtyPages, removedIds });
  return assigned;
}

async function loadMatchingRows(args: {
  threadId: string;
  cursor?: AsyncTranscriptCursor;
  direction: "oldest" | "recent" | "older" | "newer";
  limit: number;
}): Promise<AsyncTranscriptPage> {
  const { threadId, cursor, direction } = args;
  const limit = Math.max(1, Math.floor(args.limit));
  const meta = await readMeta(threadId);
  const backwards = direction === "recent" || direction === "older";
  const descriptors = backwards ? [...meta.pages].reverse() : meta.pages;
  const collected: AsyncTranscriptRow[] = [];
  let hasUnvisited = false;

  for (let index = 0; index < descriptors.length; index += 1) {
    const descriptor = descriptors[index]!;
    if (cursor) {
      if (direction === "older" && descriptor.minOrderKey > cursor.orderKey) {
        continue;
      }
      if (direction === "newer" && descriptor.maxOrderKey < cursor.orderKey) {
        continue;
      }
    }
    const rows = await readPage(threadId, descriptor.id);
    const matching = rows.filter((row) => {
      if (!cursor) return true;
      const comparison = compareCursor(row, cursor);
      return direction === "older" ? comparison < 0 : comparison > 0;
    });
    if (backwards) collected.unshift(...matching);
    else collected.push(...matching);
    if (collected.length > limit) break;
    hasUnvisited = index + 1 < descriptors.length;
  }

  const start = backwards ? Math.max(0, collected.length - limit) : 0;
  const rows = collected.slice(start, start + limit);
  const omittedBefore = start > 0 || (backwards && hasUnvisited);
  const omittedAfter =
    start + rows.length < collected.length || (!backwards && hasUnvisited);
  return {
    rows,
    hasOlder: omittedBefore || direction === "newer",
    hasNewer: omittedAfter || direction === "older",
  };
}

export function loadRecentAsyncTranscriptRows(
  threadId: string,
  limit: number,
): Promise<AsyncTranscriptPage> {
  return loadMatchingRows({ threadId, direction: "recent", limit });
}

export function loadOldestAsyncTranscriptRows(
  threadId: string,
  limit: number,
): Promise<AsyncTranscriptPage> {
  return loadMatchingRows({ threadId, direction: "oldest", limit });
}

export async function loadOlderAsyncTranscriptRows(
  threadId: string,
  cursor: AsyncTranscriptCursor,
  limit: number,
): Promise<AsyncTranscriptPage> {
  const currentCursor =
    (await findAsyncTranscriptCursor(threadId, cursor.id)) ?? cursor;
  return loadMatchingRows({
    threadId,
    cursor: currentCursor,
    direction: "older",
    limit,
  });
}

export async function loadNewerAsyncTranscriptRows(
  threadId: string,
  cursor: AsyncTranscriptCursor,
  limit: number,
): Promise<AsyncTranscriptPage> {
  const currentCursor =
    (await findAsyncTranscriptCursor(threadId, cursor.id)) ?? cursor;
  return loadMatchingRows({
    threadId,
    cursor: currentCursor,
    direction: "newer",
    limit,
  });
}

/** Resolve a durable row identity to its paging cursor without loading history. */
export async function findAsyncTranscriptCursor(
  threadId: string,
  messageId: string,
): Promise<AsyncTranscriptCursor | null> {
  const meta = await readMeta(threadId);
  const locator = (await readLocators(threadId, [messageId])).get(messageId);
  if (locator && meta.pages.some((page) => page.id === locator.pageId)) {
    const row = (await readPage(threadId, locator.pageId)).find(
      (candidate) => candidate.id === messageId,
    );
    if (row) return { orderKey: row.orderKey, id: row.id };
  }
  // Locators are derived hints and can lag an interrupted manifest commit.
  // Fall back to bounded page reads so checkpoint recovery never trusts one.
  for (const descriptor of meta.pages) {
    const row = (await readPage(threadId, descriptor.id)).find(
      (candidate) => candidate.id === messageId,
    );
    if (row) return { orderKey: row.orderKey, id: row.id };
  }
  return null;
}

/** Reconcile a complete cache window, rewriting only pages with changed rows. */
export async function synchronizeAsyncTranscriptRows(
  threadId: string,
  incoming: readonly Omit<AsyncTranscriptRow, "orderKey">[],
  isCurrent: () => boolean,
): Promise<void> {
  const meta = await readMeta(threadId);
  const pages = new Map<number, AsyncTranscriptRow[]>();
  for (const descriptor of meta.pages) {
    pages.set(descriptor.id, await readPage(threadId, descriptor.id));
  }
  const { changed, removed } = diffTranscriptSnapshot(
    [...pages.values()].flat(),
    incoming,
  );
  if (!isCurrent() || (!changed.length && !removed.length)) return;
  if (!meta.pages.length) {
    const descriptor = {
      id: meta.nextPageId++,
      minOrderKey: 0,
      maxOrderKey: 0,
      count: 0,
    };
    meta.pages.push(descriptor);
    pages.set(descriptor.id, []);
  }
  const replacedIds = new Set([...changed, ...removed].map((row) => row.id));
  const dirtyPages = new Map<number, AsyncTranscriptRow[]>();
  for (const [id, rows] of pages) {
    const kept = rows.filter((row) => !replacedIds.has(row.id));
    if (kept.length !== rows.length) dirtyPages.set(id, kept);
  }
  for (const row of changed) {
    const destination =
      descriptorForOrder(meta.pages, row.orderKey) ?? meta.pages[0]!;
    let rows = dirtyPages.get(destination.id);
    if (!rows) {
      rows = [...pages.get(destination.id)!];
      dirtyPages.set(destination.id, rows);
    }
    rows.push(row);
  }
  if (!isCurrent()) return;
  await commitDirtyPages({
    threadId,
    meta,
    dirtyPages,
    removedIds: new Set(removed.map((row) => row.id)),
  });
}

export async function clearAsyncTranscriptRows(
  threadId: string,
): Promise<void> {
  const prefix = `${PREFIX}:${encoded(threadId)}:`;
  const keys = (await AsyncStorage.getAllKeys()).filter((key) =>
    key.startsWith(prefix),
  );
  for (let offset = 0; offset < keys.length; offset += 500) {
    await AsyncStorage.multiRemove(keys.slice(offset, offset + 500));
  }
}
