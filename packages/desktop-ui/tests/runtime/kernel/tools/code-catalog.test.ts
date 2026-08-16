import { describe, expect, it } from "vitest";

import {
  buildCatalogSection,
  renderToolSignature,
  schemaToTs,
  scoreToolSearch,
  searchToolCatalog,
  tokenizeToolQuery,
  type DemotedToolCatalogEntry,
} from "@stella/runtime/kernel/tools/code-catalog";

describe("schemaToTs renderer", () => {
  it("renders objects with required/optional fields and quoted keys", () => {
    const rendered = schemaToTs({
      type: "object",
      properties: {
        connector: { type: "string" },
        reason: { type: "string" },
        "kebab-key": { type: "boolean" },
      },
      required: ["connector"],
    });
    expect(rendered).toBe(
      '{ connector: string; reason?: string; "kebab-key"?: boolean }',
    );
  });

  it("renders arrays, enums, unions, const, and type arrays", () => {
    expect(
      schemaToTs({ type: "array", items: { type: "number" } }),
    ).toBe("Array<number>");
    expect(schemaToTs({ type: "string", enum: ["a", "b"] })).toBe("'a' | 'b'".replace(/'/g, '"'));
    expect(
      schemaToTs({ anyOf: [{ type: "string" }, { type: "null" }] }),
    ).toBe("string | null");
    expect(
      schemaToTs({ oneOf: [{ type: "integer" }, { type: "number" }] }),
    ).toBe("number");
    expect(schemaToTs({ const: 42 })).toBe("42");
    expect(schemaToTs({ type: ["string", "number"] })).toBe("string | number");
  });

  it("renders empty/unknown object schemas as Record<string, unknown>", () => {
    expect(schemaToTs({ type: "object" })).toBe("Record<string, unknown>");
    expect(schemaToTs({ type: "object", properties: {} })).toBe(
      "Record<string, unknown>",
    );
  });

  it("caps recursion depth at unknown", () => {
    let schema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 10; i += 1) {
      schema = { type: "array", items: schema };
    }
    const rendered = schemaToTs(schema);
    expect(rendered).toContain("Array<");
    expect(rendered).toContain("unknown");
    expect(rendered).not.toContain("string");
  });

  it("never throws on garbage schemas", () => {
    const cyclic: Record<string, unknown> = { type: "object" };
    cyclic.properties = { self: cyclic };
    for (const garbage of [
      null,
      undefined,
      42,
      "string",
      [],
      true,
      { type: "wat" },
      { enum: "not-an-array" },
      { anyOf: [null, 1, {}] },
      cyclic,
    ]) {
      expect(() => schemaToTs(garbage)).not.toThrow();
      expect(typeof schemaToTs(garbage)).toBe("string");
    }
    expect(
      renderToolSignature({ name: "broken", parameters: undefined }),
    ).toBe("tools.broken(input: unknown): Promise<unknown>");
  });

  it("renders full callable signatures", () => {
    expect(
      renderToolSignature({
        name: "connector_status",
        parameters: {
          type: "object",
          properties: { connector: { type: "string" } },
          required: ["connector"],
        },
      }),
    ).toBe(
      "tools.connector_status(input: { connector: string }): Promise<unknown>",
    );
  });
});

const makeTool = (
  name: string,
  descriptionLength: number,
  extra: Partial<DemotedToolCatalogEntry> = {},
): DemotedToolCatalogEntry => ({
  name,
  description: "d".repeat(descriptionLength),
  parameters: {
    type: "object",
    properties: { value: { type: "string" } },
  },
  ...extra,
});

describe("buildCatalogSection budgeter", () => {
  it("returns an empty string for an empty set", () => {
    expect(buildCatalogSection([])).toBe("");
    expect(buildCatalogSection(undefined as never)).toBe("");
  });

  it("marks COMPLETE with all tools shown when the budget fits", () => {
    const section = buildCatalogSection([
      makeTool("example_send_message", 40, {
        demoted: { requiredConnectorProvider: "example_connector" },
      }),
      makeTool("example_react_message", 40, {
        demoted: { requiredConnectorProvider: "example_connector" },
      }),
      makeTool("connector_status", 40),
    ]);
    expect(section).toContain(
      "## Demoted tools (COMPLETE — all 3 shown; call via tools.<name> inside node_repl)",
    );
    expect(section).toContain("- example_connector (2 tools, 2 shown)");
    expect(section).toContain("- connector (1 tool, 1 shown)");
    expect(section).toContain(
      "tools.example_send_message(input: { value?: string }): Promise<unknown>",
    );
    expect(section).toContain("// dddd");
  });

  it("groups by requiredConnectorProvider before the name prefix", () => {
    const section = buildCatalogSection([
      makeTool("send_email", 10, {
        demoted: { requiredConnectorProvider: "gmail" },
      }),
      makeTool("send_sms", 10),
    ]);
    expect(section).toContain("- gmail (1 tool, 1 shown)");
    expect(section).toContain("- send (1 tool, 1 shown)");
  });

  it("with budget 0 shows stubs only and marks PARTIAL with $search guidance", () => {
    const section = buildCatalogSection(
      [makeTool("alpha_one", 30), makeTool("beta_one", 30)],
      0,
    );
    expect(section).toContain(
      "## Demoted tools (PARTIAL — 0 of 2 shown; find the rest with await tools.$search({ query }))",
    );
    expect(section).toContain("- alpha (1 tool, 0 shown)");
    expect(section).toContain("- beta (1 tool, 0 shown)");
    expect(section).not.toContain("tools.alpha_one(");
  });

  it("round-robins the shared budget so one verbose namespace cannot starve the rest", () => {
    // Each entry costs roughly (comment + signature) / 4 tokens; give each
    // namespace several tools and a budget that only fits a few entries.
    // Equal-length names so every entry costs the same number of tokens.
    const tools = [
      makeTool("alpha_a", 200),
      makeTool("alpha_b", 200),
      makeTool("alpha_c", 200),
      makeTool("bravo_a", 200),
      makeTool("bravo_b", 200),
      makeTool("bravo_c", 200),
    ];
    const singleCost = Math.ceil(
      (`// ${"d".repeat(120 - 1)}…\n`.length +
        "tools.alpha_a(input: { value?: string }): Promise<unknown>\n".length) /
        4,
    );
    // Stub lines consume the budget too (widest "shown" variant estimate).
    const stubCost = Math.ceil("- alpha (3 tools, 3 shown)\n".length / 4);
    const section = buildCatalogSection(
      tools,
      stubCost * 2 + singleCost * 2 + 1,
    );
    // Fairness: one from each namespace, not two from alpha.
    expect(section).toContain("- alpha (3 tools, 1 shown)");
    expect(section).toContain("- bravo (3 tools, 1 shown)");
    expect(section).toContain("PARTIAL — 2 of 6 shown");
  });

  it("is deterministic", () => {
    const tools = [
      makeTool("gamma_z", 50),
      makeTool("alpha_a", 50),
      makeTool("beta_m", 50),
    ];
    expect(buildCatalogSection(tools)).toBe(
      buildCatalogSection([...tools].reverse()),
    );
  });
});

describe("scoreToolSearch + searchToolCatalog", () => {
  const catalog: DemotedToolCatalogEntry[] = [
    {
      name: "example_send_message",
      description: "Send an example connector message with parts.",
      demoted: {
        requiredConnectorProvider: "example_connector",
        searchTerms: ["example", "sms", "rich link"],
      },
      parameters: {
        type: "object",
        properties: {
          parts: { type: "array", description: "Message parts." },
        },
      },
    },
    {
      name: "example_react_message",
      description: "Add or remove a reaction on an example connector message.",
      demoted: { requiredConnectorProvider: "example_connector", searchTerms: ["reaction"] },
      parameters: {
        type: "object",
        properties: {
          message_id: { type: "string", description: "Example connector message UUID." },
        },
      },
    },
    {
      name: "connector_status",
      description: "Check whether a Stella Store connector is connected.",
      demoted: { searchTerms: ["connector", "integration"] },
      parameters: {
        type: "object",
        properties: { connector: { type: "string" } },
      },
    },
  ];

  it("short-circuits exact tool-name queries", () => {
    const results = searchToolCatalog(catalog, "connector_status");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      name: "connector_status",
      signature:
        "tools.connector_status(input: { connector?: string }): Promise<unknown>",
    });
  });

  it("tokenizes camelCase and singularizes plurals", () => {
    expect(tokenizeToolQuery("sendMessages quickly")).toEqual([
      "send",
      "message",
      "quickly",
    ]);
    const results = searchToolCatalog(catalog, "example reactions");
    expect(results[0]?.name).toBe("example_react_message");
  });

  it("matches on input property names and descriptions", () => {
    const score = scoreToolSearch(
      catalog[1]!,
      tokenizeToolQuery("message_id UUID"),
    );
    expect(score).toBeGreaterThan(0);
  });

  it("ranks name matches above description matches and breaks ties by name", () => {
    const results = searchToolCatalog(catalog, "message");
    expect(results.map((entry) => entry.name)).toEqual([
      "example_react_message",
      "example_send_message",
    ]);
    // Both contain "message" in the name; tie broken by localeCompare.
    const [first, second] = results;
    expect(first!.name.localeCompare(second!.name)).toBeLessThan(0);
  });

  it("returns full signatures so no second lookup is needed", () => {
    const results = searchToolCatalog(catalog, "example");
    for (const result of results) {
      expect(result.signature).toMatch(/^tools\..+\(input: .+\): Promise<unknown>$/);
    }
  });

  it("clamps limit and returns [] for garbage", () => {
    expect(searchToolCatalog(catalog, "")).toEqual([]);
    expect(searchToolCatalog(catalog, "   ")).toEqual([]);
    expect(searchToolCatalog(catalog, "example", 0)).toHaveLength(1);
    expect(searchToolCatalog([], "anything")).toEqual([]);
    expect(
      searchToolCatalog(
        [{ name: "ok" }, null as never, { name: "" } as never],
        "ok",
      ),
    ).toHaveLength(1);
  });
});
