"use client";

import { StellaMark } from "@/components/stella-mark";
import s from "./skins.module.css";

export function StellaSkin() {
  return (
    <div className={s.stella}>
      <div className={s.stellaBar}>
        <span className={s.lights}>
          <i />
          <i />
          <i />
        </span>
        <StellaMark size={18} className={s.stellaMark} />
        <span className={s.stellaAccount}>
          Account <small>Pro</small>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="3" />
            <path d="M15 4v16" />
          </svg>
        </span>
      </div>
      <div className={s.stellaColumn}>
        <p className={s.stamp}>Today 9:12 AM</p>
        <p className={s.me}>Clean up my Downloads folder?</p>
        <p className={s.her}>Done. 214 files sorted into 9 folders, and 3.2 GB of old installers moved to the Bin.</p>
        <p className={s.stamp}>Today 7:42 PM</p>
        <p className={s.me}>Find us a table for four on Friday around 8</p>
        <p className={s.her}>Booked Lucia for 8pm Friday. It&apos;s in your calendar, and I let Sam and Priya know.</p>
        <p className={s.me}>Perfect. Can you move my 9am to Monday?</p>
        <p className={s.her}>Done. Dr. Okafor confirmed Monday at 9.</p>
        <div className={s.composer}>
          <span className={s.plus}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </span>
          <span className={s.placeholder}>Do anything</span>
          <svg className={s.mic} viewBox="0 0 24 24" aria-hidden="true">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
          </svg>
          <span className={s.send}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 19V5M6 11l6-6 6 6" />
            </svg>
          </span>
        </div>
      </div>
    </div>
  );
}

