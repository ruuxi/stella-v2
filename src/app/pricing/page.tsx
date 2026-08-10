import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { FooterLegalLinks } from "@/components/footer-legal-links";
import { homeFooterGroups } from "@/components/site-footer-groups";
import { SiteHeader } from "@/components/site-header";
import "./pricing.css";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Stella pricing — Free to try, Go for generous everyday usage, Pro for image, video, 3D and voice generation plus orchestrator mode.",
  alternates: { canonical: "/pricing" },
};

// Mirrors `STATIC_PLAN_DISPLAY`, `PLAN_USAGE_TAGLINE` and `PLAN_FEATURES`
// in `src/app/billing/billing-client.tsx` so /pricing and /billing always
// describe the same plans. `PRICING_MD` in `src/lib/agent-pages.ts` mirrors
// this page for agents — update all three together.
//
// When the Go intro promo runs in Convex
// (`STELLA_GO_INTRO_FIRST_MONTH_PRICE_CENTS`), keep `introFirstMonthPriceUsd`
// here in sync so marketing matches `/billing`.
const plans: {
  name: string;
  price: number;
  /** Shown alongside recurring `price`; must match Convex intro cents ÷ 100. */
  introFirstMonthPriceUsd?: number;
  tagline: string;
  features: string[];
  /** Muted line under the checklist — used to state what a tier does *not* do. */
  note?: string;
  featured?: boolean;
}[] = [
  {
    name: "Free",
    price: 0,
    tagline: "$0.50 of usage to try Stella — once, not every month",
    features: [
      "Coding agent",
      "Personal assistant",
      "Research and knowledge work",
    ],
    note: "A one-time credit. It does not refresh — once it is used, it is used. Dictation included; text output only.",
  },
  {
    name: "Go",
    price: 5,
    introFirstMonthPriceUsd: 3,
    tagline: "Room to actually work, every day",
    features: [
      "Everything in Free",
      "Up to ~$12 of model usage per 5 hours",
      "~$30 a week, ~$60 a month",
      "Refreshes with your billing cycle",
    ],
    note: "Dictation included; text output only. Generation and orchestrator mode are on Pro.",
  },
  {
    name: "Pro",
    price: 15,
    tagline: "Everything Stella can make, not just more of it",
    featured: true,
    features: [
      "Everything in Go",
      "Image, video, 3D and voice generation",
      "Orchestrator mode — many agents at once",
    ],
    note: "The only tier that can create media and run work in parallel. Dictation is on every tier — Pro adds spoken replies and live conversation.",
  },
];

const included = [
  "Runs on your computer",
  "Private by default",
  "Coding, assistant and research in one app",
  "Dictation and wake word on every tier",
  "Customizable interface",
  "Desktop and mobile access",
  "Bring your own models and keys",
];

export default function Pricing() {
  return (
    <div className="stella-page">
      <SiteHeader />

      <main>
        {/* ── Hero ─────────────────────────────────── */}
        <section className="grid-shell pr-hero section-border">
          <div className="pr-article">
            <h1 className="pr-title reveal">
              <span>Simple,</span> transparent pricing
            </h1>
            <p className="pr-subtitle reveal reveal-delay-1">
              Free is a taste. Go is where the usage gets generous. Pro is a
              different product — the tier that can generate image, video, 3D
              and voice, and run a whole team of agents at once.
            </p>
          </div>
        </section>

        {/* ── Plan cards ───────────────────────────── */}
        <section className="grid-shell pr-section section-border">
          <div className="pr-grid-wrap">
            <div className="pr-grid">
              {plans.map((plan, i) => (
                <div
                  key={plan.name}
                  className={`pr-card reveal${plan.featured ? " pr-card--featured" : ""}`}
                  style={{ animationDelay: `${i * 60}ms` }}
                >
                  {plan.featured && (
                    <span className="pr-card__badge">Popular</span>
                  )}

                  <div className="pr-card__head">
                    <h3 className="pr-card__name">{plan.name}</h3>
                    {typeof plan.introFirstMonthPriceUsd === "number" &&
                    plan.introFirstMonthPriceUsd > 0 &&
                    plan.introFirstMonthPriceUsd < plan.price ? (
                      <div className="pr-card__price-bundle">
                        <div className="pr-card__price pr-card__price--intro-offer">
                          <span className="pr-card__amount">
                            ${plan.introFirstMonthPriceUsd}
                          </span>
                          <span className="pr-card__period pr-card__period--phrase">
                            first month
                          </span>
                        </div>
                        <p className="pr-card__price-then">
                          Then{" "}
                          <strong>${plan.price}</strong>
                          <span aria-hidden="true">/mo</span> after that
                        </p>
                      </div>
                    ) : (
                      <div className="pr-card__price">
                        <span className="pr-card__amount">
                          ${plan.price}
                        </span>
                        {plan.price > 0 ? (
                          <span className="pr-card__period">/mo</span>
                        ) : null}
                      </div>
                    )}
                    <p className="pr-card__tagline">{plan.tagline}</p>
                  </div>

                  <ul className="pr-card__features">
                    {plan.features.map((f) => (
                      <li key={f}>
                        <Check size={14} strokeWidth={2.5} />
                        {f}
                      </li>
                    ))}
                  </ul>

                  {plan.note ? (
                    <p className="pr-card__note">{plan.note}</p>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Every plan includes ──────────────────── */}
        <section className="grid-shell pr-section section-border">
          <div className="pr-article">
            <h2>Every plan includes</h2>
            <p className="pr-note">
              You are not paying for an API key. Every tier comes with the whole
              desktop app — the assistant, research, the browser, your files —
              and usage limits that hold their own at the price.
            </p>
            <ul className="pr-included">
              {included.map((item) => (
                <li key={item}>
                  <Check size={15} strokeWidth={2.5} />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ── CTA ──────────────────────────────────── */}
        <section className="grid-shell pr-cta-section">
          <div className="pr-article pr-cta reveal">
            <h2>Start with Stella for free</h2>
            <p>
              No credit card required. Download Stella and try it today.
            </p>
            <Link className="button button--primary" href="/">
              Get Started
              <ArrowRight size={16} />
            </Link>
          </div>
        </section>
      </main>

      {/* ── Footer ─────────────────────────────────── */}
      <footer className="grid-shell site-footer section-border">
        <div className="footer-brand">
          <Link className="brand-mark brand-mark--footer" href="/">
            <Image
              src="/stella-logo-ui.png"
              alt="Stella"
              width={42}
              height={42}
            />
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
                      <a href={item.href}>{item.label}</a>
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
