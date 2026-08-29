import { useCallback, useEffect, useState } from "react";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogCloseButton,
} from "@/ui/dialog";
import { MagicLinkAuthFlow } from "./MagicLinkAuthFlow";
import { authClient } from "./lib/auth-client";
import { useAuthSessionState } from "./hooks/use-auth-session-state";
import {
  applyAndVerifyAccountSessionToken,
  startBrowserGoogleSignIn,
} from "./services/account-connection";
import {
  claimSessionToken,
  generateClaimSecret,
  hashClaimSecret,
} from "@/global/auth/lib/claim-secret";
import { openExternalUrl } from "@/platform/electron/open-external";
import { readConfiguredConvexSiteUrl } from "@/shared/lib/convex-urls";
import { useT } from "@/shared/i18n";
import "./AuthDialog.css";

interface AuthDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type SocialSignInResult = {
  data?: {
    url?: string;
  } | null;
  error?: {
    message?: string;
    statusText?: string;
  } | null;
};

const SOCIAL_AUTH_POLL_INTERVAL_MS = 2500;
const SOCIAL_AUTH_TIMEOUT_MS = 2 * 60_000;

const wait = (ms: number) =>
  new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });

const getConvexSiteUrl = () => {
  const url = readConfiguredConvexSiteUrl(
    import.meta.env.VITE_CONVEX_SITE_URL as string | undefined,
  );
  if (!url) {
    throw new Error("Convex site URL is not configured.");
  }
  return url;
};

type Translate = ReturnType<typeof useT>;

const startDesktopSocialAuth = async (t: Translate) => {
  const convexSiteUrl = getConvexSiteUrl();
  // Held in memory for this attempt only; the server stores just the hash.
  const claimSecret = generateClaimSecret();
  const response = await fetch(
    `${convexSiteUrl}/api/auth/desktop-social/start`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "google",
        claimHash: await hashClaimSecret(claimSecret),
      }),
    },
  );
  const data = (await response.json().catch(() => null)) as {
    requestId?: string;
    callbackURL?: string;
    error?: string;
  } | null;
  if (!response.ok || !data?.requestId || !data.callbackURL) {
    throw new Error(data?.error || t("global.auth.googleStartFailed"));
  }
  return {
    convexSiteUrl,
    requestId: data.requestId,
    callbackURL: data.callbackURL,
    claimSecret,
  };
};

const pollDesktopSocialAuth = async (
  convexSiteUrl: string,
  requestId: string,
  claimSecret: string,
  t: Translate,
) => {
  const deadline = Date.now() + SOCIAL_AUTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await wait(SOCIAL_AUTH_POLL_INTERVAL_MS);
    const response = await fetch(
      `${convexSiteUrl}/api/auth/link/status?requestId=${encodeURIComponent(requestId)}`,
    );
    if (!response.ok) {
      continue;
    }
    const data = (await response.json().catch(() => null)) as {
      status?: string;
    } | null;
    if (data?.status === "completed") {
      // The credential is never returned by /link/status. Exchange the secret
      // for it.
      const token = await claimSessionToken(
        convexSiteUrl,
        requestId,
        claimSecret,
      );
      if (!token) {
        throw new Error(t("global.auth.googleNoSession"));
      }
      await applyAndVerifyAccountSessionToken(token);
      return;
    }
    if (data?.status === "expired") {
      throw new Error(t("global.auth.googleExpired"));
    }
  }
  throw new Error(t("global.auth.googleTimedOut"));
};

export const AuthDialog = ({ open, onOpenChange }: AuthDialogProps) => {
  const t = useT();
  const { hasConnectedAccount } = useAuthSessionState();

  useEffect(() => {
    if (hasConnectedAccount && open) {
      onOpenChange(false);
    }
  }, [hasConnectedAccount, open, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent fit className="auth-dialog-content">
        <VisuallyHidden asChild>
          <DialogTitle>{t("global.auth.welcomeTitle")}</DialogTitle>
        </VisuallyHidden>
        <VisuallyHidden asChild>
          <DialogDescription>
            {t("global.auth.welcomeDescription")}
          </DialogDescription>
        </VisuallyHidden>
        <DialogCloseButton className="auth-dialog-close" />
        <DialogBody className="auth-dialog-body">
          <div className="auth-dialog-hero">
            <p className="auth-dialog-headline">
              {t("global.auth.welcomeTitle")}
            </p>
            <p className="auth-dialog-sub">{t("global.auth.welcomeSub")}</p>
          </div>
          <GoogleAuthButton />
          <div className="auth-dialog-method-divider">
            <span>{t("global.auth.orUseEmail")}</span>
          </div>
          <MagicLinkAuthFlow
            className="auth-dialog-flow"
            hideEmailLabel
            inputVariant="normal"
            emailPlaceholder={t("global.auth.emailPlaceholder")}
            autoFocus
            formClassName="auth-dialog-form"
            inputClassName="auth-dialog-input"
            buttonClassName="pill-btn pill-btn--primary pill-btn--lg auth-dialog-cta"
            buttonVariant="primary"
            buttonSize="large"
            submitLabel={t("common.continue")}
            sendingLabel={t("global.auth.sending")}
            resendLabel={t("global.auth.resendEmail")}
            extrasClassName="auth-dialog-extras"
            extrasInnerClassName="auth-dialog-extras-inner"
            sentClassName="auth-dialog-sent"
            sentMessage={t("global.auth.magicLinkSentDesktop")}
            openInboxClassName="pill-btn pill-btn--primary pill-btn--lg auth-dialog-open-inbox"
            errorClassName="auth-dialog-error"
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};

function GoogleAuthButton() {
  const t = useT();
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignIn = useCallback(async () => {
    setError(null);
    setIsSigningIn(true);

    try {
      if (!window.electronAPI) {
        let result: SocialSignInResult | undefined;
        try {
          result = (await startBrowserGoogleSignIn()) as
            | SocialSignInResult
            | undefined;
        } catch {
          setError(t("global.auth.googleStartFailed"));
          return;
        }
        if (result?.error) {
          setError(
            result.error.message ||
              result.error.statusText ||
              t("global.auth.googleStartFailed"),
          );
        }
        return;
      }

      const { convexSiteUrl, requestId, callbackURL, claimSecret } =
        await startDesktopSocialAuth(t);
      const result = (await authClient.signIn.social({
        provider: "google",
        callbackURL,
        disableRedirect: true,
      })) as SocialSignInResult | undefined;
      const url = result?.data?.url;

      if (result?.error || !url) {
        setError(
          result?.error?.message ||
            result?.error?.statusText ||
            t("global.auth.googleStartFailed"),
        );
        return;
      }

      openExternalUrl(url);
      await pollDesktopSocialAuth(convexSiteUrl, requestId, claimSecret, t);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("global.auth.googleStartFailed"),
      );
    } finally {
      setIsSigningIn(false);
    }
  }, [t]);

  return (
    <div className="auth-dialog-google-wrap">
      <button
        type="button"
        className="auth-dialog-google"
        onClick={handleSignIn}
        disabled={isSigningIn}
      >
        <GoogleIcon />
        {isSigningIn
          ? t("global.auth.googleWaiting")
          : t("global.auth.googleContinue")}
      </button>
      {error ? <div className="auth-dialog-error">{error}</div> : null}
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg
      className="auth-dialog-google-icon"
      viewBox="0 0 18 18"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.89 2.69-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.95-2.18l-2.91-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.71H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.71A5.41 5.41 0 0 1 3.69 9c0-.59.1-1.16.28-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.04l3.01-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.42 0 9 0A9 9 0 0 0 .96 4.96l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}
