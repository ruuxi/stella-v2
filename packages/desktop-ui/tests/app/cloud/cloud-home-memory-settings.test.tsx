// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  CloudMemoryDocument,
  CloudMemorySnapshot,
} from "@stella/contracts/cloud-home-sync";
import type { CloudMemoryWipeStatus } from "@/features/cloud/cloud-home-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  identity: {
    accountScope: "account:owner-a",
    identityRevision: 7,
    expectedSubject: "https://stella.example|owner-a",
  } as {
    accountScope: string;
    identityRevision: number;
    expectedSubject: string;
  } | null,
  available: true,
  loading: false,
  unavailable: false,
  lifecycle: {
    subject: "https://stella.example|owner-a",
    ownerGeneration: "generation-1",
    state: "open",
    memoryEpoch: "memory-epoch-1",
    importDisposition: "automatic_allowed",
    job: null,
  } as CloudMemoryWipeStatus | null,
  listMemory: vi.fn(),
  writeMemory: vi.fn(),
  beginMemoryExport: vi.fn(),
  commitMemoryExport: vi.fn(),
  cancelMemoryExport: vi.fn(),
  translate: (key: string) => key,
}));

vi.mock("@/features/cloud/use-cloud-home-memory", () => ({
  useCloudHomeMemory: () => ({
    identity: mocks.identity,
    lifecycle: mocks.lifecycle,
    available: mocks.available,
    loading: mocks.loading,
    unavailable: mocks.unavailable,
    listMemory: mocks.listMemory,
    writeMemory: mocks.writeMemory,
  }),
}));

vi.mock("@/shared/i18n", () => ({
  useT: () => mocks.translate,
}));

import { CloudHomeMemorySettings } from "@/features/cloud/CloudHomeMemorySettings";

const memoryDocument = (
  overrides: Partial<CloudMemoryDocument> = {},
): CloudMemoryDocument => ({
  documentId: "memory-1",
  name: "MEMORY.md",
  displayPath: "~/.stella/memories/MEMORY.md",
  kind: "memory",
  source: "cloud",
  revision: 3,
  sizeBytes: 12,
  updatedAt: 1,
  content: "cloud base\n",
  ...overrides,
});

const snapshot = (
  document: CloudMemoryDocument = memoryDocument(),
): CloudMemorySnapshot => ({
  ownerGeneration: "generation-1",
  memoryEpoch: "memory-epoch-1",
  importDisposition: "automatic_allowed",
  documents: [document],
});

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

