/**
 * Pure builders for Stella's CarPlay voice-home list. No react-native or
 * react-native-carplay imports — {@link carPlaySession} turns these row specs
 * into real CPListTemplate sections (adding brand icons), which keeps this
 * logic unit-testable off-device.
 *
 * v2 design principle: ONE rock-solid `CPListTemplate` root. v1 layered a
 * `CPVoiceControlTemplate` overlay + a pushed `CPNowPlayingTemplate` on top of
 * the list; every extra template transition was another way for a real head
 * unit to strand the driver on a surface without a working tap (see the
 * build-91 dead-tap post-mortem in CARPLAY-V2-NOTES.md). All v2 state lives in
 * the list rows themselves: big rows, driving-safe copy, no stack changes.
 */

export type CarPlayPhase = "idle" | "listening" | "thinking" | "speaking";

/** An assistant reply surfaced as a tappable row on the voice home. */
export type RecentReply = {
  id: string;
  text: string;
  /** Arrival time (ms epoch) used for the relative timestamp. */
  at: number;
};

/** How many assistant replies the home lists (newest + the previous one). */
export const RECENT_REPLY_COUNT = 2;

/** What the CarPlay home needs to render, independent of any template API. */
export type CarPlayHomeState = {
  phase: CarPlayPhase;
  /** Short preview of the reply currently being spoken (may be empty). */
  speakingPreview: string;
  /** Recent assistant replies, newest first (already capped by the bridge). */
  replies: RecentReply[];
  /** Reply that arrived since the driver last heard/read one, if any. */
  newReplyId: string | null;
  /** Converse mode: while ON, replies auto-play via TTS as they arrive. */
  converseOn: boolean;
  /** Where dictated messages go: this phone's chat or the paired computer's. */
  target: "phone" | "computer";
  /**
   * Whether a computer is paired at all. Hides the target row when there's
   * nothing to switch to — a toggle that can't do anything would be a dead
   * tap, exactly what v2 exists to eliminate.
   */
  targetSelectable: boolean;
  /** Current time (ms epoch) for relative timestamps; injected for testing. */
  now: number;
};

/** A tap target; the session maps these to the bound bridge actions. */
export type HomeRowAction =
  | { kind: "talk" }
  | { kind: "readReply"; id: string }
  | { kind: "readLatest" }
  | { kind: "toggleConverse" }
  | { kind: "toggleTarget" };

/** Template-agnostic list row (the session decorates with images). */
export type HomeRowSpec = {
  text: string;
  detailText: string;
  isPlaying?: boolean;
};

export type HomeRow = { item: HomeRowSpec; action: HomeRowAction };

export type HomeSection = { header?: string; rows: HomeRow[] };

// Copy mirrors the phone app's tone ("Ask Stella anything", "Message Stella").
// The talk row is a toggle: tap to start dictation, tap again to stop + send.
const TALK_COPY: Record<CarPlayPhase, { title: string; subtitle: string }> = {
  idle: { title: "Talk to Stella", subtitle: "Tap to speak — hands free" },
  listening: { title: "Listening…", subtitle: "Tap to stop and send" },
  thinking: { title: "Stella is thinking…", subtitle: "One moment" },
  speaking: { title: "Stella is speaking", subtitle: "Tap to interrupt and talk" },
};

/** Collapse whitespace and clamp for a single glance-safe line. */
export function previewText(text: string, max = 100): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function buildTalkRow(state: CarPlayHomeState): HomeRow {
  const copy = TALK_COPY[state.phase];
  return {
    item: {
      text: copy.title,
      detailText:
        state.phase === "speaking" && state.speakingPreview
          ? previewText(state.speakingPreview)
          : copy.subtitle,
      isPlaying: state.phase === "listening" || state.phase === "thinking",
    },
    action: { kind: "talk" },
  };
}

