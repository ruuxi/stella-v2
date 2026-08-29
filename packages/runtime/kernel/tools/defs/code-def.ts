/**
 * The `code` tool's model-visible surface, split from the executable
 * definition so workerd hosts advertise the byte-identical tool. The kernel
 * behind it uses `worker_threads`; the cloud DO substitutes its own Dynamic
 * Worker executor for that name.
 */

import { CODE_TOOL_NAME } from "../code-tool.js";

export { CODE_TOOL_NAME };

export const CODE_TOOL_DESCRIPTION =
  'Run JavaScript with top-level await in Stella\'s persistent code runtime, or observe a previously yielded cell with cell_id; bindings persist within one generation (use var for reusable names). Call the immutable globals directly: codeRuntime, sky, browser, connect, and tools. There is no frozen namespace or frozen.browser object. End with an expression to return its value, or call codeRuntime.write(...); console.log and process.stdout are not output channels. codeRuntime also exposes emitImage/emitAudio/status/reset/help and cwd/home/tmp. Long cells yield with a generation-tagged cell ID; call code again with cell_id to receive only new output or terminate it. Observations use a monotonic cursor. browser controls owned tabs and defaults to in-app; use browser.use("external") only for the user\'s signed-in Chromium browser and browser.use("in-app") to switch back. Basic navigation is: const tab = await browser.tabs.new("https://example.com"); await tab.playwright.locator("#id").waitFor({ state: "visible" });. In cloud, call browser.requestLoginTakeover({ allowedOrigins: [origin], displayOrigin: origin, startUrl?, displayTitle?, verification: { expectedOrigin: origin, authenticatedSelector, loggedOutSelector, resumeUrl } }) when private human credential entry is required. All origins and URLs must use that one exact HTTPS origin; both distinct selectors are required and may only be #id, .class, or exact [data-testid="..."]; never ask for or type the credential in code. browser.requestDeviceCodeFixture({ expiresInMs? }) exercises the separate public device-code suspension path without exposing provider secrets. tools exposes allowed Stella tools and refreshes between cells. Use tools.$list() for exact names/access expressions; non-identifier names require bracket notation such as tools["mcp.server/tool"](...). Use tools.$search({ query: "<capability>" }) for ranked signatures, and tools.$describe(name) for a complete unfamiliar schema. Use Promise.all for independent calls. Nested tools retain permissions, cancellation, file changes, produced-file omissions, and route artifacts; tools requiring explicit approval are unavailable inside code and must be called directly. Unawaited calls are drained with a bounded deadline. Batch dependent browser/computer actions in one cell, pass state_id for UI-derived actions, and use sky.wait_for_change when a mutation must become observable.';

export const CODE_TOOL_PROMPT_SNIPPET =
  "Run persistent JavaScript, orchestrate allowed Stella tools, and control apps through the sky/browser/connect globals";

export const CODE_TOOL_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    code: {
      type: "string",
      description: "JavaScript to evaluate with top-level await.",
    },
    timeout_ms: {
      type: "number",
      description: "Optional evaluation timeout in milliseconds.",
    },
    yield_time_ms: {
      type: "number",
      description:
        "How long to await a new cell before returning a resumable cell_id. Defaults to 30000ms.",
    },
    cell_id: {
      type: "string",
      description: "Generation-tagged ID returned by a running code cell.",
    },
    wait_ms: {
      type: "number",
      description:
        "How long to observe cell_id for terminal output. Defaults to 10000ms.",
    },
    cursor: {
      type: "number",
      description:
        "Optional prior cursor for cell_id. The response contains only content after this cursor and does not consume content if the wait is aborted.",
    },
    terminate: {
      type: "boolean",
      description:
        "Terminate cell_id and reset its persistent REPL generation.",
    },
  },
};
