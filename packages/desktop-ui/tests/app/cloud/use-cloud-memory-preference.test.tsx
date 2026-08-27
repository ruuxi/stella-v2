// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const subjectA = "https://stella.example|owner-a";
const subjectB = "https://stella.example|owner-b";

const mocks = vi.hoisted(() => ({
  mode: {
    cloudMode: true,
    accountScope: "account:owner-a",
    identityRevision: 4,
    ownerSubject: "https://stella.example|owner-a" as string | null,
  },
  reactiveResult: undefined as unknown,
  convex: {
    query: vi.fn(),
    mutation: vi.fn(),
  },
  mirror: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useConvex: () => mocks.convex,
  useQueries: () => ({ preference: mocks.reactiveResult }),
}));

vi.mock("@/global/auth/hooks/use-cloud-mode", () => ({
  useCloudMode: () => mocks.mode,
}));

vi.mock("@/features/cloud/cloud-memory-local-mirror", () => ({
  mirrorCloudMemoryPreferenceLocally: (enabled: boolean) =>
    mocks.mirror(enabled),
}));

import {
  useCloudMemoryPreference,
  type CloudMemoryPreferenceView,
} from "@/features/cloud/use-cloud-memory-preference";

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

const envelope = (
  args: {
    subject?: string;
    ownerGeneration?: string;
    memoryEnabled?: boolean;
    revision?: number;
    updatedAt?: number;
  } = {},
) => ({
  subject: args.subject ?? subjectA,
  ownerGeneration: args.ownerGeneration ?? "generation-a:1",
  memoryEnabled: args.memoryEnabled ?? true,
  revision: args.revision ?? 7,
  updatedAt: args.updatedAt ?? 1_000,
});

let latest: CloudMemoryPreferenceView | null = null;