const replaceTextarea = async (
  textarea: HTMLTextAreaElement,
  value: string,
) => {
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    valueSetter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("CloudHomeMemorySettings", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = async () => {
    await act(async () => root.render(<CloudHomeMemorySettings />));
    await flush();
  };

  const openMemory = async () => {
    const button = container.querySelector<HTMLButtonElement>(
      '[aria-label="mobile.cloudHome.list.openDocumentLabel"]',
    );
    expect(button).not.toBeNull();
    await click(button!);
    const textarea =
      document.body.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();
    return textarea!;
  };

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    mocks.identity = {
      accountScope: "account:owner-a",
      identityRevision: 7,
      expectedSubject: "https://stella.example|owner-a",
    };
    mocks.available = true;
    mocks.loading = false;
    mocks.unavailable = false;
    mocks.listMemory.mockReset();
    mocks.writeMemory.mockReset();
    mocks.lifecycle = {
      subject: "https://stella.example|owner-a",
      ownerGeneration: "generation-1",
      state: "open",
      memoryEpoch: "memory-epoch-1",
      importDisposition: "automatic_allowed",
      job: null,
    };
    mocks.beginMemoryExport.mockReset();
    mocks.commitMemoryExport.mockReset();
    mocks.cancelMemoryExport.mockReset();
    mocks.listMemory.mockResolvedValue(snapshot());
    mocks.beginMemoryExport.mockResolvedValue({
      ok: true,
      exportId: "export-1",
    });
    mocks.commitMemoryExport.mockResolvedValue({ ok: true });
    mocks.cancelMemoryExport.mockResolvedValue({ ok: true });
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        cloudHome: {
          beginMemoryExport: mocks.beginMemoryExport,
          commitMemoryExport: mocks.commitMemoryExport,
          cancelMemoryExport: mocks.cancelMemoryExport,
        },
      },
    });
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

  it("keeps cloud documents browsable independently of the Memory context preference", async () => {
    await render();

    expect(container.textContent).toContain(
      "mobile.cloudHome.settingsRowTitle",
    );
    expect(container.textContent).toContain("MEMORY.md");
    const textarea = await openMemory();
    expect(textarea.value).toBe("cloud base\n");
  });

  it("preserves a draft on conflict until reload-latest is explicitly chosen", async () => {
    const latest = memoryDocument({
      revision: 4,
      sizeBytes: 13,
      content: "cloud latest\n",
    });
    mocks.listMemory
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot(latest));
    mocks.writeMemory.mockResolvedValue({
      status: "conflict",
      document: latest,
    });
    await render();
    const textarea = await openMemory();
    await replaceTextarea(textarea, "private draft\n");

    const save = document.body.querySelector<HTMLButtonElement>(
      '[data-action="save-cloud-memory"]',
    );
    expect(save?.disabled).toBe(false);
    await click(save!);

    expect(mocks.writeMemory).toHaveBeenCalledWith({
      ownerGeneration: "generation-1",
      memoryEpoch: "memory-epoch-1",
      document: memoryDocument(),
      content: "private draft\n",
    });

    expect(textarea.value).toBe("private draft\n");
    expect(document.body.textContent).toContain(
      "mobile.cloudHome.conflict.title",
    );
    const reload = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button"),
    ).find(
      (button) =>
        button.textContent?.trim() === "mobile.cloudHome.conflict.reload",
    );
    expect(reload).toBeDefined();
    await click(reload!);

    expect(textarea.value).toBe("cloud latest\n");
    expect(document.body.textContent).toContain(
      "mobile.cloudHome.notices.loadedLatest",
    );
  });

  it("selects a native destination, re-reads authority, then commits the visible draft", async () => {
    await render();
    const textarea = await openMemory();
    await replaceTextarea(textarea, "recover this draft\n");

    const download = document.body.querySelector<HTMLButtonElement>(
      '[data-action="download-cloud-memory"]',
    );
    expect(download).not.toBeNull();
    await click(download!);

    expect(mocks.beginMemoryExport).toHaveBeenCalledTimes(1);
    expect(mocks.beginMemoryExport).toHaveBeenCalledWith({
      suggestedName: "MEMORY.md",
      expectedSubject: "https://stella.example|owner-a",
      ownerGeneration: "generation-1",
      memoryEpoch: "memory-epoch-1",
      lifecycleState: "open",
    });
    expect(mocks.commitMemoryExport).toHaveBeenCalledWith({
      exportId: "export-1",
      content: "recover this draft\n",
      expectedSubject: "https://stella.example|owner-a",
      ownerGeneration: "generation-1",
      memoryEpoch: "memory-epoch-1",
      lifecycleState: "open",
    });
    // Initial list, open, and the mandatory post-picker authoritative re-read.
    expect(mocks.listMemory).toHaveBeenCalledTimes(3);
  });

  it("clears the open editor and cancels the picker on a same-session wipe", async () => {
    let resolvePicker!: (value: { ok: true; exportId: string }) => void;
    mocks.beginMemoryExport.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePicker = resolve;
      }),
    );
    await render();
    const textarea = await openMemory();
    await replaceTextarea(textarea, "must not survive wipe\n");
    const download = document.body.querySelector<HTMLButtonElement>(
      '[data-action="download-cloud-memory"]',
    );
    await click(download!);

    mocks.lifecycle = {
      subject: "https://stella.example|owner-a",
      ownerGeneration: "generation-1",
      state: "wiping",
      memoryEpoch: "memory-epoch-2",
      importDisposition: "explicit_required",
      job: {
        operationId: "wipe-1",
        stage: "sweeping",
        attempts: 1,
        nextRetryAt: 0,
        objectsDeleted: 0,
        rowsDeleted: 0,
        updatedAt: 2,
      },
    };
    await act(async () => root.render(<CloudHomeMemorySettings />));
    await flush();

    expect(document.body.querySelector("textarea")).toBeNull();
    expect(container.textContent).not.toContain("MEMORY.md");
    resolvePicker({ ok: true, exportId: "pre-wipe-picker" });
    await flush();
    expect(mocks.cancelMemoryExport).toHaveBeenCalledWith("pre-wipe-picker");
    expect(mocks.commitMemoryExport).not.toHaveBeenCalled();
  });

  it("closes stale content and rehydrates after an open-to-open epoch rotation", async () => {
    const freshDocument = memoryDocument({
      documentId: "fresh-memory",
      name: "memories/fresh.md",
      displayPath: "~/.stella/memories/fresh.md",
      kind: "user_markdown",
      content: "fresh epoch\n",
      sizeBytes: 12,
    });
    mocks.listMemory
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce({
        ...snapshot(freshDocument),
        ownerGeneration: "generation-2",
        memoryEpoch: "memory-epoch-2",
      });
    await render();
    await openMemory();

    mocks.lifecycle = {
      subject: "https://stella.example|owner-a",
      ownerGeneration: "generation-2",
      state: "open",
      memoryEpoch: "memory-epoch-2",
      importDisposition: "explicit_required",
      job: null,
    };
    await act(async () => root.render(<CloudHomeMemorySettings />));
    await flush();

    expect(document.body.querySelector("textarea")).toBeNull();
    expect(container.textContent).not.toContain("MEMORY.md");
    expect(container.textContent).toContain("memories/fresh.md");
    expect(mocks.listMemory).toHaveBeenCalledTimes(3);
  });

  it("refuses to commit when the authoritative post-picker GET has rotated epochs", async () => {
    mocks.listMemory
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce({
        ...snapshot(),
        memoryEpoch: "memory-epoch-2",
        documents: [],
      });
    await render();
    await openMemory();
    const download = document.body.querySelector<HTMLButtonElement>(
      '[data-action="download-cloud-memory"]',
    );
    await click(download!);

    expect(mocks.cancelMemoryExport).toHaveBeenCalledWith("export-1");
    expect(mocks.commitMemoryExport).not.toHaveBeenCalled();
    expect(document.body.querySelector("textarea")).toBeNull();
  });

  it("drops a late document result after the account identity changes", async () => {
    let resolveOwnerA!: (value: CloudMemorySnapshot) => void;
    const ownerA = new Promise<CloudMemorySnapshot>((resolve) => {
      resolveOwnerA = resolve;
    });
    mocks.listMemory.mockReturnValueOnce(ownerA).mockResolvedValueOnce(
      snapshot(
        memoryDocument({
          documentId: "memory-b",
          name: "memories/profile.md",
          displayPath: "~/.stella/memories/profile.md",
          kind: "profile",
          content: "owner b\n",
          sizeBytes: 8,
        }),
      ),
    );
    await render();

    mocks.identity = {
      accountScope: "account:owner-b",
      identityRevision: 8,
      expectedSubject: "https://stella.example|owner-b",
    };
    mocks.lifecycle = {
      subject: "https://stella.example|owner-b",
      ownerGeneration: "generation-1",
      state: "open",
      memoryEpoch: "memory-epoch-1",
      importDisposition: "automatic_allowed",
      job: null,
    };
    await act(async () => root.render(<CloudHomeMemorySettings />));
    await flush();
    expect(container.textContent).toContain("memories/profile.md");

    resolveOwnerA(snapshot(memoryDocument()));
    await flush();
    expect(container.textContent).not.toContain("MEMORY.md");
    expect(container.textContent).toContain("memories/profile.md");
  });

  it("cancels a picked destination without committing after the account identity changes", async () => {
    let resolvePicker!: (value: { ok: true; exportId: string }) => void;
    mocks.beginMemoryExport.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePicker = resolve;
      }),
    );
    mocks.listMemory
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(
        snapshot(
          memoryDocument({
            documentId: "memory-b",
            name: "memories/profile.md",
            displayPath: "~/.stella/memories/profile.md",
            kind: "profile",
            content: "owner b\n",
            sizeBytes: 8,
          }),
        ),
      );
    await render();
    await openMemory();
    const download = document.body.querySelector<HTMLButtonElement>(
      '[data-action="download-cloud-memory"]',
    );
    await click(download!);

    mocks.identity = {
      accountScope: "account:owner-b",
      identityRevision: 8,
      expectedSubject: "https://stella.example|owner-b",
    };
    mocks.lifecycle = {
      subject: "https://stella.example|owner-b",
      ownerGeneration: "generation-1",
      state: "open",
      memoryEpoch: "memory-epoch-1",
      importDisposition: "automatic_allowed",
      job: null,
    };
    await act(async () => root.render(<CloudHomeMemorySettings />));
    await flush();
    resolvePicker({ ok: true, exportId: "picked-owner-a" });
    await flush();

    expect(mocks.cancelMemoryExport).toHaveBeenCalledWith("picked-owner-a");
    expect(mocks.commitMemoryExport).not.toHaveBeenCalled();
    expect(container.textContent).toContain("memories/profile.md");
    expect(container.textContent).not.toContain(
      "mobile.cloudHome.errors.unavailable",
    );
  });
});
