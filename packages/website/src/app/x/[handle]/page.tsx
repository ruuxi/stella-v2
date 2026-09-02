import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DownloadButton } from "@/components/download-button";
import { tryReadConvexSiteUrl } from "@/lib/convex-urls";
import styles from "./x-handle-page.module.css";

export const metadata: Metadata = {
  title: "Your plan from Stella",
  description: "What Stella would do for the task you asked about on X.",
  robots: { index: false, follow: false },
};

// Only the runs are cached, and only briefly: the bot writes a new row the
// moment it replies, and the reader usually arrives within minutes.
export const revalidate = 60;

const X_HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;

type XBotPageRun = {
  id: string;
  mentionId: string;
  replyId: string;
  summonerUsername: string;
  posterUsername: string;
  headline: string;
  reply: string;
  exchanges: Array<{ user: string; stella: string }>;
  imageUrl: string | null;
  createdAt: number;
};

type XBotPage = {
  handle: string | null;
  runs: XBotPageRun[];
};

const loadPage = async (handle: string): Promise<XBotPage | null> => {
  const siteUrl = tryReadConvexSiteUrl();
  if (!siteUrl) return null;
  try {
    const response = await fetch(
      `${siteUrl}/api/x/bot/page/${encodeURIComponent(handle)}`,
      { next: { revalidate } },
    );
    if (!response.ok) return null;
    return (await response.json()) as XBotPage;
  } catch {
    return null;
  }
};

const formatDate = (value: number) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));

export default async function XHandlePage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  const normalized = decodeURIComponent(handle ?? "")
    .trim()
    .replace(/^@/, "");
  if (!X_HANDLE_PATTERN.test(normalized)) {
    notFound();
  }
  const page = await loadPage(normalized);
  if (!page || page.runs.length === 0) {
    notFound();
  }
  const display = page.handle ?? normalized;
  const [latest, ...earlier] = page.runs;

  return (
    <div className="stella-page">
      <main className={styles.page}>
        <header className={styles.hero}>
          <div className={styles.badge}>For @{display}</div>
          <h1 className={styles.title}>{latest.headline}</h1>
          <p className={styles.lede}>
            You asked about this on X. Here is what handing it to Stella looks
            like, and the prompt to paste in once it is installed. Stella is a
            free desktop assistant that works inside your apps, browser, files,
            and terminal, and asks before anything that matters.
          </p>
          <div className={styles.actions}>
            <DownloadButton />
            <a
              className={styles.replyLink}
              href={`https://x.com/i/status/${encodeURIComponent(latest.replyId)}`}
              rel="noopener noreferrer"
              target="_blank"
            >
              See the reply on X
            </a>
          </div>
        </header>

        <RunSection run={latest} display={display} featured />

        {earlier.length > 0 ? (
          <section className={styles.earlier} aria-labelledby="earlier-plans">
            <h2 id="earlier-plans" className={styles.earlierTitle}>
              Earlier plans for @{display}
            </h2>
            <div className={styles.earlierList}>
              {earlier.map((run) => (
                <RunSection key={run.id} run={run} display={display} />
              ))}
            </div>
          </section>
        ) : null}

        <footer className={styles.footer}>
          <Link className={styles.homeLink} href="/">
            Back to stella.sh
          </Link>
        </footer>
      </main>
    </div>
  );
}

function RunSection({
  run,
  display,
  featured = false,
}: {
  run: XBotPageRun;
  display: string;
  featured?: boolean;
}) {
  const prompt = run.exchanges.map((exchange) => exchange.user).join("\n");
  return (
    <section
      className={featured ? `${styles.run} ${styles.runFeatured}` : styles.run}
      aria-label={featured ? "Your plan" : run.headline}
    >
      {run.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className={styles.card}
          src={run.imageUrl}
          alt={`Stella's plan card for @${display}: ${run.headline}`}
          width={1600}
          height={900}
          loading={featured ? "eager" : "lazy"}
        />
      ) : null}
      <div className={styles.runBody}>
        {featured ? null : <h3 className={styles.runTitle}>{run.headline}</h3>}
        <div className={styles.chat}>
          {run.exchanges.map((exchange, index) => (
            <div key={index} className={styles.exchange}>
              <p className={styles.userMessage}>{exchange.user}</p>
              <p className={styles.assistantMessage}>{exchange.stella}</p>
            </div>
          ))}
        </div>
        <div className={styles.promptBlock}>
          <div className={styles.promptLabel}>Paste this into Stella</div>
          <pre className={styles.prompt}>{prompt}</pre>
        </div>
        <p className={styles.meta}>
          Summoned by @{run.summonerUsername} under a post by @
          {run.posterUsername} on {formatDate(run.createdAt)}.
        </p>
      </div>
    </section>
  );
}