const TRACKS = [
  { name: "KICK", steps: [0, 4, 8, 11, 12] },
  { name: "SNARE", steps: [4, 12, 15] },
  { name: "HATS", steps: [0, 2, 3, 6, 8, 10, 11, 14] },
  { name: "BASS", steps: [0, 3, 7, 10, 13] },
];
export function SynthSkin() {
  return (
    <div className={s.synth}>
      <div className={s.synthTop}>
        <div className={s.synthBrand}>
          <span>STELLA</span>
          <em>-8</em>
        </div>
        <div className={s.lcd}>
          <div className={s.lcdRow}>
            <span>PATTERN A</span>
            <span>118 BPM</span>
          </div>
          <svg className={s.scope} viewBox="0 0 400 40" preserveAspectRatio="none">
            <path d="M0 20 Q 12.5 2 25 20 T 50 20 T 75 20 T 100 20 T 125 20 T 150 20 T 175 20 T 200 20 T 225 20 T 250 20 T 275 20 T 300 20 T 325 20 T 350 20 T 375 20 T 400 20" />
          </svg>
        </div>
        <div className={s.knobs}>
          {["CUTOFF", "RES", "DRIVE", "SWING", "VERB"].map((label, i) => (
            <div key={label} className={s.knob} style={{ ["--k" as string]: `${-120 + i * 52 + (i % 2) * 30}deg` }}>
              <span className={s.knobFace} />
              <small>{label}</small>
            </div>
          ))}
        </div>
      </div>
      <div className={s.seq}>
        <span className={s.playhead} />
        {TRACKS.map((track, t) => (
          <div key={track.name} className={s.seqRow} data-track={t}>
            <span className={s.seqName}>{track.name}</span>
            <div className={s.pads}>
              {Array.from({ length: 16 }, (_, i) => (
                <span
                  key={i}
                  className={s.pad}
                  data-on={track.steps.includes(i) ? "1" : "0"}
                  data-beat={i % 4 === 0 ? "1" : "0"}
                  style={{ ["--d" as string]: `${i * 0.127}s` }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className={s.synthCmd}>
        <span>&gt;</span> make the hats swing a little more<i />
      </div>
    </div>
  );
}

const PLANETS = [
  { ring: 1, label: "Dentist", day: "TUE", size: 14, hue: "#7ef9ff", speed: 26, start: 40 },
  { ring: 2, label: "Ship v2", day: "THU", size: 22, hue: "#ff7ad9", speed: 40, start: 200 },
  { ring: 3, label: "Lisbon", day: "FRI", size: 30, hue: "#ffb547", speed: 58, start: 300 },
  { ring: 4, label: "Mum’s 60th", day: "SUN", size: 18, hue: "#8f8bff", speed: 80, start: 200 },
];

export function OrbitSkin() {
  return (
    <div className={s.orbit}>
      <div className={s.stars} />
      <p className={s.orbitTitle}>THIS WEEK</p>
      <div className={s.sun}>
        <StellaMark size={56} />
      </div>
      {PLANETS.map((p) => (
        <div
          key={p.label}
          className={s.ring}
          data-ring={p.ring}
          style={{
            ["--speed" as string]: `${p.speed}s`,
            ["--start" as string]: `${p.start}deg`,
          }}
        >
          <div className={s.planetArm}>
            <span
              className={s.planet}
              style={{ ["--size" as string]: `${p.size}px`, ["--hue" as string]: p.hue }}
            >
              <span className={s.planetSpin}>
                <span className={s.planetLabel}>
                  <b>{p.label}</b>
                  <small>{p.day}</small>
                </span>
              </span>
            </span>
          </div>
        </div>
      ))}
      <div className={s.orbitAsk}>Move Lisbon to Saturday</div>
    </div>
  );
}

export function RetroSkin() {
  return (
    <div className={s.retro}>
      <div className={s.retroMenu}>
        <span className={s.retroApple}>&#10035;</span>
        <b>Stella</b>
        <span>File</span>
        <span>Edit</span>
        <span>Chat</span>
        <span>Special</span>
      </div>
      <div className={s.retroIcons}>
        <span>
          <i className={s.iconDisk} />
          Macintosh HD
        </span>
        <span>
          <i className={s.iconSynth} />
          Notes
        </span>
        <span>
          <i className={s.iconTrash} />
          Trash
        </span>
      </div>
      <div className={s.retroWin}>
        <div className={s.retroTitle}>
          <i />
          <span>Stella</span>
        </div>
        <div className={s.retroBody}>
          <p className={s.retroThem}>Welcome back, Maya.</p>
          <p className={s.retroMe}>Clean up my desktop.</p>
          <p className={s.retroThem}>Done. 214 files filed into 9 folders.</p>
          <p className={s.retroMe}>Now print my boarding pass.</p>
          <p className={s.retroThem}>Printing to LaserWriter...</p>
          <div className={s.retroInput}>
            <span className={s.retroField}>
              Ask anything<i />
            </span>
            <span className={s.retroBtn}>Send</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function KidSkin() {
  return (
    <div className={s.kid}>
      <svg className={s.kidEdge} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <path d="M4 3 C 30 1, 70 4, 96 2 C 98 30, 97 70, 98 97 C 70 99, 30 96, 3 98 C 1 70, 3 30, 4 3 Z" />
      </svg>
      <p className={s.kidHi}>Hi Ada!</p>
      <div className={s.kidButtons}>
        <span data-c="pink">
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <path d="M7 25l2.5-7.5L21 6a2.8 2.8 0 014 4L13.5 21.5 7 25z" />
            <path d="M18.5 8.5l5 5" />
          </svg>
          Draw
        </span>
        <span data-c="blue">
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <path d="M5 8c4-2 8-2 11 1 3-3 7-3 11-1v16c-4-2-8-2-11 1-3-3-7-3-11-1V8z" />
            <path d="M16 9v16" />
          </svg>
          Story
        </span>
        <span data-c="green">
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <path d="M6 9a4 4 0 014-4h12a4 4 0 014 4v8a4 4 0 01-4 4h-7l-6 5v-5a3 3 0 01-3-3V9z" />
            <path d="M13.5 11a2.5 2.5 0 115 .3c0 1.7-2.5 1.7-2.5 3.2" />
            <path d="M16 17.6v.2" />
          </svg>
          Ask
        </span>
      </div>
      <div className={s.kidMic}>
        <span className={s.kidMicRing} />
        <span className={s.kidMicRing} data-late="1" />
        <span className={s.kidMicDot}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="8.5" y="3" width="7" height="12" rx="3.5" />
            <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" fill="none" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        </span>
      </div>
      <p className={s.kidHint}>Hold to talk</p>
    </div>
  );
}
