import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  BrowserSession,
  BrowserSessionCommandError,
  type BrowserCommandReceipt,
  type BrowserJsonValue,
} from "../kernel/browser-use/client.js";

type JsonObject = Record<string, BrowserJsonValue>;

const data = <T>(receipt: BrowserCommandReceipt<T>): T =>
  receipt.result.data as T;

const frameHtml = `<!doctype html>
<html><body><button id="frame-btn" ondblclick="window.frameDbl=(window.frameDbl||0)+1">FrameButton</button></body></html>`;

const bulkButtons = Array.from(
  { length: 230 },
  (_, index) =>
    `<button class="bulk">Bulk ${index + 1} ${"x".repeat(96)}</button>`,
).join("");

const mainHtml = `<!doctype html>
<html><body style="margin:0">
  <div id="shadow-host"></div>
  <button id="slow-mutation">Slow mutation</button>
  <iframe id="frame" src="/frame" style="margin-left:120px;border:5px solid black;width:260px;height:100px"></iframe>
  <div>${bulkButtons}</div>
  <script>
    window.shadowClicks = 0;
    window.later = 0;
    window.slowMutation = 0;
    document.querySelector("#slow-mutation").addEventListener("click", () => {
      const until = performance.now() + 125;
      while (performance.now() < until) {}
      window.slowMutation += 1;
    });
    const root = document.querySelector("#shadow-host").attachShadow({mode:"open"});
    root.innerHTML = '<button id="shadow-btn">ShadowButton</button>';
    root.querySelector("#shadow-btn").addEventListener("click", () => window.shadowClicks++);
  </script>
</body></html>`;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const pathname = new URL(request.url).pathname;
    return new Response(pathname === "/frame" ? frameHtml : mainHtml, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
});

const sessionId = `live-browser-acceptance-${randomUUID()}`;
const backend =
  process.env.STELLA_LIVE_BROWSER_BACKEND === "in-app" ? "in-app" : "external";
const browser = new BrowserSession({
  sessionId,
  cwd: process.cwd(),
  commandTimeoutMs: 10_000,
});

const report: Record<string, unknown> = {
  sessionId,
  backend,
  url: `http://${server.hostname}:${server.port}/`,
};
const leaveDeliverableTab =
  process.env.STELLA_LIVE_BROWSER_LEAVE_DELIVERABLE === "1";
const knownCreatedTabIds = new Set<number>();
const closedTabIds = new Set<number>();
let completedSuccessfully = false;

const recordClosedTabs = (value: unknown): void => {
  if (!value || typeof value !== "object") return;
  const ids = (value as { closedTabIds?: unknown }).closedTabIds;
  if (!Array.isArray(ids)) return;
  for (const id of ids) {
    if (Number.isSafeInteger(id) && Number(id) > 0)
      closedTabIds.add(Number(id));
  }
};

