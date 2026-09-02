import { authClient } from "./auth-client";
import { buildAnonymousSignInOptions } from "./auth-captcha-headers";
import { getMobileChallengeToken } from "./auth-challenge";

export const signInMobileAnonymous = async () => {
  const turnstileToken = await getMobileChallengeToken();
  return await authClient.signIn.anonymous(
    buildAnonymousSignInOptions(turnstileToken),
  );
};
