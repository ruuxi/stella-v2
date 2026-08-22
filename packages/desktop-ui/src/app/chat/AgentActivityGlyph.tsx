/**
 * Star glyph for the minimal in-chat agent activity rows.
 *
 * A lightweight static echo of the working-indicator's aurora star — a soft
 * four-pointed sparkle with concave curved edges, drawn as plain SVG in
 * `currentColor`. No WebGL, no animation; while a row is running the title
 * shimmer carries the motion, the star just sits quietly in the leading
 * slot.
 *
 * This is the locked-in "candidate A" from the glyph sampler — 13px, same
 * path as sampled; ink comes from the glyph slot's solid full-strength
 * `color` (see `.agent-activity-row__glyph` in agent-activity-row.css).
 */
export function StellaStarGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg
      className="agent-activity-star"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 2 C12.9 8.2 15.8 11.1 22 12 C15.8 12.9 12.9 15.8 12 22 C11.1 15.8 8.2 12.9 2 12 C8.2 11.1 11.1 8.2 12 2 Z" />
    </svg>
  );
}
