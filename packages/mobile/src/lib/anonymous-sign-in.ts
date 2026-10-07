import { authClient } from "./auth-client";
import { buildAnonymousSignInOptions } from "./auth-integrity-headers";
import { createAnonymousSessionStarter } from "./anonymous-session";
import {
  isIntegrityKeyUnknown,
  requestWithAppIntegrity,
} from "./app-integrity";

export const signInMobileAnonymous = createAnonymousSessionStarter({
  getSession: async () => await authClient.getSession(),
  createSession: async () => await requestWithAppIntegrity({
    purpose: "anonymous-sign-in",
    request: async (proof) =>
      await authClient.signIn.anonymous(buildAnonymousSignInOptions(proof)),
    isIntegrityKeyUnknown: (result) =>
      isIntegrityKeyUnknown(result.error),
  }),
});
