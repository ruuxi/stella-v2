"use client";

import { openSignInDialog } from "./sign-in-dialog-events";

export function SignInButton({
  label = "Sign In",
  ariaLabel,
}: {
  label?: string;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      className="site-nav__signin"
      aria-label={ariaLabel}
      onClick={openSignInDialog}
    >
      {label}
    </button>
  );
}
