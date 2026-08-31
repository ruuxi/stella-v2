import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, Check } from "lucide-react";
import { AuroraCanvas } from "@/components/aurora-canvas";
import { DownloadButton } from "@/components/download-button";
import { FixHowItWorks } from "@/components/fix-how-it-works";
import { WindowsInstallNote } from "@/components/windows-install-note";
import { FooterLegalLinks } from "@/components/footer-legal-links";
import { homeFooterGroups } from "@/components/site-footer-groups";
import { SiteHeader } from "@/components/site-header";
import { StellaMark } from "@/components/stella-mark";
import { getFixPageDemo } from "@/lib/fix-page-demos";
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
            <WindowsInstallNote />
            <p className="fix-offer">
              Free to use
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

        <FixHowItWorks prompt={page.prompt} exchanges={getFixPageDemo(page.slug)} />

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
        </section>

        <section className="fix-cta">
          <div>
            <p className="fix-eyebrow">Ready when you are</p>
            <h2>{page.ctaHeadline}</h2>
            <p>
              Download Stella for Mac or Windows and tell it what&apos;s broken.
            </p>
          </div>
          <div className="fix-actions">
            <DownloadButton />
            <Link className="button button--ghost" href="/fix">
              More things Stella fixes
              <ArrowRight size={16} />
            </Link>
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
