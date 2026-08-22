import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  type Dispatch,
  type FormEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import { refreshAuthSession } from "@/global/auth/services/auth-session";
import { useT, useTPlural } from "@/shared/i18n";

type Status = "idle" | "sending" | "sent" | "verifying" | "error";

/**
 * Errors are stored as i18n descriptors rather than resolved strings: the
 * provider mounts above <I18nProvider>, so the state hook has no `t`. The
 * consumer hook (`useMagicLinkAuth`, always called from inside the i18n
 * tree) resolves them to display text.
 */
type MagicLinkError =
  | { kind: "key"; key: string }
  | { kind: "plural"; key: string; count: number }
  | { kind: "text"; text: string };

/** Thrown internally so a catch block can preserve the i18n key. */
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
/**
 * Visual cooldown after a successful send. The backend is the source of
 * truth (3/min/email + Retry-After) — this is purely UX so the resend
 * button doesn't look spam-clickable. A 429 will override with the real
 * Retry-After value.
 */
const RESEND_COOLDOWN_MS = 30_000;

interface UseMagicLinkAuthResult {
  email: string;
  setEmail: Dispatch<SetStateAction<string>>;
  status: Status;
  /**
   * The (normalized) email a sign-in link was last sent to, or null if no
   * send has succeeded in this session. When `email` differs from this we
   * treat the form as a fresh send.
   */
  sentToEmail: string | null;
  error: string | null;
  handleMagicLinkSubmit: (event: FormEvent) => Promise<void>;
  resend: () => Promise<void>;
  /** Seconds left before resend is enabled (0 when ready). */
  resendCooldownSeconds: number;
  /** True while the resend network call is in flight. */
  isResending: boolean;
  reset: () => void;
}

type MagicLinkAuthState = Omit<UseMagicLinkAuthResult, "error"> & {
  errorState: MagicLinkError | null;
};

const MagicLinkAuthContext = createContext<MagicLinkAuthState | null>(null);

/**
 * Auth-inversion P3: magic link runs through the desktop main process into
 * the runtime AuthOwner (`auth:magicLinkSend` / `auth:magicLinkStatus`).
 * The renderer only sees a requestId and a status — the raw sessionCookie
 * never transits this process.
 */
const getMagicLinkApi = () => {
  const systemApi = window.electronAPI?.system;
  if (!systemApi?.sendMagicLink || !systemApi.getMagicLinkStatus) {
    throw new MagicLinkKeyError("global.auth.magicLinkFailed");
  }
  return {
    sendMagicLink: systemApi.sendMagicLink,
    getMagicLinkStatus: systemApi.getMagicLinkStatus,
  };
};

function useMagicLinkAuthState(): MagicLinkAuthState {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<MagicLinkError | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [sentToEmail, setSentToEmail] = useState<string | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState<number>(0);
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
      const { sendMagicLink: send } = getMagicLinkApi();
      const result = await send(targetEmail);

      if (!result.ok && result.code === "rate_limited") {
        const retryAfterSec = result.retryAfterSeconds;
        setCooldownUntil(Date.now() + retryAfterSec * 1000);
        setError({
          kind: "plural",
          key: "global.auth.tooManyRequests",
          count: retryAfterSec,
        });
        if (mode === "initial") setStatus("error");
        return false;
      }

      if (!result.ok) {
        if (result.error) throw new Error(result.error);
        throw new MagicLinkKeyError("global.auth.sendFailed");
      }
      setRequestId(result.requestId);
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

  // Tick every 500ms while a cooldown is active so the visual countdown
  // stays in sync. We stop ticking once the cooldown elapses.
  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [cooldownUntil]);

  const resendCooldownSeconds = Math.max(
    0,
    Math.ceil((cooldownUntil - now) / 1000),
  );

  // Poll for magic link verification.
  useEffect(() => {
    if (status !== "sent" || !requestId) return;
    // Per-effect cancellation flag, captured by this run's poll closure. Each
    // effect execution owns its own `cancelled`, so a stale loop from a prior
    // run (e.g. after Resend re-runs this effect with a new requestId) can
    // never be un-cancelled by the newer run and stops touching shared state
    // the moment its cleanup fires. reset() cancels via the same path: it
    // clears `status`/`requestId`, which re-runs this effect and runs the old
    // run's cleanup.
    let cancelled = false;

    const poll = async () => {
      while (!cancelled) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        if (cancelled) return;

        try {
          const { getMagicLinkStatus } = getMagicLinkApi();
          const data = await getMagicLinkStatus(requestId);

          if (data.status === "completed" && data.applied) {
            // The runtime AuthOwner already applied the session cookie;
            // just re-read the (now signed-in) session.
            if (cancelled) return;
            setStatus("verifying");
            try {
              await refreshAuthSession();
            } catch {
              setStatus("error");
              setError({ kind: "key", key: "global.auth.finishFailed" });
              setRequestId(null);
            }
            return;
          }

          if (data.status === "completed") {
            if (cancelled) return;
            setStatus("error");
            setError({ kind: "key", key: "global.auth.signInIncomplete" });
            setRequestId(null);
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
          // Retry silently on network errors.
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
