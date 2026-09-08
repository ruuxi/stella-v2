import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { DownloadButton } from "@/components/download-button";
import { WindowsInstallNote } from "@/components/windows-install-note";
import { LearnSidebar } from "./learn-sidebar";

export const metadata: Metadata = {
  title: "Learn More",
  description:
    "Learn what Stella can do, how to use it, and what changed recently.",
  alternates: { canonical: "/learn-more" },
};

const capabilities = [
  {
    title: "Use your computer",
    body: "Inspect the screen, click, type, open apps, navigate windows, and work with what is actually in front of you.",
  },
  {
    title: "Use the web",
    body: "Browse, search, read pages, fill forms, and use browser context when it helps.",
  },
  {
    title: "Work with files",
    body: "Read, write, organize, summarize, and transform documents, spreadsheets, PDFs, presentations, images, and generated outputs.",
  },
  {
    title: "Create media",
    body: "Help make images, video, audio, 3D assets, small apps, games, mockups, and visual artifacts. Image, video, 3D, and voice generation come with the Pro plan.",
  },
  {
    title: "Listen and speak",
    body: "Use in-app dictation, OS-wide dictation, read-aloud, and realtime voice. Wake-word activation is optional. Dictation and wake word are on every tier; read-aloud and realtime voice come with the Pro plan.",
  },
  {
    title: "Run routines",
    body: "Create reminders, recurring check-ins, scheduled work, and automations from plain English.",
  },
  {
    title: "Connect apps",
    body: "Use supported services, including the Stella mobile app, Google Workspace, and Store-backed integrations.",
  },
  {
    title: "Choose your model",
    body: "Use Stella's managed provider, bring your own keys, use local models, pick OpenRouter-style options where supported, or select Claude Code as the engine.",
  },
];

const accessMethods = [
  {
    title: "Full desktop window",
    body: "Chat, display, settings, history, Store, media, files, and everything else in one place.",
  },
  {
    title: "Quick access",
    body: "Capture, chat, add context, or start voice from the app or page you are already using.",
  },
  {
    title: "Mini window",
    body: "Keep a smaller Stella surface nearby for fast asks without taking over your screen.",
  },
  {
    title: "Voice and dictation",
    body: "Dictate into Stella, dictate into other apps when enabled, or talk to Stella in realtime.",
  },
  {
    title: "Phone",
    body: "Pair the mobile app with your desktop so your phone can message the Stella running on your computer.",
  },
  {
    title: "Mobile app",
    body: "Message Stella from the mobile app. Full desktop-powered execution depends on pairing with your desktop, which stays available.",
  },
];

function SectionHeader({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="learn-section__header">
      <span className="learn-eyebrow">{eyebrow}</span>
      <h2>{title}</h2>
      {children ? <div className="learn-section__lede">{children}</div> : null}
    </header>
  );
}

export default function LearnMore() {
  return (
    <main className="learn-shell">
      <LearnSidebar current="learn-more" />

        <article className="learn-content">
          <section id="overview" className="learn-hero section-border">
            <div className="learn-hero__copy">
              <span className="learn-eyebrow">Learn more</span>
              <h1>
                Stella, <span className="learn-hero__accent">in detail</span>.
              </h1>
              <p>
                A desktop app that gives you one ongoing chat for your
                computer. Ask once, keep talking, and Stella figures out which
                agent, app, file, browser, model, or tool should handle the
                work.
              </p>
              <p>
                Background agents can handle independent work and report
                progress inline without making you manage separate threads.
              </p>
              <div className="learn-hero__actions">
                <DownloadButton />
              </div>
              <WindowsInstallNote />
              <p className="download-reassurance">
                Free. No credit card, no trial.
              </p>
            </div>
          </section>

          <section id="what-stella-is" className="learn-section section-border">
            <SectionHeader eyebrow="What Stella is" title="A desktop app, not just a chat box">
              <p>
                Stella works with your files, apps, and browser to help you
                get things done.
              </p>
            </SectionHeader>
            <div className="learn-prose">
              <p>
                You can use Stella for research, writing, spreadsheets, PDFs,
                Word documents, browser tasks, computer control, image
                generation, video and 3D workflows, media prompts, scheduling,
                reminders, dictation, realtime voice, and connected apps.
              </p>
              <p>
                Those capabilities belong in one personal desktop app, one chat,
                and a consistent interface instead of a maze of separate tools
                and modes.
              </p>
            </div>
          </section>

          <section id="one-chat" className="learn-section section-border">
            <SectionHeader eyebrow="One chat" title="You keep talking in the same place">
              <p>
                Most agent products make you choose a mode, start a new thread,
                pick a specialist, then remember where everything went. Stella
                keeps the top-level experience continuous.
              </p>
            </SectionHeader>
            <div className="learn-prose">
              <p>
                Behind the scenes, Stella can split work into smaller jobs, run
                specialized agents, keep track of active threads, and bring the
                result back into the conversation. Orchestrator mode is the
                default, so you stay in one conversation instead of becoming the
                project manager for your assistant.
              </p>
            </div>
          </section>

          <section id="capabilities" className="learn-section section-border">
            <SectionHeader eyebrow="Capabilities" title="What Stella can do" />
            <div className="learn-grid learn-grid--two">
              {capabilities.map((item) => (
                <section key={item.title} className="learn-tile">
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </section>
              ))}
            </div>
          </section>

          <section id="access" className="learn-section section-border">
            <SectionHeader eyebrow="Access" title="Ways to reach Stella" />
            <div className="learn-list">
              {accessMethods.map((item) => (
                <section key={item.title} className="learn-row">
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </section>
              ))}
            </div>
          </section>

          <section id="privacy" className="learn-section section-border">
            <SectionHeader eyebrow="Privacy" title="Your privacy">
              <p>
                Read our <Link href="/privacy">Privacy Policy</Link> for details
                on how Stella handles your information and the choices available
                to you.
              </p>
            </SectionHeader>
          </section>

          <section id="models" className="learn-section section-border">
            <SectionHeader eyebrow="Models" title="Use Stella, BYOK, local models, or Claude Code">
              <p>
                Stella has a managed path for convenience and a provider-control
                path for people who want to bring their own providers.
              </p>
            </SectionHeader>
            <div className="learn-prose">
              <p>
                Stella Provider lets you install the app and start using strong
                models without setting up accounts everywhere. Requests pass
                through Stella&apos;s infrastructure so billing and limits can
                work. Responses may be buffered briefly for stream recovery,
                and providers may retain submitted data under their policies.
              </p>
              <p>
                You can also add your own provider credentials, use local
                runtimes, and use Claude Code directly as the assistant engine.
                In those paths, Stella is acting as the desktop app and runtime
                you control, not as the model vendor.
              </p>
            </div>
          </section>

          <section id="whats-new-link" className="learn-section section-border">
            <SectionHeader eyebrow="What's new" title="A running changelog">
              <p>
                Stella ships preview updates almost daily. The full log,
                grouped by date with new features and fixes, lives on its own
                page so you can scroll the history without leaving Learn More.
              </p>
            </SectionHeader>
            <Link
              className="button button--ghost learn-section__link"
              href="/learn-more/whats-new"
            >
              Read the changelog
              <ArrowRight size={16} />
            </Link>
          </section>

          <section className="learn-cta">
            <h2>Stella is your desktop app.</h2>
            <p>Ready to work across your computer.</p>
            <DownloadButton />
            <p className="download-reassurance">
              Free. No credit card, no trial.
            </p>
          </section>
      </article>
    </main>
  );
}