function Harness() {
  latest = useCloudMemoryPreference();
  return <output data-status={latest.status}>{latest.memoryEnabled}</output>;
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("useCloudMemoryPreference", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = async () => {
    await act(async () => root.render(<Harness />));
    await flush();
  };

  const rerender = async () => {
    await act(async () => root.render(<Harness />));
    await flush();
  };

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    latest = null;
    mocks.mode = {
      cloudMode: true,
      accountScope: "account:owner-a",
      identityRevision: 4,
      ownerSubject: subjectA,
    };
    mocks.reactiveResult = undefined;
    mocks.convex.query.mockReset();
    mocks.convex.mutation.mockReset();
    mocks.mirror.mockReset().mockResolvedValue(true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("treats the subject-fenced reactive query as authority", async () => {
    await render();
    expect(latest?.status).toBe("loading");
    expect(latest?.memoryEnabled).toBe(false);

    mocks.reactiveResult = envelope();
    await rerender();

    expect(latest?.status).toBe("synced");
    expect(latest?.preference).toEqual({
      ownerGeneration: "generation-a:1",
      memoryEnabled: true,
      revision: 7,
      updatedAt: 1_000,
    });
  });

  it("forces the revision-zero default to become an explicit CAS write", async () => {
    mocks.reactiveResult = envelope({ revision: 0, updatedAt: 0 });
    mocks.convex.mutation.mockResolvedValue(
      envelope({ revision: 1, updatedAt: 1_001 }),
    );
    await render();

    await expect(latest!.setMemoryEnabled(true)).resolves.toBe(true);
    expect(mocks.convex.mutation).not.toHaveBeenCalled();

    let committed = false;
    await act(async () => {
      committed = await latest!.setMemoryEnabled(true, { force: true });
    });
    expect(committed).toBe(true);
    expect(mocks.convex.mutation).toHaveBeenCalledTimes(1);
    expect(mocks.convex.mutation.mock.calls[0]?.[1]).toMatchObject({
      expectedSubject: subjectA,
      memoryEnabled: true,
      expectedOwnerGeneration: "generation-a:1",
      expectedRevision: 0,
      requestId: expect.stringMatching(/^desktop-memory:/u),
    });
  });

  it("replays the exact CAS payload after an ambiguous transport failure", async () => {
    mocks.reactiveResult = envelope();
    mocks.convex.mutation
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(
        envelope({ memoryEnabled: false, revision: 8, updatedAt: 1_001 }),
      );
    await render();

    let firstResult = true;
    await act(async () => {
      firstResult = await latest!.setMemoryEnabled(false);
    });
    expect(firstResult).toBe(false);
    expect(latest?.status).toBe("error");

    let retryResult = false;
    await act(async () => {
      retryResult = await latest!.retry();
    });
    expect(retryResult).toBe(true);
    expect(mocks.convex.mutation).toHaveBeenCalledTimes(2);
    expect(mocks.convex.mutation.mock.calls[1]?.[1]).toEqual(
      mocks.convex.mutation.mock.calls[0]?.[1],
    );
  });

  it("disables the local runtime before cloud and enables it only after cloud", async () => {
    const events: string[] = [];
    mocks.reactiveResult = envelope();
    mocks.mirror.mockImplementation(async (enabled: boolean) => {
      events.push(`local:${enabled}`);
      return true;
    });
    mocks.convex.mutation.mockImplementation(async (_reference, input) => {
      events.push(`cloud:${String(input.memoryEnabled)}`);
      return envelope({ memoryEnabled: false, revision: 8 });
    });
    await render();

    await act(async () => {
      await latest!.setMemoryEnabled(false);
    });
    expect(events).toEqual(["local:false", "cloud:false"]);

    events.length = 0;
    mocks.reactiveResult = envelope({ memoryEnabled: false, revision: 8 });
    await rerender();
    mocks.convex.mutation.mockImplementation(async (_reference, input) => {
      events.push(`cloud:${String(input.memoryEnabled)}`);
      return envelope({ memoryEnabled: true, revision: 9 });
    });
    await act(async () => {
      await latest!.setMemoryEnabled(true);
    });
    expect(events).toEqual(["cloud:true", "local:true"]);
  });

  it("drops a late owner-A write after the account session changes to owner B", async () => {
    const ownerAWrite = deferred<ReturnType<typeof envelope>>();
    mocks.reactiveResult = envelope();
    mocks.convex.mutation.mockReturnValue(ownerAWrite.promise);
    await render();

    let pending!: Promise<boolean>;
    await act(async () => {
      pending = latest!.setMemoryEnabled(false);
      await Promise.resolve();
      await Promise.resolve();
    });

    mocks.mode = {
      cloudMode: true,
      accountScope: "account:owner-b",
      identityRevision: 5,
      ownerSubject: subjectB,
    };
    mocks.reactiveResult = envelope({
      subject: subjectB,
      ownerGeneration: "generation-b:1",
      memoryEnabled: true,
      revision: 2,
    });
    await rerender();
    expect(latest?.preference?.ownerGeneration).toBe("generation-b:1");

    ownerAWrite.resolve(
      envelope({ memoryEnabled: false, revision: 8, updatedAt: 1_001 }),
    );
    await act(async () => expect(pending).resolves.toBe(false));
    expect(latest?.preference?.ownerGeneration).toBe("generation-b:1");
    expect(latest?.memoryEnabled).toBe(true);
  });

  it("cancels an old-generation write when the subscription advances", async () => {
    const oldGenerationWrite = deferred<ReturnType<typeof envelope>>();
    mocks.reactiveResult = envelope();
    mocks.convex.mutation.mockReturnValue(oldGenerationWrite.promise);
    await render();

    let pending!: Promise<boolean>;
    await act(async () => {
      pending = latest!.setMemoryEnabled(false);
      await Promise.resolve();
      await Promise.resolve();
    });

    mocks.reactiveResult = envelope({
      ownerGeneration: "generation-a:2",
      memoryEnabled: false,
      revision: 0,
      updatedAt: 0,
    });
    await rerender();
    expect(latest?.preference?.ownerGeneration).toBe("generation-a:2");

    oldGenerationWrite.resolve(
      envelope({ memoryEnabled: false, revision: 8, updatedAt: 1_001 }),
    );
    await act(async () => expect(pending).resolves.toBe(false));
    expect(latest?.preference?.ownerGeneration).toBe("generation-a:2");
  });

  it("never regresses a newer same-generation reactive head after an enable mirror", async () => {
    const enableMirror = deferred<boolean>();
    mocks.reactiveResult = envelope({
      memoryEnabled: false,
      revision: 7,
      updatedAt: 1_000,
    });
    mocks.convex.mutation.mockResolvedValue(
      envelope({ memoryEnabled: true, revision: 8, updatedAt: 1_100 }),
    );
    mocks.mirror.mockImplementation((enabled: boolean) =>
      enabled ? enableMirror.promise : Promise.resolve(true),
    );
    await render();

    let pending!: Promise<boolean>;
    await act(async () => {
      pending = latest!.setMemoryEnabled(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest?.status).toBe("saving");

    mocks.reactiveResult = envelope({
      memoryEnabled: false,
      revision: 9,
      updatedAt: 1_200,
    });
    await rerender();
    enableMirror.resolve(true);
    await act(async () => expect(pending).resolves.toBe(false));
    await flush();

    expect(latest?.status).toBe("error");
    expect(latest?.issueCode).toBe("revision_conflict");
    expect(latest?.preference).toMatchObject({
      memoryEnabled: false,
      revision: 9,
    });
    expect(mocks.mirror.mock.calls).toEqual([[true], [false]]);
  });

  it("does not let an older manual reload overwrite newer reactive authority", async () => {
    const oldRead = deferred<ReturnType<typeof envelope>>();
    mocks.reactiveResult = new Error("subscription unavailable");
    mocks.convex.query.mockReturnValue(oldRead.promise);
    await render();
    expect(latest?.status).toBe("error");

    let pending!: Promise<boolean>;
    await act(async () => {
      pending = latest!.retry();
      await Promise.resolve();
    });

    mocks.reactiveResult = envelope({ revision: 9, updatedAt: 2_000 });
    await rerender();
    expect(latest?.preference?.revision).toBe(9);

    oldRead.resolve(envelope({ revision: 8, updatedAt: 1_500 }));
    await act(async () => expect(pending).resolves.toBe(false));
    expect(latest?.preference?.revision).toBe(9);
  });
});
