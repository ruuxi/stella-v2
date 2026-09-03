import type { Metadata } from "next";
import Link from "next/link";
import { DownloadButton } from "@/components/download-button";
import { WindowsInstallNote } from "@/components/windows-install-note";
import { FooterLegalLinks } from "@/components/footer-legal-links";
import { homeFooterGroups } from "@/components/site-footer-groups";
import { SiteHeader } from "@/components/site-header";
import {
  VoiceAnywhereMock,
  VoiceDictationMock,
  VoiceEveryComputerMock,
  VoiceLiveMock,
  VoiceWakeWordMock,
} from "@/components/product-mocks/voice-mocks";
import styles from "./voice.module.css";
import { StellaMark } from "@/components/stella-mark";

export const metadata: Metadata = {
  title: "Voice",
  description:
    "Talk to Stella out loud with fast cloud dictation and optional wake-word detection.",
  alternates: { canonical: "/voice" },
};

export default function VoicePage() {
  return (
    <div className={`stella-page ${styles.page}`}>
      <SiteHeader />

      <main>
        <section className={`grid-shell ${styles.heroSection}`}>
          <div className={styles.hero}>
            <span className={styles.eyebrow}>
              Voice
            </span>
            <h1>Talk to Stella out loud.</h1>
            <p>
              Speak instead of type, or just say &quot;Hey Stella.&quot; Your
              words turn into text the moment you stop talking — hands-free,
              wherever you are.
            </p>
          </div>
        </section>

        {/* Cloud dictation */}
        <section className={`grid-shell section-border ${styles.section}`} data-reveal>
          <div className={styles.row}>
            <div className={styles.copy} data-reveal-child>
              <span className={styles.eyebrow}>
                Cloud dictation
              </span>
              <h2>Your voice becomes text instantly.</h2>
              <p>
                Press the key and talk. Stella streams your speech to its cloud
                dictation service, so your words show up the moment you finish.
              </p>
            </div>

            <div
              className={styles.visual}
              aria-hidden="true"
              data-reveal-child
              style={{ ["--reveal-index" as string]: 1 }}
            >
              <VoiceDictationMock />
            </div>
          </div>
        </section>

        {/* Dictate anywhere */}
        <section className={`grid-shell section-border ${styles.section}`} data-reveal>
          <div className={`${styles.row} ${styles["row--flip"]}`}>
            <div className={styles.copy} data-reveal-child>
              <span className={styles.eyebrow}>
                Anywhere
              </span>
              <h2>Talk to type in any app.</h2>
              <p>
                Dictation isn&apos;t just for Stella. Use it in any app on your
                computer and the words drop straight into whatever you&apos;re
                typing — email, notes, chat, anywhere.
              </p>
            </div>

            <div
              className={styles.visual}
              aria-hidden="true"
              data-reveal-child
              style={{ ["--reveal-index" as string]: 1 }}
            >
              <VoiceAnywhereMock />
            </div>
          </div>
        </section>

        {/* Cross-platform dictation */}
        <section className={`grid-shell section-border ${styles.section}`} data-reveal>
          <div className={styles.row}>
            <div className={styles.copy} data-reveal-child>
              <span className={styles.eyebrow}>
                Every computer
              </span>
              <h2>It works on every computer.</h2>
              <p>
                Stella uses the same cloud dictation service on every supported
                computer, so dictation behaves the same on Windows and Mac.
              </p>
            </div>

            <div
              className={styles.visual}
              aria-hidden="true"
              data-reveal-child
              style={{ ["--reveal-index" as string]: 1 }}
            >
              <VoiceEveryComputerMock />
            </div>
          </div>
        </section>

        {/* Hey Stella wake word */}
        <section className={`grid-shell section-border ${styles.section}`} data-reveal>
          <div className={`${styles.row} ${styles["row--flip"]}`}>
            <div className={styles.copy} data-reveal-child>
              <span className={styles.eyebrow}>
                Wake word
              </span>
              <h2>Just say &quot;Hey Stella.&quot;</h2>
              <p>
                Flip on the wake word and start talking with no clicking and no
                keyboard. It listens for &quot;Hey Stella&quot; right on your
                computer, stays off until you turn it on, and steps back the
                moment you say &quot;bye.&quot;
              </p>
            </div>

            <div
              className={styles.visual}
              aria-hidden="true"
              data-reveal-child
              style={{ ["--reveal-index" as string]: 1 }}
            >
              <VoiceWakeWordMock />
            </div>
          </div>
        </section>

        {/* Live voice conversation */}
        <section className={`grid-shell section-border ${styles.section}`} data-reveal>
          <div className={styles.row}>
            <div className={styles.copy} data-reveal-child>
              <span className={styles.eyebrow}>
                Live conversation
              </span>
              <h2>Have a real conversation.</h2>
              <p>
                Talk back and forth like a phone call. Stella hears you in real
                time, answers out loud, and can even take a look at your screen
                when you ask her to.
              </p>
              <p className={styles.planNote}>
                Live conversation and having Stella read her replies aloud come
                with the <Link href="/pricing">Pro plan</Link>. Dictation and
                &quot;Hey Stella&quot; are on every tier.
              </p>
            </div>

            <div
              className={styles.visual}
              aria-hidden="true"
              data-reveal-child
              style={{ ["--reveal-index" as string]: 1 }}
            >
              <VoiceLiveMock />
            </div>
          </div>
        </section>

        {/* Closing */}
        <section className={`grid-shell section-border ${styles.closingSection}`}>
          <div className={styles.closing}>
            <span className={styles.eyebrow}>
              Just talk
            </span>
            <h2>Type less. Say more.</h2>
            <p>
              Whether it&apos;s a quick note or a full conversation, Stella&apos;s
              ready the second you start talking — hands-free, on every computer.
            </p>
            <div className={styles.closingCta}>
              <DownloadButton />
            </div>
            <WindowsInstallNote />
            <p className="download-reassurance">
              Free. No credit card, no trial.
            </p>
          </div>
        </section>
      </main>

      <footer className="grid-shell site-footer section-border">
        <div className="footer-brand">
          <Link className="brand-mark brand-mark--footer" href="/">
            <StellaMark size={42} />
            <span className="brand-text">Stella</span>
          </Link>
          <FooterLegalLinks />
        </div>

        <div className="footer-columns">
          {homeFooterGroups.map((group) => (
            <div key={group.title} className="footer-column">
              <h3>{group.title}</h3>
              <ul>
                {group.items.map((item) => (
                  <li key={item.label}>
                    {item.external ? (
                      <a
                        href={item.href}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {item.label}
                      </a>
                    ) : (
                      <Link href={item.href}>{item.label}</Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </footer>
    </div>
  );
}
