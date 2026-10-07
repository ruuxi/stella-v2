"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { ChevronDown } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { clearCachedToken } from "@/lib/auth-token";
import { useDesktopBridgeAuthUser } from "@/lib/desktop-bridge-auth";
import { SignInButton } from "./sign-in-button";

type SessionUser = {
  email?: string;
  name?: string;
  isAnonymous?: boolean | null;
};

/** Session-aware half of the header account control, loaded after first paint. */
export function SiteHeaderAccountInner() {
  const session = authClient.useSession();
  const desktopUser = useDesktopBridgeAuthUser();
  const user =
    (session.data as { user?: SessionUser } | null | undefined)?.user ??
    desktopUser;
  const isSignedIn = Boolean(user) && user?.isAnonymous !== true;

  if (isSignedIn && user) {
    return <AccountMenu user={user} />;
  }

  return <SignInButton />;
}

function AccountMenu({ user }: { user: SessionUser }) {
  const label = user.name?.trim() || user.email?.trim() || "Account";
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOut = useCallback(async () => {
    setSigningOut(true);
    try {
      await authClient.signOut();
      clearCachedToken();
    } catch {
      clearCachedToken();
    } finally {
      setSigningOut(false);
    }
  }, []);

  return (
    <div className="site-nav__group">
      <button
        type="button"
        className="site-nav__trigger"
        aria-haspopup="true"
        aria-label="Account menu"
      >
        {label}
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      <div className="site-nav__menu site-nav__menu--end">
        <div className="site-nav__panel">
          <Link href="/billing">Manage account</Link>
          <button
            type="button"
            className="site-nav__panel-action"
            onClick={() => void handleSignOut()}
            disabled={signingOut}
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </div>
    </div>
  );
}
