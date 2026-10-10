import Link from "next/link";
import { ANSWER_PAGES, FAQ, faqJsonLd } from "@/lib/answers";
import { getSiteUrl } from "@/lib/site-url";
import f from "./faq.module.css";

export function FaqSection() {
  const url = new URL("/", getSiteUrl()).href;
  return (
    <section id="faq" className={f.faq} data-tone="light" data-bg="#ffffff" aria-labelledby="faq-title">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd(FAQ, url)) }}
      />
      <div className={f.head}>
        <h2 id="faq-title" className={f.title}>
          Questions.
        </h2>
      </div>
      <div className={f.list}>
        {FAQ.map((item, i) => (
          <details key={item.q} className={f.item} open={i === 0}>
            <summary className={f.q}>
              <span>{item.q}</span>
              <i className={f.icon} aria-hidden="true" />
            </summary>
            <div className={f.a}>
              <p>{item.a}</p>
            </div>
          </details>
        ))}
        <nav className={f.more} aria-label="Stella for">
          {ANSWER_PAGES.map((page) => (
            <Link key={page.slug} href={`/ai/${page.slug}`}>
              {page.headline.replace(/\.$/, "")}
            </Link>
          ))}
        </nav>
      </div>
    </section>
  );
}
