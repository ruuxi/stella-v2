import {
  ArrowUp,
  AudioLines,
  Check,
  Cloud,
  Laptop,
  Mic,
  Monitor,
  Paperclip,
  X,
} from "lucide-react";
import { MockWindow } from "./mock-window";
import { StellaMark } from "@/components/stella-mark";
import ui from "./mock-ui.module.css";
import styles from "./voice-mocks.module.css";

/* Product-accurate mini-mocks for /voice. Every string inside a window is
   verbatim from the app's catalog (`settings.audio.*`, `app.chat.voiceSession`);
   anything the app does not put on screen is stated in a caption underneath.
   Surfaces modelled: the in-composer dictation bar (waveform · timer · cancel ·
   confirm · send), the 300px OS-wide dictation pill, Settings › Audio, and the
   "Talked with Stella" session pill in the transcript. */

/* Deterministic level history so SSR and the client render identically. 120
   samples is more than any container can show; `.wave` anchors them right and
   fades the oldest, so the meter is always full. */
const BAR_SEED = [
  22, 38, 60, 46, 74, 92, 70, 54, 84, 100, 76, 58, 40, 66, 88, 96, 72, 50, 34,
  62, 90, 78, 56, 44, 68, 86, 98, 74, 52, 36, 60, 82, 94, 66, 48, 30, 54, 76,
  88, 64, 42, 26, 48, 70, 58, 36, 24, 40,
];

const BAR_HEIGHTS = Array.from(
  { length: 120 },
  (_, i) => BAR_SEED[(i * 7 + (i % 5)) % BAR_SEED.length],
);

function Wave() {
  return (
    <span className={styles.wave} aria-hidden="true">
      {BAR_HEIGHTS.map((height, i) => (
        <i
          key={i}
          style={{
            height: `${height}%`,
            ["--i" as string]: i % 24,
          }}
        />
      ))}
    </span>
  );
}

export function VoiceDictationMock() {
  return (
    <div className={styles.frame}>
      <MockWindow title="Stella" className={styles.tall}>
        <div className={styles.transcript}>
          <span className={styles.ask}>
            Write Priya a note that the Thursday review moved to Friday at 10.
          </span>
          <p className={styles.reply}>
            Drafted it — subject &ldquo;Review moved to Friday 10:00&rdquo;.
            Want me to send it?
          </p>
          <span className={ui.chip}>
            <Paperclip size={10} aria-hidden="true" />
            review-notes.md
          </span>
        </div>

        <div className={styles.composer}>
          <Wave />
          <span className={styles.timer}>0:07</span>
          <span className={styles.ctl}>
            <X size={14} aria-hidden="true" />
          </span>
          <span className={styles.ctl} data-strong="true">
            <Check size={15} aria-hidden="true" />
          </span>
          <span className={styles.ctl} data-send="true">
            <ArrowUp size={14} aria-hidden="true" />
          </span>
        </div>
      </MockWindow>

      <p className={ui.caption}>
        <Mic size={13} aria-hidden="true" />
        Hold the dictation key and talk. Stella streams your speech to its cloud
        dictation service and inserts the transcript when you stop.
      </p>
    </div>
  );
}

export function VoiceAnywhereMock() {
  return (
    <div className={styles.frame}>
      <div className={styles.desk}>
        <MockWindow title="New Message">
          <div className={styles.mailBody}>
            <div className={styles.mailField}>
              <span className={styles.mailLabel}>To:</span>
              <span className={styles.mailValue}>priya@northwind.co</span>
            </div>
            <div className={styles.mailField}>
              <span className={styles.mailLabel}>Cc:</span>
              <span className={styles.mailValue}>design@northwind.co</span>
            </div>
            <div className={styles.mailField}>
              <span className={styles.mailLabel}>Subject:</span>
              <span className={styles.mailValue}>
                Review moved to Friday 10:00
              </span>
            </div>
            <p className={styles.mailText}>
              Hi Priya — quick heads up that Thursday&apos;s review has moved to
              Friday at 10. Same room, same agenda, and the deck is already in
              the shared folder if you want a look beforehand. I&apos;ll bring
              the updated numbers and the one-pager
              <span className={styles.caret} />
            </p>
          </div>
        </MockWindow>

        <div className={styles.pill}>
          <Wave />
          <span className={styles.timer}>0:12</span>
        </div>
      </div>

      <p className={ui.caption}>
        <Laptop size={13} aria-hidden="true" />
        The dictation bar floats above whatever app you&apos;re in; the text
        lands in the field you were already typing in.
      </p>
    </div>
  );
}

