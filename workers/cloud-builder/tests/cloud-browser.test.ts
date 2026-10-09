import { describe, expect, mock, test } from "bun:test";
import type {
  CloudBrowserCommandRequest,
  CloudBrowserSuspension,
} from "@stella/contracts/cloud-browser";
import { isAgentToolSuspendedError } from "@stella/runtime/kernel/agent-core/suspension.js";
import type { CloudCodeExecutorFactory } from "../src/cloud-code-executor.js";
import type {
  CloudBrowserTransport,
  ForwardedBrowserGatewayCommand,
} from "../src/cloud-browser.js";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));

const { executeCloudCodeWithExecutorFactory } = await import(
  "../src/cloud-code-executor.js"
);
const { createCloudCodeAgentTool } = await import("../src/cloud-code-tool.js");
const { createCloudBrowserClient, CloudBrowserSuspendedError } =
  await import("../src/cloud-browser.js");
mock.restore();

const loader = {} as WorkerLoader;
const signal = new AbortController().signal;

const forwarded = (body: unknown, status = 200): ForwardedBrowserGatewayCommand => ({
  kind: "forwarded",
  status,
  body: new TextEncoder().encode(JSON.stringify(body)),
});

const suspensionFor = (requestId: string): CloudBrowserSuspension => ({
  schemaVersion: 1,
  outcome: "waiting_for_user",
  interactionId: "7c1f8e4a-0d2b-4c6e-9a1f-3b5d7e9f1a2c",
  interactionRevision: 1,
  interactionKind: "login_takeover",
  toolCallId: requestId,
  requestDigest: "a".repeat(64),
  profileId: "default",
  profileEpoch: 1,
  displayOrigin: "https://example.com",
  expiresAt: 1_900_000_000_000,
});

/** A gateway stand-in that answers each action the way Browser Run does. */
const gateway = (
  sent: CloudBrowserCommandRequest[],
  answer: (
    command: CloudBrowserCommandRequest,
  ) => ForwardedBrowserGatewayCommand = (command) =>
    forwarded({
      schemaVersion: 1,
      outcome: "completed",
      requestId: command.requestId,
      data:
        command.action === "browser.screenshot"
          ? {
              screenshot: {
                mimeType: "image/jpeg",
                data: "/9j/4AAQ",
                width: 1280,
                height: 720,
              },
            }
          : command.action === "browser.text"
            ? { text: "Order total: $42" }
            : command.action === "browser.open"
          ? {
              profileId: "default",
              profileEpoch: 1,
              restored: true,
              observation: {
                url: "https://example.com/",
                title: "Example",
                text: "Hello",
              },
            }
          : { ok: true },
    }),
): CloudBrowserTransport =>
  async (command) => {
    sent.push(command);
    if (command.action === "browser.login_takeover") {
      return forwarded({
        schemaVersion: 1,
        outcome: "suspended",
        suspension: suspensionFor(command.requestId),
      });
    }
    return answer(command);
  };

const TAKEOVER = {
  allowedOrigins: ["https://example.com"],
  displayOrigin: "https://example.com",
  verification: {
    expectedOrigin: "https://example.com",
    authenticatedSelector: "#account",
    loggedOutSelector: "#login",
    resumeUrl: "https://example.com/",
  },
};

