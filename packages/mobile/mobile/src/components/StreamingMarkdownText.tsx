/**
 * Phrase-level fade reveal for streaming markdown text.
 *
 * Splits each text node's content into runs of WORDS_PER_GROUP words and
 * wraps each run in an `<Animated.Text>` that fades opacity 0 → 1 once on
 * mount. The whitespace that separates two groups stays outside any span so
 * word spacing renders naturally.
 *
 * Why this works cleanly under nitro: `react-native-nitro-markdown`'s
 * incremental parser passes unchanged subtrees through by reference, and
 * its `NodeRenderer` is memoized on `node === node`. Past blocks therefore
 * never re-render mid-stream — only the trailing text leaf does. As long
 * as we key word-group spans deterministically by token position, React
 * keeps the same component instances for already-rendered groups (their
 * fades complete naturally on the original timer) and only mounts a fresh
 * `<Animated.Text>` when a new group spawns. No ledger needed.
 *
 * Mirrors `desktop/src/app/chat/rehype-word-fade.ts` (phrase grouping)
 * + `markdown.css` `@keyframes stellaWordFadeIn` (opacity-only fade).
 */
import { useEffect, useRef, type ReactNode } from "react";
import { Animated, Easing } from "react-native";
import type {
  CustomRenderers,
  CustomRendererProps,
} from "react-native-nitro-markdown";

const WORDS_PER_GROUP = 3;
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
    return chunks.map((chunk, i) =>
      chunk.kind === "ws" ? (
        chunk.text
      ) : (
        <AnimatedWordGroup key={`g${i}`} text={chunk.text} />
      ),
    );
  },
};
