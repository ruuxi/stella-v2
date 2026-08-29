import type { BetterFetch } from "@better-fetch/fetch";

/** Exchange a short-lived callback token through Better Auth's native plugin. */
export const verifyOneTimeToken = async (
  authFetch: BetterFetch,
  token: string,
): Promise<void> => {
  await authFetch("/one-time-token/verify", {
    method: "POST",
    body: { token },
  });
};
