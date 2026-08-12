/**
 * Bounded-window fade reveal for streaming markdown text.
 *
 * Splits a text node's content into runs of WORDS_PER_GROUP words, but only
 * the trailing TRAILING_ANIMATED_GROUPS runs get an `<Animated.Text>` that
 * fades opacity 0 → 1 once on mount. Everything before that window collapses
 * into a single plain string.
 *
 * Why the window matters: `react-native-nitro-markdown`'s incremental parser
 * hands the trailing text node a fresh identity carrying the ENTIRE grown
 * paragraph on every streamed delta (its `NodeRenderer` is memoized on
 * `node === node`, so past blocks pass through untouched — markdown.tsx:992 —
 * but the live text leaf is rebuilt each rAF). Wrapping every word in its own
 * span therefore re-tokenized and re-allocated a span per word for the whole
 * message every frame: O(n) work that compounded to O(n²) as the reply grew,
 * and up to MAX_CONCURRENT_FADES JS-driven (non-native-driver) opacity
 * animations ticking every frame. Collapsing the settled head to one plain
 * string keeps per-frame element allocation and animation work O(window)
 * regardless of message length. Already-rendered word groups keep the same
 * component instance (keyed by absolute group ordinal) so their fades finish
 * naturally, and a group only leaves the window once it is already faded.
 *
 * Mirrors desktop's principle in `StreamingTextReveal.tsx`: the reveal does
 * not live on individual words — desktop sweeps a single GPU CSS-mask frontier
 * over the whole block. Mobile can't drive a native-driver mask over nested
 * Text, so it keeps a short animated tail while paying only bounded per-frame
 * cost, matching desktop's smoothness without the O(n²) span churn.
 */

import { useEffect, useRef, type ReactNode } from "react";
import { Animated, Easing } from "react-native";
import type {
  CustomRenderers,
  CustomRendererProps,
} from "react-native-nitro-markdown";

const WORDS_PER_GROUP = 3;
// Only the last few word groups animate; everything before them renders as one
// plain string. Sized so the trailing fade stays soft (~a line and a half of
// words) while a group is comfortably past its FADE_DURATION_MS by the time it
// leaves the window, so graduating to plain text never pops.
const TRAILING_ANIMATED_GROUPS = 6;
const FADE_DURATION_MS = 600;
const WHITESPACE_RE = /^\s+$/;

// The fade is JS-driven (nested Text can't use the native driver — virtual
// Text nodes have no native view), so each mid-fade group ticks the JS
// Animated loop per frame. Cap how many animate at once to bound JS-thread
// work during fast streams; groups past the cap render fully opaque.
const MAX_CONCURRENT_FADES = 10;
let activeFadeCount = 0;

function tokenize(value: string): string[] {
  const out: string[] = [];
  const re = /\s+|\S+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) out.push(match[0]);
  return out;
}

type Chunk =
  | { kind: "group"; text: string }
  | { kind: "ws"; text: string };

function groupTokens(tokens: string[]): Chunk[] {
  const out: Chunk[] = [];
  let buffer = "";
  let wordCount = 0;
  let pendingSeparator = "";

  const flush = () => {
    if (buffer.length === 0) return;
    out.push({ kind: "group", text: buffer });
    buffer = "";
    wordCount = 0;
  };

  for (const tok of tokens) {
    if (WHITESPACE_RE.test(tok)) {
      if (wordCount === 0) {
        out.push({ kind: "ws", text: tok });
      } else {
        pendingSeparator += tok;
      }
      continue;
    }
    if (wordCount === 0) {
      buffer = tok;
      wordCount = 1;
    } else {
      buffer = buffer + pendingSeparator + tok;
      pendingSeparator = "";
      wordCount += 1;
    }
    if (wordCount >= WORDS_PER_GROUP) {
      flush();
      if (pendingSeparator.length > 0) {
        out.push({ kind: "ws", text: pendingSeparator });
        pendingSeparator = "";
      }
    }
  }
  flush();
  if (pendingSeparator.length > 0) {
    out.push({ kind: "ws", text: pendingSeparator });
  }
  return out;
}

function AnimatedWordGroup({ text }: { text: string }) {
  const opacityRef = useRef(new Animated.Value(0));

  useEffect(() => {
    if (activeFadeCount >= MAX_CONCURRENT_FADES) {
      opacityRef.current.setValue(1);
      return;
    }
    activeFadeCount += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeFadeCount -= 1;
    };
    // Nested Text opacity can fail silently with the native driver on
    // some Android builds — the fade never registers and text looks
    // fully opaque from the first frame.
    const anim = Animated.timing(opacityRef.current, {
      toValue: 1,
      duration: FADE_DURATION_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    });
    anim.start(release);
    return () => {
      anim.stop();
      release();
    };
  }, []);

  return (
    <Animated.Text style={{ opacity: opacityRef.current }}>
      {text}
    </Animated.Text>
  );
}

/**
 * Override for nitro's `text` node renderer. Drop into the `<Markdown>` /
 * `<MarkdownStream>` `renderers` prop to enable the streaming fade.
 *
 * Code blocks and inline code don't reach this rule (they use dedicated
 * renderers), so syntax content never animates.
 */
export const streamingTextRenderers: CustomRenderers = {
  text: (props: CustomRendererProps): ReactNode => {
    const content = props.node.content ?? "";
    if (content.length === 0) return null;
    if (WHITESPACE_RE.test(content)) return content;

    const chunks = groupTokens(tokenize(content));

    // Collapse everything except the trailing window of word groups into a
    // single plain string. The wrapping text node grows on every streamed
    // delta, so this keeps per-frame element allocation and JS-driven fade
    // work O(TRAILING_ANIMATED_GROUPS) instead of O(message length).
    let totalGroups = 0;
    for (const chunk of chunks) if (chunk.kind === "group") totalGroups += 1;
    const firstAnimatedGroup = Math.max(0, totalGroups - TRAILING_ANIMATED_GROUPS);

    const out: ReactNode[] = [];
    let head = "";
    let seenGroups = 0;
    for (const chunk of chunks) {
      if (chunk.kind === "ws") {
        // Whitespace up to (and including) the boundary before the first
        // animated group folds into the plain head; inside the window it
        // renders inline so word spacing survives between animated groups.
        if (seenGroups <= firstAnimatedGroup) head += chunk.text;
        else out.push(chunk.text);
        continue;
      }
      if (seenGroups < firstAnimatedGroup) {
        head += chunk.text;
        seenGroups += 1;
        continue;
      }
      if (head.length > 0) {
        out.push(head);
        head = "";
      }
      // Key by absolute group ordinal: a group in progress keeps the same
      // component instance (its fade keeps running) as more characters arrive,
      // and a completed group that scrolls out of the window is already faded.
      out.push(<AnimatedWordGroup key={`g${seenGroups}`} text={chunk.text} />);
      seenGroups += 1;
    }
    if (head.length > 0) out.push(head);
    return out;
  },
};

