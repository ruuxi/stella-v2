// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryResults: {} as Record<string, unknown>,
  queryRequests: null as unknown,
  createClient: vi.fn(),
  beginWrite: vi.fn(),
  listMemory: vi.fn(),
  clientWrite: vi.fn(),
  getTokenForSubject: vi.fn(),
  authSnapshot: {
    data: {
      user: { id: "owner-a", isAnonymous: false },
      session: { id: "session-a" },
    },
    isPending: false,
    error: null,
    identityRevision: 9,
  },
}));

vi.mock("convex/react", () => ({
  useQueries: (requests: unknown) => {
    mocks.queryRequests = requests;
    return mocks.queryResults;
  },
}));

vi.mock("@/global/auth/hooks/use-auth-session-state", () => ({
  useAuthSessionState: () => ({
    user: { id: "owner-a", isAnonymous: false },
    hasSession: true,
    isAnonymous: false,
    hasConnectedAccount: true,
    isLoading: false,
    cacheScope: "account:owner-a",
    identityRevision: 9,
  }),
}));

vi.mock("@/global/auth/hooks/use-cloud-mode", () => ({
  useCloudMode: () => ({
    cloudMode: true,
    accountScope: "account:owner-a",
    identityRevision: 9,
    expectedSubject: "owner-a",
    ownerSubject: "https://site.example|owner-a",
  }),
}));

vi.mock("@/global/auth/services/auth-session", () => ({
  getAuthSessionSnapshot: () => mocks.authSnapshot,
}));

vi.mock("@/global/auth/services/auth-token", () => ({
  getConvexTokenForSubject: mocks.getTokenForSubject,
}));

vi.mock("@/shared/lib/convex-urls", () => ({
  readConfiguredConvexSiteUrl: () => "https://site.example",
}));

vi.mock("@/features/cloud/cloud-home-memory-client", () => {
  class CloudHomeMemoryError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  return {
    CloudHomeMemoryError,
    beginCloudMemoryDocumentWrite: mocks.beginWrite,
    createCloudHomeMemoryClient: mocks.createClient,
  };
});

import {
  useCloudHomeMemory,
  type UseCloudHomeMemoryResult,
} from "@/features/cloud/use-cloud-home-memory";

describe("useCloudHomeMemory", () => {
  let container: HTMLDivElement;
  let root: Root;
  let observed: UseCloudHomeMemoryResult | null;

  function Probe() {
    observed = useCloudHomeMemory();
    return null;
  }

  const render = async () => {
    await act(async () => root.render(<Probe />));
  };

  const lifecycle = {
    subject: "https://site.example|owner-a",
    ownerGeneration: "generation-1",
    state: "open",
    memoryEpoch: "memory-epoch-1",
    importDisposition: "automatic_allowed",
    job: null,
  };

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    observed = null;
    mocks.queryResults = {};
    mocks.queryRequests = null;
    mocks.createClient.mockReset();
    mocks.beginWrite.mockReset();
    mocks.listMemory.mockReset();
    mocks.clientWrite.mockReset();
    mocks.getTokenForSubject.mockReset();
    mocks.getTokenForSubject.mockResolvedValue("signed-token");
    mocks.createClient.mockReturnValue({
      listMemory: mocks.listMemory,
      readMemory: vi.fn(),
      writeMemory: mocks.clientWrite,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("turns a realtime-config query error into an explicit unavailable state", async () => {
    mocks.queryResults = {
      realtime: new Error("deployment unavailable"),
      memoryLifecycle: lifecycle,
    };
    await render();

    expect(observed).toMatchObject({
      available: false,
      loading: false,
      unavailable: true,
    });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.queryRequests).toMatchObject({
      realtime: { args: {} },
      memoryLifecycle: {
        args: { expectedSubject: "https://site.example|owner-a" },
      },
    });
  });

  it("pins issuer, subject, account, and session revision in the client", async () => {
    mocks.queryResults = {
      realtime: {
        protocol: 1,
        httpOrigin: "https://builder.example",
        socketOrigin: null,
      },
      memoryLifecycle: lifecycle,
    };
    await render();

    expect(observed).toMatchObject({
      available: true,
      loading: false,
      unavailable: false,
      lifecycle,
    });
    expect(mocks.createClient).toHaveBeenCalledTimes(1);
    const options = mocks.createClient.mock.calls[0]![0] as {
      builderOrigin: string;
      identity: {
        accountScope: string;
        identityRevision: number;
        expectedSubject: string;
      };
      getCurrentIdentity: () => unknown;
      getTokenForSubject: (subject: string) => Promise<string>;
    };
    expect(options.builderOrigin).toBe("https://builder.example");
    expect(options.identity).toEqual({
      accountScope: "account:owner-a",
      identityRevision: 9,
      expectedSubject: "https://site.example|owner-a",
    });
    expect(options.getCurrentIdentity()).toEqual(options.identity);
    await expect(
      options.getTokenForSubject("https://site.example|owner-a"),
    ).resolves.toBe("signed-token");
    expect(mocks.getTokenForSubject).toHaveBeenCalledWith(
      "https://site.example|owner-a",
    );
  });

  it("fails closed while the exact-subject lifecycle is wiping", async () => {
    mocks.queryResults = {
      realtime: {
        protocol: 1,
        httpOrigin: "https://builder.example",
        socketOrigin: null,
      },
      memoryLifecycle: {
        ...lifecycle,
        state: "wiping",
        memoryEpoch: "memory-epoch-2",
        job: {
          operationId: "wipe-1",
          stage: "sweeping",
          attempts: 1,
          nextRetryAt: 0,
          objectsDeleted: 0,
          rowsDeleted: 0,
          updatedAt: 1,
        },
      },
    };
    await render();

    expect(observed).toMatchObject({
      available: false,
      loading: false,
      unavailable: false,
      lifecycle: { state: "wiping", memoryEpoch: "memory-epoch-2" },
    });
  });

  it("rejects a lifecycle echo for a different exact subject", async () => {
    mocks.queryResults = {
      realtime: {
        protocol: 1,
        httpOrigin: "https://builder.example",
        socketOrigin: null,
      },
      memoryLifecycle: {
        ...lifecycle,
        subject: "https://site.example|owner-b",
      },
    };
    await render();

    expect(observed).toMatchObject({
      available: false,
      loading: false,
      unavailable: true,
      lifecycle: null,
    });
  });
});
