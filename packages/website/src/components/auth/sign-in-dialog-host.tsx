"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { SIGN_IN_DIALOG_EVENT } from "./sign-in-dialog-events";

const LazySignInDialogProvider = dynamic(() =>
  import("./sign-in-dialog").then((module) => module.SignInDialogProvider),
);

/** Loads the auth dialog implementation only when a sign-in is requested. */
export function SignInDialogHost() {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const activate = () => setActive(true);
    window.addEventListener(SIGN_IN_DIALOG_EVENT, activate);

    // OAuth redirects can land on any route with a one-time token. In that
    // exceptional case, load the dialog immediately so it can verify the token.
    if (new URL(window.location.href).searchParams.has("ott")) activate();

    return () => window.removeEventListener(SIGN_IN_DIALOG_EVENT, activate);
  }, []);

  return active ? <LazySignInDialogProvider initiallyOpen /> : null;
}
