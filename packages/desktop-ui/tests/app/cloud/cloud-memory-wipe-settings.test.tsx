// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  view: {
    identity: {
      accountScope: "account:owner-a",
      identityRevision: 7,
      ownerSubject: "https://stella.example|owner-a",
    },
    phase: "ready" as
      | "loading"
      | "ready"
      | "starting"
      | "active"
      | "completed"
      | "error",
    status: {
      subject: "https://stella.example|owner-a",
      ownerGeneration: "generation-1",
      state: "open" as "open" | "wiping",
      memoryEpoch: "epoch-1",
      importDisposition: "automatic_allowed" as
        | "automatic_allowed"
        | "explicit_required"
        | "explicit_allowed",
      job: null as null | {
        operationId: string;
        stage: "sweeping" | "metadata" | "releasing" | "completed";
        attempts: number;
        nextRetryAt: number;
        lastErrorCode?: string;
        objectsDeleted: number;
        rowsDeleted: number;
        completedAt?: number;
        updatedAt: number;
      },
    },
    issueCode: null as string | null,
    disabled: false,
  },
  startWipe: vi.fn(),
  refresh: vi.fn(),
  retry: vi.fn(),
  translate: (key: string) => key,
}));

vi.mock("@/features/cloud/use-cloud-memory-wipe", () => ({
  useCloudMemoryWipe: () => ({
    ...mocks.view,
    startWipe: mocks.startWipe,
    refresh: mocks.refresh,
    retry: mocks.retry,
  }),
}));

vi.mock("@/shared/i18n", () => ({
  useT: () => mocks.translate,
}));

import { CloudMemoryWipeSettings } from "@/features/cloud/CloudMemoryWipeSettings";

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const click = async (element: HTMLElement) => {
  await act(async () => element.click());
  await flush();
};

const replaceInput = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("CloudMemoryWipeSettings", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = async () => {
    await act(async () => root.render(<CloudMemoryWipeSettings />));
    await flush();
  };

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    mocks.view.identity = {
      accountScope: "account:owner-a",
      identityRevision: 7,
      ownerSubject: "https://stella.example|owner-a",
    };
    mocks.view.phase = "ready";
    mocks.view.status = {
      subject: "https://stella.example|owner-a",
      ownerGeneration: "generation-1",
      state: "open",
      memoryEpoch: "epoch-1",
      importDisposition: "automatic_allowed",
      job: null,
    };
    mocks.view.issueCode = null;
    mocks.view.disabled = false;
    mocks.startWipe.mockReset().mockResolvedValue(true);
    mocks.refresh.mockReset().mockResolvedValue(true);
    mocks.retry.mockReset().mockResolvedValue(true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document
      .querySelectorAll('[data-component="dialog-overlay"]')
      .forEach((element) => element.remove());
    vi.restoreAllMocks();
  });

  it("requires review and an exact typed final confirmation", async () => {
    await render();
    await click(
      container.querySelector<HTMLElement>(
        '[data-action="open-cloud-memory-wipe"]',
      )!,
    );
    expect(
      document.body.querySelector(
        '[data-cloud-memory-wipe-confirmation="review"]',
      ),
    ).not.toBeNull();
    expect(mocks.startWipe).not.toHaveBeenCalled();

    await click(
      document.body.querySelector<HTMLElement>(
        '[data-action="continue-cloud-memory-wipe"]',
      )!,
    );
    const input = document.body.querySelector<HTMLInputElement>("input")!;
    const confirm = document.body.querySelector<HTMLButtonElement>(
      '[data-action="confirm-cloud-memory-wipe"]',
    )!;
    expect(confirm.disabled).toBe(true);
    await replaceInput(input, "erase");
    expect(confirm.disabled).toBe(true);
    await replaceInput(input, "ERASE");
    expect(confirm.disabled).toBe(false);
    await click(confirm);

    expect(mocks.startWipe).toHaveBeenCalledTimes(1);
  });

  it("shows durable intermediate progress without claiming completion", async () => {
    mocks.view.phase = "active";
    mocks.view.disabled = true;
    mocks.view.status = {
      subject: "https://stella.example|owner-a",
      ownerGeneration: "generation-1",
      state: "wiping",
      memoryEpoch: "epoch-1",
      importDisposition: "automatic_allowed",
      job: {
        operationId: "memorywipe-1",
        stage: "metadata",
        attempts: 2,
        nextRetryAt: 200,
        lastErrorCode: "TRANSIENT_STORAGE_FAILURE",
        objectsDeleted: 12,
        rowsDeleted: 5,
        updatedAt: 100,
      },
    };
    await render();

    expect(container.textContent).toContain(
      "Removing Memory document metadata",
    );
    expect(container.textContent).toContain(
      "12 cloud objects and 5 metadata rows erased",
    );
    expect(container.textContent).toContain("retry automatically");
    expect(container.textContent).not.toContain("Memory wipe completed");
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-action="open-cloud-memory-wipe"]',
      )?.disabled,
    ).toBe(true);
  });

  it("only presents completion for an open lifecycle with a completed receipt", async () => {
    mocks.view.phase = "completed";
    mocks.view.status = {
      subject: "https://stella.example|owner-a",
      ownerGeneration: "generation-1",
      state: "open",
      memoryEpoch: "epoch-2",
      importDisposition: "explicit_required",
      lastWipedEpoch: "epoch-1",
      job: {
        operationId: "memorywipe-1",
        stage: "completed",
        attempts: 1,
        nextRetryAt: 200,
        objectsDeleted: 12,
        rowsDeleted: 5,
        completedAt: 200,
        updatedAt: 200,
      },
    };
    await render();

    expect(container.textContent).toContain("Memory wipe completed");
    expect(container.textContent).toContain("new empty epoch is open");
    expect(container.textContent).toContain("non-content completion receipt");
  });

  it("closes an armed confirmation when the account identity changes", async () => {
    await render();
    await click(
      container.querySelector<HTMLElement>(
        '[data-action="open-cloud-memory-wipe"]',
      )!,
    );
    expect(
      document.body.querySelector(
        '[data-cloud-memory-wipe-confirmation="review"]',
      ),
    ).not.toBeNull();

    mocks.view.identity = {
      accountScope: "account:owner-b",
      identityRevision: 8,
      ownerSubject: "https://stella.example|owner-b",
    };
    await render();

    expect(
      document.body.querySelector(
        '[data-cloud-memory-wipe-confirmation="review"]',
      ),
    ).toBeNull();
    expect(mocks.startWipe).not.toHaveBeenCalled();
  });
});