/** Driving-glance relative timestamp: "now", "2m ago", "3h ago", "2d ago". */
export function formatRelativeTime(at: number, now: number): string {
  const elapsed = Math.max(0, now - at);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * One tappable row per recent assistant reply; tapping reads it via TTS. The
 * detail line carries the relative timestamp, and a reply that arrived since
 * the driver last heard one is marked "New" (CPListItem has no true badge
 * slot under the audio entitlement, so the marker lives in the detail text).
 */
export function buildReplyRows(state: CarPlayHomeState): HomeRow[] {
  return state.replies.slice(0, RECENT_REPLY_COUNT).map((reply) => {
    const isNew = reply.id === state.newReplyId;
    const when = formatRelativeTime(reply.at, state.now);
    return {
      item: {
        text: previewText(reply.text),
        detailText: isNew ? `New · ${when} — tap to hear it` : when,
        isPlaying: false,
      },
      action: { kind: "readReply", id: reply.id },
    };
  });
}

/**
 * Dedicated one-tap "read the newest reply aloud" row. Only rendered when a
 * reply exists — a row that can't do anything would be a dead tap, which is
 * exactly what v2 exists to eliminate.
 */
export function buildReadLatestRow(state: CarPlayHomeState): HomeRow | null {
  const newest = state.replies[0];
  if (!newest) return null;
  return {
    item: {
      text: "Read latest reply",
      detailText: previewText(newest.text, 80),
    },
    action: { kind: "readLatest" },
  };
}

/**
 * Converse-mode toggle: the hands-free loop. While ON, the reply to a
 * dictated message auto-plays via TTS the moment it arrives — talk, listen,
 * talk again, eyes on the road. The on/off state is always visible in the
 * row title.
 */
export function buildConverseRow(state: CarPlayHomeState): HomeRow {
  return {
    item: {
      text: `Converse mode: ${state.converseOn ? "On" : "Off"}`,
      detailText: state.converseOn
        ? "Replies play aloud automatically — tap to turn off"
        : "Tap to hear replies automatically",
    },
    action: { kind: "toggleConverse" },
  };
}

/**
 * Voice-target row: where "Talk to Stella" sends the dictated message — the
 * phone's own chat or the paired computer's Stella over the bridge. Only
 * rendered when a computer is paired. Tapping pins the other target (the
 * driver made an explicit choice; auto-follow resumes from the phone's
 * Settings screen).
 */
export function buildTargetRow(state: CarPlayHomeState): HomeRow | null {
  if (!state.targetSelectable) return null;
  const onComputer = state.target === "computer";
  return {
    item: {
      text: `Send to: ${onComputer ? "Computer" : "Phone"}`,
      detailText: onComputer
        ? "Messages go to your computer's chat — tap to use this phone"
        : "Messages stay in this phone's chat — tap to use your computer",
    },
    action: { kind: "toggleTarget" },
  };
}

/**
 * The whole home surface, ordered exactly as rendered. react-native-carplay
 * reports item selection as a FLAT index across all sections (see
 * `parseListItems:startIndex:` in RNCarPlay.m), so callers should flatten the
 * rows in order to resolve a tap back to its action.
 */
export function buildHome(state: CarPlayHomeState): HomeSection[] {
  const firstRows: HomeRow[] = [buildTalkRow(state)];
  const readLatest = buildReadLatestRow(state);
  if (readLatest) firstRows.push(readLatest);
  firstRows.push(buildConverseRow(state));
  const targetRow = buildTargetRow(state);
  if (targetRow) firstRows.push(targetRow);
  const sections: HomeSection[] = [{ rows: firstRows }];
  const replyRows = buildReplyRows(state);
  if (replyRows.length > 0) {
    sections.push({ header: "Recent replies", rows: replyRows });
  }
  return sections;
}

/** Flat tap-index → action list matching {@link buildHome}'s render order. */
export function flattenActions(sections: HomeSection[]): HomeRowAction[] {
  return sections.flatMap((section) => section.rows.map((row) => row.action));
}

/**
 * Interop-safe replacement for react-native-carplay's `Template.parseConfig`.
 *
 * The library's own implementation does
 * `const resolveAssetSource = require('react-native/Libraries/Image/resolveAssetSource')`
 * — but on RN 0.83 that file is an ES module (`export default resolveAssetSource`),
 * so the bare `require` returns the namespace OBJECT `{ default: fn }`.
 * Calling it throws `TypeError: Object is not a function` inside every
 * template constructor / `updateSections` that carries an `image` — which is
 * exactly the deterministic on-device crash that kept the CarPlay JS takeover
 * from ever landing (`[js] JS connect handler FAILED: TypeError: Object is
 * not a function`).
 *
 * Mirrors the original semantics: deep-walk the config, replace the value of
 * every key matching `/[Ii]mage$/` with the resolved asset source, then JSON
 * round-trip (drops function props like onItemSelect, same as upstream).
 * Pure — the caller injects the real `Image.resolveAssetSource`.
 */
export function parseTemplateConfig(
  config: unknown,
  resolveImage: (source: unknown) => unknown,
): unknown {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(
        node as Record<string, unknown>,
      )) {
        if (/[Ii]mage$/.test(key) && value != null) {
          out[key] = resolveImage(value);
        } else {
          out[key] = walk(value);
        }
      }
      return out;
    }
    return node;
  };
  return JSON.parse(JSON.stringify(walk(config)));
}
