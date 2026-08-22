import { Check, CircleDashed, FileText, Globe, Loader2 } from "lucide-react";
import { MockWindow } from "./mock-window";
import ui from "./mock-ui.module.css";
import styles from "./go-mocks.module.css";

/* /go visuals. The hero stacks three surfaces the desktop app really has —
   the unified-diff "Changes" view, the in-app browser, and the chat that
   drove both — so the page opens on one assistant working across the
   computer instead of a decorative diagram. */

const DIFF_LINES: Array<{ kind: "meta" | "add" | "del"; marker: string; code: string }> = [
  { kind: "meta", marker: "", code: "export function signIn(user) {" },
  { kind: "del", marker: "-", code: "  const ttl = 60 * 5;" },
  { kind: "add", marker: "+", code: "  const ttl = 60 * 60 * 12;" },
  { kind: "add", marker: "+", code: "  if (!session) throw expired();" },
  { kind: "meta", marker: "", code: "  return signSession(user, ttl);" },
  { kind: "meta", marker: "", code: "}" },
  { kind: "meta", marker: "", code: "" },
  { kind: "meta", marker: "", code: "export function refresh(token) {" },
  { kind: "del", marker: "-", code: "  return signIn(token.user);" },
  { kind: "add", marker: "+", code: "  return rotate(token, ttl);" },
];

const DIFF_TAIL: typeof DIFF_LINES = [
  { kind: "del", marker: "-", code: "  maxAge: 300," },
  { kind: "add", marker: "+", code: "  maxAge: ttl," },
  { kind: "add", marker: "+", code: "  rolling: true," },
];

export function GoHeroStack() {
  return (
    <div className={styles.hero} aria-hidden="true">
      <MockWindow
        title="Stella"
        trailing={
          <span className={ui.chip} data-tone="accent">
            3 running
          </span>
        }
      >
        <div className={styles.heroSplit}>
          <div className={styles.chatPane}>
            <p className={styles.ask}>
              Fix the session timeout, file the permit, and put October&apos;s
              receipts in a sheet.
            </p>
            <p className={styles.replyLine}>
              Reading the auth code now.
            </p>
            <p className={styles.ask}>
              don&apos;t sign me out mid-session again
            </p>
            <p className={styles.replyLine}>
              On it — all three. The diff stays on the right while I work;
              nothing lands until you say so.
            </p>
            <div className={styles.work}>
              <div className={styles.workRow}>
                <span className={styles.tick}>
                  <Check size={13} aria-hidden="true" />
                </span>
                <span>Edited src/server/auth.ts</span>
              </div>
              <div className={styles.workRow}>
                <span className={styles.spin}>
                  <Loader2 size={13} aria-hidden="true" />
                </span>
                <span className={styles.spinStill}>
                  <CircleDashed size={13} aria-hidden="true" />
                </span>
                <span>Filling the permit form in your browser</span>
              </div>
              <div className={styles.workRow}>
                <span className={styles.spin}>
                  <Loader2 size={13} aria-hidden="true" />
                </span>
                <span className={styles.spinStill}>
                  <CircleDashed size={13} aria-hidden="true" />
                </span>
                <span>Building expenses-october.xlsx</span>
              </div>
              <div className={styles.workRow}>
                <span className={styles.tick}>
                  <Check size={13} aria-hidden="true" />
                </span>
                <span>Ran the auth test suite — 41 passed</span>
              </div>
              <div className={styles.workRow}>
                <span className={styles.tick}>
                  <Check size={13} aria-hidden="true" />
                </span>
                <span>Pulled 18 receipts out of receipts-oct.zip</span>
              </div>
            </div>
          </div>

          <aside className={styles.displayPane}>
            <div className={styles.tabs}>
              <span className={styles.tab} data-active="true">
                Changes
              </span>
              <span className={styles.tab}>
                <Globe size={10} aria-hidden="true" />
                Browser
              </span>
            </div>
            <div className={styles.diff}>
              <span className={styles.diffFile}>src/server/auth.ts</span>
              {DIFF_LINES.map((line, i) => (
                <div
                  className={styles.diffLine}
                  data-kind={line.kind}
                  key={`a${i}`}
                >
                  <span>{line.marker}</span>
                  <code>{line.code}</code>
                </div>
              ))}
              <span className={styles.diffFile}>src/server/session.ts</span>
              {DIFF_TAIL.map((line, i) => (
                <div
                  className={styles.diffLine}
                  data-kind={line.kind}
                  key={`b${i}`}
                >
                  <span>{line.marker}</span>
                  <code>{line.code}</code>
                </div>
              ))}
            </div>
            <div className={styles.diffFoot}>
              <span className={ui.chip}>3 files changed</span>
              <span className={styles.diffTime}>2m</span>
            </div>
          </aside>
        </div>
      </MockWindow>
    </div>
  );
}

export function GoDiffPreview() {
  return (
    <div className={styles.preview} aria-hidden="true">
      <div className={styles.previewBar}>
        <span className={styles.previewDots} />
        Changes · 3 files
      </div>
      <div className={styles.previewDiff}>
        {DIFF_LINES.slice(1, 5).map((line) => (
          <div className={styles.diffLine} data-kind={line.kind} key={line.code}>
            <span>{line.marker}</span>
            <code>{line.code}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

const DELIVERABLES = [
  { label: "quarterly-report.docx", color: "#2b5fc0" },
  { label: "budget.xlsx", color: "#1f8a52" },
  { label: "review.pptx", color: "#d24625" },
  { label: "summary.pdf", color: "#d33a36" },
];

export function GoFilesPreview() {
  return (
    <div className={styles.preview} aria-hidden="true">
      <div className={styles.previewBar}>
        <span className={styles.previewDots} />
        Files
      </div>
      <div className={styles.previewBody}>
        <div className={styles.fileChips}>
          {DELIVERABLES.map((file) => (
            <span className={styles.fileChip} key={file.label}>
              <i style={{ background: file.color }} />
              {file.label}
            </span>
          ))}
        </div>
        <span className={`${styles.fileChip} ${styles.fileChipStart}`}>
          <FileText size={9} aria-hidden="true" />
          Written from your notes
        </span>
      </div>
    </div>
  );
}

export function GoCapturePreview() {
  return (
    <div className={styles.preview} aria-hidden="true">
      <div className={styles.previewBar}>
        <span className={styles.previewDots} />
        Capture
      </div>
      <div className={styles.previewBody}>
        <div className={styles.capture}>
          <span className={styles.captureRing} />
          <span className={styles.captureHint}>
            Click to capture window - drag to capture region - Right-click or
            Esc to cancel
          </span>
        </div>
      </div>
    </div>
  );
}
