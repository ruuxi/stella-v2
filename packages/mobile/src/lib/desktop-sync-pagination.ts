export const DESKTOP_SYNC_MAX_PAGES_PER_RUN = 8;

export type DesktopSyncPageLike<T> = {
  cursor: string | null;
  messages: readonly T[];
  hasMore?: boolean;
};

export type DesktopSyncPageRun<TPage> = {
  lastPage: TPage;
  pages: number;
  rows: number;
  continuationNeeded: boolean;
};

export const shouldUseLegacySyncRecoverySnapshot = (args: {
  catchUp: boolean;
  initialCursor: string | null;
  cursorStatus?: "valid" | "snapshot" | "invalid";
  rows: number;
}): boolean =>
  args.catchUp &&
  Boolean(args.initialCursor) &&
  args.cursorStatus === undefined &&
  args.rows === 0;

/**
 * Drain bounded forward pages without retaining the transferred transcript.
 * New desktops provide `hasMore`; the row-count fallback only exists for
 * older desktop builds that predate explicit page metadata.
 */
export async function drainDesktopSyncPages<
  T,
  TPage extends DesktopSyncPageLike<T>,
>({
  initialCursor,
  pageSize,
  maxPages = DESKTOP_SYNC_MAX_PAGES_PER_RUN,
  pull,
  consume,
}: {
  initialCursor: string | null;
  pageSize: number;
  maxPages?: number;
  pull: (cursor: string | null, page: number) => Promise<TPage>;
  consume: (page: TPage, pageNumber: number) => Promise<void>;
}): Promise<DesktopSyncPageRun<TPage>> {
  const boundedPageSize = Math.max(1, Math.floor(pageSize));
  const boundedMaxPages = Math.max(1, Math.floor(maxPages));
  let cursor = initialCursor;
  let rows = 0;
  let lastPage: TPage | null = null;

  for (let pageNumber = 1; pageNumber <= boundedMaxPages; pageNumber += 1) {
    const page = await pull(cursor, pageNumber);
    await consume(page, pageNumber);
    lastPage = page;
    rows += page.messages.length;

    const explicitContinuation = page.hasMore === true;
    const legacyContinuation =
      page.hasMore === undefined && page.messages.length >= boundedPageSize;
    const shouldContinue = explicitContinuation || legacyContinuation;
    if (!shouldContinue) {
      return {
        lastPage: page,
        pages: pageNumber,
        rows,
        continuationNeeded: false,
      };
    }
    if (!page.cursor || page.cursor === cursor) {
      throw new Error("Desktop sync page did not advance its cursor");
    }
    cursor = page.cursor;
    if (pageNumber === boundedMaxPages) {
      return {
        lastPage: page,
        pages: pageNumber,
        rows,
        continuationNeeded: true,
      };
    }
  }

  throw new Error("Desktop sync pagination completed without a page");
}
