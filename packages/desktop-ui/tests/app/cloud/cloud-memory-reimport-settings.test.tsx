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
    } as {
      accountScope: string;
      identityRevision: number;
      ownerSubject: string;
    } | null,
    phase: "ready" as
      | "loading"
      | "ready"
      | "authorizing"
      | "authorized"
      | "error",
    status: {
      subject: "https://stella.example|owner-a",
      ownerGeneration: "generation-1",
      state: "open" as "open" | "wiping",
      memoryEpoch: "epoch-2",
      importDisposition: "explicit_required" as
        | "automatic_allowed"
        | "explicit_required"
        | "explicit_allowed",
      lastWipedEpoch: "epoch-1" as string | undefined,
      job: null,
    },
    issueCode: null as string | null,
    eligible: true,
    disabled: false,
  },
  authorizeReimport: vi.fn(),
  refresh: vi.fn(),
  retry: vi.fn(),
  translate: (key: string) => key,
}));

vi.mock("@/features/cloud/use-cloud-memory-reimport", () => ({
  useCloudMemoryReimport: () => ({
    ...mocks.view,
    authorizeReimport: mocks.authorizeReimport,
    refresh: mocks.refresh,
    retry: mocks.retry,
  }),
}));

vi.mock("@/shared/i18n", () => ({
  useT: () => mocks.translate,
}));

import { CloudMemoryReimportSettings } from "@/features/cloud/CloudMemoryReimportSettings";

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

describe("CloudMemoryReimportSettings", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = async () => {
    await act(async () => root.render(<CloudMemoryReimportSettings />));
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
      memoryEpoch: "epoch-2",
      importDisposition: "explicit_required",
      lastWipedEpoch: "epoch-1",
      job: null,
    };
    mocks.view.issueCode = null;
    mocks.view.eligible = true;
    mocks.view.disabled = false;
    mocks.authorizeReimport.mockReset().mockResolvedValue(true);
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

  it("requires a clear confirmation before authorizing local Memory import", async () => {
    await render();
    expect(container.textContent).toContain("new epoch is empty");
    expect(container.textContent).toContain(
      "Skill synchronization is separate",
    );
    expect(mocks.authorizeReimport).not.toHaveBeenCalled();

    await click(
      container.querySelector<HTMLElement>(
        '[data-action="open-cloud-memory-reimport"]',
      )!,
    );
    const dialog = document.body.querySelector<HTMLElement>(
      "[data-cloud-memory-reimport-confirmation]",
    )!;
    expect(dialog.textContent).toContain("local Memory documents");
    expect(dialog.textContent).toContain("new, empty cloud Memory epoch");
    expect(dialog.textContent).toContain(
      "erased epoch stays permanently deleted",
    );
    expect(dialog.textContent).toContain("Allow reimport");
    expect(dialog.textContent).not.toContain("Upload local Memory");

    await click(
      dialog.querySelector<HTMLElement>(
        '[data-action="confirm-cloud-memory-reimport"]',
      )!,
    );
    expect(mocks.authorizeReimport).toHaveBeenCalledTimes(1);
  });

  it("renders no action unless the authoritative lifecycle is eligible", async () => {
    mocks.view.eligible = false;
    mocks.view.status.importDisposition = "explicit_allowed";
    await render();

    expect(container.querySelector("[data-cloud-memory-reimport]")).toBeNull();
    expect(mocks.authorizeReimport).not.toHaveBeenCalled();
  });

  it("closes a reviewed confirmation when the generation or epoch changes", async () => {
    await render();
    await click(
      container.querySelector<HTMLElement>(
        '[data-action="open-cloud-memory-reimport"]',
      )!,
    );
    expect(
      document.body.querySelector("[data-cloud-memory-reimport-confirmation]"),
    ).not.toBeNull();

    mocks.view.status = {
      ...mocks.view.status,
      ownerGeneration: "generation-2",
      memoryEpoch: "epoch-3",
    };
    await render();

    expect(
      document.body.querySelector("[data-cloud-memory-reimport-confirmation]"),
    ).toBeNull();
    expect(mocks.authorizeReimport).not.toHaveBeenCalled();
  });

  it("offers exact retry instead of a second authorization action after failure", async () => {
    mocks.view.phase = "error";
    mocks.view.issueCode = "unavailable";
    mocks.view.disabled = true;
    await render();

    expect(
      container.querySelector('[data-action="open-cloud-memory-reimport"]'),
    ).toBeNull();
    await click(
      container.querySelector<HTMLElement>(
        '[data-action="retry-cloud-memory-reimport"]',
      )!,
    );
    expect(mocks.retry).toHaveBeenCalledTimes(1);
    expect(mocks.authorizeReimport).not.toHaveBeenCalled();
  });
});
