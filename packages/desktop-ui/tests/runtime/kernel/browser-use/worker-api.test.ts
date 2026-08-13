import { describe, expect, it, vi } from "vitest";

import {
  installBrowserWorkerApi,
  type BrowserWorkerCall,
} from "@stella/runtime/kernel/browser-use/worker-api";

type RecordedCall = {
  method: "command" | "chain";
  args: readonly unknown[];
};

const semantic = (payload: Record<string, unknown>) =>
  `aria=${encodeURIComponent(JSON.stringify(payload))}`;

describe("browser worker API", () => {
  it("defaults to in-app browsing and exposes an explicit external selector", async () => {
    const callBrowser = vi.fn<BrowserWorkerCall>(async (method, args) => ({
      backend: method === "use" ? args[0] : "in-app",
    }));
    const browser = installBrowserWorkerApi(callBrowser);

    expect(browser.backend).toBe("in-app");
    await expect(browser.use("external")).resolves.toEqual({
      backend: "external",
    });
    expect(browser.backend).toBe("external");
    expect(callBrowser).toHaveBeenCalledWith("use", ["external"]);

    await expect(browser.use("chrome" as "external")).rejects.toThrow(
      "backend must be 'in-app' or 'external'",
    );
    expect(callBrowser).toHaveBeenCalledTimes(1);
  });

  it("adapts waitForFunction and detached scheduling to the existing extension API", async () => {
    const callBrowser = vi.fn<BrowserWorkerCall>(async (method, args) => {
      if (method === "use") return { backend: args[0] };
      return { success: true, data: { result: true } };
    });
    const browser = installBrowserWorkerApi(callBrowser);

    await browser.use("external");
    const playwright = browser.tabs.get(7).playwright;
    await expect(
      playwright.waitForFunction(() => document.readyState === "complete"),
    ).resolves.toBe(true);
    await playwright.schedule(() => window.scrollTo(0, 100));

    const commands = callBrowser.mock.calls
      .filter(([method]) => method === "command")
      .map(([, args]) => args);
    expect(commands.map(([action]) => action)).toEqual([
      "evaluate",
      "evaluate",
    ]);
    expect(commands[0]?.[1]).toMatchObject({ tabId: 7 });
    expect(commands[1]?.[1]).toMatchObject({ tabId: 7 });
    expect((commands[1]?.[1] as { script: string }).script).toContain(
      "Promise.resolve().then",
    );
  });

  it("accepts ten-minute daemon waits and rejects longer waits", async () => {
    const calls: RecordedCall[] = [];
    const tab = installBrowserWorkerApi(async (method, args) => {
      calls.push({ method, args });
      if (args[0] === "requests") {
        return { success: true, data: { requests: [] } };
      }
      if (args[0] === "responsebody") {
        return { success: true, data: { status: 204, body: "" } };
      }
      return { success: true, data: { result: true } };
    }).tabs.get(3);

    await tab.playwright.waitForFunction("true", { timeout: 600_000 });
    await tab.network.waitForResponse("/done", undefined, {
      timeout: 600_000,
    });
    await expect(
      tab.playwright.waitForFunction("true", { timeout: 600_001 }),
    ).rejects.toThrow("at most 600000");
    await expect(
      tab.network.waitForResponse("/done", undefined, { timeout: 600_001 }),
    ).rejects.toThrow("at most 600000");

    expect(calls.map(({ args }) => args[0])).toEqual([
      "waitforfunction",
      "requests",
      "responsebody",
    ]);
    expect(calls[0]?.args[1]).toMatchObject({ timeout: 600_000 });
    expect(calls[2]?.args[1]).toMatchObject({ timeout: 600_000 });
  });

  it("exposes daemon-backed waits, detached work, and bounded network APIs", async () => {
    const calls: RecordedCall[] = [];
    const browser = installBrowserWorkerApi(async (method, args) => {
      calls.push({ method, args });
      const action = args[0];
      if (action === "waitforfunction") {
        return { success: true, data: { result: true } };
      }
      if (action === "requests") {
        return { success: true, data: { requests: [{ url: "/api" }] } };
      }
      if (action === "responsebody") {
        return { success: true, data: { status: 200, body: "ok" } };
      }
      if (action === "authenticated_request") {
        return { success: true, data: { status: 201, body: "created" } };
      }
      if (action === "authenticated_request_batch") {
        return {
          success: true,
          data: { responses: [{ status: 200 }, { status: 201 }] },
        };
      }
      return { success: true, data: {} };
    });
    const tab = browser.tabs.get(7);

    await expect(
      tab.playwright.waitForFunction(() => document.readyState === "complete", {
        timeout: 120_000,
      }),
    ).resolves.toBe(true);
    await tab.playwright.schedule(async () => {
      await Promise.resolve();
    });
    await expect(
      tab.network.requests({ filter: "/api", limit: 5 }),
    ).resolves.toEqual([{ url: "/api" }]);
    await tab.network.rewriteRequest("*/generate", {
      jsonPatch: { parameters: { safety_tolerance: 3 } },
      headers: { "x-client": "stella" },
    });
    await tab.network.clearRequestRewrite("*/generate");
    await expect(
      tab.network.fetch("/api/create", {
        method: "POST",
        body: "{}",
        timeout: 90_000,
        maxBodyBytes: 4096,
      }),
    ).resolves.toMatchObject({ status: 201 });
    await expect(
      tab.network.fetchAll(
        [{ url: "/api/one" }, { url: "/api/two", method: "POST", body: "{}" }],
        { concurrency: 2, timeout: 120_000 },
      ),
    ).resolves.toEqual([{ status: 200 }, { status: 201 }]);
    await expect(
      tab.network.waitForResponse("/api/result", async () => undefined, {
        timeout: 60_000,
      }),
    ).resolves.toMatchObject({ status: 200 });

    expect(calls.map(({ args }) => args[0])).toEqual([
      "waitforfunction",
      "evaluate_detached",
      "requests",
      "rewrite_request",
      "unrewrite_request",
      "authenticated_request",
      "authenticated_request_batch",
      "requests",
      "responsebody",
    ]);
    expect(calls[0]?.args[1]).toMatchObject({ tabId: 7, timeout: 120_000 });
    expect(calls[3]?.args[1]).toMatchObject({
      tabId: 7,
      jsonPatch: { parameters: { safety_tolerance: 3 } },
    });
  });

  it("is self-contained when stringified and deeply freezes public roots", async () => {
    const restored = (0, eval)(
      `(${installBrowserWorkerApi.toString()})`,
    ) as typeof installBrowserWorkerApi;
    const browser = restored(async (method, args) => {
      if (method === "command" && args[0] === "tab_list") {
        return {
          success: true,
          data: {
            tabs: [
              {
                tabId: 7,
                title: "Example",
                url: "https://example.com",
                active: true,
              },
            ],
            activeTabId: 7,
          },
        };
      }
      return { success: true, data: {} };
    });

    const [tab] = await browser.tabs.list();
    const locator = tab!.playwright.getByRole("button", { name: "Save" });

    expect(Object.isFrozen(browser)).toBe(true);
    expect(Object.isFrozen(browser.tabs)).toBe(true);
    expect(Object.isFrozen(tab)).toBe(true);
    expect(Object.isFrozen(tab!.playwright)).toBe(true);
    expect(Object.isFrozen(locator)).toBe(true);
    expect("run" in browser).toBe(false);
    expect(browser.documentation()).toContain(
      "multiple awaited browser actions",
    );
    expect(browser.documentation()).toContain("Do not add sleeps");
  });

  it("normalizes tab payloads and preserves Tab identity across the graph", async () => {
    const calls: RecordedCall[] = [];
    const callBrowser: BrowserWorkerCall = vi.fn(async (method, args) => {
      calls.push({ method, args });
      const action = args[0];
      if (method === "command" && action === "tab_list") {
        return {
          result: {
            success: true,
            data: {
              tabs: [
                {
                  tabId: "41",
                  title: "First",
                  url: "https://first.test",
                  active: true,
                },
              ],
              activeTabId: "41",
            },
          },
        };
      }
      if (method === "command" && action === "tab_new") {
        return { success: true, data: { tabId: 52 } };
      }
      return { success: true, data: {} };
    });
    const browser = installBrowserWorkerApi(callBrowser);

    const firstList = await browser.tabs.list();
    const secondList = await browser.tabs.list();
    const selected = await browser.tabs.selected();
    const created = await browser.tabs.new("https://new.test");

    expect(firstList[0]).toBe(secondList[0]);
    expect(firstList[0]).toBe(browser.tabs.get(41));
    expect(selected).toBe(firstList[0]);
    expect(created).toBe(browser.tabs.get(52));
    expect(created.id).toBe(52);
    expect(calls.at(-1)).toEqual({
      method: "command",
      args: ["tab_new", { url: "https://new.test" }],
    });
  });

  it("fences a stale handle when a numeric tab id is reused", async () => {
    const calls: RecordedCall[] = [];
    let generation = "11111111-1111-4111-8111-111111111111";
    const browser = installBrowserWorkerApi(async (method, args) => {
      calls.push({ method, args });
      if (method === "command" && args[0] === "tab_list") {
        return {
          success: true,
          data: {
            tabs: [{ tabId: 7, tabGeneration: generation, active: true }],
            activeTabId: 7,
          },
        };
      }
      if (method === "command" && args[0] === "title") {
        return { success: true, data: { title: "Current" } };
      }
      return { success: true, data: {} };
    });

    const [oldHandle] = await browser.tabs.list();
    const oldLocator = oldHandle!.playwright.getByText("Old");
    const cachedPlaywright = oldHandle!.playwright;
    expect(oldHandle!.generation).toBe(generation);

    generation = "22222222-2222-4222-8222-222222222222";
    const [currentHandle] = await browser.tabs.list();

    expect(Object.is(currentHandle, oldHandle)).toBe(false);
    expect(currentHandle!.generation).toBe(generation);
    await expect(oldHandle!.title()).rejects.toThrow(
      "Stale browser tab handle",
    );
    await expect(oldLocator.count()).rejects.toThrow(
      "Stale browser tab handle",
    );
    await expect(cachedPlaywright.evaluate("() => true")).rejects.toThrow(
      "Stale browser tab handle",
    );
    await expect(currentHandle!.title()).resolves.toBe("Current");
    expect(calls.at(-1)).toEqual({
      method: "command",
      args: [
        "title",
        {
          tabId: 7,
          tabGeneration: "22222222-2222-4222-8222-222222222222",
        },
      ],
    });
  });

  it("fails loudly when a legacy backend returns index-only tab payloads", async () => {
    const browser = installBrowserWorkerApi(async (method, args) => {
      if (method === "command" && args[0] === "tab_list") {
        return {
          success: true,
          data: {
            tabs: [{ index: 0, title: "Legacy" }],
            active: 0,
          },
        };
      }
      if (method === "command" && args[0] === "tab_new") {
        return { success: true, data: { index: 0, total: 1 } };
      }
      return { success: true, data: {} };
    });

    await expect(browser.tabs.list()).rejects.toThrow(
      /protocol mismatch.*stable positive tabId.*predates stable tab ids/i,
    );
    await expect(browser.tabs.new()).rejects.toThrow(
      /protocol mismatch.*tab_new returned no stable tabId.*predates stable tab ids/i,
    );
    const error = await browser.tabs.list().then(
      () => {
        throw new Error("expected tabs.list to reject");
      },
      (cause: unknown) => cause as Error,
    );
    expect(error.message).not.toContain("1.2.6");
  });

  it("reports a generic protocol mismatch for malformed tab payloads without blaming the extension", async () => {
    const browser = installBrowserWorkerApi(async (method, args) => {
      if (method === "command" && args[0] === "tab_list") {
        return {
          success: true,
          data: { tabs: [{ tabId: "not-a-number", title: "Broken" }] },
        };
      }
      return { success: true, data: {} };
    });

    await expect(browser.tabs.list()).rejects.toThrow(
      /protocol mismatch.*stable positive tabId.*backend and runtime versions match/i,
    );
  });

  it("translates every Tab operation to a structured action with tabId", async () => {
    const calls: RecordedCall[] = [];
    const callBrowser: BrowserWorkerCall = vi.fn(async (method, args) => {
      calls.push({ method, args });
      const action = args[0];
      if (action === "url") {
        return { success: true, data: { url: "https://after.test" } };
      }
      if (action === "title") {
        return { success: true, data: { title: "After" } };
      }
      if (action === "snapshot") {
        return { success: true, data: { snapshot: "tree" } };
      }
      return { success: true, data: { ok: true } };
    });
    const tab = installBrowserWorkerApi(callBrowser).tabs.get(9);

    await tab.goto("https://example.test", { waitUntil: "none", timeout: 500 });
    await tab.back();
    await tab.forward();
    await tab.reload({ timeout: 750 });
    await expect(tab.url()).resolves.toBe("https://after.test");
    await expect(tab.title()).resolves.toBe("After");
    await expect(
      tab.snapshot({ interactive: true, maxDepth: 3 }),
    ).resolves.toBe("tree");
    await tab.screenshot({ fullPage: true, format: "png" });
    await tab.close();

    expect(calls).toEqual([
      {
        method: "command",
        args: [
          "navigate",
          {
            tabId: 9,
            url: "https://example.test",
            waitUntil: "none",
            timeout: 500,
          },
        ],
      },
      { method: "command", args: ["back", { tabId: 9 }] },
      { method: "command", args: ["forward", { tabId: 9 }] },
      { method: "command", args: ["reload", { tabId: 9, timeout: 750 }] },
      { method: "command", args: ["url", { tabId: 9 }] },
      { method: "command", args: ["title", { tabId: 9 }] },
      {
        method: "command",
        args: ["snapshot", { tabId: 9, interactive: true, maxDepth: 3 }],
      },
      {
        method: "command",
        args: ["screenshot", { tabId: 9, fullPage: true, format: "png" }],
      },
      { method: "command", args: ["tab_close", { tabId: 9 }] },
    ]);
  });

  it("exposes enumerable method names so agents can introspect the frozen API", async () => {
    // Run against the data-URL-restored function: introspection must survive
    // stringification exactly like the rest of the worker API.
    const restored = (0, eval)(
      `(${installBrowserWorkerApi.toString()})`,
    ) as typeof installBrowserWorkerApi;
    const browser = restored(async () => ({ success: true, data: {} }));
    const tab = browser.tabs.get(9);
    const locator = tab.playwright.getByRole("button", { name: "Save" });

    expect(Object.keys(browser)).toEqual(
      expect.arrayContaining(["documentation", "chain", "tabs"]),
    );
    expect(Object.keys(browser.tabs)).toEqual(
      expect.arrayContaining(["list", "new", "selected", "get", "finalize"]),
    );
    for (const name of [
      "id",
      "playwright",
      "keyboard",
      "press",
      "goto",
      "back",
      "forward",
      "reload",
      "close",
      "url",
      "title",
      "snapshot",
      "screenshot",
      "scroll",
      "expectNewTab",
    ]) {
      expect(Object.keys(tab), `tab is missing '${name}'`).toContain(name);
    }
    expect(Object.keys(tab.keyboard)).toEqual(
      expect.arrayContaining(["press", "type"]),
    );
    for (const name of [
      "click",
      "dblclick",
      "fill",
      "type",
      "press",
      "hover",
      "focus",
      "count",
      "nth",
      "first",
      "last",
      "filter",
      "selectOption",
      "setInputFiles",
      "scrollIntoViewIfNeeded",
      "waitFor",
      "evaluate",
      "innerText",
      "inputValue",
      "isVisible",
      "boundingBox",
    ]) {
      expect(Object.keys(locator), `locator is missing '${name}'`).toContain(
        name,
      );
    }
    // TS-private internals stay hidden.
    expect(Object.keys(locator)).not.toContain("state");
    expect(Object.keys(locator)).not.toContain("action");
    expect(Object.keys(tab)).not.toContain("state");

    // Introspection must not weaken freezing, identity, or behavior.
    expect(Object.isFrozen(tab)).toBe(true);
    expect(Object.isFrozen(locator)).toBe(true);
    expect(tab.press).toBe(Object.getPrototypeOf(tab).press);
    await expect(tab.press("Enter")).resolves.toBeDefined();
    expect(browser.documentation()).toContain("Object.keys");
  });

  it("exposes page-level press and keyboard on the tab handle", async () => {
    const calls: RecordedCall[] = [];
    const callBrowser: BrowserWorkerCall = vi.fn(async (method, args) => {
      calls.push({ method, args });
      return { success: true, data: { pressed: true } };
    });
    const tab = installBrowserWorkerApi(callBrowser).tabs.get(9);

    await tab.press("Enter");
    await tab.press("Control+a");
    await tab.keyboard.press("Meta+Shift+P");
    await tab.keyboard.type("héllo 🌍");
    await tab.keyboard.type("");

    expect(calls).toEqual([
      { method: "command", args: ["press", { tabId: 9, key: "Enter" }] },
      { method: "command", args: ["press", { tabId: 9, key: "Control+a" }] },
      {
        method: "command",
        args: ["press", { tabId: 9, key: "Meta+Shift+P" }],
      },
      {
        method: "command",
        args: ["inserttext", { tabId: 9, text: "héllo 🌍" }],
      },
      { method: "command", args: ["inserttext", { tabId: 9, text: "" }] },
    ]);

    // Keyboard handle is frozen and identity-stable per tab.
    expect(Object.isFrozen(tab.keyboard)).toBe(true);
    expect(tab.keyboard).toBe(tab.keyboard);

    // Invalid inputs are rejected before transport.
    await expect(tab.press("")).rejects.toThrow(TypeError);
    await expect(tab.press("x".repeat(65))).rejects.toThrow(RangeError);
    await expect(tab.keyboard.type(42 as unknown as string)).rejects.toThrow(
      TypeError,
    );
    expect(calls).toHaveLength(5);

    // The agent-facing documentation advertises the page-level keyboard.
    const browser = installBrowserWorkerApi(callBrowser);
    expect(browser.documentation()).toContain("tab.press(key)");
    expect(browser.documentation()).toContain("tab.keyboard.type(text)");
  });

  it("sends press-with-selector payloads that focus the target element", async () => {
    const calls: RecordedCall[] = [];
    const callBrowser: BrowserWorkerCall = vi.fn(async (method, args) => {
      calls.push({ method, args });
      return { success: true, data: { pressed: true } };
    });
    const playwright =
      installBrowserWorkerApi(callBrowser).tabs.get(21).playwright;

    await playwright
      .getByRole("textbox", { name: "Search", exact: true })
      .press("Enter");
    await playwright.locator("#query").press("Control+a");

    expect(calls).toEqual([
      {
        method: "command",
        args: [
          "press",
          {
            tabId: 21,
            selector: semantic({
              kind: "role",
              role: "textbox",
              name: "Search",
              exact: true,
            }),
            key: "Enter",
          },
        ],
      },
      {
        method: "command",
        args: ["press", { tabId: 21, selector: "#query", key: "Control+a" }],
      },
    ]);
  });

  it("uploads files through locator.setInputFiles with absolute-path validation", async () => {
    const calls: RecordedCall[] = [];
    const callBrowser: BrowserWorkerCall = vi.fn(async (method, args) => {
      calls.push({ method, args });
      return { success: true, data: { uploaded: 1 } };
    });
    const playwright =
      installBrowserWorkerApi(callBrowser).tabs.get(4).playwright;
    const input = playwright.locator("input[type=file]");

    await input.setInputFiles("/tmp/report.pdf");
    await input.setInputFiles(["/tmp/a.png", "C:\\data\\b.png"]);
    await input.setInputFiles([]);

    expect(calls).toEqual([
      {
        method: "command",
        args: [
          "upload",
          {
            tabId: 4,
            selector: "input[type=file]",
            files: ["/tmp/report.pdf"],
          },
        ],
      },
      {
        method: "command",
        args: [
          "upload",
          {
            tabId: 4,
            selector: "input[type=file]",
            files: ["/tmp/a.png", "C:\\data\\b.png"],
          },
        ],
      },
      {
        method: "command",
        args: ["upload", { tabId: 4, selector: "input[type=file]", files: [] }],
      },
    ]);

    // Relative paths and non-strings are rejected before transport.
    await expect(input.setInputFiles("relative/path.txt")).rejects.toThrow(
      TypeError,
    );
    await expect(
      input.setInputFiles([42] as unknown as string[]),
    ).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(3);

    expect(installBrowserWorkerApi(callBrowser).documentation()).toContain(
      "setInputFiles",
    );
  });

  it("scrolls the page and elements through tab.scroll", async () => {
    const calls: RecordedCall[] = [];
    const callBrowser: BrowserWorkerCall = vi.fn(async (method, args) => {
      calls.push({ method, args });
      return { success: true, data: { scrolled: true } };
    });
    const tab = installBrowserWorkerApi(callBrowser).tabs.get(6);

    await tab.scroll({ y: 600 });
    await tab.scroll({ x: -120, y: -40 });
    await tab.scroll({ selector: ".list", direction: "down", amount: 300 });

    expect(calls).toEqual([
      { method: "command", args: ["scroll", { tabId: 6, y: 600 }] },
      { method: "command", args: ["scroll", { tabId: 6, x: -120, y: -40 }] },
      {
        method: "command",
        args: [
          "scroll",
          { tabId: 6, selector: ".list", direction: "down", amount: 300 },
        ],
      },
    ]);

    await expect(tab.scroll({ direction: "diagonal" })).rejects.toThrow(
      TypeError,
    );
    await expect(tab.scroll({ y: Number.NaN })).rejects.toThrow(TypeError);
    await expect(
      tab.scroll({ velocity: 3 } as Record<string, unknown>),
    ).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(3);

    expect(installBrowserWorkerApi(callBrowser).documentation()).toContain(
      "tab.scroll(",
    );
  });

  it("encodes semantic selectors deterministically and re-encodes nth", async () => {
    const calls: RecordedCall[] = [];
    const callBrowser: BrowserWorkerCall = vi.fn(async (method, args) => {
      calls.push({ method, args });
      return { success: true, data: { clicked: true } };
    });
    const playwright =
      installBrowserWorkerApi(callBrowser).tabs.get(17).playwright;
    const save = playwright.getByRole("button", {
      name: "Save / close",
      exact: true,
    });

    expect(
      playwright.getByRole("button", {
        name: "Save / close",
        exact: true,
      }),
    ).toBe(save);
    await save.click();
    await save.nth(2).click();
    await playwright.getByText("Continue?", { exact: false }).click();
    await playwright.getByLabel("Email").fill("a@example.com");
    await playwright.getByPlaceholder("Search").type("query");
    await playwright.getByTestId("submit-button").click();

    const role = {
      kind: "role",
      role: "button",
      name: "Save / close",
      exact: true,
    };
    expect(calls[0]).toEqual({
      method: "command",
      args: ["click", { tabId: 17, selector: semantic(role) }],
    });
    expect(calls[1]).toEqual({
      method: "command",
      args: ["click", { tabId: 17, selector: semantic({ ...role, nth: 2 }) }],
    });
    expect(calls.slice(2)).toEqual([
      {
        method: "command",
        args: [
          "click",
          {
            tabId: 17,
            selector: semantic({
              kind: "text",
              value: "Continue?",
              exact: false,
            }),
          },
        ],
      },
      {
        method: "command",
        args: [
          "fill",
          {
            tabId: 17,
            selector: semantic({ kind: "label", value: "Email", exact: false }),
            value: "a@example.com",
          },
        ],
      },
      {
        method: "command",
        args: [
          "type",
          {
            tabId: 17,
            selector: semantic({
              kind: "placeholder",
              value: "Search",
              exact: false,
            }),
            text: "query",
          },
        ],
      },
      {
        method: "command",
        args: [
          "click",
          {
            tabId: 17,
            selector: semantic({
              kind: "testid",
              value: "submit-button",
              exact: false,
            }),
          },
        ],
      },
    ]);
  });

  it("uses a marker chain for positional CSS interactions", async () => {
    const callBrowser = vi.fn<BrowserWorkerCall>(async () => ({
      success: true,
      data: { filled: true },
    }));
    const locator = installBrowserWorkerApi(callBrowser)
      .tabs.get(6)
      .playwright.locator("#results > .row")
      .nth(3);

    await locator.fill("chosen");

    expect(callBrowser).toHaveBeenCalledWith(
      "chain",
      expect.arrayContaining([
        expect.arrayContaining([
          expect.objectContaining({
            action: "evaluate",
            params: expect.objectContaining({
              tabId: 6,
              script: expect.stringContaining('"index":3'),
            }),
          }),
          expect.objectContaining({
            action: "fill",
            params: expect.objectContaining({
              tabId: 6,
              selector: expect.stringContaining("data-stella-worker-locator"),
              value: "chosen",
            }),
          }),
        ]),
        expect.objectContaining({
          abortOnError: false,
          waitForSelector: false,
        }),
      ]),
    );
    expect(callBrowser).toHaveBeenLastCalledWith("command", [
      "evaluate",
      expect.objectContaining({
        tabId: 6,
        script: expect.stringContaining("removeAttribute"),
      }),
    ]);
  });

  it("runs filtered-locator cleanup in a separate finally command", async () => {
    const calls: RecordedCall[] = [];
    let failAction = false;
    const callBrowser: BrowserWorkerCall = vi.fn(async (method, args) => {
      calls.push({ method, args });
      return {
        success: true,
        data: {
          results: [
            { success: true, data: true },
            failAction
              ? { success: false, error: "click failed" }
              : { success: true, data: { clicked: true } },
          ],
        },
      };
    });
    const locator = installBrowserWorkerApi(callBrowser)
      .tabs.get(6)
      .playwright.locator(".row")
      .filter({ hasText: "Ready" });

    await expect(locator.click()).resolves.toEqual({ clicked: true });
    const [steps, options] = calls[0]!.args;
    expect(options).toEqual({ abortOnError: false, waitForSelector: false });
    expect(steps).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      method: "command",
      args: [
        "evaluate",
        expect.objectContaining({
          script: expect.stringContaining("removeAttribute"),
        }),
      ],
    });

    failAction = true;
    await expect(locator.click()).rejects.toThrow("click failed");
    expect(calls[2]?.args[0] as unknown[]).toHaveLength(2);
    expect(calls[3]).toMatchObject({
      method: "command",
      args: [
        "evaluate",
        expect.objectContaining({
          script: expect.stringContaining("removeAttribute"),
        }),
      ],
    });
  });

  it("round-trips a filtered locator through the daemon chain response shape", async () => {
    // Mocks the CDP daemon's native chain executor response: per-step results
    // with step/action/success/data/durationMs plus completed/total counters.
    const calls: RecordedCall[] = [];
    const callBrowser: BrowserWorkerCall = vi.fn(async (method, args) => {
      calls.push({ method, args });
      if (method === "chain") {
        return {
          result: {
            id: "req-1",
            success: true,
            data: {
              results: [
                {
                  step: 0,
                  action: "evaluate",
                  success: true,
                  data: { result: true, origin: "https://rows.test" },
                  durationMs: 4,
                },
                {
                  step: 1,
                  action: "innertext",
                  success: true,
                  data: { text: "Ready row", origin: "https://rows.test" },
                  durationMs: 2,
                },
              ],
              completed: 2,
              total: 2,
              totalDurationMs: 6,
            },
          },
        };
      }
      return { success: true, data: { result: 0 } };
    });
    const locator = installBrowserWorkerApi(callBrowser)
      .tabs.get(6)
      .playwright.locator(".row")
      .filter({ hasText: "Ready" });

    await expect(locator.innerText()).resolves.toBe("Ready row");

    // Exact chain payload: a two-step marker chain (tag via evaluate, act via
    // the marker attribute selector) with waits disabled.
    expect(calls[0]!.method).toBe("chain");
    const [steps, options] = calls[0]!.args as [
      ReadonlyArray<{ action: string; params: Record<string, unknown> }>,
      Record<string, unknown>,
    ];
    expect(options).toEqual({ abortOnError: false, waitForSelector: false });
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({
      action: "evaluate",
      params: { tabId: 6, script: expect.stringContaining("setAttribute") },
    });
    expect(steps[0]!.params.script).toContain("data-stella-worker-locator");
    expect(steps[0]!.params.script).toContain("Ready");
    expect(steps[1]).toEqual({
      action: "innertext",
      params: {
        tabId: 6,
        selector: expect.stringMatching(
          /^\[data-stella-worker-locator="[^"]+"\]$/,
        ),
      },
    });
    // The marker the tag script writes is the marker the action step targets.
    const marker = /data-stella-worker-locator="([^"]+)"/.exec(
      steps[1]!.params.selector as string,
    )![1]!;
    expect(steps[0]!.params.script).toContain(JSON.stringify(marker));

    // Cleanup runs as a separate top-level evaluate afterwards.
    expect(calls[1]).toMatchObject({
      method: "command",
      args: [
        "evaluate",
        expect.objectContaining({
          tabId: 6,
          script: expect.stringContaining("removeAttribute"),
        }),
      ],
    });
    expect(calls).toHaveLength(2);
  });

  it("surfaces the daemon chain failure envelope for filtered locators", async () => {
    // The CDP daemon fails the whole chain envelope when a step fails
    // (success: false + "Chain step N (action) failed: ..."), which the
    // transport surfaces as a rejection before per-step parsing.
    const calls: RecordedCall[] = [];
    const callBrowser: BrowserWorkerCall = vi.fn(async (method, args) => {
      calls.push({ method, args });
      if (method === "chain") {
        return {
          result: {
            id: "req-2",
            success: false,
            error:
              "Chain step 1 (click) failed: Element found but not visible (display: none or visibility: hidden): [data-stella-worker-locator]",
            data: {
              results: [
                { step: 0, action: "evaluate", success: true, durationMs: 3 },
                {
                  step: 1,
                  action: "click",
                  success: false,
                  error: "Element found but not visible",
                  durationMs: 2504,
                },
              ],
              completed: 1,
              total: 2,
              totalDurationMs: 2507,
            },
          },
        };
      }
      return { success: true, data: {} };
    });
    const locator = installBrowserWorkerApi(callBrowser)
      .tabs.get(6)
      .playwright.locator(".row")
      .filter({ hasText: "Ready" });

    await expect(locator.click()).rejects.toThrow(
      /Chain step 1 \(click\) failed: Element found but not visible/,
    );
    // Marker cleanup still runs after the failure.
    expect(calls[1]).toMatchObject({
      method: "command",
      args: [
        "evaluate",
        expect.objectContaining({
          script: expect.stringContaining("removeAttribute"),
        }),
      ],
    });
  });

  it("normalizes locator read payloads and keeps Locator identity stable", async () => {
    const callBrowser: BrowserWorkerCall = vi.fn(async (_method, args) => {
      switch (args[0]) {
        case "count":
          return { result: { success: true, data: { count: "3" } } };
        case "innertext":
          return { success: true, data: { text: "Hello" } };
        case "gettext":
          return { success: true, data: { text: null } };
        case "inputvalue":
          return { success: true, data: { value: "typed" } };
        case "getattribute":
          return { success: true, data: { value: "/next" } };
        case "isvisible":
          return { success: true, data: { visible: true } };
        case "isenabled":
          return { success: true, data: { enabled: false } };
        case "ischecked":
          return { success: true, data: { checked: "true" } };
        case "boundingbox":
          return {
            success: true,
            data: { box: { x: 1, y: 2, width: 3, height: 4 } },
          };
        default:
          return { success: true, data: {} };
      }
    });
    const playwright =
      installBrowserWorkerApi(callBrowser).tabs.get(2).playwright;
    const locator = playwright.locator("#field");

    expect(playwright.locator("#field")).toBe(locator);
    await expect(locator.count()).resolves.toBe(3);
    await expect(locator.innerText()).resolves.toBe("Hello");
    await expect(locator.textContent()).resolves.toBeNull();
    await expect(locator.inputValue()).resolves.toBe("typed");
    await expect(locator.getAttribute("href")).resolves.toBe("/next");
    await expect(locator.isVisible()).resolves.toBe(true);
    await expect(locator.isEnabled()).resolves.toBe(false);
    await expect(locator.isChecked()).resolves.toBe(true);
    await expect(locator.boundingBox()).resolves.toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
  });

  it("captures exactly one newly adopted owned tab around an action", async () => {
    const calls: RecordedCall[] = [];
    let childCreated = false;
    const callBrowser: BrowserWorkerCall = vi.fn(async (method, args) => {
      calls.push({ method, args });
      if (method === "command" && args[0] === "tab_list") {
        return {
          success: true,
          data: {
            tabs: [
              { tabId: 10, url: "https://parent.test", active: !childCreated },
              ...(childCreated
                ? [{ tabId: 11, url: "https://child.test", active: true }]
                : []),
            ],
            activeTabId: childCreated ? 11 : 10,
          },
        };
      }
      if (method === "command" && args[0] === "click") {
        childCreated = true;
      }
      return { success: true, data: {} };
    });
    const browser = installBrowserWorkerApi(callBrowser);
    const parent = browser.tabs.get(10);

    const child = await parent.expectNewTab(async () => {
      await parent.playwright.getByText("Open report").click();
    });

    expect(child.id).toBe(11);
    expect(child).toBe(browser.tabs.get(11));
    expect(calls.map((entry) => entry.args[0])).toEqual([
      "tab_list",
      "click",
      "tab_list",
    ]);
  });

  it("sanitizes structured chains and rejects nested or arbitrary actions", async () => {
    const callBrowser = vi.fn<BrowserWorkerCall>(async () => ({
      success: true,
      data: { completed: 2 },
    }));
    const browser = installBrowserWorkerApi(callBrowser);
    const steps = [
      { action: "click", params: { tabId: 4, selector: "#save" } },
      { action: "title", params: { tabId: 4 } },
    ];

    await browser.chain(steps, { abortOnError: true, waitForSelector: false });

    expect(callBrowser).toHaveBeenCalledWith("chain", [
      steps,
      { abortOnError: true, waitForSelector: false },
    ]);
    await expect(
      browser.chain([{ action: "chain", params: { tabId: 4 } }]),
    ).rejects.toThrow("nested chain");
    await expect(
      browser.chain([{ action: "cookies_get", params: { tabId: 4 } }]),
    ).rejects.toThrow("unsupported action");
    await expect(
      browser.chain([{ action: "click", params: { selector: "#save" } }]),
    ).rejects.toThrow("tabId");
    await expect(
      browser.chain(
        Array.from({ length: 101 }, () => ({
          action: "title",
          params: { tabId: 4 },
        })),
      ),
    ).rejects.toThrow("at most 100");
  });

  it("finalizes owned tabs with explicit handoff statuses", async () => {
    const callBrowser = vi.fn<BrowserWorkerCall>(async () => ({
      success: true,
      data: { closedTabIds: [3], releasedTabIds: [1, 2] },
    }));
    const browser = installBrowserWorkerApi(callBrowser);
    const first = browser.tabs.get(1);
    const second = browser.tabs.get(2);

    await browser.tabs.finalize([first, { tab: second, status: "handoff" }]);

    expect(callBrowser).toHaveBeenCalledWith("command", [
      "finalize_tabs",
      {
        keep: [
          { tabId: 1, status: "deliverable" },
          { tabId: 2, status: "handoff" },
        ],
      },
    ]);
  });

  it("round-trips finalize against the CDP daemon response shape", async () => {
    // Mirrors the CDP backend's finalize_tabs envelope: the daemon wraps
    // { closedTabIds, releasedTabIds, kept } in a success envelope, and
    // finalize() resolves with the unwrapped data.
    const callBrowser = vi.fn<BrowserWorkerCall>(async (method, args) => {
      expect(method).toBe("command");
      expect(args[0]).toBe("finalize_tabs");
      expect(args[1]).toEqual({ keep: [{ tabId: 2, status: "handoff" }] });
      return {
        result: {
          id: "finalize-1",
          success: true,
          data: {
            closedTabIds: [3, 5],
            releasedTabIds: [2],
            kept: [{ tabId: 2, status: "handoff" }],
          },
        },
      };
    });
    const browser = installBrowserWorkerApi(callBrowser);

    const finalized = await browser.tabs.finalize([
      { tabId: 2, status: "handoff" },
    ]);

    expect(finalized).toEqual({
      closedTabIds: [3, 5],
      releasedTabIds: [2],
      kept: [{ tabId: 2, status: "handoff" }],
    });
    expect(callBrowser).toHaveBeenCalledTimes(1);
  });

  it("finalize with no entries closes everything the owner holds", async () => {
    const callBrowser = vi.fn<BrowserWorkerCall>(async () => ({
      success: true,
      data: { closedTabIds: [1], releasedTabIds: [], kept: [] },
    }));
    const browser = installBrowserWorkerApi(callBrowser);

    const finalized = await browser.tabs.finalize();

    expect(callBrowser).toHaveBeenCalledWith("command", [
      "finalize_tabs",
      { keep: [] },
    ]);
    expect(finalized).toEqual({
      closedTabIds: [1],
      releasedTabIds: [],
      kept: [],
    });
  });

  it("rejects RegExp selector inputs before transport", async () => {
    const callBrowser = vi.fn<BrowserWorkerCall>(async () => ({
      success: true,
      data: {},
    }));
    const playwright =
      installBrowserWorkerApi(callBrowser).tabs.get(1).playwright;

    expect(() => playwright.getByText(/unsafe/ as unknown as string)).toThrow(
      "does not support RegExp",
    );
    expect(callBrowser).not.toHaveBeenCalled();
  });
});
