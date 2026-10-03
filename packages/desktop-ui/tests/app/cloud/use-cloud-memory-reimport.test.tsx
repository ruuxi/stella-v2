// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const subjectA = "https://stella.example|owner-a";
const subjectB = "https://stella.example|owner-b";

const mocks = vi.hoisted(() => ({
  mode: {
    isCloudConversationReady: true,
    accountScope: "account:owner-a",
    identityRevision: 4,
    ownerSubject: "https://stella.example|owner-a" as string | null,
  },
  reactiveResult: undefined as unknown,
  backend: {
    call: vi.fn(),
    reconnect: vi.fn(),
  },
  requestSync: vi.fn(),
}));

vi.mock("@/platform/backend/use-backend-view", () => ({
  useBackendView: (_view: string, args: unknown) => {
    const result = args === "skip" ? undefined : mocks.reactiveResult;
    if (result === undefined) {
      return { status: "loading", value: undefined, error: undefined };
    }
    return result instanceof Error
      ? { status: "error", value: undefined, error: result }
      : { status: "ready", value: result, error: undefined };
  },
}));

vi.mock("@/platform/backend/backend-client", () => ({
  backendClient: mocks.backend,
}));

vi.mock("@/global/auth/hooks/use-cloud-conversation-session", () => ({
  useCloudConversationSession: () => mocks.mode,
}));

vi.mock("@/features/cloud/cloud-home-sync", () => ({
  cloudHomeSyncRetryStore: { request: mocks.requestSync },
}));

import {
  useCloudMemoryReimport,
  type CloudMemoryReimportView,
} from "@/features/cloud/use-cloud-memory-reimport";

const required = (
  subject = subjectA,
  generation = "generation-1",
  epoch = "epoch-2",
) => ({
  subject,
  ownerGeneration: generation,
  state: "open" as const,
  memoryEpoch: epoch,
  importDisposition: "explicit_required" as const,
  lastWipedEpoch: "epoch-1",
  job: {
    operationId: "memorywipe-operation-1",
    stage: "completed" as const,
    attempts: 1,
    nextRetryAt: 2,
    objectsDeleted: 4,
    rowsDeleted: 2,
    completedAt: 2,
    updatedAt: 2,
  },
});

const allowed = (
  subject = subjectA,
  generation = "generation-1",
  epoch = "epoch-2",
) => ({
  ...required(subject, generation, epoch),
  importDisposition: "explicit_allowed" as const,
});

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
};

let latest: CloudMemoryReimportView | null = null;

function Harness() {
  latest = useCloudMemoryReimport();
  return <output data-phase={latest.phase} />;
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("useCloudMemoryReimport", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = async () => {
    await act(async () => root.render(<Harness />));
    await flush();
  };

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    latest = null;
    mocks.mode = {
      isCloudConversationReady: true,
      accountScope: "account:owner-a",
      identityRevision: 4,
      ownerSubject: subjectA,
    };
    mocks.reactiveResult = required();
    mocks.backend.call.mockReset();
    mocks.backend.reconnect.mockReset();
    mocks.requestSync.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("authorizes the current generation and epoch of the live head", async () => {
    mocks.backend.call.mockResolvedValue(allowed());
    await render();

    expect(latest?.eligible).toBe(true);
    await act(async () =>
      expect(latest!.authorizeReimport()).resolves.toBe(true),
    );

    expect(mocks.backend.call.mock.calls[0]?.[0]).toBe(
      "memory.authorizeReimport",
    );
    expect(mocks.backend.call.mock.calls[0]?.[1]).toEqual({
      expectedOwnerGeneration: "generation-1",
      expectedMemoryEpoch: "epoch-2",
      requestId: expect.stringMatching(/^desktop-memory-reimport:/u),
    });
    expect(latest?.phase).toBe("authorized");
    expect(latest?.eligible).toBe(false);
    expect(mocks.requestSync).toHaveBeenCalledTimes(1);
  });

  it("retries an ambiguous mutation with the exact same payload", async () => {
    mocks.backend.call
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(allowed());
    await render();

    await act(async () =>
      expect(latest!.authorizeReimport()).resolves.toBe(false),
    );
    expect(latest?.phase).toBe("error");
    await act(async () => expect(latest!.retry()).resolves.toBe(true));

    expect(mocks.backend.call).toHaveBeenCalledTimes(2);
    expect(mocks.backend.call.mock.calls[1]?.[1]).toEqual(
      mocks.backend.call.mock.calls[0]?.[1],
    );
    expect(mocks.requestSync).toHaveBeenCalledTimes(1);
  });

  it("drops a late authorization result after the full account identity changes", async () => {
    const ownerAResult = deferred<ReturnType<typeof allowed>>();
    mocks.backend.call.mockReturnValue(ownerAResult.promise);
    await render();

    let pending!: Promise<boolean>;
    await act(async () => {
      pending = latest!.authorizeReimport();
      await Promise.resolve();
    });

    mocks.mode = {
      isCloudConversationReady: true,
      accountScope: "account:owner-b",
      identityRevision: 5,
      ownerSubject: subjectB,
    };
    mocks.reactiveResult = required(subjectB, "generation-b", "epoch-b");
    await render();

    ownerAResult.resolve(allowed());
    await act(async () => expect(pending).resolves.toBe(false));

    expect(latest?.status?.subject).toBe(subjectB);
    expect(latest?.eligible).toBe(true);
    expect(mocks.requestSync).not.toHaveBeenCalled();
  });

  it("never offers authorization for an already allowed lifecycle", async () => {
    mocks.reactiveResult = allowed();
    await render();

    expect(latest?.phase).toBe("authorized");
    expect(latest?.eligible).toBe(false);
    await expect(latest!.authorizeReimport()).resolves.toBe(false);
    expect(mocks.backend.call).not.toHaveBeenCalled();
  });
});
