import { describe, expect, it, vi } from "vitest";

import {
  executeFirstPartyAdapter,
  FirstPartyAdapterEncodingUnsupportedError,
  FirstPartyAdapterError,
  FirstPartyAdapterNotConfiguredError,
  firstPartyAdapterBaseUrlEnvVar,
  firstPartyAdapterCredentialEnvVar,
  firstPartyAdapterCredentialState,
  firstPartyAdapterTokenKey,
  getFirstPartyAdapter,
  isFirstPartyAdapterMutation,
  listFirstPartyAdapterIds,
  listFirstPartyAdapters,
  planFirstPartyAdapterRequest,
  shouldUseFirstPartyAdapter,
} from "@stella/runtime/kernel/connectors/first-party-adapters";

const ROOT = "/tmp/stella-first-party-adapters";

const EXPECTED_IDS = [
  "figma",
  "stripe",
  "2chat",
  "0codekit",
  "1password",
  "7shifts",
  "abyssale",
] as const;

describe("first-party adapter registry", () => {
  it("owns exactly the in-scope design/finance/ops connector ids, unchanged", () => {
    expect([...listFirstPartyAdapterIds()].sort()).toEqual(
      [...EXPECTED_IDS].sort(),
    );
  });

  it("records a Composio fallback toolkit for every adapter", () => {
    for (const adapter of listFirstPartyAdapters()) {
      expect(adapter.composioToolkit.trim().length).toBeGreaterThan(0);
    }
  });

  it("exposes representative read and write actions per adapter", () => {
    for (const adapter of listFirstPartyAdapters()) {
      const kinds = new Set(adapter.actions.map((action) => action.kind));
      expect(kinds.has("read"), `${adapter.id} read`).toBe(true);
      expect(kinds.has("write"), `${adapter.id} write`).toBe(true);
    }
  });

  it("uses unique, identifier-safe action names", () => {
    for (const adapter of listFirstPartyAdapters()) {
      const names = adapter.actions.map((action) => action.name);
      expect(new Set(names).size).toBe(names.length);
      for (const name of names) {
        expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/u);
      }
    }
  });

  it("derives architecture-consistent credential handles", () => {
    expect(firstPartyAdapterTokenKey("2chat")).toBe("native-adapter:2chat");
    expect(firstPartyAdapterCredentialEnvVar("2chat")).toBe(
      "STELLA_NATIVE_ADAPTER_2CHAT_API_KEY",
    );
    expect(firstPartyAdapterBaseUrlEnvVar("1password")).toBe(
      "STELLA_NATIVE_ADAPTER_1PASSWORD_BASE_URL",
    );
  });
});

describe("planFirstPartyAdapterRequest", () => {
  const figma = getFirstPartyAdapter("figma")!;
  const stripe = getFirstPartyAdapter("stripe")!;
  const sevenshifts = getFirstPartyAdapter("7shifts")!;
  const onepassword = getFirstPartyAdapter("1password")!;

  it("substitutes path params and builds an absolute URL", () => {
    const plan = planFirstPartyAdapterRequest(figma, "FIGMA_GET_FILE", {
      file_key: "abc123",
    });
    expect(plan.method).toBe("GET");
    expect(plan.path).toBe("/files/abc123");
    expect(plan.url).toBe("https://api.figma.com/v1/files/abc123");
    expect(plan.body).toBeUndefined();
  });

  it("splits declared query params from body args", () => {
    const plan = planFirstPartyAdapterRequest(stripe, "STRIPE_LIST_CUSTOMERS", {
      limit: 3,
      email: "a@b.com",
    });
    expect(plan.query).toEqual({ limit: "3", email: "a@b.com" });
    expect(plan.body).toBeUndefined();
  });

  it("routes non-query args into the request body for writes", () => {
    const plan = planFirstPartyAdapterRequest(
      figma,
      "FIGMA_POST_FILE_COMMENT",
      { file_key: "abc123", message: "hi" },
    );
    expect(plan.method).toBe("POST");
    expect(plan.path).toBe("/files/abc123/comments");
    expect(plan.body).toEqual({ message: "hi" });
  });

  it("carries provider static headers such as the 7shifts api version", () => {
    const plan = planFirstPartyAdapterRequest(
      sevenshifts,
      "SEVENSHIFTS_WHOAMI",
    );
    expect(plan.headers["x-api-version"]).toBeDefined();
  });

  it("percent-encodes path parameters", () => {
    const plan = planFirstPartyAdapterRequest(figma, "FIGMA_GET_FILE", {
      file_key: "a/b c",
    });
    expect(plan.path).toBe("/files/a%2Fb%20c");
  });

  it("rejects unknown actions", () => {
    expect(() =>
      planFirstPartyAdapterRequest(figma, "FIGMA_DOES_NOT_EXIST"),
    ).toThrow(FirstPartyAdapterError);
  });

  it("rejects missing required and missing path params", () => {
    expect(() =>
      planFirstPartyAdapterRequest(figma, "FIGMA_POST_FILE_COMMENT", {
        file_key: "abc",
      }),
    ).toThrow(/requires "message"/u);
    expect(() =>
      planFirstPartyAdapterRequest(figma, "FIGMA_GET_FILE", {}),
    ).toThrow(/requires "file_key"/u);
  });

  it("requires a base URL for self-hosted providers, honoring an override", () => {
    expect(() =>
      planFirstPartyAdapterRequest(onepassword, "ONEPASSWORD_LIST_VAULTS"),
    ).toThrow(FirstPartyAdapterNotConfiguredError);
    const plan = planFirstPartyAdapterRequest(
      onepassword,
      "ONEPASSWORD_LIST_VAULTS",
      {},
      { baseUrl: "https://connect.example.com/" },
    );
    expect(plan.url).toBe("https://connect.example.com/v1/vaults");
  });
});

