import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";

import { createPiTools } from "../kernel/agent-runtime/tool-adapters.js";
import {
  BrowserSession,
  type BrowserChainOptions,
  type BrowserChainResult,
  type BrowserChainStep,
  type BrowserCommandOptions,
  type BrowserCommandParams,
  type BrowserCommandReceipt,
  type BrowserProtocolAction,
  type BrowserSessionClient,
  type BrowserSessionOptions,
  type BrowserTurnEndBehavior,
} from "../kernel/browser-use/client.js";
import { NodeReplKernelRegistry } from "../kernel/computer-use/kernel.js";
import { createNodeReplTool } from "../kernel/tools/defs/node-repl.js";
import type {
  ToolContext,
  ToolResult,
  ToolUpdateCallback,
} from "../kernel/tools/types.js";

const assert: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new Error(message);
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() {
    return new Response(
      `<!doctype html><html><body style="margin:0;background:#172033;color:white">
        <main style="padding:32px"><h1>Stella browser adapter acceptance</h1>
        <button id="acceptance">Typed screenshot</button></main>
      </body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  },
});

const runId = `live-browser-adapter-${randomUUID()}`;
const conversationId = `conversation-${randomUUID()}`;
const pageUrl = `http://${server.hostname}:${server.port}/`;
const knownCreatedTabIds = new Set<number>();
const closedTabIds = new Set<number>();
const cleanupErrors: string[] = [];
const sessionCleanups: Array<() => Promise<void>> = [];

const recordBrowserReceipt = (
  action: BrowserProtocolAction,
  receipt: BrowserCommandReceipt<unknown>,
): void => {
  const data = receipt.result.data;
  if (!data || typeof data !== "object") return;
  if (action === "tab_new") {
    const tabId = (data as { tabId?: unknown }).tabId;
    if (Number.isSafeInteger(tabId) && Number(tabId) > 0) {
      knownCreatedTabIds.add(Number(tabId));
    }
  }
  if (action === "finalize_tabs") {
    const ids = (data as { closedTabIds?: unknown }).closedTabIds;
    if (Array.isArray(ids)) {
      for (const id of ids) {
        if (Number.isSafeInteger(id) && Number(id) > 0) {
          closedTabIds.add(Number(id));
        }
      }
    }
  }
};

const createTrackedBrowserSession = (
  options: BrowserSessionOptions,
): BrowserSessionClient => {
  const session = new BrowserSession(options);
  let browserTouched = false;
  let cleanupStarted = false;
  let disposePromise: Promise<void> | undefined;
  const cleanupOwnedTabs = async (): Promise<void> => {
    if (!browserTouched || cleanupStarted || session.isDisposed) return;
    cleanupStarted = true;
    try {
      const receipt = await session.command("finalize_tabs", {
        keep: [],
        preserveMarked: false,
      });
      recordBrowserReceipt("finalize_tabs", receipt);
    } catch (error) {
      cleanupErrors.push(
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  sessionCleanups.push(cleanupOwnedTabs);

  return {
    async command<TData = unknown>(
      action: BrowserProtocolAction,
      params?: BrowserCommandParams,
      commandOptions?: BrowserCommandOptions,
    ): Promise<BrowserCommandReceipt<TData>> {
      browserTouched = true;
      const receipt = await session.command<TData>(
        action,
        params,
        commandOptions,
      );
      recordBrowserReceipt(action, receipt as BrowserCommandReceipt<unknown>);
      return receipt;
    },
    async chain<TData = unknown>(
      steps: readonly BrowserChainStep[],
      chainOptions?: BrowserChainOptions,
    ): Promise<BrowserCommandReceipt<BrowserChainResult<TData>>> {
      browserTouched = true;
      return await session.chain<TData>(steps, chainOptions);
    },
    async selectBackend(backend) {
      return await session.selectBackend(backend);
    },
    beginTurn(turnId: string): void {
      session.beginTurn(turnId);
    },
    async endTurn(
      turnId: string,
      behavior: BrowserTurnEndBehavior,
    ): Promise<void> {
      await session.endTurn(turnId, behavior);
    },
    dispose(): Promise<void> {
      disposePromise ??= cleanupOwnedTabs().then(() => session.dispose());
      return disposePromise;
    },
  };
};

const registry = new NodeReplKernelRegistry({
  sessionFactory: () => ({ request: async () => ({}) }),
  browserSessionFactory: createTrackedBrowserSession,
  idleTimeoutMs: 60_000,
});
const nodeReplTool = createNodeReplTool({ registry });

const [modelTool] = createPiTools({
  runId,
  rootRunId: runId,
  conversationId,
  agentType: "general",
  deviceId: "live-browser-adapter",
  stellaAppDir: process.cwd(),
  stellaDataDir: process.env.STELLA_DATA_DIR,
  toolWorkspaceRoot: process.cwd(),
  agentDepth: 1,
  toolsAllowlist: ["node_repl"],
  toolCatalog: [
    {
      name: "node_repl",
      description: nodeReplTool.description,
      parameters: nodeReplTool.parameters,
    },
  ],
  store: {},
  toolExecutor: async (
    toolName: string,
    toolArgs: Record<string, unknown>,
    toolContext: ToolContext,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ): Promise<ToolResult> => {
    assert(toolName === "node_repl", `Unexpected tool dispatch: ${toolName}`);
    return await nodeReplTool.execute(toolArgs, toolContext, {
      ...(signal ? { signal } : {}),
      ...(onUpdate ? { onUpdate } : {}),
    });
  },
});

assert(modelTool, "node_repl was not registered in the model tool adapter");

try {
  const resetErrorResult = await modelTool.execute(
    `live-browser-reset-error-${randomUUID()}`,
    {
      code: "var discardedAfterLiveResetError = 1; nodeRepl.reset(); throw new Error('live adapter reset failure')",
      timeout_ms: 20_000,
    },
    undefined,
    undefined,
  );
  const resetErrorDetails = resetErrorResult.details as
    | {
        nodeRepl?: {
          generation?: number;
          status?: string;
          reset?: {
            reason?: string;
            previousGeneration?: number;
            nextGeneration?: number;
            bindingsDiscarded?: boolean;
          };
        };
      }
    | undefined;
  assert(resetErrorResult.isError === true, "Reset-then-error did not fail");
  assert(
    resetErrorDetails?.nodeRepl?.status === "failed" &&
      resetErrorDetails.nodeRepl.reset?.reason === "explicit" &&
      resetErrorDetails.nodeRepl.reset.previousGeneration === 1 &&
      resetErrorDetails.nodeRepl.reset.nextGeneration === 2 &&
      resetErrorDetails.nodeRepl.reset.bindingsDiscarded === true,
    `Reset-then-error lost provenance: ${JSON.stringify(resetErrorDetails)}`,
  );
  const afterErrorReset = await modelTool.execute(
    `live-browser-after-reset-error-${randomUUID()}`,
    {
      code: "({ status: nodeRepl.status(), discarded: typeof discardedAfterLiveResetError })",
      timeout_ms: 20_000,
    },
    undefined,
    undefined,
  );
  const afterErrorText = (
    afterErrorReset.content as Array<{ text?: string }>
  )[0]?.text;
  assert(
    afterErrorText?.includes("generation: 2") === true &&
      afterErrorText.includes("discarded: 'undefined'") === true,
    `Reset-then-error did not commit: ${afterErrorText}`,
  );

  const code = `
await browser.use("external");
var acceptanceTab = await browser.tabs.new(${JSON.stringify(pageUrl)});
var acceptanceScreenshot;
try {
  await acceptanceTab.playwright.waitForURL(${JSON.stringify(pageUrl)}, { timeout: 5000 });
  acceptanceScreenshot = await acceptanceTab.screenshot({ format: "png" });
  nodeRepl.write({ tabId: acceptanceTab.id, screenshot: acceptanceScreenshot });
} finally {
  await browser.tabs.finalize([]);
}
nodeRepl.reset()`;

  const result = await modelTool.execute(
    `live-browser-adapter-${randomUUID()}`,
    { code, timeout_ms: 20_000 },
    undefined,
    undefined,
  );
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter((item: { type?: string }) => item?.type === "text")
    .map((item: { text?: string }) => item.text ?? "")
    .join("\n");
  const images = content.filter(
    (item: { type?: string }) => item?.type === "image",
  ) as Array<{
    type: "image";
    mimeType?: string;
    data?: string;
    sourcePath?: string;
  }>;

  assert(
    result.isError !== true,
    `Model-facing node_repl result was an error: ${text}`,
  );
  assert(
    images.length === 1,
    `Expected one typed image, received ${images.length}`,
  );
  const image = images[0];
  assert(
    image.mimeType === "image/png",
    `Unexpected MIME type: ${image.mimeType}`,
  );
  assert(
    typeof image.data === "string" && image.data.length > 0,
    "Typed image has no data",
  );
  assert(
    typeof image.sourcePath === "string" && path.isAbsolute(image.sourcePath),
    "Typed image has no absolute source path",
  );
  assert(
    Buffer.from(image.data, "base64")
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    "Typed image is not a complete PNG payload",
  );
  assert(
    text.includes("attached: true"),
    "Compact screenshot receipt is missing",
  );
  assert(
    text.includes("[browser-receipt]"),
    "Browser lifecycle receipt is missing",
  );
  assert(
    !text.includes("data:image/"),
    "Screenshot leaked into model text as a data URL",
  );
  assert(
    !text.includes("base64"),
    "Screenshot leaked into model text as base64",
  );
  assert(
    !/[A-Za-z0-9+/]{512,}={0,2}/.test(text),
    "Screenshot-like base64 leaked into model text",
  );
  assert(
    !text.includes("[stella-attach-image]"),
    "Legacy attachment marker leaked into model text",
  );

  const details = result.details as
    | {
        nodeRepl?: {
          content?: Array<{
            type?: string;
            path?: string;
            mimeType?: string;
            deleteAfterAttach?: boolean;
          }>;
          reset?: {
            reason?: string;
            previousGeneration?: number;
            nextGeneration?: number;
            bindingsDiscarded?: boolean;
          };
        };
      }
    | undefined;
  const typedDetail = details?.nodeRepl?.content?.find(
    (item) => item.type === "image",
  );
  assert(typedDetail, "Typed node_repl image metadata is missing");
  assert(
    typedDetail.path === image.sourcePath,
    "Model image source and node_repl image receipt disagree",
  );
  assert(
    typedDetail.deleteAfterAttach === true,
    "Kernel-owned screenshot did not transfer cleanup ownership",
  );
  let screenshotStillExists = true;
  try {
    await access(image.sourcePath);
  } catch {
    screenshotStillExists = false;
  }
  assert(
    screenshotStillExists === false,
    "Adapter did not acknowledge and clean up the transferred screenshot",
  );
  assert(
    details?.nodeRepl?.reset?.reason === "explicit" &&
      details.nodeRepl.reset.previousGeneration === 2 &&
      details.nodeRepl.reset.nextGeneration === 3 &&
      details.nodeRepl.reset.bindingsDiscarded === true,
    `Screenshot reset lost provenance: ${JSON.stringify(details)}`,
  );
  const afterScreenshotReset = await modelTool.execute(
    `live-browser-after-screenshot-reset-${randomUUID()}`,
    { code: "nodeRepl.status()", timeout_ms: 20_000 },
    undefined,
    undefined,
  );
  const afterScreenshotText = (
    afterScreenshotReset.content as Array<{ text?: string }>
  )[0]?.text;
  assert(
    afterScreenshotText?.includes("generation: 3") === true,
    `Screenshot reset did not advance generation: ${afterScreenshotText}`,
  );
  const createdIds = [...knownCreatedTabIds].sort(
    (left, right) => left - right,
  );
  const closedIds = [...closedTabIds].sort((left, right) => left - right);
  assert(
    createdIds.length === 1,
    `Expected one created tab, got ${createdIds}`,
  );
  assert(
    createdIds.every((tabId) => closedTabIds.has(tabId)),
    `Created tab IDs were not all reported in closedTabIds: created=${createdIds} closed=${closedIds}`,
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        runId,
        pageUrl,
        modelTextChars: text.length,
        modelText: text,
        typedImage: {
          mimeType: image.mimeType,
          sourcePath: image.sourcePath,
          decodedBytes: Buffer.from(image.data, "base64").byteLength,
        },
        rawBase64InModelText: false,
        legacyMarkerInModelText: false,
        resetThenError: {
          reset: resetErrorDetails?.nodeRepl?.reset,
          committedState: afterErrorText,
        },
        screenshotReset: {
          reset: details?.nodeRepl?.reset,
          nextState: afterScreenshotText,
          temporaryFileRemoved: true,
        },
        browserTabs: {
          createdTabIds: createdIds,
          closedTabIds: closedIds,
          exactCreatedTabsClosed: true,
        },
      },
      null,
      2,
    ),
  );
} finally {

  await Promise.allSettled(sessionCleanups.map((cleanup) => cleanup()));
  await registry.dispose().catch(() => undefined);
  server.stop(true);
}
