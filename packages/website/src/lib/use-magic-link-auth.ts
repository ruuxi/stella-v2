"use client";

import {
  useState,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from "react";
import { authClient } from "./auth-client";
import { tryReadConvexSiteUrl } from "./convex-urls";
import { getWebsiteChallengeToken, turnstileHeader } from "./turnstile";

export type MagicLinkStatus = "idle" | "sending" | "sent" | "error";

export interface UseMagicLinkAuthResult {
  email: string;
  setEmail: Dispatch<SetStateAction<string>>;
  status: MagicLinkStatus;
  error: string | null;
  handleMagicLinkSubmit: (event: FormEvent) => Promise<void>;
  reset: () => void;
}

export const useMagicLinkAuth = (): UseMagicLinkAuthResult => {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<MagicLinkStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const handleMagicLinkSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = email.trim();

    if (!trimmed) {
      setError("Enter your email address.");
      return;
    }

    if (!tryReadConvexSiteUrl()) {
      setStatus("error");
      setError(
        "Sign-in isn't configured for this build. Contact the team or set NEXT_PUBLIC_CONVEX_URL.",
      );
      return;
    }

    setError(null);
    setStatus("sending");

    try {
      const token = await getWebsiteChallengeToken();
      const result = await authClient.signIn.magicLink({
        email: trimmed,
        callbackURL: new URL("/sign-in", window.location.origin).toString(),
        fetchOptions: {
          headers: turnstileHeader(token),
        },
      });
      if (result.error) {
        throw new Error(
          result.error.message ?? "Failed to send sign-in email.",
        );
      }
      setStatus("sent");
    } catch (cause) {
      setStatus("error");
      setError(
        cause instanceof Error
          ? cause.message
          : "Failed to send sign-in email.",
      );
    }
  };

  const reset = () => {
    setEmail("");
    setStatus("idle");
    setError(null);
  };

  return {
    email,
    setEmail,
    status,
    error,
    handleMagicLinkSubmit,
    reset,
  };
};
