import {
  Check,
  Cloud,
  Database,
  FileSpreadsheet,
  FileText,
  HardDrive,
  Image as ImageIcon,
  Laptop,
  Lock,
  MessageSquare,
  Mic,
  Paperclip,
  Send,
  Signal,
  Smartphone,
  Wifi,
} from "lucide-react";
import { MockWindow } from "./mock-window";
import ui from "./mock-ui.module.css";
import styles from "./storage-mocks.module.css";

/* Product-accurate mini-mocks for /storage, modelled on the real desktop app:
   the chat window, the Settings › Backups tab (segmented Off / hourly control,
   "Back Up Now", "No remote backups yet."), an inbound connector thread, and
   the phone paired to the desktop. Facts the app never puts on screen — the
   `~/.stella/stella.sqlite` location, what leaves the machine — are stated in
   a caption *under* the window, never faked as app chrome. Static frames: no
   hydration, no layout shift. */

const CHATS = [
  { title: "Lease renewal", meta: "8:41 AM", active: true },
  { title: "Q3 report", meta: "Yesterday" },
  { title: "Gym membership", meta: "Yesterday" },
  { title: "Lisbon flights", meta: "Tue" },
  { title: "Receipts → sheet", meta: "Mon" },
];

export function StorageLocalChatMock() {
  return (
    <div className={styles.frame}>
      <MockWindow title="Stella" className={styles.tall}>
        <div className={ui.split}>
          <aside className={`${ui.sidebar} ${styles.chatList}`}>
            <span className={ui.sideHead}>Chats</span>
            {CHATS.map((chat) => (
              <span
                key={chat.title}
                className={styles.chatItem}
                data-active={chat.active ? "true" : undefined}
              >
                <span className={styles.chatItemTitle}>{chat.title}</span>
                <span className={styles.chatItemMeta}>{chat.meta}</span>
              </span>
            ))}
          </aside>

          <div className={ui.pane}>
            <div className={ui.toolbar}>
              <span className={ui.toolbarTitle}>Lease renewal — 14 Elm St</span>
            </div>

            <div className={styles.transcript}>
              <span className={styles.ask}>
                Find the email from my landlord about the lease and tell him
                we&apos;re in.
              </span>
              <p className={styles.reply}>
                Done — I told Marcus you&apos;re staying another 12 months and
                asked him to hold rent at $1,450.
              </p>
              <div className={styles.replyFiles}>
                <span className={ui.chip}>
                  <FileText size={10} aria-hidden="true" />
                  lease-renewal.pdf
                </span>
                <span className={ui.chip}>
                  <Paperclip size={10} aria-hidden="true" />2 attachments
                </span>
              </div>
            </div>
          </div>
        </div>
      </MockWindow>

      <p className={ui.caption}>
        <Database size={13} aria-hidden="true" />
        Every message in this conversation is written to
        <span className={ui.captionPath}>~/.stella/stella.sqlite</span>
        on this computer.
      </p>
    </div>
  );
}

/* Settings tab order matches the app: General · Shortcuts · Backups ·
   Account & Legal · Audio. */
const SETTINGS_TABS = [
  { label: "General" },
  { label: "Shortcuts" },
  { label: "Backups", active: true },
  { label: "Account & Legal" },
  { label: "Audio" },
];

