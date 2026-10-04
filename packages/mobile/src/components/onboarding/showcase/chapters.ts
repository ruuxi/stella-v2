/**
 * The showcase's script: five short chapters, each a real request typed into
 * the mini chat, then the work it kicks off, then the reply.
 *
 * A chapter is a list of timed cues; the mini chat and the scene render
 * whatever the cues reached so far say should be on screen. Copy lives in
 * the catalog under `mobile.onboarding.showcase.chapters.<id>`.
 */
import type { IconName } from "../../Icon";

export type ChapterId = "errands" | "shopping" | "work" | "routines" | "research";

export type Cue = { id: string; at: number };

export type Receipt = {
  cue: string;
  icon: IconName;
  /** Catalog key under the chapter. */
  key: string;
};

/** The order the pieces of the thread land in, after the user's message. */
export type ThreadPart = "scene" | "confirm" | "receipts" | "reply";

export type ChapterSpec = {
  id: ChapterId;
  cues: Cue[];
  receipts: Receipt[];
  /** The "with your OK" moment: an approval card in the thread. */
  confirm?: { cue: string; doneCue: string };
  order: ThreadPart[];
  /** Cue that clears the working pill (defaults to the first receipt). */
  workingUntil?: string;
};

export const TYPE_START_DELAY_MS = 280;
export const TYPE_CHAR_MS = 34;
export const AUTO_ADVANCE_HOLD_MS = 1600;

export const CHAPTERS: readonly ChapterSpec[] = [
  {
    id: "errands",
    cues: [
      { id: "send", at: 1600 },
      { id: "working", at: 1900 },
      { id: "scene", at: 2400 },
      { id: "fill-1", at: 3000 },
      { id: "fill-2", at: 3450 },
      { id: "fill-3", at: 3900 },
      { id: "click", at: 4500 },
      { id: "confirmed", at: 4950 },
      { id: "work-1", at: 5250 },
      { id: "work-1-done", at: 5600 },
      { id: "work-2", at: 5850 },
      { id: "work-2-done", at: 6250 },
      { id: "reply", at: 6750 },
      { id: "end", at: 8300 },
    ],
    receipts: [
      { cue: "work-1", icon: "globe", key: "receipt1" },
      { cue: "work-2", icon: "clock", key: "receipt2" },
    ],
    order: ["scene", "receipts", "reply"],
  },
  {
    id: "shopping",
    cues: [
      { id: "send", at: 1500 },
      { id: "working", at: 1800 },
      { id: "scene", at: 2300 },
      { id: "size", at: 3000 },
      { id: "cart", at: 3650 },
      { id: "confirm", at: 4250 },
      { id: "confirm-press", at: 5450 },
      { id: "confirm-done", at: 5650 },
      { id: "work-1", at: 6100 },
      { id: "work-1-done", at: 6450 },
      { id: "reply", at: 6950 },
      { id: "end", at: 8500 },
    ],
    receipts: [{ cue: "work-1", icon: "check", key: "receipt1" }],
    confirm: { cue: "confirm", doneCue: "confirm-done" },
    order: ["scene", "confirm", "receipts", "reply"],
    workingUntil: "confirm",
  },
  {
    id: "work",
    cues: [
      { id: "send", at: 1700 },
      { id: "working", at: 2000 },
      { id: "work-1", at: 2400 },
      { id: "work-1-done", at: 2800 },
      { id: "scene", at: 3000 },
      { id: "slide-1", at: 3350 },
      { id: "slide-2", at: 3600 },
      { id: "slide-3", at: 3850 },
      { id: "slide-4", at: 4100 },
      { id: "slide-5", at: 4350 },
      { id: "slide-6", at: 4600 },
      { id: "work-2", at: 4900 },
      { id: "work-2-done", at: 5400 },
      { id: "reply", at: 5900 },
      { id: "end", at: 7500 },
    ],
    receipts: [
      { cue: "work-1", icon: "file-text", key: "receipt1" },
      { cue: "work-2", icon: "artifacts", key: "receipt2" },
    ],
    order: ["receipts", "scene", "reply"],
    workingUntil: "work-1",
  },
  {
    id: "routines",
    cues: [
      { id: "send", at: 1600 },
      { id: "working", at: 1900 },
      { id: "work-1", at: 2400 },
      { id: "work-1-done", at: 2800 },
      { id: "reply", at: 3300 },
      { id: "scene", at: 4300 },
      { id: "notify", at: 5100 },
      { id: "end", at: 7400 },
    ],
    receipts: [{ cue: "work-1", icon: "clock", key: "receipt1" }],
    order: ["receipts", "reply", "scene"],
  },
  {
    id: "research",
    cues: [
      { id: "send", at: 1500 },
      { id: "working", at: 1800 },
      { id: "scene", at: 2300 },
      { id: "src-1", at: 2700 },
      { id: "src-2", at: 3050 },
      { id: "src-3", at: 3400 },
      { id: "rank", at: 4200 },
      { id: "work-1", at: 4700 },
      { id: "work-1-done", at: 5000 },
      { id: "work-2", at: 5200 },
      { id: "work-2-done", at: 5600 },
      { id: "reply", at: 6100 },
      { id: "end", at: 7800 },
    ],
    receipts: [
      { cue: "work-1", icon: "search", key: "receipt1" },
      { cue: "work-2", icon: "file-text", key: "receipt2" },
    ],
    order: ["scene", "receipts", "reply"],
  },
];

export const chapterDuration = (spec: ChapterSpec) =>
  spec.cues[spec.cues.length - 1]!.at;

export const chapterKey = (id: ChapterId, field: string) =>
  `mobile.onboarding.showcase.chapters.${id}.${field}`;
