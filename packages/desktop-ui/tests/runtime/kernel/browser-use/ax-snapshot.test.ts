import { describe, expect, it } from "vitest";

import {
  installBrowserWorkerApi,
  type BrowserWorkerCall,
} from "@stella/runtime/kernel/browser-use/worker-api";

type Capture = Readonly<{ snapshot: string; documentKey?: string }> | Error;

/**
 * A backend that answers each `snapshot` command with the next queued tree.
 * The worker API's line diff is a closure inside `installBrowserWorkerApi`
 * (its source is embedded into the worker), so it is exercised through the
 * observations `axSnapshot()` returns.
 */
function axBackend(captures: Capture[]) {
  const calls: Array<{ method: string; args: readonly unknown[] }> = [];
  const callBrowser: BrowserWorkerCall = async (method, args) => {
    calls.push({ method, args });
    if (args[0] !== "snapshot") return { success: true, data: {} };
    const next = captures.shift();
    if (!next) throw new Error("no queued capture");
    if (next instanceof Error) throw next;
    return {
      success: true,
      data: { documentKey: "doc-1", ...next, refs: {} },
    };
  };
  return { calls, tab: installBrowserWorkerApi(callBrowser).tabs.get(3) };
}

const rows = (count: number) =>
  Array.from(
    { length: count },
    (_, i) => `  - listitem "Row ${i + 1}" [ref=e${i + 1}]`,
  );
const tree = (lines: readonly string[]) => ["- list", ...lines].join("\n");

describe("tab.axSnapshot", () => {
  it("returns a full tree first, then an unchanged receipt for the same tree", async () => {
    const base = tree(rows(10));
    const { calls, tab } = axBackend([{ snapshot: base }, { snapshot: base }]);

    const first = await tab.axSnapshot();
    expect(first).toEqual({
      kind: "full",
      snapshotId: expect.stringMatching(/^ax-\d+$/),
      snapshot: base,
      reason: "initial",
    });
    expect(calls[0].args).toEqual([
      "snapshot",
      expect.objectContaining({
        tabId: 3,
        format: "ax",
        interactive: false,
        compact: false,
      }),
    ]);

    const second = await tab.axSnapshot();
    expect(second).toEqual({
      kind: "unchanged",
      snapshotId: (first as { snapshotId: string }).snapshotId,
    });
  });

  it("emits line-diff hunks for inserted and deleted lines", async () => {
    const base = rows(10);
    const inserted = [
      ...base.slice(0, 5),
      '  - button "Added" [ref=e99]',
      ...base.slice(5),
    ];
    const { tab } = axBackend([
      { snapshot: tree(base) },
      { snapshot: tree(inserted) },
      { snapshot: tree(base) },
    ]);

    const first = await tab.axSnapshot();
    const insert = await tab.axSnapshot();
    expect(insert).toEqual({
      kind: "diff",
      snapshotId: expect.any(String),
      baseSnapshotId: (first as { snapshotId: string }).snapshotId,
      diff: [
        "@@ -5,4 +5,5 @@",
        ` ${base[3]}`,
        ` ${base[4]}`,
        `+${inserted[5]}`,
        ` ${base[5]}`,
        ` ${base[6]}`,
      ].join("\n"),
    });

    const remove = await tab.axSnapshot();
    expect(remove).toEqual({
      kind: "diff",
      snapshotId: expect.any(String),
      baseSnapshotId: (insert as { snapshotId: string }).snapshotId,
      diff: [
        "@@ -5,5 +5,4 @@",
        ` ${base[3]}`,
        ` ${base[4]}`,
        `-${inserted[5]}`,
        ` ${base[5]}`,
        ` ${base[6]}`,
      ].join("\n"),
    });
  });

  it("falls back to a full tree when the diff is not smaller unless mode is diff", async () => {
    const { tab } = axBackend([
      { snapshot: "a" },
      { snapshot: "b" },
      { snapshot: "c" },
    ]);
    await tab.axSnapshot();
    expect(await tab.axSnapshot()).toMatchObject({
      kind: "full",
      snapshot: "b",
      reason: "diff-not-smaller",
    });
    expect(await tab.axSnapshot({ mode: "diff" })).toMatchObject({
      kind: "diff",
      diff: "@@ -1,1 +1,1 @@\n-b\n+c",
    });
  });

  it("reports why a full tree was returned", async () => {
    const wide = rows(600);
    const { tab } = axBackend([
      { snapshot: tree(rows(10)) },
      { snapshot: tree(rows(10)), documentKey: "doc-2" },
      { snapshot: tree(rows(10)), documentKey: "doc-2" },
      { snapshot: tree(rows(10)), documentKey: "doc-2" },
      { snapshot: tree(wide), documentKey: "doc-2" },
      {
        snapshot: tree([
          ...wide.slice(0, 300),
          "  - button",
          ...wide.slice(300),
        ]),
        documentKey: "doc-2",
      },
    ]);
    await tab.axSnapshot();
    expect(await tab.axSnapshot()).toMatchObject({
      reason: "document-changed",
    });
    expect(await tab.axSnapshot({ interactive: true })).toMatchObject({
      reason: "options-changed",
    });
    expect(
      await tab.axSnapshot({ interactive: true, mode: "full" }),
    ).toMatchObject({
      reason: "requested",
    });
    // Baseline options are back to the defaults after this full capture.
    expect(await tab.axSnapshot()).toMatchObject({ reason: "options-changed" });
    expect(await tab.axSnapshot()).toMatchObject({ reason: "diff-budget" });
  });

  it("clears the baseline after a failed capture", async () => {
    const base = tree(rows(3));
    const { tab } = axBackend([
      { snapshot: base },
      new Error("capture failed"),
      { snapshot: base },
    ]);
    await tab.axSnapshot();
    await expect(tab.axSnapshot()).rejects.toThrow("capture failed");
    expect(await tab.axSnapshot()).toMatchObject({
      kind: "full",
      reason: "initial",
    });
  });

  it("rejects unknown options and modes", async () => {
    const { tab } = axBackend([]);
    await expect(tab.axSnapshot({ mode: "partial" as "auto" })).rejects.toThrow(
      "AX snapshot mode must be 'auto', 'full', or 'diff'.",
    );
    await expect(
      tab.axSnapshot({ cursor: true } as unknown as { mode: "auto" }),
    ).rejects.toThrow();
  });
});
