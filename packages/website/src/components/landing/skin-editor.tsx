"use client";

import { useRef } from "react";
import { useLayerLive } from "./motion";
import { StellaCharacter } from "./stella-character";
import e from "./skin-editor.module.css";

const SEGMENTS: [kind: "clip" | "gap", width: number][] = [
  ["clip", 12],
  ["gap", 3],
  ["clip", 9],
  ["gap", 2.4],
  ["clip", 14],
  ["gap", 3.2],
  ["clip", 8],
  ["gap", 2],
  ["clip", 11],
  ["gap", 3.6],
  ["clip", 10],
  ["gap", 2.2],
  ["clip", 7],
];

const HUES = ["#4f6bd8", "#7a55d6", "#3d8fd1", "#6a5fd8", "#4a78c9", "#8456c9", "#4d84d6"];
const CAPTIONS = [1, 9, 17, 29, 38, 46, 55, 63];
const TICKS = Array.from({ length: 13 }, (_, i) => i);

const CLIP_INDEX = SEGMENTS.map((_, i) => SEGMENTS.slice(0, i + 1).filter(([k]) => k === "clip").length);

function Track({ audio }: { audio?: boolean }) {
  return (
    <div className={e.lane}>
      {SEGMENTS.map(([kind, w], i) => {
        if (kind === "gap") {
          return <span key={i} className={e.gap} data-audio={audio ? "1" : "0"} style={{ ["--w" as string]: `${w}%` }} />;
        }
        const clip = CLIP_INDEX[i];
        const hue = HUES[(clip - 1) % HUES.length];
        return (
          <span
            key={i}
            className={audio ? e.audio : e.video}
            style={{ ["--w" as string]: `${w}%`, ["--hue" as string]: hue, ["--shift" as string]: `${clip * 37}px` }}
          >
            {audio ? null : <i>{`A0${clip}`}</i>}
          </span>
        );
      })}
    </div>
  );
}

export function EditorSkin() {
  const rootRef = useRef<HTMLDivElement>(null);

  useLayerLive(rootRef, (live) => {
    if (rootRef.current) rootRef.current.dataset.play = live ? "1" : "0";
  });

  return (
    <div ref={rootRef} className={e.editor} data-play="0">
      <div className={e.bar}>
        <span className={e.lights}>
          <i />
          <i />
          <i />
        </span>
        <span className={e.project}>lisbon_film_v3</span>
        <span className={e.center}>
          <StellaCharacter size={18} eyeColor="#1b1c20" state="working" />
          Edit
        </span>
        <span className={e.export}>Export</span>
      </div>

      <div className={e.body}>
        <aside className={e.chat}>
          <div className={e.thread}>
            <p className={e.stamp}>Today 4:12 PM</p>
            <p className={e.me}>Pull the best takes from Tuesday&apos;s shoot</p>
            <p className={e.her}>Found 7. They&apos;re on V1 in story order.</p>
            <p className={e.me}>Warmer grade on the cabin shots</p>
            <p className={e.her}>Done. Matched all 7 to A03.</p>
            <p className={e.me}>Cut the dead air and caption it</p>
            <p className={e.her} data-late="1">
              Cut 14 pauses, 2:41 shorter. Captions are on V2.
            </p>
            <p className={e.me} data-late="2">
              Now make the intro punchier
            </p>
            <p className={e.typing} data-late="3">
              <i />
              <i />
              <i />
            </p>
          </div>
          <div className={e.prompt}>
            <span>Do anything</span>
            <b>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </b>
          </div>
        </aside>

        <section className={e.viewer}>
          <div className={e.screen}>
            <img src="/landing/cabin-poster.webp" alt="" loading="lazy" decoding="async" />
            <span className={e.caption}>We drove up before sunrise.</span>
            <span className={e.safe} />
          </div>
          <div className={e.transport}>
            <span className={e.tc}>
              <b>00:01:12:08</b>
              <span className={e.dur}>
                <em className={e.durOld}>07:19</em>
                <em className={e.durNew}>04:38</em>
              </span>
            </span>
            <span className={e.controls}>
              <i data-k="back" />
              <i data-k="play" />
              <i data-k="fwd" />
            </span>
            <span className={e.zoom}>Fit</span>
          </div>
        </section>

        <section className={e.timeline}>
          <div className={e.ruler}>
            {TICKS.map((t) => (
              <span key={t}>{`0${Math.floor(t / 2)}:${t % 2 ? "30" : "00"}`}</span>
            ))}
          </div>
          <div className={e.tracks}>
            <div className={e.row}>
              <span className={e.label}>V2</span>
              <div className={e.lane}>
                {CAPTIONS.map((left, i) => (
                  <span key={left} className={e.cap} style={{ left: `${left}%`, ["--i" as string]: i }} />
                ))}
              </div>
            </div>
            <div className={e.row}>
              <span className={e.label}>V1</span>
              <Track />
            </div>
            <div className={e.row}>
              <span className={e.label}>A1</span>
              <Track audio />
            </div>
            <div className={e.row}>
              <span className={e.label}>A2</span>
              <div className={e.lane}>
                <span className={e.music} />
              </div>
            </div>
            <span className={e.playhead} />
          </div>
        </section>
      </div>
    </div>
  );
}
