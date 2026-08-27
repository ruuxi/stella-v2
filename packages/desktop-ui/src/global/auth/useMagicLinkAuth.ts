import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  claimSessionToken,
  generateClaimSecret,
  hashClaimSecret,
} from "@/global/auth/lib/claim-secret";
import { refreshAuthSession } from "@/global/auth/services/auth-session";
import { readConfiguredConvexSiteUrl } from "@/shared/lib/convex-urls";
import { useT, useTPlural } from "@/shared/i18n";

type Status = "idle" | "sending" | "sent" | "verifying" | "error";

type MagicLinkError =
  | { kind: "key"; key: string }
  | { kind: "plural"; key: string; count: number }
  | { kind: "text"; text: string };

class MagicLinkKeyError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(key);
    this.key = key;
  }
}

const toMagicLinkError = (err: unknown): MagicLinkError => {
  if (err instanceof MagicLinkKeyError) return { kind: "key", key: err.key };
  if (err instanceof Error) return { kind: "text", text: err.message };
  return { kind: "key", key: "global.auth.magicLinkFailed" };
};

const POLL_INTERVAL_MS = 2500;

const RESEND_COOLDOWN_MS = 30_000;

interface UseMagicLinkAuthResult {
  email: string;
  setEmail: Dispatch<SetStateAction<string>>;
  status: Status;

  sentToEmail: string | null;
  error: string | null;
  handleMagicLinkSubmit: (event: FormEvent) => Promise<void>;
  resend: () => Promise<void>;

  resendCooldownSeconds: number;

  isResending: boolean;
  reset: () => void;
}

type MagicLinkAuthState = Omit<UseMagicLinkAuthResult, "error"> & {
  errorState: MagicLinkError | null;
};

const MagicLinkAuthContext = createContext<MagicLinkAuthState | null>(null);

const getConvexSiteUrl = () => {
  const url = readConfiguredConvexSiteUrl(
    import.meta.env.VITE_CONVEX_SITE_URL as string | undefined,
  );
  if (!url) {
    throw new Error("Convex site URL is not configured.");
  }
  return url;
};

function useMagicLinkAuthState(): MagicLinkAuthState {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<MagicLinkError | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [sentToEmail, setSentToEmail] = useState<string | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState<number>(0);

  const claimSecretRef = useRef<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [isResending, setIsResending] = useState(false);

  const sendMagicLink = async (
    targetEmail: string,
    mode: "initial" | "resend",
  ): Promise<boolean> => {
    setError(null);
    if (mode === "initial") setStatus("sending");
    else setIsResending(true);

    try {
      const convexSiteUrl = getConvexSiteUrl();

      const claimSecret = generateClaimSecret();
      claimSecretRef.current = claimSecret;
      const response = await fetch(`${convexSiteUrl}/api/auth/link/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: targetEmail,
          claimHash: await hashClaimSecret(claimSecret),
        }),
      });

      if (response.status === 429) {
        const retryAfterHeader = response.headers.get("Retry-After");
        const retryAfterSec = retryAfterHeader
          ? Math.max(1, parseInt(retryAfterHeader, 10) || 1)
          : 60;
        setCooldownUntil(Date.now() + retryAfterSec * 1000);
        setError({
          kind: "plural",
          key: "global.auth.tooManyRequests",
          count: retryAfterSec,
        });
        if (mode === "initial") setStatus("error");
        return false;
      }

      const data = (await response.json()) as {
        requestId?: string;
        error?: string;
      };
      if (!response.ok || !data.requestId) {
        if (data.error) throw new Error(data.error);
        throw new MagicLinkKeyError("global.auth.sendFailed");
      }
      setRequestId(data.requestId);
      setSentToEmail(targetEmail);
      setStatus("sent");
      setCooldownUntil(Date.now() + RESEND_COOLDOWN_MS);
      return true;
    } catch (err) {
      if (mode === "initial") setStatus("error");
      setError(toMagicLinkError(err));
      return false;
    } finally {
      if (mode === "resend") setIsResending(false);
    }
  };

  const handleMagicLinkSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = email.trim();

    if (!trimmed) {
      setError({ kind: "key", key: "global.auth.enterEmail" });
      return;
    }

    await sendMagicLink(trimmed, "initial");
  };

  const resend = async () => {
    const trimmed = email.trim();
    if (!trimmed) return;
    if (Date.now() < cooldownUntil) return;
    if (isResending) return;
    await sendMagicLink(trimmed, "resend");
  };

  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [cooldownUntil]);

  const resendCooldownSeconds = Math.max(
    0,
    Math.ceil((cooldownUntil - now) / 1000),
  );

  useEffect(() => {
    if (status !== "sent" || !requestId) return;

    let cancelled = false;
    const convexSiteUrl = getConvexSiteUrl();

    const poll = async () => {
      while (!cancelled) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        if (cancelled) return;

        try {
          const res = await fetch(
            `${convexSiteUrl}/api/auth/link/status?requestId=${encodeURIComponent(requestId)}`,
          );
          if (!res.ok) continue;
          const data = (await res.json()) as { status: string };

          if (data.status === "completed") {
            if (cancelled) return;
            setStatus("verifying");
            try {
              const secret = claimSecretRef.current;
              const token = secret
                ? await claimSessionToken(convexSiteUrl, requestId, secret)
                : null;
              if (!token) {
                throw new Error("Handoff could not be claimed.");
              }
              await window.electronAPI?.system.applyAuthSessionToken?.(token);
              claimSecretRef.current = null;
              await refreshAuthSession();
            } catch {
              setStatus("error");
              setError({ kind: "key", key: "global.auth.finishFailed" });
              setRequestId(null);
            }
            return;
          }

          if (data.status === "expired") {
            if (cancelled) return;
            setStatus("error");
            setError({ kind: "key", key: "global.auth.signInLinkExpired" });
            setRequestId(null);
            return;
          }
        } catch {

        }
      }
    };

    void poll();
    return () => {
      cancelled = true;
    };
  }, [status, requestId]);

  const reset = () => {
    setEmail("");
    setStatus("idle");
    setError(null);
    setRequestId(null);
    setSentToEmail(null);
    setCooldownUntil(0);
    setIsResending(false);
  };

  return {
    email,
    setEmail,
    status,
    sentToEmail,
    errorState: error,
    handleMagicLinkSubmit,
    resend,
    resendCooldownSeconds,
    isResending,
    reset,
  };
}

export function MagicLinkAuthProvider({ children }: { children: ReactNode }) {
  const value = useMagicLinkAuthState();
  return createElement(MagicLinkAuthContext.Provider, { value }, children);
}

export const useMagicLinkAuth = (): UseMagicLinkAuthResult => {
  const value = useContext(MagicLinkAuthContext);
  const t = useT();
  const tPlural = useTPlural();
  if (!value) {
    throw new Error(
      "useMagicLinkAuth must be used within MagicLinkAuthProvider",
    );
  }
  const { errorState, ...rest } = value;
  const error =
    errorState === null
      ? null
      : errorState.kind === "text"
        ? errorState.text
        : errorState.kind === "plural"
          ? tPlural(errorState.key, errorState.count)
          : t(errorState.key);
  return { ...rest, error };
};
