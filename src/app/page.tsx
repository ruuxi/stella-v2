import Link from "next/link";
import { FooterLegalLinks } from "@/components/footer-legal-links";
import { homeFooterGroups } from "@/components/site-footer-groups";
import { HomeDesktopMock } from "@/components/home-desktop-mock";
import { HomeDeferredSections } from "@/components/home-deferred-sections";
import { HomeHero } from "@/components/home-hero";
import { SiteHeader } from "@/components/site-header";
import { StellaMark } from "@/components/stella-mark";

export default function Home() {
  return (
    <div className="stella-page">
      <SiteHeader />

      <main>
        <HomeHero />
        <HomeDesktopMock />
        <HomeDeferredSections />
      </main>

      <footer className="grid-shell site-footer section-deferred-render section-border">
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
