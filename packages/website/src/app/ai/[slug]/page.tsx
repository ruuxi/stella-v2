import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DownloadButton } from "@/components/download-button";
import { Backdrop } from "@/components/landing/backdrop";
import { Finale, LandingFooter } from "@/components/landing/closing";
import { landingFontVars } from "@/components/landing/fonts";
import { LandingHeader } from "@/components/landing/landing-header";
import l from "@/components/landing/landing.module.css";
import { ANSWER_PAGES, faqJsonLd, getAnswerPage } from "@/lib/answers";
import { getSiteUrl } from "@/lib/site-url";
import a from "./answer.module.css";

export const dynamicParams = false;

export function generateStaticParams() {
  return ANSWER_PAGES.map((page) => ({ slug: page.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = getAnswerPage(slug);
  if (!page) return {};
  return {
    title: { absolute: `${page.metaTitle} | Stella` },
    description: page.metaDescription,
    alternates: { canonical: `/ai/${page.slug}` },
    openGraph: { title: page.metaTitle, description: page.metaDescription, url: `/ai/${page.slug}` },
  };
}

export default async function AnswerPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const page = getAnswerPage(slug);
  if (!page) notFound();

  const site = getSiteUrl();
  const url = new URL(`/ai/${page.slug}`, site).href;
  const jsonLd = [
    faqJsonLd(page.questions, url),
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Stella", item: site.origin },
        { "@type": "ListItem", position: 2, name: page.eyebrow, item: url },
      ],
    },
  ];
  const others = ANSWER_PAGES.filter((other) => other.slug !== page.slug);

  return (
    <div className={`${l.root} ${landingFontVars}`} data-landing-root="" data-native-scroll="">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <Backdrop />
      <LandingHeader />
      <main>
        <section className={a.hero} data-tone="light" data-bg="#ffffff" aria-labelledby="answer-title">
          <p className={a.eyebrow}>{page.eyebrow}</p>
          <h1 id="answer-title" className={a.title}>
            {page.headline}
          </h1>
          <p className={a.answer}>{page.answer}</p>
          <div className={a.cta}>
            <DownloadButton />
            <span className={a.free}>Free.</span>
          </div>
        </section>

        <section className={a.points} data-tone="light" data-bg="#ffffff" aria-label="What Stella does">
          {page.points.map((point) => (
            <div key={point.title} className={a.point}>
              <h2>{point.title}</h2>
              <p>{point.body}</p>
            </div>
          ))}
        </section>

        <section className={a.qa} data-tone="light" data-bg="#ffffff" aria-labelledby="answer-questions">
          <h2 id="answer-questions" className={a.qaTitle}>
            Questions.
          </h2>
          <div className={a.qaList}>
            {page.questions.map((item) => (
              <div key={item.q} className={a.qaItem}>
                <h3>{item.q}</h3>
                <p>{item.a}</p>
              </div>
            ))}
            <Link href="/#faq" className={a.qaMore}>
              More questions
            </Link>
          </div>
        </section>

        <nav className={a.more} data-tone="light" data-bg="#ffffff" aria-label="More about Stella">
          {others.map((other) => (
            <Link key={other.slug} href={`/ai/${other.slug}`}>
              {other.headline.replace(/\.$/, "")}
            </Link>
          ))}
        </nav>

        <Finale />
      </main>
      <LandingFooter />
    </div>
  );
}
