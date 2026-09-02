"use client";

import {
  AUTH_CAPTCHA_HEADER,
  AUTH_CHALLENGE_PAGE_PATH,
  AUTH_CHALLENGE_STATE_PARAM,
} from "@stella/contracts/auth-challenge";

const TURNSTILE_SITE_KEY =
  process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() ?? "";
const CHALLENGE_TIMEOUT_MS = 90_000;

type TurnstileMessage = {
  type: "stella-turnstile";
  token: string;
  state: string;
};

const readTurnstileMessage = (value: unknown): TurnstileMessage | null => {
  if (!value || typeof value !== "object") return null;
  if (!("type" in value) || value.type !== "stella-turnstile") return null;
  if (!("token" in value) || typeof value.token !== "string") return null;
  if (!("state" in value) || typeof value.state !== "string") return null;
  const token = value.token.trim();
  const state = value.state.trim();
  if (!token || token.length > 4096 || !state) return null;
  return { type: "stella-turnstile", token, state };
};

/** Opens the public challenge route and accepts one state-bound token. */
export const getWebsiteChallengeToken = async (): Promise<
  string | undefined
> => {
  if (!TURNSTILE_SITE_KEY) return undefined;

  const state = crypto.randomUUID();
  const challengeUrl = new URL(
    AUTH_CHALLENGE_PAGE_PATH,
    window.location.origin,
  );
  challengeUrl.searchParams.set("client", "web");
  challengeUrl.searchParams.set(AUTH_CHALLENGE_STATE_PARAM, state);

  const popup = window.open(
    challengeUrl,
    "stella-turnstile",
    "popup,width=440,height=560,resizable=yes,scrollbars=yes",
  );
  if (!popup) {
    throw new Error("Allow the verification window, then try again.");
  }

  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (result: { token: string } | { error: Error }) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timeoutId);
      window.clearInterval(closedPollId);
      if (!popup.closed) popup.close();
      if ("token" in result) resolve(result.token);
      else reject(result.error);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== popup) {
        return;
      }
      const message = readTurnstileMessage(event.data);
      if (!message || message.state !== state) return;
      finish({ token: message.token });
    };
    const timeoutId = window.setTimeout(() => {
      finish({
        error: new Error("Human verification timed out. Please try again."),
      });
    }, CHALLENGE_TIMEOUT_MS);
    const closedPollId = window.setInterval(() => {
      if (popup.closed) {
        finish({
          error: new Error("Human verification was closed before it finished."),
        });
      }
    }, 250);
    window.addEventListener("message", onMessage);
  });
};

export const turnstileHeader = (token: string | undefined) =>
  token ? { [AUTH_CAPTCHA_HEADER]: token } : undefined;