try {
  await browser.selectBackend(backend);
  const health = data<Record<string, unknown>>(
    await browser.command("healthcheck"),
  );
  report.health = health;

  const created = data<{ tabId: number; tabGeneration?: string }>(
    await browser.command("tab_new", { url: report.url as string }),
  );
  const tabId = created.tabId;
  knownCreatedTabIds.add(tabId);
  report.tabId = tabId;

  await browser.command("bringtofront", { tabId });
  await browser.command("wait", {
    selector: "#frame-btn",
    timeout: 5_000,
    tabId,
  });

  const snapshot = data<{
    snapshot: string;
    refs: Record<string, unknown>;
  }>(await browser.command("snapshot", { compact: true, tabId }));
  report.snapshot = {
    chars: snapshot.snapshot.length,
    lines: snapshot.snapshot.split("\n").length,
    refs: Object.keys(snapshot.refs).length,
    bounded: snapshot.snapshot.length <= 22_000,
    reportsTruncation: snapshot.snapshot.includes(
      "snapshot metadata: truncated=true",
    ),
  };

  const commandData = async <T>(
    action: Parameters<BrowserSession["command"]>[0],
    params: JsonObject,
  ) => data<T>(await browser.command<T>(action, { ...params, tabId }));

  report.composedTree = {
    bulkCount: await commandData("count", { selector: ".bulk" }),
    shadowCount: await commandData("count", { selector: "#shadow-btn" }),
    frameCount: await commandData("count", { selector: "#frame-btn" }),
    shadowText: await commandData("innertext", { selector: "#shadow-btn" }),
    frameVisible: await commandData("isvisible", { selector: "#frame-btn" }),
    frameBox: await commandData("boundingbox", { selector: "#frame-btn" }),
    viewport: await commandData("evaluate", {
      script:
        "({innerWidth: window.innerWidth, innerHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio})",
    }),
  };
  await browser.command("click", { selector: "#shadow-btn", tabId });
  await browser.command("dblclick", { selector: "#frame-btn", tabId });
  report.actions = await commandData("evaluate", {
    script:
      "({shadowClicks: window.shadowClicks, frameDbl: document.querySelector('#frame').contentWindow.frameDbl})",
  });

  const screenshot = data<{ base64: string; format: string }>(
    await browser.command("screenshot", {
      selector: "#frame-btn",
      format: "png",
      tabId,
    }),
  );
  report.screenshot = {
    format: screenshot.format,
    base64Chars: screenshot.base64.length,
    decodedBytes: Buffer.from(screenshot.base64, "base64").byteLength,
  };

  const timeoutStartedAt = Date.now();
  try {
    await browser.command("waitforurl", {
      url: "*never-browser-acceptance*",
      timeout: 1_250,
      tabId,
    });
    report.timeout = { unexpectedSuccess: true };
  } catch (error) {
    report.timeout = {
      elapsedMs: Date.now() - timeoutStartedAt,
      isBrowserError: error instanceof BrowserSessionCommandError,
      timeoutMs:
        error instanceof BrowserSessionCommandError
          ? error.timeoutMs
          : undefined,
      timeoutSource:
        error instanceof BrowserSessionCommandError
          ? error.timeoutSource
          : undefined,
      requestDispatched:
        error instanceof BrowserSessionCommandError
          ? error.requestDispatched
          : undefined,
      outcomeUnknown:
        error instanceof BrowserSessionCommandError
          ? error.outcomeUnknown
          : undefined,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const execute = (
    browser as unknown as {
      execute<T>(
        action: string,
        params: JsonObject,
        signal: AbortSignal | undefined,
        timeoutMs: number,
        timeoutSource: "caller" | "runtime-default",
      ): Promise<BrowserCommandReceipt<T>>;
    }
  ).execute.bind(browser);
  try {
    const chain = data<{
      results: Array<{ action: string; success: boolean; error?: string }>;
      completed: number;
      total: number;
    }>(
      await execute(
        "chain",
        {
          steps: [
            { action: "waitforurl", url: "*never-chain*", timeout: 1_000 },
            { action: "evaluate", script: "window.later = 1" },
          ],
          timeout: 25,
          waitForSelector: false,
          abortOnError: false,
          tabId,
        },
        undefined,
        2_000,
        "caller",
      ),
    );
    report.chainDeadline = { unexpectedSuccess: true, ...chain };
  } catch (error) {
    report.chainDeadline = {
      isBrowserError: error instanceof BrowserSessionCommandError,
      timeoutMs:
        error instanceof BrowserSessionCommandError
          ? error.timeoutMs
          : undefined,
      timeoutSource:
        error instanceof BrowserSessionCommandError
          ? error.timeoutSource
          : undefined,
      requestDispatched:
        error instanceof BrowserSessionCommandError
          ? error.requestDispatched
          : undefined,
      outcomeUnknown:
        error instanceof BrowserSessionCommandError
          ? error.outcomeUnknown
          : undefined,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const later = await commandData<number>("evaluate", {
    script: "window.later",
  });
  report.chainDeadline = { ...(report.chainDeadline as object), later };

  if (backend === "external") {
    try {
      await execute(
        "chain",
        {
          steps: [{ action: "click", selector: "#slow-mutation" }],
          timeout: 25,
          waitForSelector: false,
          tabId,
        },
        undefined,
        2_000,
        "caller",
      );
      report.mutationTimeout = { unexpectedSuccess: true };
    } catch (error) {
      const browserError =
        error instanceof BrowserSessionCommandError ? error : undefined;
      const receiptResult = browserError?.receipt?.result as
        | {
            outcomeUnknown?: boolean;
            data?: { results?: Array<{ outcomeUnknown?: boolean }> };
          }
        | undefined;
      report.mutationTimeout = {
        isBrowserError: browserError !== undefined,
        timeoutMs: browserError?.timeoutMs,
        timeoutSource: browserError?.timeoutSource,
        requestDispatched: browserError?.requestDispatched,
        outcomeUnknown: browserError?.outcomeUnknown,
        receiptOutcomeUnknown: receiptResult?.outcomeUnknown,
        stepOutcomeUnknown: receiptResult?.data?.results?.[0]?.outcomeUnknown,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 175));
    const slowMutation = await commandData<{ result: number }>("evaluate", {
      script: "window.slowMutation",
    });
    report.mutationTimeout = {
      ...(report.mutationTimeout as object),
      observedMutationAfterTimeout: slowMutation.result,
    };
  }

  await browser.command("mark_tab", {
    tabId,
    status: "deliverable",
  });
  const disposable = data<{ tabId: number }>(
    await browser.command("tab_new", { url: "about:blank" }),
  );
  knownCreatedTabIds.add(disposable.tabId);
  const finalized = data(
    await browser.command("finalize_tabs", {
      keep: [],
      preserveMarked: leaveDeliverableTab,
    }),
  );
  recordClosedTabs(finalized);
  report.finalize = finalized;
  report.leaveDeliverableTab = leaveDeliverableTab;
  if (leaveDeliverableTab) {
    report.intentionalDeliverableTabId = tabId;
    report.cleanupNote =
      "The marked localhost tab was intentionally released for preserveMarked acceptance. Close it manually after inspection.";
  }
  report.disposableTabId = disposable.tabId;
  completedSuccessfully = true;
} finally {

  if (!completedSuccessfully || !leaveDeliverableTab) {
    try {
      const cleanup = data(
        await browser.command("finalize_tabs", {
          keep: [],
          preserveMarked: false,
        }),
      );
      recordClosedTabs(cleanup);
      report.outerCleanup = cleanup;
    } catch (error) {
      report.outerCleanupError =
        error instanceof Error ? error.message : String(error);
    }
  }
  report.cleanup = {
    knownCreatedTabIds: [...knownCreatedTabIds].sort(
      (left, right) => left - right,
    ),
    closedTabIds: [...closedTabIds].sort((left, right) => left - right),
  };
  await browser.dispose().catch(() => undefined);
  server.stop(true);
}

const composed = report.composedTree as {
  bulkCount: { count: number };
  shadowCount: { count: number };
  frameCount: { count: number };
  frameBox: { x?: number; box?: { x: number } };
  viewport: { result: { innerWidth: number; innerHeight: number } };
};
const actionResult = report.actions as {
  result: { shadowClicks: number; frameDbl: number };
};
const snapshotResult = report.snapshot as {
  bounded: boolean;
  reportsTruncation: boolean;
};
const screenshotResult = report.screenshot as { decodedBytes: number };
const timeoutResult = report.timeout as {
  elapsedMs: number;
  timeoutMs: number;
  timeoutSource: string;
  requestDispatched: boolean;
  outcomeUnknown: boolean;
};
const chainResult = report.chainDeadline as {
  timeoutMs: number;
  timeoutSource: string;
  requestDispatched: boolean;
  outcomeUnknown: boolean;
  later: { result: number };
};
const mutationTimeoutResult = report.mutationTimeout as
  | {
      timeoutMs: number;
      timeoutSource: string;
      requestDispatched: boolean;
      outcomeUnknown: boolean;
      receiptOutcomeUnknown: boolean;
      stepOutcomeUnknown: boolean;
      observedMutationAfterTimeout: number;
    }
  | undefined;
const finalized = report.finalize as {
  closedTabIds: number[];
  releasedTabIds: number[];
};
const cleanup = report.cleanup as {
  knownCreatedTabIds: number[];
  closedTabIds: number[];
};
if (process.env.STELLA_LIVE_BROWSER_DEBUG === "1") {
  console.error(JSON.stringify(report, null, 2));
}

assert.equal(snapshotResult.bounded, true);
assert.equal(snapshotResult.reportsTruncation, true);
assert.deepEqual(
  [
    composed.bulkCount.count,
    composed.shadowCount.count,
    composed.frameCount.count,
  ],
  [230, 1, 1],
);
const frameX = composed.frameBox.box?.x ?? composed.frameBox.x;
assert.ok(typeof frameX === "number");
assert.ok(frameX >= 125);
assert.ok(composed.viewport.result.innerWidth > 0);
assert.ok(composed.viewport.result.innerHeight > 0);
assert.deepEqual(actionResult.result, { frameDbl: 1, shadowClicks: 1 });
assert.ok(screenshotResult.decodedBytes > 0);
assert.ok(timeoutResult.elapsedMs >= 1_200 && timeoutResult.elapsedMs < 3_000);
assert.deepEqual(
  {
    timeoutMs: timeoutResult.timeoutMs,
    timeoutSource: timeoutResult.timeoutSource,
    requestDispatched: timeoutResult.requestDispatched,
    outcomeUnknown: timeoutResult.outcomeUnknown,
  },
  {
    timeoutMs: 1_250,
    timeoutSource: "caller",
    requestDispatched: true,
    outcomeUnknown: false,
  },
);
if (backend === "external") {
  assert.deepEqual(
    {
      timeoutMs: mutationTimeoutResult?.timeoutMs,
      timeoutSource: mutationTimeoutResult?.timeoutSource,
      requestDispatched: mutationTimeoutResult?.requestDispatched,
      outcomeUnknown: mutationTimeoutResult?.outcomeUnknown,
      receiptOutcomeUnknown: mutationTimeoutResult?.receiptOutcomeUnknown,
      stepOutcomeUnknown: mutationTimeoutResult?.stepOutcomeUnknown,
      observedMutationAfterTimeout:
        mutationTimeoutResult?.observedMutationAfterTimeout,
    },
    {
      timeoutMs: 25,
      timeoutSource: "caller",
      requestDispatched: true,
      outcomeUnknown: true,
      receiptOutcomeUnknown: true,
      stepOutcomeUnknown: true,
      observedMutationAfterTimeout: 1,
    },
  );
}
assert.deepEqual(
  {
    timeoutMs: chainResult.timeoutMs,
    timeoutSource: chainResult.timeoutSource,
    requestDispatched: chainResult.requestDispatched,
    outcomeUnknown: chainResult.outcomeUnknown,
    later: chainResult.later.result,
  },
  {
    timeoutMs: 25,
    timeoutSource: "caller",
    requestDispatched: true,
    outcomeUnknown: false,
    later: 0,
  },
);
if (leaveDeliverableTab) {
  assert.deepEqual(finalized.closedTabIds, [report.disposableTabId]);
  assert.deepEqual(finalized.releasedTabIds, [report.tabId]);
} else {
  assert.deepEqual(
    [...finalized.closedTabIds].sort((left, right) => left - right),
    [report.tabId, report.disposableTabId].sort(
      (left, right) => Number(left) - Number(right),
    ),
  );
  assert.equal(finalized.releasedTabIds.length, 0);
  assert.deepEqual(cleanup.closedTabIds, cleanup.knownCreatedTabIds);
}
report.verified = true;

console.log(JSON.stringify(report, null, 2));
