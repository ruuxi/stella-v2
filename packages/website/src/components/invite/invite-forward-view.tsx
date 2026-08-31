"use client";

import Link from "next/link";
import { useEffect, useMemo } from "react";
import { ArrowRight, Download } from "lucide-react";
import styles from "./invite-forward.module.css";

const DESKTOP_SCHEME =
  process.env.NEXT_PUBLIC_STELLA_DESKTOP_SCHEME?.trim() || "stella";

export type InviteForwardKind = "join-community" | "add-friend";

type InviteForwardViewProps = {
  kind: InviteForwardKind;
  /** Invite code (join) or username (add-friend); already URL-safe. */
  value: string;
};

/**
 * Handoff page behind shareable social invite links
 * (`stella.sh/join/<code>`, `stella.sh/add-friend/<username>`). Auto
 * forwards to the desktop deep link (`stella://join/...`,
 * `stella://add-friend/...`) and keeps an explicit "Open in Stella"
 * button for browsers that block the automatic handoff — same pattern as
 * the auth callback page.
 */
export function InviteForwardView({ kind, value }: InviteForwardViewProps) {
  const isJoin = kind === "join-community";

  const deepLink = useMemo(() => {
    const host = isJoin ? "join" : "add-friend";
    return `${DESKTOP_SCHEME}://${host}/${encodeURIComponent(value)}`;
  }, [isJoin, value]);

  useEffect(() => {
    window.location.replace(deepLink);
  }, [deepLink]);

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <div className={styles.badge}>
          {isJoin ? "Community invite" : "Friend invite"}
        </div>
        <h1 className={styles.title}>
          {isJoin ? "You\u2019re invited" : "Connect on Stella"}
        </h1>
        <p className={styles.body}>
          {isJoin
            ? "Someone invited you to their community on Stella — a trusted circle where members share what they build. We\u2019re opening the app so you can confirm and join."
            : "Someone sent you a friend invite on Stella. We\u2019re opening the app so you can confirm and connect."}
        </p>

        <div className={styles.code}>{isJoin ? value : `@${value}`}</div>

        <div className={styles.actions}>
          <a
            className={`${styles.button} ${styles.buttonPrimary}`}
            href={deepLink}
          >
            Open in Stella
            <ArrowRight size={16} />
          </a>
          <Link
            className={`${styles.button} ${styles.buttonSecondary}`}
            href="/"
          >
            Get Stella for desktop
            <Download size={16} />
          </Link>
        </div>

        <p className={styles.note}>
          If nothing happened, Stella might not be installed yet — grab the
          app first, then click the invite link again.
        </p>

        <Link className={styles.homeLink} href="/">
          Back to stella.sh
        </Link>
      </div>
    </main>
  );
}
