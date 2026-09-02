"use client";

import { useEffect, useRef, useState } from "react";
import {
  AUTH_CHALLENGE_DEEP_LINK_HOST,
  AUTH_CHALLENGE_STATE_PARAM,
  AUTH_CHALLENGE_TOKEN_PARAM,
  type AuthChallengeClient,
} from "@stella/contracts/auth-challenge";
import styles from "./challenge.module.css";

const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js";
const TURNSTILE_SCRIPT_ID = "stella-turnstile-script";
const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() ?? "";
const PROTOCOL_PATTERN = /^[a-z][a-z0-9+.-]{2,32}$/;

type TurnstileApi = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      appearance: "interaction-only";
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
  }).catch((cause: unknown) => {
    scriptPromise = null;
    throw cause;
  });
  return await scriptPromise;
};

const readClient = (value: string | null): AuthChallengeClient | null => {
  if (value === "desktop" || value === "web") {
    return value;
  }
  return null;
};

const handTokenBack = (args: {
  client: AuthChallengeClient;
  protocol: string | null;
  state: string;
  token: string;
}) => {
  if (args.client === "web") {
    // Same-origin openers only: a third-party page that opened this route
    // must never receive a token minted for Stella's site key.
    window.opener?.postMessage(
      { type: "stella-turnstile", token: args.token, state: args.state },
      window.location.origin,
    );
    window.setTimeout(() => window.close(), 100);
    return;
  }

  if (!args.protocol || !PROTOCOL_PATTERN.test(args.protocol)) {
    throw new Error("The desktop callback protocol is invalid.");
  }
  const query = new URLSearchParams({
    [AUTH_CHALLENGE_TOKEN_PARAM]: args.token,
    [AUTH_CHALLENGE_STATE_PARAM]: args.state,
  });
  window.location.href = `${args.protocol}://${AUTH_CHALLENGE_DEEP_LINK_HOST}?${query.toString()}`;
};

export default function ChallengePage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let widget: { api: TurnstileApi; id: string } | null = null;
    const startChallenge = async () => {
      await Promise.resolve();
      if (cancelled) return;
      const query = new URLSearchParams(window.location.search);
      const client = readClient(query.get("client"));
      const protocol = query.get("protocol")?.trim().toLowerCase() ?? null;
      const state = query.get(AUTH_CHALLENGE_STATE_PARAM)?.trim() ?? "";
      if (
        !client ||
        !state ||
        state.length > 128 ||
        (client === "desktop" &&
          (!protocol || !PROTOCOL_PATTERN.test(protocol)))
      ) {
        setError("This verification link is invalid.");
        return;
      }
      if (!SITE_KEY) {
        setError("Human verification is not configured for this build.");
        return;
      }

      try {
        const turnstile = await loadTurnstile();
        if (cancelled || !containerRef.current) return;
        const widgetId = turnstile.render(containerRef.current, {
          sitekey: SITE_KEY,
          appearance: "interaction-only",
          callback: (token) => {
            if (cancelled) return;
            try {
              handTokenBack({ client, protocol, state, token });
            } catch (cause) {
              setError(
                cause instanceof Error
                  ? cause.message
                  : "Human verification could not finish.",
              );
            }
          },
          "error-callback": () => {
            if (!cancelled)
              setError("Human verification failed. Please retry.");
          },
          "expired-callback": () => {
            if (!cancelled) setError("Verification expired. Please retry.");
          },
        });
        widget = { api: turnstile, id: widgetId };
      } catch (cause) {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Human verification could not load.",
          );
        }
      }
    };
    void startChallenge();
    return () => {
      cancelled = true;
      if (widget) widget.api.remove(widget.id);
    };
  }, []);

  return (
    <main className={styles.page}>
      <section className={styles.card}>
        <h1>One quick check</h1>
        <p>{error ?? "Stella is checking that you're human."}</p>
        <div ref={containerRef} className={styles.widget} />
      </section>
    </main>
  );
}