describe("mutation + credential state", () => {
  it("flags write actions as mutations and reads as non-mutations", () => {
    expect(
      isFirstPartyAdapterMutation("figma", "FIGMA_POST_FILE_COMMENT"),
    ).toBe(true);
    expect(isFirstPartyAdapterMutation("figma", "FIGMA_GET_ME")).toBe(false);
    expect(isFirstPartyAdapterMutation("figma", "NOPE")).toBe(false);
  });

  it("reports credential and base-url readiness", () => {
    const stripe = getFirstPartyAdapter("stripe")!;
    expect(
      firstPartyAdapterCredentialState(stripe, { hasCredential: false }).status,
    ).toBe("missing_credential");
    expect(
      firstPartyAdapterCredentialState(stripe, { hasCredential: true }),
    ).toMatchObject({ connectable: true, status: "ready" });

    const onepassword = getFirstPartyAdapter("1password")!;
    expect(
      firstPartyAdapterCredentialState(onepassword, {
        hasCredential: true,
        hasBaseUrl: false,
      }).status,
    ).toBe("missing_base_url");
  });
});

describe("executeFirstPartyAdapter single-execution guarantees", () => {
  it("defers to Composio (never dispatches) when no credential is stored", async () => {
    const call = vi.fn();
    await expect(
      executeFirstPartyAdapter(
        ROOT,
        "figma",
        "FIGMA_POST_FILE_COMMENT",
        { file_key: "abc", message: "hi" },
        {},
        { loadCredential: async () => undefined, call },
      ),
    ).rejects.toBeInstanceOf(FirstPartyAdapterNotConfiguredError);
    expect(call).not.toHaveBeenCalled();
  });

  it("defers form-encoded writes without dispatching the wrong wire format", async () => {
    const call = vi.fn();
    await expect(
      executeFirstPartyAdapter(
        ROOT,
        "stripe",
        "STRIPE_CREATE_CUSTOMER",
        { email: "a@b.com" },
        {},
        { loadCredential: async () => "sk_test_123", call },
      ),
    ).rejects.toBeInstanceOf(FirstPartyAdapterEncodingUnsupportedError);
    expect(call).not.toHaveBeenCalled();
  });

  it("runs a single local REST call with the provider's api-key header", async () => {
    const call = vi.fn().mockResolvedValue({ ok: true });
    const result = await executeFirstPartyAdapter(
      ROOT,
      "2chat",
      "TWOCHAT_LIST_WHATSAPP_NUMBERS",
      { page_number: 0 },
      {},
      { loadCredential: async () => "key_123", call },
    );
    expect(result).toEqual({ ok: true });
    expect(call).toHaveBeenCalledTimes(1);
    const [, apiConfig, apiArgs] = call.mock.calls[0];
    expect(apiConfig).toMatchObject({
      id: "2chat",
      baseUrl: "https://api.p.2chat.io/open",
      auth: {
        type: "api_key",
        headerName: "X-User-API-Key",
        scheme: "raw",
        tokenKey: "native-adapter:2chat",
      },
    });
    expect(apiArgs).toMatchObject({
      method: "GET",
      path: "/whatsapp/get-numbers",
      query: { page_number: "0" },
    });
  });

  it("maps an oauth2 adapter to a bearer Authorization call", async () => {
    const call = vi.fn().mockResolvedValue({ id: "me" });
    await executeFirstPartyAdapter(
      ROOT,
      "figma",
      "FIGMA_GET_ME",
      {},
      {},
      { loadCredential: async () => "tok", call },
    );
    const [, apiConfig] = call.mock.calls[0];
    expect(apiConfig.auth).toMatchObject({
      type: "oauth",
      scheme: "bearer",
      headerName: "Authorization",
      tokenKey: "native-oauth:figma",
    });
  });
});

describe("shouldUseFirstPartyAdapter", () => {
  it("only opts into local execution once a credential exists", async () => {
    expect(
      await shouldUseFirstPartyAdapter(ROOT, "abyssale", {
        loadCredential: async () => undefined,
      }),
    ).toBe(false);
    expect(
      await shouldUseFirstPartyAdapter(ROOT, "abyssale", {
        loadCredential: async () => "key",
      }),
    ).toBe(true);
  });

  it("still withholds self-hosted providers without a base URL", async () => {
    const previous = process.env.STELLA_NATIVE_ADAPTER_1PASSWORD_BASE_URL;
    delete process.env.STELLA_NATIVE_ADAPTER_1PASSWORD_BASE_URL;
    try {
      expect(
        await shouldUseFirstPartyAdapter(ROOT, "1password", {
          loadCredential: async () => "token",
        }),
      ).toBe(false);
    } finally {
      if (previous !== undefined) {
        process.env.STELLA_NATIVE_ADAPTER_1PASSWORD_BASE_URL = previous;
      }
    }
  });

  it("returns false for a non-adapter id", async () => {
    expect(await shouldUseFirstPartyAdapter(ROOT, "gmail")).toBe(false);
  });
});
