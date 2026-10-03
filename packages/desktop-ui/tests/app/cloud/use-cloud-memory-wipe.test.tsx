// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackendRequestError } from "@stella/contracts/backend/client";

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

import {
  useCloudMemoryWipe,
  type CloudMemoryWipeView,
} from "@/features/cloud/use-cloud-memory-wipe";

const refusal = (reason: string) =>
  new BackendRequestError({
    code: "CONFLICT",
    message: "refused",
    retryable: false,
    reason,
  });

const ready = (
  args: {
    subject?: string;
    generation?: string;
    epoch?: string;
  } = {},
) => ({
  subject: args.subject ?? subjectA,
  ownerGeneration: args.generation ?? "generation-1",
  state: "open" as const,
  memoryEpoch: args.epoch ?? "epoch-1",
  importDisposition: "automatic_allowed" as const,
  job: null,
});

const active = (
  args: {
    subject?: string;
    generation?: string;
    epoch?: string;
  } = {},
) => ({
  subject: args.subject ?? subjectA,
  ownerGeneration: args.generation ?? "generation-1",
  state: "wiping" as const,
  memoryEpoch: args.epoch ?? "epoch-1",
  importDisposition: "automatic_allowed" as const,
  job: {
    operationId: "memorywipe-operation-1",
    stage: "sweeping" as const,
    attempts: 0,
    nextRetryAt: 1,
    objectsDeleted: 0,
    rowsDeleted: 0,
    updatedAt: 1,
  },
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

let latest: CloudMemoryWipeView | null = null;

function Harness() {
  latest = useCloudMemoryWipe();
  return <output data-phase={latest.phase} />;
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("useCloudMemoryWipe", () => {
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
    mocks.reactiveResult = ready();
    mocks.backend.call.mockReset();
    mocks.backend.reconnect.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("settles on the live head after a nonretryable epoch error without replaying the stale attempt", async () => {
    mocks.backend.call.mockRejectedValue(refusal("CLOUD_MEMORY_EPOCH_STALE"));
    await render();

    await act(async () => expect(latest!.startWipe()).resolves.toBe(false));
    expect(latest?.phase).toBe("error");
    expect(latest?.issueCode).toBe("stale_epoch");

    mocks.reactiveResult = ready({
      generation: "generation-2",
      epoch: "epoch-2",
    });
    await render();
    await act(async () => expect(latest!.retry()).resolves.toBe(true));
    expect(latest?.phase).toBe("ready");
    expect(latest?.status?.ownerGeneration).toBe("generation-2");
    expect(mocks.backend.call).toHaveBeenCalledTimes(1);
    expect(mocks.backend.call.mock.calls[0]?.[0]).toBe("memory.startWipe");
  });

  it("replays one exact idempotent attempt after ambiguous transport loss", async () => {
    mocks.backend.call
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(active());
    await render();

    await act(async () => expect(latest!.startWipe()).resolves.toBe(false));
    await act(async () => expect(latest!.retry()).resolves.toBe(true));

    expect(latest?.phase).toBe("active");
    expect(mocks.backend.call).toHaveBeenCalledTimes(2);
    expect(mocks.backend.call.mock.calls[1]?.[1]).toEqual(
      mocks.backend.call.mock.calls[0]?.[1],
    );
  });

  it("drops a late start result after the account identity changes", async () => {
    const ownerAStart = deferred<ReturnType<typeof active>>();
    const ownerBStart = deferred<ReturnType<typeof active>>();
    mocks.backend.call
      .mockReturnValueOnce(ownerAStart.promise)
      .mockReturnValueOnce(ownerBStart.promise);
    await render();

    let pending!: Promise<boolean>;
    await act(async () => {
      pending = latest!.startWipe();
      await Promise.resolve();
    });

    mocks.mode = {
      isCloudConversationReady: true,
      accountScope: "account:owner-b",
      identityRevision: 5,
      ownerSubject: subjectB,
    };
    mocks.reactiveResult = ready({
      subject: subjectB,
      generation: "generation-b",
      epoch: "epoch-b",
    });
    await render();
    expect(latest?.status?.subject).toBe(subjectB);

    let pendingB!: Promise<boolean>;
    await act(async () => {
      pendingB = latest!.startWipe();
      await Promise.resolve();
    });

    ownerAStart.resolve(active());
    await act(async () => expect(pending).resolves.toBe(false));
    expect(latest?.status?.subject).toBe(subjectB);
    expect(latest?.phase).toBe("starting");

    ownerBStart.resolve(
      active({
        subject: subjectB,
        generation: "generation-b",
        epoch: "epoch-b",
      }),
    );
    await act(async () => expect(pendingB).resolves.toBe(true));
    expect(latest?.status?.subject).toBe(subjectB);
    expect(latest?.phase).toBe("active");
  });
});
