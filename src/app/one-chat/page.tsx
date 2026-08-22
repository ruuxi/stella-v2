import type { Metadata } from "next";
import Link from "next/link";
import {
  AudioLines,
  Bell,
  Box,
  CalendarClock,
  Cpu,
  FileText,
  Image as ImageIcon,
  KeyRound,
  MessageSquare,
  Mic,
  Music,
  Send,
  Video,
} from "lucide-react";
import { DownloadButton } from "@/components/download-button";
import { WindowsInstallNote } from "@/components/windows-install-note";
import { FooterLegalLinks } from "@/components/footer-legal-links";
import { homeFooterGroups } from "@/components/site-footer-groups";
import { SiteHeader } from "@/components/site-header";
import styles from "./one-chat.module.css";
import { StellaMark } from "@/components/stella-mark";

export const metadata: Metadata = {
  title: "One chat",
  description:
    "Stella is one ongoing conversation. Questions, tasks, follow-ups, results, and scheduled things all live in one place. Work runs in the background without freezing your chat, and nothing gets lost between threads — because there are no threads.",
  alternates: { canonical: "/one-chat" },
};

export default function OneChatPage() {
  return (
    <div className={`stella-page ${styles.page}`}>
      <SiteHeader />

      <main>
        <section className={`grid-shell ${styles.heroSection}`}>
          <div className={styles.hero}>
            <span className={styles.eyebrow}>
              One chat
            </span>
            <h1>One chat. Everything in it.</h1>
            <p>
              Other chat apps spread your life across a dozen threads. Stella
              is one ongoing conversation — ask, follow up, get results, come
              back tomorrow. It&apos;s all right here.
            </p>
          </div>
        </section>

        {/* One place */}
        <section className={`grid-shell section-border ${styles.section}`}>
          <div className={styles.row}>
            <div className={styles.copy}>
              <span className={styles.eyebrow}>
                One place
              </span>
              <h2>Everything you ask lives in one place.</h2>
              <p>
                Most chatbots want a fresh thread for every question, so your
                history ends up scattered and the context goes with it. In
                Stella there&apos;s just one conversation. The trip you planned
                last week, the email from this morning, the thing you&apos;re
                about to ask — same place, same Stella.
              </p>
            </div>

            <div className={styles.visual} aria-hidden="true">
              <div className={styles.flow}>
                <div className={`${styles.bubble} ${styles["bubble--you"]}`}>
                  &ldquo;plan my trip&rdquo;
                </div>
                <div className={`${styles.bubble} ${styles["bubble--you"]}`}>
                  &ldquo;draft the emails&rdquo;
                </div>
                <div className={`${styles.bubble} ${styles["bubble--you"]}`}>
                  &ldquo;actually, make it Thursday&rdquo;
                </div>
                <span className={styles.down} />
                <div className={styles.stella}>
                  <span className={styles.stellaIcon}>
                    <StellaMark size={18} />
                  </span>
                  <div className={styles.stellaText}>
                    <strong>Stella</strong>
                    <em>one ongoing conversation</em>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Background work / non-blocking */}
        <section className={`grid-shell section-border ${styles.section}`}>
          <div className={`${styles.row} ${styles["row--flip"]}`}>
            <div className={styles.copy}>
              <span className={styles.eyebrow}>
                No waiting
              </span>
              <h2>Work runs in the background. Your chat stays open.</h2>
              <p>
                Ask for something big and Stella gets going on it without
                freezing the conversation. Keep typing, ask something else,
                step away — she brings the result back into the same chat the
                moment it&apos;s ready.
              </p>
            </div>

            <div className={styles.visual} aria-hidden="true">
              <div className={styles.flow}>
                <div className={styles.runStack}>
                  <span className={styles.runRow}>
                    <span className={styles.runDot} />
                    research flights
                    <em>running</em>
                  </span>
                  <span className={styles.runRow}>
                    <span className={styles.runDot} />
                    draft emails
                    <em>running</em>
                  </span>
                  <span className={styles.runRow} data-done="true">
                    <span className={styles.runDot} />
                    book a table
                    <em>done</em>
                  </span>
                </div>
                <span className={styles.down} />
                <div className={`${styles.bubble} ${styles["bubble--you"]}`}>
                  <Send size={14} />
                  …and you keep typing
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Nothing lost */}
        <section className={`grid-shell section-border ${styles.section}`}>
          <div className={styles.row}>
            <div className={styles.copy}>
              <span className={styles.eyebrow}>
                Nothing lost
              </span>
              <h2>No threads. So nothing falls between them.</h2>
              <p>
                There&apos;s no hunting for the chat where you asked that thing.
                Follow-ups, results, reminders, and scheduled work all land in
                the one conversation you already have — with the context still
                intact.
              </p>
            </div>

            <div className={styles.visual} aria-hidden="true">
              <div className={styles.flow}>
                <div className={styles.branchRow}>
                  <span className={styles.piece}>
                    <MessageSquare size={14} />
                    follow-up
                  </span>
                  <span className={styles.piece}>
                    <FileText size={14} />
                    result
                  </span>
                  <span className={styles.piece}>
                    <Bell size={14} />
                    reminder
                  </span>
                  <span className={styles.piece}>
                    <CalendarClock size={14} />
                    scheduled check-in
                  </span>
                </div>
                <span className={styles.gather} />
                <div className={styles.stella}>
                  <span className={styles.stellaIcon}>
                    <StellaMark size={18} />
                  </span>
                  <div className={styles.stellaText}>
                    <strong>Stella</strong>
                    <em>all in the same chat</em>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Engines / BYOK / zero setup */}
        <section className={`grid-shell section-border ${styles.section}`}>
          <div className={`${styles.row} ${styles["row--flip"]}`}>
            <div className={styles.copy}>
              <span className={styles.eyebrow}>
                Any brain you like
              </span>
              <h2>Nothing to set up — or bring your own.</h2>
              <p>
                Out of the box, Stella runs on her own models. No keys, no
                accounts, no setup — just open the app and go. Prefer something
                else? Plug in Claude, Codex, Cursor, or your own key and Stella
                runs on that instead.
              </p>
            </div>

            <div className={styles.visual} aria-hidden="true">
              <div className={styles.engineGrid}>
                <span className={`${styles.engineTile} ${styles["engineTile--lead"]}`}>
                  <StellaMark size={18} />
                  Stella
                  <em>zero setup</em>
                </span>
                <span className={styles.engineTile}>
                  <Cpu size={16} />
                  Claude
                </span>
                <span className={styles.engineTile}>
                  <Cpu size={16} />
                  Codex
                </span>
                <span className={styles.engineTile}>
                  <Cpu size={16} />
                  Cursor
                </span>
                <span className={styles.engineTile}>
                  <KeyRound size={16} />
                  Your own key
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Built-in media */}
        <section className={`grid-shell section-border ${styles.section}`}>
          <div className={styles.row}>
            <div className={styles.copy}>
              <span className={styles.eyebrow}>
                Built in
              </span>
              <h2>Pictures, voice, and more — on Pro.</h2>
              <p>
                Ask Stella to make an image, a video, a song, or a spoken
                reading, and she just does it. It runs on the house models with
                nothing extra to wire up, and it comes with the{" "}
                <Link href="/pricing">Pro plan</Link>.
              </p>
            </div>

            <div className={styles.visual} aria-hidden="true">
              <div className={styles.chipCloud}>
                <span className={styles.chip}>
                  <ImageIcon size={14} />
                  Images
                </span>
                <span className={styles.chip}>
                  <Video size={14} />
                  Video
                </span>
                <span className={styles.chip}>
                  <Music size={14} />
                  Music
                </span>
                <span className={styles.chip}>
                  <AudioLines size={14} />
                  Sound
                </span>
                <span className={styles.chip}>
                  <Box size={14} />
                  3D
                </span>
                <span className={styles.chip}>
                  <Mic size={14} />
                  Live voice
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Closing */}
        <section className={`grid-shell section-border ${styles.closingSection}`}>
          <div className={styles.closing}>
            <span className={styles.eyebrow}>
              One conversation, start to finish
            </span>
            <h2>Ask once. Keep talking.</h2>
            <p>
              One ongoing chat, with the work happening behind it — on
              Stella&apos;s models or yours. Running several jobs at once in
              the background comes with <Link href="/pricing">Pro</Link>;
              other plans work through one at a time.
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
