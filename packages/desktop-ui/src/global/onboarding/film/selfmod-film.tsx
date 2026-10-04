/**
 * "I can change myself" — the self-modification film (desktop only).
 *
 * The same loop the product runs: the user asks for a feature in Stella
 * herself, an agent drafts it in Stella's own source (a diff streams in, a
 * live preview of the draft opens), the reply carries the real Update card,
 * and pressing Update swaps the new code in with the focus pull the app
 * uses — only the part of the window that changed blurs out and sharpens
 * back in. The card settles to "Updated just now" with Undo on it.
 */
import { Check, Code, Globe } from "@/ui/icons";
import { UpdateCard } from "@/features/app-source/UpdateCard";
import {
  DemoBubble,
  DemoChat,
  DemoComposer,
  DemoShell,
  DemoWorkCard,
  DemoWorking,
} from "@/global/onboarding/demo/DemoShell";
import type { ChoreographyCue } from "@/global/onboarding/demo/use-choreography";
import { Cursor, Film, Layer, pickShot, Thread, WIDE, Win, type Has } from "./Film";
import "./selfmod-film.css";

export const SELFMOD_PROMPT = "Put my next meeting in the top bar, with a Join button";

export const SELFMOD_CUES: ChoreographyCue[] = [
  { id: "send", at: 1900 },
  { id: "working", at: 2250 },
  { id: "agent", at: 2600 },
  { id: "diff", at: 2900 },
  { id: "preview", at: 4100 },
  { id: "work-1", at: 4300 },
  { id: "work-1-done", at: 4700 },
  { id: "reply", at: 5200 },
  { id: "card", at: 5500 },
  { id: "retire", at: 6000 },
  { id: "you", at: 6050 },
  { id: "press", at: 7000 },
  { id: "swap", at: 7700 },
  { id: "pulled", at: 8300 },
  { id: "applied", at: 8700 },
  { id: "wide", at: 9500 },
  { id: "end", at: 11000 },
];

const STELLA = { x: 100, y: 30, w: 760, h: 480 };
const CODE = { x: 596, y: 120, w: 340, h: 232 };
const PREVIEW = { x: 556, y: 336, w: 384, h: 146 };
const THREAD_ORIGIN = { x: 560, y: 410 };

type DiffLine = { sign: "+" | " " | "-"; text: string; indent?: number };

const DIFF: { file: string; lines: DiffLine[] }[] = [
  {
    file: "shell/TopBar.tsx",
    lines: [
      { sign: " ", text: "<Controls />" },
      { sign: "+", text: "<NextMeeting" },
      { sign: "+", text: "event={calendar.next}", indent: 1 },
      { sign: "+", text: "onJoin={openCall} />", indent: 1 },
      { sign: " ", text: "<Spacer />" },
    ],
  },
  {
    file: "shell/NextMeeting.tsx",
    lines: [
      { sign: "+", text: "export function NextMeeting({ event }) {" },
      { sign: "+", text: "return <Pill live={event.soon}>", indent: 1 },
    ],
  },
];

/** What the change adds to Stella's top bar. */
function MeetingPill({ state }: { state: "none" | "preview" | "pulling" | "in" }) {
  return (
    <span className="osm-pill" data-state={state}>
      <i className="osm-pill__dot" />
      <span className="osm-pill__text">Design review · in 12 min</span>
      <span className="osm-pill__join">Join</span>
    </span>
  );
}

