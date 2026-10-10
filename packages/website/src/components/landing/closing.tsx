"use client";

import Link from "next/link";
import { useRef } from "react";
import { DownloadButton } from "@/components/download-button";
import { FooterLegalLinks } from "@/components/footer-legal-links";
import { homeFooterGroups } from "@/components/site-footer-groups";
import { StellaMark } from "@/components/stella-mark";
import { AuroraField } from "./aurora-field";
import { useInViewOnce } from "./motion";
import l from "./landing.module.css";
import o from "./closing.module.css";

const SOURCE = `  private async take(
    cwd: string,
    source: TakeSource,
  ): Promise<void | { background: true }> {
    const head = await git(cwd, ["rev-parse", "HEAD"]);
    const plan = await classifyUpdate(cwd, head, source.ref);
    this.options.log("app-source.take-planned", {
      from: source.kind,
      kind: plan.kind,
    });
    if (plan.kind === "none") throw new Error(source.emptyMessage);
    let to = plan.kind === "fast-forward" ? plan.tip : "";
    if (plan.kind === "conflict") {
      return await this.dispatchMerge(cwd, source, source.brief(plan, head));
    }
    if (plan.kind === "clean") {
      // The merge exists as objects only: nothing is checked out and the
      // checkout's branch has not moved, so giving up here leaves no state.
      to = await git(
        cwd,
        ["commit-tree", plan.tree, "-p", head, "-p", plan.tip, "-m", source.subject],
        { env: await this.identityEnv(cwd) },
      );
      if (!(source.trustIdenticalTree && plan.identical)) {
        const gate = await checkMergedUpdate(cwd, to, this.options.updateScratchDir);
        if (!gate.ok) {
          return await this.dispatchMerge(cwd, source, source.brief(plan, head, gate.output));
        }
      }
    }
    // No line in the chat for this: it applied while the user watched the
    // button, exactly like a fast-forward.
    await git(cwd, ["merge", "--ff-only", to]);
    await source.settle?.(to);
    await this.swapIn(cwd, head, to);
  }`;

const HIGHLIGHT = `    await git(cwd, ["merge", "--ff-only", to]);`;

export function OpenSourceAct() {
  const ref = useRef<HTMLElement>(null);
  const lines = SOURCE.split("\n");

  useInViewOnce(ref);

  return (
    <section ref={ref} className={o.source} data-tone="light" data-bg="#ffffff" aria-labelledby="source-title">
      <div className={o.wall} aria-hidden="true">
        {[0, 1, 2].map((col) => (
          <pre key={col} className={o.col}>
            {lines.map((line, i) => (
              <span key={i}>
                {line || " "}
                {"\n"}
              </span>
            ))}
          </pre>
        ))}
      </div>
      <h2 id="source-title" className={o.sourceTitle}>
        Open <span>source.</span>
      </h2>
      <code className={o.hot}>{HIGHLIGHT.trim()}</code>
      <span className={o.license}>Apache-2.0</span>
    </section>
  );
}

export function Finale() {
  return (
    <section id="get" className={`${o.finale} ${l.invert}`} data-tone="dark" data-bg="#060609" aria-labelledby="get-title">
      <div className={o.finaleAurora}>
        <AuroraField className={o.finaleCanvas} dark />
      </div>
      <h2 id="get-title" className={o.word}>
        <StellaMark className={o.wordMark} />
        Stella
      </h2>
      <div className={o.getRow}>
        <DownloadButton />
        <span className={o.free}>Free.</span>
      </div>
      <div className={o.stores}>
        <a href="https://apps.apple.com/us/app/stella-your-ai/id6761148311" target="_blank" rel="noopener noreferrer">
          iPhone
        </a>
        <a href="https://play.google.com/store/apps/details?id=com.fromyou.stella" target="_blank" rel="noopener noreferrer">
          Android
        </a>
        <Link href="/chat">Web</Link>
        <Link href="/download/linux">Linux</Link>
      </div>
    </section>
  );
}

export function LandingFooter() {
  return (
    <footer className={o.footer} data-tone="dark" data-bg="#060609">
      <div className={o.footBrand}>
        <StellaMark size={26} />
        <span>Stella</span>
      </div>
      <nav className={o.footCols} aria-label="Footer">
        {homeFooterGroups.map((group) => (
          <div key={group.title}>
            <h3>{group.title}</h3>
            <ul>
              {group.items.map((item) => (
                <li key={item.label}>
                  {item.external ? (
                    <a href={item.href} target="_blank" rel="noopener noreferrer">
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
      </nav>
      <div className={o.legal}>
        <FooterLegalLinks />
      </div>
    </footer>
  );
}
