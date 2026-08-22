import { describe, expect, it, vi } from "vitest";

import {
  executeFirstPartyAdapter,
  FirstPartyAdapterError,
  FirstPartyAdapterNotConfiguredError,
  FirstPartyAdapterSharedCoreRequiredError,
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
    expect(
      Object.fromEntries(
        listFirstPartyAdapters().map((adapter) => [
          adapter.id,
          adapter.composioToolkit,
        ]),
      ),
    ).toEqual({
      figma: "FIGMA",
      stripe: "STRIPE",
      "2chat": "_2CHAT",
      "0codekit": "0CODEKIT",
      "1password": "_1PASSWORD",
      "7shifts": "7SHIFTS",
      abyssale: "ABYSSALE",
    });
  });

  it("matches 0CodeKit's documented production origin and API-key header", () => {
    const adapter = getFirstPartyAdapter("0codekit");
    expect(adapter?.baseUrl).toBe("https://prod.0codekit.com");
    expect(adapter?.auth).toMatchObject({
      kind: "api_key",
      headerName: "auth",
      scheme: "raw",
    });
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
    expect(getFirstPartyAdapter("stripe")?.auth).toMatchObject({
      kind: "oauth2",
      tokenKey: "native-oauth:stripe",
    });
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

describe("runtime execution delegates to the shared core", () => {
  it("never loads a credential or dispatches from the runtime", async () => {
    const loadCredential = vi.fn().mockResolvedValue("secret");
    const call = vi.fn();
    await expect(
      executeFirstPartyAdapter(
        ROOT,
        "figma",
        "FIGMA_POST_FILE_COMMENT",
        { file_key: "abc", message: "hi" },
        {},
        { loadCredential, call },
      ),
    ).rejects.toBeInstanceOf(FirstPartyAdapterSharedCoreRequiredError);
    expect(loadCredential).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("still rejects unknown adapters before delegation", async () => {
    await expect(
      executeFirstPartyAdapter(ROOT, "nope", "NOPE"),
    ).rejects.toBeInstanceOf(FirstPartyAdapterError);
  });
});

describe("shouldUseFirstPartyAdapter", () => {
  it("never opts into runtime-local execution, even with a credential", async () => {
    expect(
      await shouldUseFirstPartyAdapter(ROOT, "abyssale", {
        loadCredential: async () => undefined,
      }),
    ).toBe(false);
    expect(
      await shouldUseFirstPartyAdapter(ROOT, "abyssale", {
        loadCredential: async () => "key",
      }),
    ).toBe(false);
    expect(
      await shouldUseFirstPartyAdapter(ROOT, "7shifts", {
        loadCredential: async () => "partner-token",
      }),
    ).toBe(false);
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
