"use client";

import { lazy, Suspense, useEffect, useState } from "react";
import { isConvexConfigured } from "@/lib/convex-urls";
import { SignInButton } from "./sign-in-button";

const SiteHeaderAccountInner = lazy(() =>
  import("./site-header-account-inner").then((module) => ({
    default: module.SiteHeaderAccountInner,
  })),
);

/**
 * Account/sign-in control rendered inside the existing `<nav className="site-nav">`
 * on every marketing page. Renders nothing when the Convex backend isn't
 * configured for this build (preview deploys without env vars).
 *
 * Sign-in opens a global dialog (see `SignInDialogProvider`) instead of
 * navigating to `/sign-in`, so the user stays on the page they were reading.
 *
 * SSR and the first client paint emit the static "Sign In" string. The
 * session-aware implementation is imported when the browser is idle, keeping
 * Better Auth and its session request off the critical rendering path without
 * sacrificing the signed-in account label once the page settles.
 */
export function SiteHeaderAccount() {
  const [loadSession, setLoadSession] = useState(false);

  useEffect(() => {
    const requestIdle = window.requestIdleCallback;
    if (requestIdle) {
      const id = requestIdle(() => setLoadSession(true), { timeout: 1500 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(() => setLoadSession(true), 1);
    return () => window.clearTimeout(id);
  }, []);

  if (!isConvexConfigured()) {
    return null;
  }
  return loadSession ? (
    <Suspense fallback={<SignInButton />}>
      <SiteHeaderAccountInner />
    </Suspense>
  ) : (
    <SignInButton />
  );
}
