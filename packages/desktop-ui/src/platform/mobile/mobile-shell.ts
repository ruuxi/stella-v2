type MobileShellConfig = {
  token?: string;
  platform?: "ios" | "android" | string;
};

type NativeResponse = {
  type?: string;
  requestId?: string;
  result?: { token?: string };
  error?: string;
};

declare global {
  interface Window {
    __STELLA_MOBILE_SHELL__?: MobileShellConfig;
    ReactNativeWebView?: {
      postMessage(value: string): void;
    };
  }
}

export const getInjectedMobileConvexToken = (): string | null => {
  const token = window.__STELLA_MOBILE_SHELL__?.token?.trim();
  return token || null;
};

export const isMobileShell = (): boolean =>
  Boolean(window.__STELLA_MOBILE_SHELL__);

export const requestMobileConvexToken = async (): Promise<string | null> => {
  const bridge = window.ReactNativeWebView;
  if (!bridge) return getInjectedMobileConvexToken();
  const requestId = `mobile-token-${
    crypto.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }`;
  return await new Promise<string | null>((resolve) => {
    const removeListeners = () => {
      window.removeEventListener("message", onMessage);
      document.removeEventListener("message", onMessage as EventListener);
    };
    const timeout = window.setTimeout(() => {
      removeListeners();
      resolve(getInjectedMobileConvexToken());
    }, 10_000);
    const onMessage = (event: MessageEvent) => {
      let response: NativeResponse;
      try {
        response =
          typeof event.data === "string"
            ? (JSON.parse(event.data) as NativeResponse)
            : (event.data as NativeResponse);
      } catch {
        return;
      }
      if (
        response.type !== "stella:native-response" ||
        response.requestId !== requestId
      ) {
        return;
      }
      window.clearTimeout(timeout);
      removeListeners();
      const token = response.result?.token?.trim() || null;
      if (token) {
        window.__STELLA_MOBILE_SHELL__ = {
          ...window.__STELLA_MOBILE_SHELL__,
          token,
        };
      }
      resolve(token);
    };
    window.addEventListener("message", onMessage);
    document.addEventListener("message", onMessage as EventListener);
    bridge.postMessage(JSON.stringify({ type: "getConvexToken", requestId }));
  });
};

export const speakCarPlayReply = (message: string): void => {
  window.ReactNativeWebView?.postMessage(
    JSON.stringify({
      type: "carplaySpeak",
      payload: { message },
    }),
  );
};