describe("cloud browser client", () => {
  test("opens a page limited to its own origin and returns the observation", async () => {
    const sent: CloudBrowserCommandRequest[] = [];
    const client = createCloudBrowserClient(gateway(sent));

    const page = await client.call("open", ["https://example.com/inbox"], signal);

    expect(sent[0]).toMatchObject({
      schemaVersion: 1,
      action: "browser.open",
      params: {
        allowedOrigins: ["https://example.com"],
        startUrl: "https://example.com/inbox",
      },
    });
    expect(page).toEqual({
      url: "https://example.com/",
      title: "Example",
      text: "Hello",
      restored: true,
    });
    expect(client.used()).toBe(true);
  });

  test("refuses a non-https start URL before reaching the gateway", async () => {
    const sent: CloudBrowserCommandRequest[] = [];
    const client = createCloudBrowserClient(gateway(sent));

    await expect(
      client.call("open", ["http://example.com"], signal),
    ).rejects.toThrow("https://");
    expect(sent).toHaveLength(0);
  });

  test("records a login handoff and fences every later command", async () => {
    const sent: CloudBrowserCommandRequest[] = [];
    const client = createCloudBrowserClient(gateway(sent));

    await expect(
      client.call("requestLoginTakeover", [TAKEOVER], signal),
    ).rejects.toBeInstanceOf(CloudBrowserSuspendedError);
    expect(client.suspension()).toMatchObject({
      interactionKind: "login_takeover",
      toolCallId: sent[0]?.requestId,
    });

    await expect(client.call("observe", [], signal)).rejects.toBeInstanceOf(
      CloudBrowserSuspendedError,
    );
    // A profile under human control gets no checkpoint either.
    await client.checkpoint(signal);
    expect(sent).toHaveLength(1);
  });

  test("surfaces the gateway's failure code, not its message", async () => {
    const client = createCloudBrowserClient(
      gateway([], (command) =>
        forwarded(
          {
            schemaVersion: 1,
            outcome: "failed",
            requestId: command.requestId,
            code: "navigation_denied",
            message: "internal detail",
          },
          403,
        ),
      ),
    );

    await expect(
      client.call("navigate", ["https://elsewhere.test"], signal),
    ).rejects.toThrow("browser.navigate failed: navigation_denied.");
  });

  test("returns cookies and page data but never a Live View capability", async () => {
    const client = createCloudBrowserClient(
      gateway([], (command) =>
        forwarded({
          schemaVersion: 1,
          outcome: "completed",
          requestId: command.requestId,
          data:
            command.action === "browser.cookies"
              ? { cookies: [{ name: "sid", value: "abc" }] }
              : { result: { url: "https://live.browser.run/x" } },
        }),
      ),
    );

    expect(await client.call("cookies", [], signal)).toEqual([
      { name: "sid", value: "abc" },
    ]);
    await expect(
      client.call("evaluate", ["location.href"], signal),
    ).rejects.toThrow("private capability");
  });

  test("surfaces the gateway's error envelope with the page's own detail", async () => {
    const client = createCloudBrowserClient(
      gateway([], () =>
        forwarded(
          {
            schemaVersion: 1,
            error: {
              code: "evaluation_failed",
              message: "The page script threw an error.",
              detail: "ReferenceError: foo is not defined",
            },
          },
          422,
        ),
      ),
    );

    await expect(client.call("evaluate", ["foo"], signal)).rejects.toThrow(
      "evaluation_failed — ReferenceError: foo is not defined",
    );
  });

  test("maps the desktop-parity methods onto gateway actions", async () => {
    const sent: CloudBrowserCommandRequest[] = [];
    const client = createCloudBrowserClient(gateway(sent));

    await client.call("fill", ["input[type=password]", "hunter2"], signal);
    await client.call("evaluate", ["(n) => n + 1", 1], signal);
    await client.call("setCookies", [[{ name: "a", value: "b" }]], signal);
    await client.call("responseBody", ["https://example.com/api"], signal);
    expect(sent.splice(0).map((command) => [command.action, command.params])).toEqual([
      ["browser.fill", { selector: "input[type=password]", value: "hunter2" }],
      ["browser.evaluate", { script: "(n) => n + 1", arg: 1 }],
      ["browser.set_cookies", { cookies: [{ name: "a", value: "b" }] }],
      ["browser.response_body", { url: "https://example.com/api" }],
    ]);

    await client.call("back", [], signal);
    await client.call("hover", ["ref=e3"], signal);
    await client.call("scroll", [{ selector: 'role=button[name="More"]' }], signal);
    await client.call("check", ["#terms"], signal);
    const text = await client.call("text", ['text="Order total"'], signal);

    expect(sent.map((command) => [command.action, command.params])).toEqual([
      ["browser.back", {}],
      ["browser.hover", { selector: "ref=e3" }],
      [
        "browser.scroll",
        { direction: "down", selector: 'role=button[name="More"]' },
      ],
      ["browser.check", { selector: "#terms" }],
      ["browser.text", { selector: 'text="Order total"' }],
    ]);
    expect(text).toBe("Order total: $42");
  });

  test("checkpoints the profile only after it was used", async () => {
    const sent: CloudBrowserCommandRequest[] = [];
    const client = createCloudBrowserClient(gateway(sent));

    await client.checkpoint(signal);
    expect(sent).toHaveLength(0);

    await client.call("observe", [], signal);
    await client.checkpoint(signal);
    expect(sent.map((command) => command.action)).toEqual([
      "browser.observe",
      "browser.checkpoint",
    ]);
  });
});

