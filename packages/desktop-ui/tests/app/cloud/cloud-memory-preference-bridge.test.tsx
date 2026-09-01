// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mode: {
    isCloudConversationReady: true,
    accountScope: "account:owner-a",
    identityRevision: 4,
    ownerSubject: "https://stella.example|owner-a" as string | null,
  },
  preference: {
    status: "loading" as "loading" | "synced" | "saving" | "error",
    preference: null as null | {
      ownerGeneration: string;
      memoryEnabled: boolean;
      revision: number;
      updatedAt: number;
    },
  },
  mirror: vi.fn(),
}));

vi.mock("@/global/auth/hooks/use-cloud-conversation-session", () => ({
  useCloudConversationSession: () => mocks.mode,
}));

vi.mock("@/features/cloud/use-cloud-memory-preference", () => ({
  useCloudMemoryPreference: () => mocks.preference,
}));

vi.mock("@/features/cloud/cloud-memory-local-mirror", () => ({
  mirrorCloudMemoryPreferenceLocally: (enabled: boolean) =>
    mocks.mirror(enabled),
}));

import { CloudMemoryPreferenceBridge } from "@/features/cloud/CloudMemoryPreferenceBridge";

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("CloudMemoryPreferenceBridge", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    mocks.mode = {
      isCloudConversationReady: true,
      accountScope: "account:owner-a",
      identityRevision: 4,
      ownerSubject: "https://stella.example|owner-a",
    };
    mocks.preference = { status: "loading", preference: null };
    mocks.mirror.mockReset().mockResolvedValue(true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("fails closed before mirroring a synced cloud preference", async () => {
    mocks.preference = {
      status: "synced",
      preference: {
        ownerGeneration: "generation-a:1",
        memoryEnabled: true,
        revision: 7,
        updatedAt: 1_000,
      },
    };

    await act(async () => root.render(<CloudMemoryPreferenceBridge />));
    await flush();

    expect(mocks.mirror.mock.calls).toEqual([[false], [true]]);
  });

  it("remounts fail-closed on an account/session transition", async () => {
    await act(async () => root.render(<CloudMemoryPreferenceBridge />));
    await flush();
    expect(mocks.mirror.mock.calls).toEqual([[false]]);

    mocks.mode = {
      isCloudConversationReady: true,
      accountScope: "account:owner-b",
      identityRevision: 5,
      ownerSubject: "https://stella.example|owner-b",
    };
    mocks.preference = { status: "loading", preference: null };
    await act(async () => root.render(<CloudMemoryPreferenceBridge />));
    await flush();

    expect(mocks.mirror.mock.calls).toEqual([[false], [false]]);
  });

  it("stays fail-closed while cloud authority is unavailable", async () => {
    mocks.mode = {
      isCloudConversationReady: false,
      accountScope: "account:unavailable",
      identityRevision: 8,
      ownerSubject: null,
    };
    mocks.preference = { status: "error", preference: null };

    await act(async () => root.render(<CloudMemoryPreferenceBridge />));
    await flush();

    expect(mocks.mirror.mock.calls).toEqual([[false]]);
  });

  it("returns to fail-closed when a previously synced authority errors", async () => {
    mocks.preference = {
      status: "synced",
      preference: {
        ownerGeneration: "generation-a:1",
        memoryEnabled: true,
        revision: 7,
        updatedAt: 1_000,
      },
    };
    await act(async () => root.render(<CloudMemoryPreferenceBridge />));
    await flush();
    expect(mocks.mirror.mock.calls).toEqual([[false], [true]]);

    mocks.preference = { status: "error", preference: null };
    await act(async () => root.render(<CloudMemoryPreferenceBridge />));
    await flush();

    expect(mocks.mirror.mock.calls).toEqual([[false], [true], [false]]);
  });

  it("retries a rejected fail-closed echo before enabling Memory", async () => {
    vi.useFakeTimers();
    mocks.mirror
      .mockReset()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await act(async () => root.render(<CloudMemoryPreferenceBridge />));
    await flush();
    expect(mocks.mirror.mock.calls).toEqual([[false]]);

    await act(async () => vi.advanceTimersByTime(1_000));
    await flush();
    expect(mocks.mirror.mock.calls).toEqual([[false], [false]]);
  });
});