export function StorageBackupsMock() {
  return (
    <div className={styles.frame}>
      <MockWindow title="Settings" className={styles.tall}>
        <div className={ui.split}>
          <aside className={ui.sidebar}>
            {SETTINGS_TABS.map((tab) => (
              <span
                key={tab.label}
                className={ui.sideItem}
                data-active={tab.active ? "true" : undefined}
              >
                <span>{tab.label}</span>
              </span>
            ))}
          </aside>

          <div className={ui.pane}>
            <div className={ui.toolbar}>
              <span className={ui.toolbarTitle}>Backups</span>
            </div>

            <div className={ui.section}>
              <ul className={ui.list}>
                <li className={ui.row}>
                  <span className={ui.rowText}>
                    <span className={ui.rowTitle}>Automatic backups</span>
                    <span className={ui.rowSub}>Last local backup: Never</span>
                  </span>
                  <span className={styles.segment}>
                    <span data-selected="true">Off</span>
                    <span>Automatic hourly backups</span>
                  </span>
                </li>
                <li className={ui.row}>
                  <span className={ui.rowText}>
                    <span className={ui.rowTitle}>Back up now</span>
                    <span className={ui.rowSub}>
                      Save a backup right now. It uploads automatically when
                      you&apos;re signed in.
                    </span>
                  </span>
                  <span className={ui.btn}>Back Up Now</span>
                </li>
                <li className={ui.row}>
                  <span className={ui.rowText}>
                    <span className={ui.rowTitle}>Saved backups</span>
                    <span className={ui.rowSub}>No remote backups yet.</span>
                  </span>
                </li>
              </ul>
            </div>

            <div className={ui.notice}>
              <Cloud size={12} aria-hidden="true" />
              <span>Backups are included with any paid Stella plan.</span>
            </div>
          </div>
        </div>
      </MockWindow>

      <p className={ui.caption}>
        <Lock size={13} aria-hidden="true" />
        Off until you switch it on. A backup is sha256&apos;d and AES-encrypted
        on this computer before any of it is uploaded.
      </p>
    </div>
  );
}

export function StorageConnectorMock() {
  return (
    <div className={styles.frame}>
      <MockWindow
        title="Messages · +1 555 0148"
        icon={<MessageSquare size={12} aria-hidden="true" />}
        className={styles.tall}
      >
        <div className={ui.thread}>
          <span className={ui.bubbleIn}>
            hey — can you send me the invoice from tuesday?
          </span>

          <div className={styles.handoff}>
            <span className={ui.rowIcon} data-tone="neutral">
              <Laptop size={14} aria-hidden="true" />
            </span>
            <span className={styles.handoffText}>
              <span className={ui.rowTitle}>Handled on this Mac</span>
              <span className={ui.rowSub}>
                Read the message, found invoice-1042.pdf, wrote the reply
              </span>
            </span>
            <Check size={13} aria-hidden="true" />
          </div>

          <span className={ui.bubbleOut}>
            Sent — invoice #1042, $1,450, dated Tue. Attached the PDF.
          </span>
          <span className={`${ui.bubbleMeta} ${styles.metaRight}`}>
            Delivered · 8:42 AM
          </span>
        </div>
      </MockWindow>

      <p className={ui.caption}>
        <Send size={13} aria-hidden="true" />
        Stella&apos;s backend carries the message to your machine and the reply
        back out — routing and delivery state only.
      </p>
    </div>
  );
}

