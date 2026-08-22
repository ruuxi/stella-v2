import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Bot, Check, Laptop } from "lucide-react";
import { DownloadButton } from "@/components/download-button";
import { WindowsInstallNote } from "@/components/windows-install-note";
import { FooterLegalLinks } from "@/components/footer-legal-links";
import { homeFooterGroups } from "@/components/site-footer-groups";
import { SiteHeader } from "@/components/site-header";
import {
  GoCapturePreview,
  GoDiffPreview,
  GoFilesPreview,
  GoHeroStack,
} from "@/components/product-mocks/go-mocks";
import "./go.css";
import { StellaMark } from "@/components/stella-mark";

export const metadata: Metadata = {
  title: "AI coding agent and personal assistant",
  description:
    "Stella is an AI agent for coding, research, documents, browsers, files, and desktop apps, with paid plans for higher usage.",
  alternates: { canonical: "/go" },
};

const work = [
  {
    preview: GoDiffPreview,
    title: "Build and fix software",
    body: "Read repositories, edit code, run commands, debug failures, and hand independent work to background agents.",
  },
  {
    preview: GoFilesPreview,
    title: "Create real deliverables",
    body: "Research a topic, then turn the result into editable documents, spreadsheets, presentations, and PDFs.",
  },
  {
    preview: GoCapturePreview,
    title: "Work across your computer",
    body: "Use your browser, files, and desktop apps to finish tasks instead of stopping at an answer in a chat box.",
  },
];

const included = [
  "Local-first desktop app",
  "Mac, Windows, and Linux",
  "Bring your own AI models",
];

export default function GoPage() {
  return (
    <div className="stella-page go-page">
      <SiteHeader />

      <main>
        <section className="go-hero section-border">
          <div className="go-hero__copy">
            <p className="go-eyebrow">
              Personal assistant · Knowledge work · Coding agent
            </p>
            <h1>
              One agent for <span>more than code.</span>
            </h1>
            <p className="go-hero__lede">
              Stella works across codebases, research, documents, your browser,
              files, and desktop apps—so the same assistant can finish the rest
              of the job too.
            </p>
            <div className="go-hero__actions">
              <DownloadButton />
              <Link className="button button--ghost" href="/pricing">
                See pricing
                <ArrowRight size={16} />
              </Link>
            </div>
            <WindowsInstallNote />
            <p className="go-offer">
              Free. No credit card, no trial. Go includes 10× higher usage.
            </p>
          </div>

          <div className="go-hero__visual" aria-label="Ways Stella can work">
            <GoHeroStack />
          </div>
        </section>

        <section className="go-proof section-border" aria-label="Included with Stella">
          {included.map((item) => (
            <span key={item}>
              <Check size={15} strokeWidth={2.5} aria-hidden="true" />
              {item}
            </span>
          ))}
        </section>

        <section className="go-section section-border" id="work" data-reveal>
          <header className="go-section__header">
            <p className="go-eyebrow">Coding is only the start</p>
            <h2>Keep one assistant for the whole job.</h2>
            <p>
              Keep one conversation for the whole job. Stella can take action in
              the tools already on your computer while background agents keep
              independent work moving.
            </p>
          </header>

          <div className="go-work-grid">
            {work.map(({ preview: Preview, title, body }) => (
              <article className="go-work-card" key={title}>
                <Preview />
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="go-section go-choice section-border" data-reveal>
          <div>
            <p className="go-eyebrow">Your models, or ours</p>
            <h2>Use Stella without another required subscription.</h2>
            <p>
              Bring supported provider keys, or choose Stella&apos;s managed models
              when you want one account and no provider setup.
            </p>
          </div>
          <div className="go-choice__cards">
            <article>
              <Laptop aria-hidden="true" />
              <strong>Bring your own models</strong>
              <span>$0 for the Stella app</span>
            </article>
            <article>
              <Bot aria-hidden="true" />
              <strong>Stella managed AI</strong>
              <span>Go: $5/month</span>
            </article>
          </div>
        </section>

        <section className="go-cta">
          <div>
            <p className="go-eyebrow">Ready when you are</p>
            <h2>Give Stella the task. Keep moving.</h2>
            <p>Download the desktop app and give it a task.</p>
          </div>
          <div className="go-cta__actions">
            <DownloadButton />
          </div>
          <WindowsInstallNote />
          <p className="download-reassurance">
            Free. No credit card, no trial.
          </p>
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
                    <a
                      href={item.href}
                      target={item.external ? "_blank" : undefined}
                      rel={item.external ? "noopener noreferrer" : undefined}
                    >
                      {item.label}
                    </a>
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
