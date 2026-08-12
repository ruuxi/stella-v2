import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { AuroraCanvas } from "@/components/aurora-canvas";
import { DownloadButton } from "@/components/download-button";
import { FooterLegalLinks } from "@/components/footer-legal-links";
import { homeFooterGroups } from "@/components/site-footer-groups";
import { SiteHeader } from "@/components/site-header";
import { StellaMark } from "@/components/stella-mark";
import { FIX_PAGES } from "@/lib/fix-pages";
import "./fix.css";

export const metadata: Metadata = {
  title: "Things Stella just fixes",
  description:
    "Broken apps, full disks, mod chaos, spreadsheet drudgery — Stella is a desktop AI agent that works your computer and just fixes it. Free to start.",
  alternates: { canonical: "/fix" },
};

export default function FixIndexPage() {
  return (
    <div className="stella-page fix-page">
      <SiteHeader />

      <main>
        <section className="fix-hero section-border">
          <AuroraCanvas className="fix-aurora" />
          <div className="fix-hero__copy">
            <p className="fix-eyebrow">Fix it with Stella</p>
            <h1>
              Whatever broke, <span>tell Stella.</span>
            </h1>
            <p className="fix-lede">
              Stella is a desktop AI agent that can actually use your computer
              — apps, browser, files. Pick your problem below, or just
              download it and describe what&apos;s wrong in your own words.
            </p>
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

        <section className="fix-section" aria-label="Problems Stella fixes">
          <div className="fix-index-grid">
            {FIX_PAGES.map((page) => (
              <Link
                className="fix-index-card"
                key={page.slug}
                href={`/fix/${page.slug}`}
              >
                <h2>
                  {page.headline} <em>{page.headlineAccent}</em>
                </h2>
                <p>{page.metaDescription}</p>
              </Link>
            ))}
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
