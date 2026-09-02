import { AUTH_CAPTCHA_HEADER } from "@stella/contracts/auth-challenge";

export const buildAuthCaptchaHeaders = (
  token: string | undefined,
): Record<string, string> => {
  const normalized = token?.trim();
  return normalized ? { [AUTH_CAPTCHA_HEADER]: normalized } : {};
};

export const buildAnonymousSignInOptions = (token: string | undefined) => ({
  fetchOptions: {
    headers: buildAuthCaptchaHeaders(token),
  },
});

export const buildMagicLinkHeaders = (token: string | undefined) => ({
  "Content-Type": "application/json",
  ...buildAuthCaptchaHeaders(token),
});
