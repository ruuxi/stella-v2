"use client";

/** Lightweight event contract shared by dialog launchers and the lazy host. */
export const SIGN_IN_DIALOG_EVENT = "stella:open-sign-in";

export function openSignInDialog() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SIGN_IN_DIALOG_EVENT));
}
