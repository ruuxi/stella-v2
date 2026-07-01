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
  /** Current time (ms epoch) for relative timestamps; injected for testing. */
  now: number;
};

/** A tap target; the session maps these to the bound bridge actions. */
export type HomeRowAction =
  | { kind: "talk" }
  | { kind: "readReply"; id: string };

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
 * The whole home surface, ordered exactly as rendered. react-native-carplay
 * reports item selection as a FLAT index across all sections (see
 * `parseListItems:startIndex:` in RNCarPlay.m), so callers should flatten the
 * rows in order to resolve a tap back to its action.
 */
export function buildHome(state: CarPlayHomeState): HomeSection[] {
  const sections: HomeSection[] = [{ rows: [buildTalkRow(state)] }];
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
