"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { reportGoogleAdsSignup } from "@/components/google-ads-tag";
import styles from "./view.module.css";

export function AuthCallbackView() {
  const searchParams = useSearchParams();
  const isDone = searchParams.get("done") === "true";

  useEffect(() => {
    if (isDone) {
      reportGoogleAdsSignup();
    }
  }, [isDone]);

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <div className={styles.badge}>Stella</div>
        <h1 className={styles.title}>
          {isDone
            ? "You’re signed in"
            : "This sign-in link is no longer valid"}
        </h1>
        <p className={styles.body}>
          {isDone
            ? "You can close this tab and return to Stella."
            : "Return to Stella and start a new sign-in. Older app handoff links are no longer supported."}
        </p>
        <Link className={styles.homeLink} href="/">
          Back to stella.sh
        </Link>
      </div>
    </main>
  );
}
