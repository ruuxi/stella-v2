import * as Crypto from "expo-crypto";
import * as WebBrowser from "expo-web-browser";
import {
  AUTH_CHALLENGE_DEEP_LINK_HOST,
  AUTH_CHALLENGE_PAGE_PATH,
  AUTH_CHALLENGE_STATE_PARAM,
  AUTH_CHALLENGE_TOKEN_PARAM,
} from "@stella/contracts/auth-challenge";
import { env } from "../config/env";

const MOBILE_CHALLENGE_SCHEME = "stella-mobile";
const TOKEN_MAX_LENGTH = 4096;

/** Opens Stella's hosted challenge and validates its state-bound deep link. */
export const getMobileChallengeToken = async (): Promise<
  string | undefined
> => {
  if (!process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY?.trim()) return undefined;

  const state = Crypto.randomUUID();
  const challengeUrl = new URL(AUTH_CHALLENGE_PAGE_PATH, env.siteUrl);
  challengeUrl.searchParams.set("client", "mobile");
  challengeUrl.searchParams.set(AUTH_CHALLENGE_STATE_PARAM, state);
  const redirectUrl = `${MOBILE_CHALLENGE_SCHEME}://${AUTH_CHALLENGE_DEEP_LINK_HOST}`;
  const result = await WebBrowser.openAuthSessionAsync(
    challengeUrl.toString(),
    redirectUrl,
  );
  if (result.type !== "success") {
    throw new Error("Human verification was canceled.");
  }

  const callback = new URL(result.url);
  const states = callback.searchParams.getAll(AUTH_CHALLENGE_STATE_PARAM);
  const tokens = callback.searchParams.getAll(AUTH_CHALLENGE_TOKEN_PARAM);
  const token = tokens[0]?.trim() ?? "";
  if (
    callback.protocol !== `${MOBILE_CHALLENGE_SCHEME}:` ||
    callback.hostname !== AUTH_CHALLENGE_DEEP_LINK_HOST ||
    states.length !== 1 ||
    states[0] !== state ||
    tokens.length !== 1 ||
    !token ||
    token.length > TOKEN_MAX_LENGTH
  ) {
    throw new Error("Human verification returned an invalid response.");
  }
  return token;
};
