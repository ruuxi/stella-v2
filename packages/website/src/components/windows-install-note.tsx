"use client";

import { usePlatform } from "./download-button";
import styles from "./windows-install-note.module.css";

/**
 * A small, calm helper shown only to Windows visitors near a download CTA.
 * The launcher is signed by FromYou, LLC, but SmartScreen can still flag a
 * new download until the file builds reputation; this explains how to proceed.
 * Gated on the same client-side platform detection as the download button, so
 * Mac and Linux visitors never see the (irrelevant) warning copy.
 */
export function WindowsInstallNote({ className }: { className?: string }) {
  const platform = usePlatform();
  if (platform !== "windows") return null;

  return (
    <details className={[styles.note, className].filter(Boolean).join(" ")}>
      <summary className={styles.summary}>
        Seeing a Windows security warning?
      </summary>
      <div className={styles.body}>
        <p>
          Stella for Windows is signed by FromYou, LLC. Windows can still flag a
          new download until it&apos;s seen it more often. It&apos;s safe to
          install; here&apos;s how to continue:
        </p>
        <ul>
          <li>
            <strong>If the download is blocked:</strong> open the &ldquo;&middot;&middot;&middot;&rdquo;
            menu next to it and choose <strong>Keep</strong>.
          </li>
          <li>
            <strong>If Windows warns when you open it:</strong> click{" "}
            <strong>More info</strong>, then <strong>Run anyway</strong>.
          </li>
        </ul>
      </div>
    </details>
  );
}
