import type { BetterFetch } from "@better-fetch/fetch";

export const verifyOneTimeToken = async (
  authFetch: BetterFetch,
  token: string,
): Promise<void> => {
  await authFetch("/one-time-token/verify", {
    method: "POST",
    body: { token },
  });
};