export function StoragePhoneMock() {
  return (
    <div className={styles.frame}>
      <div className={styles.pair}>
        <MockWindow
          title="Stella"
          trailing={
            <span className={ui.chip} data-tone="good">
              Awake
            </span>
          }
          className={styles.pairDesk}
        >
          <div className={ui.section}>
            <div className={ui.sectionHead}>
              <span>Running now</span>
              <span>MacBook Pro</span>
            </div>
            <ul className={ui.list}>
              <li className={ui.row}>
                <span className={ui.rowIcon}>
                  <FileSpreadsheet size={14} aria-hidden="true" />
                </span>
                <span className={ui.rowText}>
                  <span className={ui.rowTitle}>Building the expense sheet</span>
                  <span className={ui.rowSub}>18 receipts · 2 flagged</span>
                </span>
                <span className={ui.rowMeta}>0:12</span>
              </li>
              <li className={ui.row}>
                <span className={ui.rowIcon} data-tone="neutral">
                  <FileText size={14} aria-hidden="true" />
                </span>
                <span className={ui.rowText}>
                  <span className={ui.rowTitle}>Reading receipts-oct.zip</span>
                  <span className={ui.rowSub}>
                    Opened from your Downloads folder
                  </span>
                </span>
                <span className={ui.rowMeta}>0:04</span>
              </li>
              <li className={ui.row}>
                <span className={ui.rowIcon} data-tone="good">
                  <Check size={14} aria-hidden="true" />
                </span>
                <span className={ui.rowText}>
                  <span className={ui.rowTitle}>Sent to your phone</span>
                  <span className={ui.rowSub}>expenses-october.xlsx</span>
                </span>
                <span className={ui.rowMeta}>now</span>
              </li>
            </ul>
          </div>
        </MockWindow>

        <div className={styles.phone}>
          <div className={styles.phoneStatus}>
            <span>9:41</span>
            <span className={styles.phoneStatusIcons}>
              <Signal size={9} aria-hidden="true" />
              <Wifi size={9} aria-hidden="true" />
            </span>
          </div>
          <div className={styles.phoneHeader}>
            <Laptop size={11} aria-hidden="true" />
            MacBook Pro
            <span className={styles.phonePaired}>
              <Lock size={8} aria-hidden="true" />
              Paired
            </span>
          </div>
          <div className={styles.phoneBody}>
            <span className={styles.phoneAsk}>
              Turn October&apos;s receipts into a sheet
            </span>
            <p className={styles.phoneReply}>
              On it — working on your Mac. I&apos;ll send the file here.
            </p>
            <span className={ui.chip} data-tone="accent">
              <FileSpreadsheet size={9} aria-hidden="true" />
              expenses-october.xlsx
            </span>
          </div>
          <span className={styles.phoneHome} />
        </div>

      </div>

      <p className={ui.caption}>
        <Smartphone size={13} aria-hidden="true" />
        Pairing, routing and temporary delivery state run through Stella —
        the work itself happens on your desktop.
      </p>
    </div>
  );
}

const ROUTES = [
  {
    icon: MessageSquare,
    title: "Chats, memory, files",
    sub: "Written to the database on this computer",
    chip: "This Mac",
    tone: "good" as const,
  },
  {
    icon: Mic,
    title: "Dictation",
    sub: "On-device where supported, cloud elsewhere",
    chip: "This Mac / Cloud",
    tone: undefined,
  },
  {
    icon: Cloud,
    title: "Managed AI models",
    sub: "Request content goes to the model provider",
    chip: "Provider",
    tone: "warn" as const,
  },
  {
    icon: ImageIcon,
    title: "Media generation, search",
    sub: "Prompt and result metadata processed remotely",
    chip: "Provider",
    tone: "warn" as const,
  },
  {
    icon: Lock,
    title: "Backups (optional, off)",
    sub: "AES-encrypted on this Mac before upload",
    chip: "Encrypted",
    tone: undefined,
  },
];

/* Not a screenshot: a legend. It deliberately drops the window chrome so it
   never claims to be a settings screen the app does not have. */
export function StorageRoutingMock() {
  return (
    <div className={styles.frame}>
      <MockWindow chrome={false} className={styles.panel}>
        <div className={styles.panelHead}>
          <HardDrive size={13} aria-hidden="true" />
          Where each feature runs
        </div>
        <div className={ui.section}>
          <ul className={ui.list}>
            {ROUTES.map(({ icon: Icon, title, sub, chip, tone }) => (
              <li className={ui.row} key={title}>
                <span
                  className={ui.rowIcon}
                  data-tone={tone === "good" ? "good" : "neutral"}
                >
                  <Icon size={14} aria-hidden="true" />
                </span>
                <span className={ui.rowText}>
                  <span className={ui.rowTitle}>{title}</span>
                  <span className={ui.rowSub}>{sub}</span>
                </span>
                <span className={ui.chip} data-tone={tone}>
                  {chip}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </MockWindow>

      <p className={ui.caption}>
        <Cloud size={13} aria-hidden="true" />
        Providers keep submitted data under their own policies.
      </p>
    </div>
  );
}
