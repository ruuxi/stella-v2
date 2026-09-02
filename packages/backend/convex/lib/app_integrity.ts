import {
  APP_INTEGRITY_HEADER,
  appIntegrityChallengeString,
  decodeAppIntegrityProof,
  type AppIntegrityErrorCode,
  type AppIntegrityProof,
  type AppIntegrityPurpose,
} from "@stella/contracts/app-integrity";
import { AUTH_CAPTCHA_HEADER } from "@stella/contracts/auth-challenge";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import type { ActionCtx } from "../_generated/server";
import { getClientAddressKey } from "./http_utils";
import { isTurnstileEnabled, verifyTurnstileToken } from "./turnstile";

export type AppIntegrityMode = "enforce" | "off";
export type VerifiedProofPlatform = "ios" | "android" | "web";

type AppIntegrityEnvironment = Readonly<{
  APPLE_APP_ATTEST_TEAM_ID?: string;
  GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON?: string;
  STELLA_APP_INTEGRITY_MODE?: string;
}>;

export type IntegrityVerificationResult =
  | { ok: true; platform: "ios" | "android" }
  | {
      ok: false;
      code: Extract<
        AppIntegrityErrorCode,
        "integrity_invalid" | "integrity_key_unknown"
      >;
    };

export type AuthProofResult =
  | { ok: true; platform?: VerifiedProofPlatform }
  | { ok: false; code: AppIntegrityErrorCode };

export type IntegrityProofVerifier = (
  ctx: Pick<ActionCtx, "runAction">,
  proof: AppIntegrityProof,
) => Promise<IntegrityVerificationResult>;

const consumeNonceRef = makeFunctionReference<
  "mutation",
  { nonce: string; purpose: AppIntegrityPurpose; now: number },
  "valid" | "missing" | "consumed" | "expired" | "purpose_mismatch"
>(
  "app_integrity:consumeAppIntegrityNonceInternal",
) as unknown as FunctionReference<
  "mutation",
  "internal",
  { nonce: string; purpose: AppIntegrityPurpose; now: number },
  "valid" | "missing" | "consumed" | "expired" | "purpose_mismatch"
>;

const verifyIntegrityProofRef = makeFunctionReference<
  "action",
  { proof: AppIntegrityProof },
  IntegrityVerificationResult
>(
  "app_integrity_node:verifyAppIntegrityProofInternal",
) as unknown as FunctionReference<
  "action",
  "internal",
  { proof: AppIntegrityProof },
  IntegrityVerificationResult
>;

let loggedIntegrityOffWarning = false;

const configuredValue = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export const getAppIntegrityMode = (
  env: AppIntegrityEnvironment = process.env,
): AppIntegrityMode => {
  const configured = configuredValue(env.STELLA_APP_INTEGRITY_MODE);
  if (configured === "enforce" || configured === "off") return configured;
  if (configured !== undefined) {
    throw new Error(
      'STELLA_APP_INTEGRITY_MODE must be either "enforce" or "off".',
    );
  }
  return configuredValue(env.APPLE_APP_ATTEST_TEAM_ID) ||
    configuredValue(env.GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON)
    ? "enforce"
    : "off";
};

export const isIntegrityPlatformConfigured = (
  platform: "ios" | "android",
  env: AppIntegrityEnvironment = process.env,
): boolean =>
  platform === "ios"
    ? configuredValue(env.APPLE_APP_ATTEST_TEAM_ID) !== undefined
    : configuredValue(env.GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON) !==
      undefined;

export const logAppIntegrityOffOnce = (): void => {
  if (loggedIntegrityOffWarning) return;
  loggedIntegrityOffWarning = true;
  console.warn("[auth] App integrity is OFF (local development mode)");
};

export const appIntegrityPurposeForAuthPath = (
  path: string | undefined,
): AppIntegrityPurpose | null => {
  if (path === "/sign-in/anonymous") return "anonymous-sign-in";
  if (path === "/sign-in/magic-link") return "magic-link";
  return null;
};

const verifyIntegrityProofWithNodeAction: IntegrityProofVerifier = async (
  ctx,
  proof,
) => await ctx.runAction(verifyIntegrityProofRef, { proof });

export const verifyAuthRequestProof = async (args: {
  ctx: Pick<ActionCtx, "runAction" | "runMutation">;
  request: Request;
  purpose: AppIntegrityPurpose;
  verifyIntegrityProof?: IntegrityProofVerifier;
}): Promise<AuthProofResult> => {
  const mode = getAppIntegrityMode();
  if (mode === "off") logAppIntegrityOffOnce();

  const turnstileEnabled = isTurnstileEnabled();
  const captchaToken =
    args.request.headers.get(AUTH_CAPTCHA_HEADER)?.trim() ?? "";
  const integrityHeader =
    args.request.headers.get(APP_INTEGRITY_HEADER)?.trim() ?? "";
  let sawInvalidProof = false;

  if (turnstileEnabled && captchaToken) {
    const captchaResult = await verifyTurnstileToken(
      captchaToken,
      getClientAddressKey(args.request) ?? undefined,
    );
    if (captchaResult.ok) return { ok: true, platform: "web" };
    sawInvalidProof = true;
  }

  if (integrityHeader) {
    const proof = decodeAppIntegrityProof(integrityHeader);
    if (proof) {
      if (mode === "off") {
        if (proof.purpose === args.purpose) {
          return { ok: true, platform: proof.platform };
        }
        sawInvalidProof = true;
      } else {
        const nonceStatus = await args.ctx.runMutation(consumeNonceRef, {
          nonce: proof.nonce,
          purpose: args.purpose,
          now: Date.now(),
        });
        if (
          nonceStatus !== "valid" ||
          proof.purpose !== args.purpose ||
          !isIntegrityPlatformConfigured(proof.platform)
        ) {
          sawInvalidProof = true;
        } else {
          const verify =
            args.verifyIntegrityProof ?? verifyIntegrityProofWithNodeAction;
          const result = await verify(args.ctx, proof);
          if (result.ok) return result;
          return result;
        }
      }
    } else {
      sawInvalidProof = true;
    }
  }

  if (!turnstileEnabled && mode === "off") return { ok: true };
  return sawInvalidProof
    ? { ok: false, code: "integrity_invalid" }
    : { ok: false, code: "integrity_required" };
};

export const appIntegrityErrorStatus = (
  code: AppIntegrityErrorCode,
): 400 | 403 => (code === "integrity_required" ? 400 : 403);

export const appIntegrityErrorMessage = (
  code: AppIntegrityErrorCode,
): string => {
  switch (code) {
    case "integrity_required":
      return "This request needs a verification proof.";
    case "integrity_key_unknown":
      return "The app integrity key is not registered.";
    case "integrity_invalid":
      return "The verification proof is invalid.";
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const readVerifiedProofPlatform = (
  context: unknown,
): VerifiedProofPlatform | undefined => {
  if (!isRecord(context)) return undefined;
  const value = context.appIntegrityPlatform;
  return value === "ios" || value === "android" || value === "web"
    ? value
    : undefined;
};

export const integrityChallengeForProof = (proof: AppIntegrityProof): string =>
  appIntegrityChallengeString(proof.purpose, proof.nonce);
