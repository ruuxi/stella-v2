/**
 * Where auto-follow parks the live tail of the chat.
 *
 * `useChatScrollManagement` owns the motion (the spring loop, the manual-scroll
 * release); this module owns the *destination* — pure arithmetic over measured
 * geometry, so the framing rules can be pinned by tests without a layout engine.
 *
 * Two things make the destination less obvious than "bottom of the streaming
 * row minus a margin":
 *
 *  1. The streaming row is not the bottom of the live tail. The working
 *     indicator is its own timeline item *below* the row, and a card row can be
 *     appended mid-turn. They occupy real space, so framing the row alone parks
 *     them under the viewport edge — visible only as a sliver, which is exactly
 *     the "indicator clipped below the fold" bug.
 *  2. The scroll viewport's bottom band is not readable. `.session-content`
 *     carries a mask that fades its last `CHAT_VIEWPORT_BOTTOM_FADE_PX` to
 *     transparent, so content sitting in that band is technically inside
 *     `clientHeight` but visually gone. Breathing space measured from the raw
 *     viewport bottom is spent on the fade before any of it reads as empty
 *     space, which is why the deliberate bottom gutter never appeared.
 *
 * Both are handled by framing `resolveLiveTailBottom()` against
 * `followBottomInsetPx()` rather than the row bottom against the raw edge.
 */
/**
 * Height of the bottom mask fade on `.session-content` (see the `mask-image`
 * rule in `shell/full-shell.layout.css`). Content inside this band is painted
 * at partial-to-zero opacity, so "fully visible" means clearing it. Keep in
 * sync with the CSS.
 */
export const CHAT_VIEWPORT_BOTTOM_FADE_PX = 56;
/**
 * Empty space kept below the live tail, *above* the fade band, while
 * auto-following. This is the gutter the chat is supposed to always show:
 * the latest content never sits flush against the readable bottom edge.
 *
 * It doubles as the follow loop's lag budget — the effective visible margin is
 * `FOLLOW_BREATHING_PX - lerp_lag`, and 72px keeps that positive for any
 * per-frame growth up to ~100px, which covers everything short of the rare
 * hundreds-of-px post-tool burst that the follow loop's hard snap catches.
 */
export const FOLLOW_BREATHING_PX = 72;
/**
 * Gap left above the streaming assistant row's top edge when auto-follow pins
 * to the top. Once a reply grows taller than the viewport, follow stops here
 * instead of chasing the bottom forever — the user gets a stable reading area
 * with a small peek of the prior message above so the conversation reads as
 * continuous rather than chopped.
 */
export const FOLLOW_TOP_PEEK_PX = 56;
/** Breathing room between the user bubble's bottom edge and the footer. */
export const POST_SEND_USER_MESSAGE_BREATHING_PX = 48;
/**
 * Distance from the raw viewport bottom at which content is both fully opaque
 * and carrying the intended gutter beneath it.
 */
export const followBottomInsetPx = () => CHAT_VIEWPORT_BOTTOM_FADE_PX + FOLLOW_BREATHING_PX;
export const resolveLiveTailBottom = (geometry) => {
    if (geometry.tailBottom === null)
        return geometry.rowBottom;
    const displaced = geometry.tailBottom - Math.max(0, geometry.unrevealedPx);
    // Never behind the row itself: a shrinking tail (indicator vacating) must not
    // drag the destination back above the text being streamed.
    return Math.max(geometry.rowBottom, displaced);
};
/**
 * Destination `scrollTop` for stream-follow: the whole live tail framed above
 * the fade band with the bottom gutter intact, capped by the top pin so a reply
 * taller than the viewport stops chasing its own bottom.
 */
export const resolveStreamFollowTarget = (geometry) => {
    const liveBottom = resolveLiveTailBottom(geometry);
    const tailFollow = liveBottom - geometry.clientHeight + followBottomInsetPx();
    // The queued stack owns its own (tighter) framing: it bottom-aligns inside a
    // pre-allocated gutter, so it does not need the fade inset on top.
    const queuedFollow = geometry.queuedBottom === null
        ? 0
        : geometry.queuedBottom -
            geometry.clientHeight +
            POST_SEND_USER_MESSAGE_BREATHING_PX;
    const bottomFollow = Math.max(tailFollow, queuedFollow);
    // `min` lets short replies and the queued-follow-up stack keep bottom-
    // following (their `pinnedTop` sits below `bottomFollow`, so it never bites).
    const pinnedTop = Math.max(0, geometry.rowTop - FOLLOW_TOP_PEEK_PX);
    return Math.max(0, Math.min(bottomFollow, pinnedTop));
};
/**
 * Destination `scrollTop` for growth outside a streaming run — a completion
 * card mounting, or the working indicator coming up while the current assistant
 * slot has already settled. `contentBottom` is the end of laid-out content (the
 * trailing footer's top), framed the same way so the gutter reads identically
 * whether or not a row happens to be streaming.
 */
export const resolveIdleTailTarget = (args) => Math.max(0, args.contentBottom - args.clientHeight + followBottomInsetPx());
