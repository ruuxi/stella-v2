import { describe, expect, test } from "bun:test";
import {
  DESKTOP_SYNC_MAX_PAGES_PER_RUN,
  drainDesktopSyncPages,
  shouldUseLegacySyncRecoverySnapshot,
} from "../desktop-sync-pagination";

describe("desktop sync forward pagination", () => {
  test("a two-row missing suffix does not fetch or replay the full history", async () => {
    const requestedCursors: Array<string | null> = [];
    const consumed: string[] = [];
    const result = await drainDesktopSyncPages({
      initialCursor: "v2:9998:9998:event-9998",
      pageSize: 100,
      pull: async (cursor) => {
        requestedCursors.push(cursor);
        return {
          cursor: "v2:10000:10000:event-10000",
          cursorStatus: "valid" as const,
          hasMore: false,
          messages: ["message-9999", "message-10000"],
        };
      },
      consume: async (page) => {
        consumed.push(...page.messages);
      },
    });

    expect(requestedCursors).toEqual(["v2:9998:9998:event-9998"]);
    expect(consumed).toEqual(["message-9999", "message-10000"]);
    expect(result).toMatchObject({
      pages: 1,
      rows: 2,
      continuationNeeded: false,
    });
  });

  test("drains a larger gap in ordered bounded pages", async () => {
    const source = Array.from({ length: 245 }, (_, index) => index + 1);
    const consumed: number[] = [];
    const result = await drainDesktopSyncPages({
      initialCursor: "cursor-0",
      pageSize: 100,
      pull: async (cursor) => {
        const offset = Number(cursor?.slice("cursor-".length) ?? 0);
        const messages = source.slice(offset, offset + 100);
        const nextOffset = offset + messages.length;
        return {
          cursor: `cursor-${nextOffset}`,
          hasMore: nextOffset < source.length,
          messages,
        };
      },
      consume: async (page) => {
        expect(page.messages.length).toBeLessThanOrEqual(100);
        consumed.push(...page.messages);
      },
    });

    expect(result.pages).toBe(3);
    expect(result.rows).toBe(245);
    expect(result.continuationNeeded).toBe(false);
    expect(consumed).toEqual(source);
  });

  test("yields after a bounded chunk and resumes from its exact cursor", async () => {
    const requested: Array<string | null> = [];
    const result = await drainDesktopSyncPages({
      initialCursor: "cursor-0",
      pageSize: 100,
      pull: async (cursor, page) => {
        requested.push(cursor);
        return {
          cursor: `cursor-${page * 100}`,
          hasMore: true,
          messages: Array.from({ length: 100 }, (_, index) => index),
        };
      },
      consume: async () => {},
    });

    expect(requested).toHaveLength(DESKTOP_SYNC_MAX_PAGES_PER_RUN);
    expect(result).toMatchObject({
      pages: DESKTOP_SYNC_MAX_PAGES_PER_RUN,
      rows: DESKTOP_SYNC_MAX_PAGES_PER_RUN * 100,
      continuationNeeded: true,
    });
    expect(result.lastPage.cursor).toBe(
      `cursor-${DESKTOP_SYNC_MAX_PAGES_PER_RUN * 100}`,
    );
  });

  test("fails closed when a paged response cannot advance", async () => {
    expect(
      drainDesktopSyncPages({
        initialCursor: "cursor-1",
        pageSize: 100,
        pull: async () => ({
          cursor: "cursor-1",
          hasMore: true,
          messages: [1],
        }),
        consume: async () => {},
      }),
    ).rejects.toThrow("did not advance");
  });

  test("uses full recovery only for an empty catch-up from an old desktop", () => {
    expect(
      shouldUseLegacySyncRecoverySnapshot({
        catchUp: true,
        initialCursor: "legacy-cursor",
        rows: 0,
      }),
    ).toBe(true);
    expect(
      shouldUseLegacySyncRecoverySnapshot({
        catchUp: true,
        initialCursor: "legacy-cursor",
        rows: 2,
      }),
    ).toBe(false);
    expect(
      shouldUseLegacySyncRecoverySnapshot({
        catchUp: true,
        initialCursor: "v2:10:10:event-10",
        cursorStatus: "valid",
        rows: 0,
      }),
    ).toBe(false);
  });
});
