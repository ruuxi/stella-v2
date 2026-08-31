import Link from "next/link";
import { SiteNav } from "@/components/site-nav";
import { StellaMark } from "@/components/stella-mark";

export function SiteHeader() {
  return (
    <header className="grid-shell grid-shell--dense site-header">
      <div className="brand-wrap">
        <Link className="brand-mark" href="/">
          <span className="brand-mark__logo">
            <StellaMark className="brand-mark__logo-img" size={64} />
          </span>
          <span className="brand-text">Stella</span>
        </Link>
      </div>

      <SiteNav />
    </header>
  );
}
