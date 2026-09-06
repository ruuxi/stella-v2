/**
 * Real-workerd acceptance for the cloud `code` tool's device contract: the
 * `tools` proxy (`$list`/`$search`/`$describe` and `tools.<name>`), a
 * catchable nested-tool error, the `connect` global, and the sealed sandbox
 * (no outbound network, no host secrets in the model-visible text).
 */
import type { AgentTool } from "@stella/runtime/kernel/agent-core/types.js";
import { createCloudCodeAgentTool } from "../../src/cloud-code-tool.js";

type Env = { LOADER: WorkerLoader };

const secretMarker = "raw-turn-token-must-not-leak";

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const nestedCalls: Array<{ name: string; input: unknown }> = [];
    const readValue: AgentTool & { demoted?: { searchTerms: string[] } } = {
      name: "read_value",
      label: "Read value",
      description: `Read one stored value by key. ${secretMarker}`,
      parameters: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
        additionalProperties: false,
      } as AgentTool["parameters"],
      demoted: { searchTerms: ["lookup", "fetch stored"] },
      execute: async (_toolCallId, params) => {
        const key = String((params as { key?: unknown }).key ?? "");
        nestedCalls.push({ name: "read_value", input: params });
        if (key === "missing") {
          return {
            content: [{ type: "text", text: `No value stored for "${key}".` }],
            details: null,
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: `value:${key}` }],
          details: { key },
        };
      },
    };
    const connectCalls: unknown[] = [];
    const codeTool = await createCloudCodeAgentTool({
      loader: env.LOADER,
      tools: [readValue],
      executionScope: "workerd:code-contract-acceptance",
      connect: {
        discover: async (query) => {
          connectCalls.push(["discover", query]);
          return {
            query,
            matches: [
              {
                id: "gmail",
                name: "Gmail",
                kind: "native",
                connected: true,
                next: "Ready.",
              },
            ],
          };
        },
        connectors: async () => [{ id: "gmail", name: "Gmail", kind: "native", connected: true, description: "Mail" }],
        actions: async () => ({ connector: "gmail", total: 0, shown: 0, actions: [] }),
        schema: async () => ({ connector: "gmail", name: "X", inputSchema: null }),
        call: async (id, action, args) => {
          connectCalls.push(["call", id, action, args]);
          return { email: "me@example.com", secret: secretMarker };
        },
        addMcp: async () => {
          throw new Error("desktop-only");
        },
        remove: async () => {
          throw new Error("desktop-only");
        },
      },
    });
    const executed = await codeTool.execute("workerd-code-call", {
      timeout_ms: 5_000,
      code: `
        const listed = tools.$list();
        const hits = await tools.$search({ query: "lookup stored" });
        const described = await tools.$describe("read_value");
        const value = await tools.read_value({ key: "alpha" });
        let caught = null;
        try {
          await tools.read_value({ key: "missing" });
        } catch (error) {
          caught = error.message;
        }
        const docs = connect.documentation();
        const discovered = await connect.discover("gmail");
        const called = await connect.call("gmail", "GMAIL_GET_PROFILE", { user_id: "me" });
        let addMcp = null;
        try {
          await connect.addMcp({ id: "x", transport: { url: "https://example.com" } });
        } catch (error) {
          addMcp = error.message;
        }
        let outbound = "allowed";
        try {
          await fetch("https://example.com/");
        } catch {
          outbound = "blocked";
        }
        ({
          answer: 6 * 7,
          outbound,
          listed,
          hits: hits.map((hit) => hit.name),
          describedInvocation: described.invocation,
          value,
          caught,
          docsMentionsCall: docs.includes("connect.call(id, action, args)"),
          discovered: discovered.matches.map((match) => match.id),
          calledEmail: called.email,
          addMcp,
          frozen: Object.isFrozen(connect) && Reflect.set(tools, "x", 1) === false,
        })
      `,
    });
    if (executed.isError) return Response.json(executed, { status: 500 });
    const visibleText = (executed.content[0] as { text?: string }).text ?? "";
    const result = JSON.parse(visibleText) as Record<string, unknown>;
    return Response.json({
      ok: true,
      result,
      hostProof: {
        nestedCallCount: nestedCalls.length,
        nestedInputs: nestedCalls.map((call) => call.input),
        connectCallCount: connectCalls.length,
        // The tool description and the connect result both carried the
        // marker; only the model-chosen return value may show it, and this
        // cell never returned it.
        secretLeaked: visibleText.includes(secretMarker),
      },
    });
  },
};