/** Runs the sandbox's `$browser` dispatch the way the generated module does. */
const providerFactory = (
  run: (
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>,
  ) => Promise<unknown>,
): CloudCodeExecutorFactory => () => ({
  async execute(_source, providers) {
    if (!Array.isArray(providers)) throw new Error("providers required");
    try {
      return { result: await run(providers[0]?.fns ?? {}) };
    } catch (error) {
      return {
        result: undefined,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

describe("cloud code with the cloud browser", () => {
  test("exposes the browser only when the turn holds one", async () => {
    let keys: string[] = [];
    const factory = providerFactory(async (fns) => {
      keys = Object.keys(fns);
      return null;
    });
    const without = await createCloudCodeAgentTool({
      loader,
      tools: [],
      executionScope: "g:c:t",
      executeCode: (request) =>
        executeCloudCodeWithExecutorFactory(request, factory),
    });
    await without.execute("call", { code: "1" });
    expect(keys).not.toContain("$browser");
    expect(without.description).toContain("or browser in this session");

    const withBrowser = await createCloudCodeAgentTool({
      loader,
      tools: [],
      executionScope: "g:c:t",
      browser: createCloudBrowserClient(gateway([])),
      executeCode: (request) =>
        executeCloudCodeWithExecutorFactory(request, factory),
    });
    await withBrowser.execute("call", { code: "1" });
    expect(keys).toContain("$browser");
    expect(withBrowser.description).toContain("browser.requestLoginTakeover");
  });

  test("hands a screenshot to the model as an image, not to the cell", async () => {
    let cellSaw: unknown;
    const factory = providerFactory(async (fns) => {
      cellSaw = await fns.$browser?.({ method: "screenshot", args: [] });
      return "looked";
    });
    const code = await createCloudCodeAgentTool({
      loader,
      tools: [],
      executionScope: "g:c:t",
      browser: createCloudBrowserClient(gateway([])),
      executeCode: (request) =>
        executeCloudCodeWithExecutorFactory(request, factory),
    });

    const output = await code.execute("outer", {
      code: "await browser.screenshot()",
    });

    expect(JSON.stringify(cellSaw)).not.toContain("/9j/4AAQ");
    expect(cellSaw).toMatchObject({ width: 1280, height: 720 });
    expect(output.content).toContainEqual({
      type: "image",
      data: "/9j/4AAQ",
      mimeType: "image/jpeg",
    });
  });

  test("ends the call as a suspension even when the cell catches the handoff", async () => {
    const factory = providerFactory(async (fns) => {
      try {
        await fns.$browser?.({
          method: "requestLoginTakeover",
          args: [TAKEOVER],
        });
      } catch {
        // The model's cell swallowed the error; the handoff still stands.
      }
      return "kept going";
    });
    const code = await createCloudCodeAgentTool({
      loader,
      tools: [],
      executionScope: "g:c:t",
      browser: createCloudBrowserClient(gateway([])),
      executeCode: (request) =>
        executeCloudCodeWithExecutorFactory(request, factory),
    });

    const outcome = await code
      .execute("outer-call", { code: "await browser.requestLoginTakeover({})" })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(isAgentToolSuspendedError(outcome)).toBe(true);
  });
});
