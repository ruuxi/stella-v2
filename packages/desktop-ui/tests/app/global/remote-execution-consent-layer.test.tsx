// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RemoteExecutionConsentLayer } from "@/global/execution/RemoteExecutionConsentLayer";
import { LocalI18nProvider } from "@/shared/i18n";

type ConsentRequest = { requestedAt: number; requesterLabel?: string };

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("RemoteExecutionConsentLayer", () => {
  let container: HTMLDivElement;
  let root: Root;
  let raise: ((request: ConsentRequest) => void) | null;
  let unsubscribed: number;
  const answer = vi.fn<(allow: boolean) => Promise<{ allow: boolean }>>();

  const button = (action: "allow" | "decline") =>
    document.body.querySelector<HTMLButtonElement>(
      `[data-consent-action="${action}"]`,
    );

  const ask = async (request: ConsentRequest) => {
    await act(async () => raise?.(request));
    await flush();
  };

  beforeEach(async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    answer.mockResolvedValue({ allow: true });
    raise = null;
    unsubscribed = 0;
    (
      window as unknown as { electronAPI?: Record<string, unknown> }
    ).electronAPI = {
      remoteExecution: {
        onRequest: (callback: (request: ConsentRequest) => void) => {
          raise = callback;
          return () => {
            unsubscribed += 1;
          };
        },
        answer,
      },
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <LocalI18nProvider>
          <RemoteExecutionConsentLayer />
        </LocalI18nProvider>,
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it("asks nothing until this computer is actually asked", () => {
    expect(button("allow")).toBeNull();
    expect(answer).not.toHaveBeenCalled();
  });

  it("raises the question on the event and allows over the invoke", async () => {
    await ask({ requestedAt: 1_700_000, requesterLabel: "Studio iMac" });

    expect(document.body.textContent).toContain(
      "Allow work from your other devices?",
    );
    expect(document.body.textContent).toContain("Studio iMac");

    await act(async () => button("allow")?.click());
    await flush();

    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer).toHaveBeenCalledWith(true);
    expect(button("allow")).toBeNull();
  });

  it("records a refusal instead of only closing the prompt", async () => {
    await ask({ requestedAt: 1_700_001 });

    expect(document.body.textContent).toContain(
      "Another of your devices asked to run work on this computer.",
    );

    await act(async () => button("decline")?.click());
    await flush();

    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer).toHaveBeenCalledWith(false);
    expect(button("decline")).toBeNull();
  });

  it("keeps the prompt up when the answer could not be delivered", async () => {
    answer.mockRejectedValueOnce(new Error("runtime is not running"));
    await ask({ requestedAt: 1_700_002 });

    await act(async () => button("allow")?.click());
    await flush();

    expect(document.body.textContent).toContain(
      "That answer didn't go through.",
    );
    expect(button("allow")).not.toBeNull();
  });

  it("drops its subscription with the layer", async () => {
    await act(async () => root.unmount());
    expect(unsubscribed).toBe(1);
    root = createRoot(container);
  });
});
