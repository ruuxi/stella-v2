const TURNSTILE_SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type TurnstileVerificationResult =
  | { ok: true }
  | { ok: false; reason: string };

let loggedDisabledWarning = false;

export const getTurnstileSecretKey = (): string | undefined => {
  const value = process.env.TURNSTILE_SECRET_KEY?.trim();
  return value || undefined;
};

export const isTurnstileEnabled = (): boolean =>
  getTurnstileSecretKey() !== undefined;

export const logTurnstileDisabledOnce = (): void => {
  if (loggedDisabledWarning || isTurnstileEnabled()) return;
  loggedDisabledWarning = true;
  console.warn("[auth] Turnstile is OFF (TURNSTILE_SECRET_KEY unset)");
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readTurnstileFailureReason = (value: unknown): string => {
  if (!isRecord(value)) return "invalid_response";
  const codes = value["error-codes"];
  if (!Array.isArray(codes)) return "verification_failed";
  const normalized = codes.filter(
    (code): code is string => typeof code === "string" && code.length > 0,
  );
  return normalized.length > 0 ? normalized.join(",") : "verification_failed";
};

export const verifyTurnstileToken = async (
  token: string,
  remoteIp?: string,
): Promise<TurnstileVerificationResult> => {
  const secretKey = getTurnstileSecretKey();
  if (!secretKey) return { ok: true };

  const responseToken = token.trim();
  if (!responseToken) return { ok: false, reason: "missing_token" };

  try {
    const response = await fetch(TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret: secretKey,
        response: responseToken,
        ...(remoteIp?.trim() ? { remoteip: remoteIp.trim() } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return { ok: false, reason: `siteverify_http_${response.status}` };
    }
    const body: unknown = await response.json();
    if (isRecord(body) && body.success === true) return { ok: true };
    return { ok: false, reason: readTurnstileFailureReason(body) };
  } catch {
    return { ok: false, reason: "siteverify_unavailable" };
  }
};
