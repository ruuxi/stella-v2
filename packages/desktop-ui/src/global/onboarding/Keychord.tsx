import "./Keychord.css";

type KeychordProps = {
  glyphs: string[];
  aria: string;
  size?: "default" | "compact";
  highlight?: boolean;
};

export function Keychord({
  glyphs,
  aria,
  size = "default",
  highlight,
}: KeychordProps) {
  return (
    <div
      className="onboarding-keychord"
      data-size={size}
      data-highlight={highlight || undefined}
      role="img"
      aria-label={aria}
    >
      {glyphs.map((glyph, i) => (
        <span key={i} className="onboarding-keychord__group">
          {i > 0 ? (
            <span className="onboarding-keychord__sep" aria-hidden="true">
              +
            </span>
          ) : null}
          <span className="onboarding-keychord__cap">{glyph}</span>
        </span>
      ))}
    </div>
  );
}
