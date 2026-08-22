import type { Metadata } from "next";
import Link from "next/link";
import { FooterLegalLinks } from "@/components/footer-legal-links";
import { homeFooterGroups } from "@/components/site-footer-groups";
import { SiteHeader } from "@/components/site-header";
import {
  StorageBackupsMock,
  StorageConnectorMock,
  StorageLocalChatMock,
  StoragePhoneMock,
  StorageRoutingMock,
} from "@/components/product-mocks/storage-mocks";
import styles from "./storage.module.css";
import { StellaMark } from "@/components/stella-mark";

export const metadata: Metadata = {
  title: "Storage",
  description:
    "Where Stella stores data locally, what its cloud services process, and when third-party providers handle request content.",
  alternates: { canonical: "/storage" },
};

export default function StoragePage() {
  return (
    <div className={`stella-page ${styles.page}`}>
      <SiteHeader />

      <main>
        <section className={`grid-shell ${styles.heroSection}`}>
          <div className={styles.hero}>
            <span className={styles.eyebrow}>
              Storage
            </span>
            <h1>Where Stella keeps your data.</h1>
            <p>
              Your normal desktop database lives on your computer. Managed AI,
              media, search, mobile access, and connected services process the
              data needed to fulfill your requests.
            </p>
          </div>
        </section>

        {/* Local-first chat */}
        <section className={`grid-shell section-border ${styles.section}`} data-reveal>
          <div className={styles.row}>
            <div className={styles.copy} data-reveal-child>
              <span className={styles.eyebrow}>
                On your device
              </span>
              <h2>Your conversations live on your laptop.</h2>
              <p>
                Your normal desktop chat history is saved in a database on your
                computer. Relevant content can be sent to Stella and third-party
                providers when a request uses a cloud-backed feature.
              </p>
            </div>

            <div
              className={styles.visual}
              aria-hidden="true"
              data-reveal-child
              style={{ ["--reveal-index" as string]: 1 }}
            >
              <StorageLocalChatMock />
            </div>
          </div>
        </section>

        {/* Backups */}
        <section className={`grid-shell section-border ${styles.section}`} data-reveal>
          <div className={`${styles.row} ${styles["row--flip"]}`}>
            <div className={styles.copy} data-reveal-child>
              <span className={styles.eyebrow}>
                Backups
              </span>
              <h2>Backups stay off until you ask.</h2>
              <p>
                If you ever want a safety copy, you can turn backups on. They
                get locked tight before they leave your computer, and they come
                with a paid plan. Backups are off until you turn them on.
              </p>
            </div>

            <div
              className={styles.visual}
              aria-hidden="true"
              data-reveal-child
              style={{ ["--reveal-index" as string]: 1 }}
            >
              <StorageBackupsMock />
            </div>
          </div>
        </section>

        {/* Connectors */}
        <section className={`grid-shell section-border ${styles.section}`} data-reveal>
          <div className={styles.row}>
            <div className={styles.copy} data-reveal-child>
              <span className={styles.eyebrow}>
                Texts &amp; chat apps
              </span>
              <h2>Messages run through your own machine.</h2>
              <p>
                Connect Stella to your texts or chat apps and the work happens
                on your computer — it reads the message, does the task, and
                sends the reply. Stella&apos;s backend processes request content,
                routing data, and delivery state needed to connect the service
                to your machine.
              </p>
            </div>

            <div
              className={styles.visual}
              aria-hidden="true"
              data-reveal-child
              style={{ ["--reveal-index" as string]: 1 }}
            >
              <StorageConnectorMock />
            </div>
          </div>
        </section>

        {/* Phone control */}
        <section className={`grid-shell section-border ${styles.section}`} data-reveal>
          <div className={`${styles.row} ${styles["row--flip"]}`}>
            <div className={styles.copy} data-reveal-child>
              <span className={styles.eyebrow}>
                From your phone
              </span>
              <h2>Your phone can reach your desktop.</h2>
              <p>
                Use the app to reach your computer from anywhere. Stella&apos;s
                backend handles pairing, routing, and temporary delivery state,
                including request content when needed to complete the work.
              </p>
            </div>

            <div
              className={styles.visual}
              aria-hidden="true"
              data-reveal-child
              style={{ ["--reveal-index" as string]: 1 }}
            >
              <StoragePhoneMock />
            </div>
          </div>
        </section>

        {/* Sharing */}
        <section className={`grid-shell section-border ${styles.section}`} data-reveal>
          <div className={styles.row}>
            <div className={styles.copy} data-reveal-child>
              <span className={styles.eyebrow}>
                Cloud features
              </span>
              <h2>Some features need remote processing.</h2>
              <p>
                Managed AI, media generation, search, connected services,
                mobile delivery, backups, and publishing send the content and
                metadata needed to provide those features. Providers may retain
                submitted data under their own policies and configurations.
              </p>
            </div>

            <div
              className={styles.visual}
              aria-hidden="true"
              data-reveal-child
              style={{ ["--reveal-index" as string]: 1 }}
            >
              <StorageRoutingMock />
            </div>
          </div>
        </section>

        {/* Closing */}
        <section className={`grid-shell section-border ${styles.closingSection}`}>
          <div className={styles.closing}>
            <span className={styles.eyebrow}>
              Learn more
            </span>
            <h2>Local storage and cloud processing are separate.</h2>
            <p>
              You can inspect and delete your local Stella data. Account,
              billing, usage, device, delivery, and optional cloud-feature data
              may be stored by Stella, while providers handle submitted data
              under their own policies. Read the Privacy Policy for details.
            </p>
            <div className={styles.closingCta}>
              <Link className="button button--primary" href="/privacy">
                Read the Privacy Policy
              </Link>
            </div>
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
                    {item.external ? (
                      <a
                        href={item.href}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {item.label}
                      </a>
                    ) : (
                      <Link href={item.href}>{item.label}</Link>
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
