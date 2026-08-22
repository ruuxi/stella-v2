// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const modalProbe = vi.hoisted(() => ({
  props: null as null | {
    provider: string;
    label?: string;
    showLabel?: boolean;
    onSubmit: (payload: { label: string; secret: string }) => Promise<void>;
  },
}));

vi.mock("@/global/integrations/CredentialModal", () => ({
  CredentialModal: (props: NonNullable<typeof modalProbe.props>) => {
    modalProbe.props = props;
    return <div data-testid="api-key-modal">API key modal</div>;
  },
}));

import { ConnectorCredentialRequestLayer } from "@/global/auth/ConnectorCredentialRequestLayer";

type RequestPayload = {
  requestId: string;
  tokenKey: string;
  displayName: string;
  mode: "api_key" | "oauth";
  completionMode?: "approve" | "wait";
  description?: string;
  oauthUserCode?: string;
  oauthVerificationUri?: string;
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("ConnectorCredentialRequestLayer", () => {
  let container: HTMLDivElement;
  let root: Root;
  let requestListener: ((_event: unknown, data: RequestPayload) => void) | null;
  let completeListener:
    | ((
        _event: unknown,
        data: { requestId: string; ok: boolean; reason?: string },
      ) => void)
    | null;
  let unsubscribeRequest: ReturnType<typeof vi.fn>;
  let unsubscribeComplete: ReturnType<typeof vi.fn>;
  let submitConnectorCredential: ReturnType<typeof vi.fn>;
  let cancelConnectorCredential: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    requestListener = null;
    completeListener = null;
    unsubscribeRequest = vi.fn();
    unsubscribeComplete = vi.fn();
    submitConnectorCredential = vi.fn().mockResolvedValue({ ok: true });
    cancelConnectorCredential = vi.fn().mockResolvedValue({ ok: true });
    modalProbe.props = null;
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        system: {
          onConnectorCredentialRequest: vi.fn((listener) => {
            requestListener = listener;
            return unsubscribeRequest;
          }),
          onConnectorCredentialComplete: vi.fn((listener) => {
            completeListener = listener;
            return unsubscribeComplete;
          }),
          submitConnectorCredential,
          cancelConnectorCredential,
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
    Reflect.deleteProperty(window, "electronAPI");
  });

  const renderLayer = async () => {
    await act(async () => {
      root.render(<ConnectorCredentialRequestLayer />);
      await Promise.resolve();
    });
  };

  const sendRequest = async (request: RequestPayload) => {
    await act(async () => requestListener?.(undefined, request));
  };

  const clickButton = async (label: string) => {
    const button = [...document.body.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === label,
    );
    expect(button).toBeDefined();
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
  };

  it("opens first-party OAuth approval, waits for completion, and unsubscribes", async () => {
    await renderLayer();
    await sendRequest({
      requestId: "google-request",
      tokenKey: "googlesuper",
      displayName: "Google Workspace",
      mode: "oauth",
      completionMode: "wait",
    });

    expect(document.body.textContent).toContain("Connect Google Workspace");
    expect(document.body.textContent).not.toContain("googlesuper");
    await clickButton("Open browser");
    expect(submitConnectorCredential).toHaveBeenCalledWith({
      requestId: "google-request",
      value: "open",
      label: "Google Workspace",
    });
    expect(document.body.textContent).toContain("Waiting for Google Workspace");

    await act(async () =>
      completeListener?.(undefined, { requestId: "google-request", ok: true }),
    );
    expect(document.body.textContent).not.toContain("Google Workspace");

    await act(async () => root.unmount());
    expect(unsubscribeRequest).toHaveBeenCalledOnce();
    expect(unsubscribeComplete).toHaveBeenCalledOnce();
    root = createRoot(container);
  });

  it("shows device codes without rendering the verification URL and surfaces failures", async () => {
    await renderLayer();
    await sendRequest({
      requestId: "device-request",
      tokenKey: "device-provider",
      displayName: "Device Provider",
      mode: "oauth",
      completionMode: "wait",
      oauthUserCode: "ABCD-EFGH",
      oauthVerificationUri: "https://example.com/device?user_code=ABCD-EFGH",
    });

    expect(document.body.textContent).toContain("ABCD-EFGH");
    expect(document.body.textContent).not.toContain("https://example.com");
    await clickButton("Open browser");
    await act(async () =>
      completeListener?.(undefined, {
        requestId: "device-request",
        ok: false,
        reason: "Authorization was declined.",
      }),
    );

    expect(document.body.textContent).toContain("Couldn't connect Device Provider");
    expect(document.body.textContent).toContain(
      "The connection could not be completed.",
    );
    expect(document.body.textContent).not.toContain("Authorization was declined.");
    await clickButton("Close");
    expect(document.body.textContent).not.toContain("Device Provider");
    expect(cancelConnectorCredential).not.toHaveBeenCalled();
  });

  it("cancels an OAuth request through the existing preload contract", async () => {
    await renderLayer();
    await sendRequest({
      requestId: "cancel-request",
      tokenKey: "google-workspace",
      displayName: "Google Workspace",
      mode: "oauth",
    });

    await clickButton("Cancel");
    expect(cancelConnectorCredential).toHaveBeenCalledWith({
      requestId: "cancel-request",
    });
    expect(document.body.textContent).not.toContain("Google Workspace");
  });

  it("cancels while waiting and advances to the next queued authorization", async () => {
    await renderLayer();
    await sendRequest({
      requestId: "google-request",
      tokenKey: "google-workspace",
      displayName: "Google Workspace",
      mode: "oauth",
      completionMode: "wait",
    });
    await sendRequest({
      requestId: "outlook-request",
      tokenKey: "outlook",
      displayName: "Outlook",
      mode: "oauth",
      completionMode: "wait",
    });

    await clickButton("Open browser");
    expect(document.body.textContent).toContain("Waiting for Google Workspace");
    expect(document.body.textContent).not.toContain("Outlook");

    await clickButton("Cancel");
    expect(cancelConnectorCredential).toHaveBeenCalledWith({
      requestId: "google-request",
    });
    expect(document.body.textContent).not.toContain("Waiting for Google Workspace");
    expect(document.body.textContent).toContain("Connect Outlook");
  });

  it("submits API keys directly through ConnectorCredentialService", async () => {
    await renderLayer();
    await sendRequest({
      requestId: "api-key-request",
      tokenKey: "example-token-key",
      displayName: "Example Connector",
      mode: "api_key",
    });

    expect(document.body.textContent).toContain("API key modal");
    expect(modalProbe.props).toMatchObject({
      provider: "example-token-key",
      label: "Example Connector",
      showLabel: false,
    });
    await act(async () => {
      await modalProbe.props?.onSubmit({
        label: "Example Connector",
        secret: "test-api-key",
      });
    });

    expect(submitConnectorCredential).toHaveBeenCalledWith({
      requestId: "api-key-request",
      value: "test-api-key",
      label: "Example Connector",
    });
    expect(document.body.textContent).not.toContain("API key modal");
  });
});
