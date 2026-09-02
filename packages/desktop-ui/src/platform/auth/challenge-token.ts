import { AUTH_CAPTCHA_HEADER } from "@stella/contracts/auth-challenge";

const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js";
const TURNSTILE_SCRIPT_ID = "stella-turnstile-script";
const CHALLENGE_TIMEOUT_MS = 90_000;

type TurnstileApi = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      appearance: "interaction-only";
      theme: "auto";
      callback: (token: string) => void;
      "error-callback": () => void;
      "expired-callback": () => void;
    },
  ) => string;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<TurnstileApi> | null = null;

const loadTurnstile = async (): Promise<TurnstileApi> => {
  if (window.turnstile) return window.turnstile;
  if (scriptPromise) return await scriptPromise;

  scriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const finishLoad = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error("Human verification could not load."));
    };
    const existing = document.getElementById(TURNSTILE_SCRIPT_ID);
    if (existing) {
      existing.addEventListener("load", finishLoad, { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("Human verification could not load.")),
        { once: true },
      );
      return;
    }
    const script = document.createElement("script");
    script.id = TURNSTILE_SCRIPT_ID;
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", finishLoad, { once: true });
    script.addEventListener(
      "error",
      () => reject(new Error("Human verification could not load.")),
      { once: true },
    );
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    scriptPromise = null;
    throw error;
  });
  return await scriptPromise;
};

const getInlineChallengeToken = async (siteKey: string): Promise<string> => {
  const turnstile = await loadTurnstile();
  const layer = document.createElement("div");
  layer.setAttribute("aria-live", "polite");
  Object.assign(layer.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    display: "grid",
    placeItems: "center",
    pointerEvents: "none",
  });
  const container = document.createElement("div");
  container.style.pointerEvents = "auto";
  layer.appendChild(container);
  document.body.appendChild(layer);

  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    let widgetId: string | null = null;
    const finish = (result: { token: string } | { error: Error }) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      if (widgetId) turnstile.remove(widgetId);
      layer.remove();
      if ("token" in result) resolve(result.token);
      else reject(result.error);
    };
    const timeoutId = window.setTimeout(() => {
      finish({
        error: new Error("Human verification timed out. Please try again."),
      });
    }, CHALLENGE_TIMEOUT_MS);
    widgetId = turnstile.render(container, {
      sitekey: siteKey,
      appearance: "interaction-only",
      theme: "auto",
      callback: (token) => finish({ token }),
      "error-callback": () =>
        finish({
          error: new Error("Human verification failed. Please try again."),
        }),
      "expired-callback": () =>
        finish({
          error: new Error("Human verification expired. Please try again."),
        }),
    });
  });
};

/** Gets one fresh token from Electron main or from an inline browser widget. */
export const getPlatformChallengeToken = async (): Promise<
  string | undefined
> => {
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim();
  if (!siteKey) return undefined;
  if (window.electronAPI) {
    return await window.electronAPI.system.getChallengeToken();
  }
  return await getInlineChallengeToken(siteKey);
};

export const captchaHeaders = (
  token: string | undefined,
): Record<string, string> => (token ? { [AUTH_CAPTCHA_HEADER]: token } : {});
