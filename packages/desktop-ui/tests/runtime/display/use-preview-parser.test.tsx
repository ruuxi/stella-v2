// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  usePreviewParser,
  PREVIEW_WORKER_IDLE_MS,
  __testing,
} from "@/shell/display/use-preview-parser";
import { withI18n } from "../../helpers/i18n";
import type {
  PreviewRequest,
  PreviewResult,
} from "@/shell/display/preview-parser";

type Posted = { id: number; request?: PreviewRequest; cancel?: true };

class FakeWorker {
  static instances: FakeWorker[] = [];
  posted: Posted[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(message: Posted) {
    if (this.terminated) throw new Error("worker terminated");
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  respond(id: number, payload: { result?: PreviewResult; error?: string }) {
    this.onmessage?.({ data: { id, ...payload } } as MessageEvent<unknown>);
  }
}

const request = (text: string): PreviewRequest => ({
  kind: "table",
  bytes: new TextEncoder().encode(text),
  delimiter: ",",
  truncated: false,
});
const resultFor = (cell: string): PreviewResult => ({
  rows: [[cell]],
  lines: [],
  limited: false,
});

let container: HTMLDivElement;
let root: Root;
let latest: ReturnType<typeof usePreviewParser>;

function Probe({ request }: { request: PreviewRequest | null }) {
  latest = usePreviewParser(request);
  return null;
}

function render(next: PreviewRequest | null) {
  act(() => {
    root.render(withI18n(<Probe request={next} />));
  });
}

describe("usePreviewParser shared worker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWorker.instances = [];
    (globalThis as { Worker?: unknown }).Worker = FakeWorker;
    __testing.reset();
    latest = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    __testing.reset();
    delete (globalThis as { Worker?: unknown }).Worker;
    vi.useRealTimers();
  });

  it("reuses one worker across requests and resolves by request id", () => {
    const first = request("a");
    render(first);
    const second = request("b");
    render(second);
    expect(FakeWorker.instances).toHaveLength(1);
    const worker = FakeWorker.instances[0];
    const ids = worker.posted
      .filter((message) => message.request)
      .map((message) => message.id);
    expect(ids).toHaveLength(2);
    act(() => worker.respond(ids[1], { result: resultFor("b") }));
    expect(latest?.request).toBe(second);
    expect(latest?.result).toEqual(resultFor("b"));
  });

  it("ignores a stale response after the input changes", () => {
    const first = request("a");
    render(first);
    const worker = FakeWorker.instances[0];
    const staleId = worker.posted[0].id;
    const second = request("b");
    render(second);
    expect(worker.posted.some((message) => message.cancel)).toBe(true);
    act(() => worker.respond(staleId, { result: resultFor("a") }));
    expect(latest).toBeNull();
    const liveId = worker.posted.filter((m) => m.request)[1].id;
    act(() => worker.respond(liveId, { result: resultFor("b") }));
    expect(latest?.result).toEqual(resultFor("b"));
  });

  it("drops responses that arrive after unmount", () => {
    render(request("a"));
    const worker = FakeWorker.instances[0];
    const id = worker.posted[0].id;
    render(null);
    act(() => worker.respond(id, { result: resultFor("a") }));
    expect(latest).toBeNull();
  });

  it("recovers by rebooting the worker after a crash", () => {
    render(request("a"));
    const crashed = FakeWorker.instances[0];
    act(() => crashed.onerror?.(new Event("error")));
    expect(crashed.terminated).toBe(true);
    expect(latest?.error).toBe("Unable to prepare this preview.");
    render(request("b"));
    expect(FakeWorker.instances).toHaveLength(2);
    const fresh = FakeWorker.instances[1];
    act(() => fresh.respond(fresh.posted[0].id, { result: resultFor("b") }));
    expect(latest?.result).toEqual(resultFor("b"));
  });

  it("terminates the worker only after the idle timeout", () => {
    const first = request("a");
    render(first);
    const worker = FakeWorker.instances[0];
    act(() => {
      vi.advanceTimersByTime(PREVIEW_WORKER_IDLE_MS * 2);
    });
    expect(worker.terminated).toBe(false);
    act(() => worker.respond(worker.posted[0].id, { result: resultFor("a") }));
    act(() => {
      vi.advanceTimersByTime(PREVIEW_WORKER_IDLE_MS - 1);
    });
    expect(worker.terminated).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(worker.terminated).toBe(true);
    render(request("c"));
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it("falls back to an error state when Worker is unavailable", () => {
    delete (globalThis as { Worker?: unknown }).Worker;
    render(request("a"));
    expect(latest?.error).toBeTruthy();
  });
});