export function SelfModFilm({
  has,
  typed,
  typing,
}: {
  has: Has;
  typed: string;
  typing: boolean;
}) {
  const shot = pickShot(has, { x: 480, y: 286, z: 1.5 }, [
    ["send", { x: 480, y: 300, z: 1.15 }],
    ["agent", { x: 700, y: 260, z: 1.3 }],
    ["preview", { x: 720, y: 340, z: 1.3 }],
    ["reply", { x: 440, y: 384, z: 1.45 }],
    ["swap", { x: 480, y: 52, z: 2.1 }],
    ["wide", WIDE],
  ]);
  const pill = has("pulled") ? "in" : has("swap") ? "pulling" : "none";
  const applied = has("applied");
  return (
    <Film shot={shot} className="osm">
      <Layer box={STELLA} visible from="fade" z={5}>
        <DemoShell
          className="ofilm-stella ofilm-stella--wide"
          topbarCenter={<MeetingPill state={pill} />}
        >
          <DemoChat
            started={has("send")}
            composer={
              <DemoComposer
                value={has("send") ? "" : typed}
                typing={typing && !has("send")}
                sending={has("send") && !has("working")}
              />
            }
          >
            <DemoBubble role="user" visible={has("send")}>
              {SELFMOD_PROMPT}
            </DemoBubble>
            <DemoWorking visible={has("working") && !has("work-1")} label="Changing Stella…" />
            <DemoWorkCard
              visible={has("work-1")}
              done={has("work-1-done")}
              icon={<Code size={12} />}
            >
              Drafted 2 files · checked · preview ready
            </DemoWorkCard>
            <DemoBubble role="assistant" visible={has("reply")}>
              Here it is. Press Update to try it. You can undo it any time.
            </DemoBubble>
            <div className="osm-card" data-visible={has("card") || undefined}>
              <UpdateCard
                tone={applied ? "done" : "update"}
                title="Show my next meeting in the top bar"
                detail={applied ? "Updated just now" : "Changes to Stella · 2 files"}
                action={{ label: applied ? "Undo" : "Update", primary: !applied, onClick: () => {} }}
                busy={has("press") && !applied}
              />
            </div>
          </DemoChat>
        </DemoShell>
        {/* The "before" picture over the changed strip: it blurs out while
            the new top bar sharpens in under it, as the real transition does. */}
        <span className="osm-cover" data-state={pill} />
      </Layer>

      <Thread
        from={THREAD_ORIGIN}
        to={{ x: CODE.x, y: CODE.y + 70 }}
        visible={has("agent") && !has("retire")}
        done={has("work-1-done")}
      />
      <Layer
        box={CODE}
        visible={has("agent") && !has("retire")}
        from="right"
        z={10}
        dim={has("preview") && !has("reply")}
      >
        <Win title="Draft · next-meeting" accent={<Code size={11} />}>
          <div className="osm-diff" data-visible={has("diff") || undefined}>
            {DIFF.map((file, fileIndex) => (
              <div className="osm-diff__file" key={file.file}>
                <span
                  className="osm-diff__name"
                  style={{ transitionDelay: `${fileIndex * 520}ms` }}
                >
                  {file.file}
                </span>
                {file.lines.map((line, index) => (
                  <span
                    key={index}
                    className="osm-diff__line"
                    data-sign={line.sign === "+" ? "add" : "same"}
                    style={{
                      paddingLeft: 8 + (line.indent ?? 0) * 14,
                      transitionDelay: `${fileIndex * 520 + (index + 1) * 90}ms`,
                    }}
                  >
                    <i>{line.sign}</i>
                    {line.text}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </Win>
      </Layer>
      <Layer box={PREVIEW} visible={has("preview") && !has("retire")} from="rise" z={11}>
        <Win
          url="stella-preview://next-meeting"
          badge={
            <>
              <Globe size={9} /> Preview
            </>
          }
        >
          <div className="osm-preview">
            <span className="osm-preview__bar">
              <i />
              <i />
              <i />
              <span className="osm-preview__spacer" />
              <MeetingPill state="preview" />
              <span className="osm-preview__spacer" />
            </span>
            <span className="osm-preview__note">
              <Check size={10} /> Your draft, running live
            </span>
          </div>
        </Win>
      </Layer>

      <Cursor
        owner="you"
        x={has("you") ? 614 : 690}
        y={has("you") ? 420 : 500}
        click={has("press") && !has("swap")}
        visible={has("you") && !has("swap")}
      />
    </Film>
  );
}
