import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, Check } from "lucide-react";
import { AuroraCanvas } from "@/components/aurora-canvas";
import { DownloadButton } from "@/components/download-button";
import { FooterLegalLinks } from "@/components/footer-legal-links";
import { homeFooterGroups } from "@/components/site-footer-groups";
import { SiteHeader } from "@/components/site-header";
import { StellaMark } from "@/components/stella-mark";
import { FIX_PAGES, getFixPage } from "@/lib/fix-pages";
import "../fix.css";

export const dynamicParams = false;

export function generateStaticParams() {
  return FIX_PAGES.map((page) => ({ slug: page.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = getFixPage(slug);
  if (!page) return {};
  return {
    title: page.metaTitle,
    description: page.metaDescription,
    alternates: { canonical: `/fix/${page.slug}` },
  };
}

export default async function FixPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const page = getFixPage(slug);
  if (!page) notFound();

  return (
    <div className="stella-page fix-page">
      <SiteHeader />

      <main>
        <section className="fix-hero section-border">
          <AuroraCanvas className="fix-aurora" />
          <div className="fix-hero__copy">
            <p className="fix-eyebrow">{page.eyebrow}</p>
            <h1>
              {page.headline} <span>{page.headlineAccent}</span>
            </h1>
            <p className="fix-lede">{page.lede}</p>
            <div className="fix-actions">
              <DownloadButton />
              <Link className="button button--ghost" href="/pricing">
                See pricing
                <ArrowRight size={16} />
              </Link>
            </div>
            <p className="fix-offer">
              Free to start — no setup, no API keys. Go is $5/mo, Pro is
              $15/mo.
            </p>
          </div>
        </section>

        <section
          className="fix-section section-border"
          aria-label="Searches this page answers"
        >
          <header className="fix-section__header">
            <p className="fix-eyebrow">Sound familiar?</p>
            <h2>You&apos;ve probably already searched this.</h2>
          </header>
          <ul className="fix-symptoms">
            {page.symptoms.map((symptom) => (
              <li key={symptom}>{symptom}</li>
            ))}
          </ul>
        </section>

        <section className="fix-section section-border">
          <header className="fix-section__header">
            <p className="fix-eyebrow">How it works</p>
            <h2>Tell Stella. It works your computer. Done.</h2>
            <p>
              Stella is a desktop AI agent that can actually use your computer
              — your apps, your browser, your files. You describe the problem
              in plain words; it does the fixing.
            </p>
          </header>

          <div className="fix-steps">
            <article className="fix-step">
              <span className="fix-step__num">1</span>
              <h3>Tell Stella the problem</h3>
              <p>In your own words. No settings to hunt for, no forum-speak.</p>
              <p className="fix-prompt">&ldquo;{page.prompt}&rdquo;</p>
            </article>
            <article className="fix-step">
              <span className="fix-step__num">2</span>
              <h3>Stella works your computer</h3>
              <p>
                It opens what needs opening, reads the real errors, and does
                the actual fix — while you watch every step it takes.
              </p>
            </article>
            <article className="fix-step">
              <span className="fix-step__num">3</span>
              <h3>Done — and you saw all of it</h3>
              <p>
                Stella confirms the fix worked and shows you what changed.
                Anything destructive waits for your OK first.
              </p>
            </article>
          </div>
        </section>

        <section className="fix-section section-border">
          <header className="fix-section__header">
            <p className="fix-eyebrow">On this problem</p>
            <h2>What Stella actually does.</h2>
          </header>
          <ul className="fix-does">
            {page.steps.map((step) => (
              <li key={step}>
                <Check size={16} strokeWidth={2.5} aria-hidden="true" />
                {step}
              </li>
            ))}
          </ul>
          <aside className="fix-scope">
            <h3>Honest scope</h3>
            <p>{page.scope}</p>
          </aside>
        </section>

        <section className="fix-cta">
          <div>
            <p className="fix-eyebrow">Ready when you are</p>
            <h2>{page.ctaHeadline}</h2>
            <p>
              Download Stella free for Mac or Windows and tell it what&apos;s
              broken.
            </p>
          </div>
          <div className="fix-actions">
            <DownloadButton />
            <Link className="button button--ghost" href="/fix">
              More things Stella fixes
              <ArrowRight size={16} />
            </Link>
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