export function VoiceEveryComputerMock() {
  return (
    <div className={styles.frame}>
      <div className={styles.pair}>
        <MockWindow
          title="Settings — Audio"
          icon={<Laptop size={12} aria-hidden="true" />}
        >
          <div className={ui.section}>
            <div className={ui.sectionHead}>
              <span>Mac</span>
            </div>
            <ul className={ui.list}>
              <li className={ui.row}>
                <span className={ui.rowText}>
                  <span className={ui.rowTitle}>Super Fast dictation</span>
                  <span className={ui.rowSub}>
                    Keep the microphone warm so dictation starts with less
                    delay.
                  </span>
                </span>
                <span className={ui.toggle} data-state="on" />
              </li>
              <li className={ui.row}>
                <span className={ui.rowText}>
                  <span className={ui.rowTitle}>Dictation sounds</span>
                  <span className={ui.rowSub}>
                    Play a sound when dictation starts and stops.
                  </span>
                </span>
                <span className={ui.toggle} data-state="on" />
              </li>
            </ul>
          </div>
        </MockWindow>

        <MockWindow
          title="Settings — Audio"
          icon={<Monitor size={12} aria-hidden="true" />}
        >
          <div className={ui.section}>
            <div className={ui.sectionHead}>
              <span>Windows</span>
            </div>
            <ul className={ui.list}>
              <li className={ui.row}>
                <span className={ui.rowText}>
                  <span className={ui.rowTitle}>Enable microphone</span>
                  <span className={ui.rowSub}>
                    Required for talking to Stella.
                  </span>
                </span>
                <span className={ui.toggle} data-state="on" />
              </li>
              <li className={ui.row}>
                <span className={ui.rowText}>
                  <span className={ui.rowTitle}>Super Fast dictation</span>
                  <span className={ui.rowSub}>
                    Keep the microphone warm so dictation starts with less
                    delay.
                  </span>
                </span>
                <span className={ui.toggle} data-state="on" />
              </li>
            </ul>
          </div>
        </MockWindow>
      </div>

      <p className={ui.caption}>
        <Cloud size={13} aria-hidden="true" />
        Stella uses one cloud dictation path everywhere. Same key, same bar,
        same result.
      </p>
    </div>
  );
}

export function VoiceWakeWordMock() {
  return (
    <div className={styles.frame}>
      <div className={styles.wakeStack}>
        <MockWindow title="Settings — Audio">
          <div className={ui.section}>
            <div className={ui.sectionHead}>
              <span>Microphone</span>
            </div>
            <ul className={ui.list}>
              <li className={ui.row}>
                <span className={ui.rowText}>
                  <span className={ui.rowTitle}>Enable microphone</span>
                  <span className={ui.rowSub}>
                    Required for talking to Stella.
                  </span>
                </span>
                <span className={ui.toggle} data-state="on" />
              </li>
              <li className={ui.row}>
                <span className={ui.rowText}>
                  <span className={ui.rowTitle}>Hey Stella wake word</span>
                  <span className={ui.rowSub}>
                    Listen for &ldquo;Hey Stella&rdquo; in the background and
                    start a voice conversation. When off, mic stays idle until
                    you press dictate.
                  </span>
                </span>
                <span className={ui.toggle} data-state="off" />
              </li>
            </ul>
          </div>
        </MockWindow>

        <div className={styles.wakeCard}>
          <span className={styles.wakeSprite}>
            <span className={styles.wakeRing} />
            <span className={styles.wakeRing} />
            <StellaMark size={22} />
          </span>
          <span className={styles.wakeText}>
            <span className={styles.wakeSaid}>&ldquo;Hey Stella&rdquo;</span>
            <span className={styles.wakeReply}>
              Hi. What should we get done?
            </span>
          </span>
        </div>
      </div>

      <p className={ui.caption}>
        <Mic size={13} aria-hidden="true" />
        Off by default, and it listens on your own machine. Say
        &ldquo;bye&rdquo; and it steps back.
      </p>
    </div>
  );
}

export function VoiceLiveMock() {
  return (
    <div className={styles.frame}>
      <MockWindow title="Stella" className={styles.tall}>
        <div className={styles.transcript}>
          <span className={styles.ask}>Hey Stella</span>

          <span className={styles.sessionPill}>
            <AudioLines
              size={13}
              strokeWidth={1.75}
              className={styles.sessionIcon}
              aria-hidden="true"
            />
            <span className={styles.sessionLabel}>Talked with Stella</span>
            <span className={styles.sessionMeta}>4m 12s</span>
          </span>

          <p className={styles.reply}>
            Booked the 8:05 flight, moved the review to Friday, and put the
            summary in your inbox. Say &ldquo;bye&rdquo; whenever you&apos;re
            done.
          </p>
        </div>

        <div className={styles.composer}>
          <span className={styles.composerText}>Message Stella</span>
          <span className={styles.voiceButton}>
            <AudioLines size={15} aria-hidden="true" />
          </span>
        </div>
      </MockWindow>

      <p className={ui.caption}>
        <AudioLines size={13} aria-hidden="true" />
        Live back-and-forth voice and reading replies aloud come with the Pro
        plan; the finished call lands in the same conversation.
      </p>
    </div>
  );
}
