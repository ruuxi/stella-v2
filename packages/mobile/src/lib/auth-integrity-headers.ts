import { APP_INTEGRITY_HEADER } from "@stella/contracts/app-integrity";

export const buildAuthIntegrityHeaders = (
  proof: string | undefined,
): Record<string, string> => {
  const normalized = proof?.trim();
  return normalized ? { [APP_INTEGRITY_HEADER]: normalized } : {};
};

export const buildAnonymousSignInOptions = (proof: string | undefined) => ({
  fetchOptions: {
    headers: buildAuthIntegrityHeaders(proof),
  },
});

export const buildMagicLinkHeaders = (proof: string | undefined) => ({
  "Content-Type": "application/json",
  ...buildAuthIntegrityHeaders(proof),
});
