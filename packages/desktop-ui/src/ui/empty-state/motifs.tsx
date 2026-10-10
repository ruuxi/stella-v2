import { useId, type CSSProperties, type ReactNode } from "react";

export type EmptyStateMotif =
  | "files"
  | "search"
  | "unavailable"
  | "preview"
  | "blank"
  | "changes"
  | "apps"
  | "trash"
  | "updates";

const ART = 148;
const CENTER = ART / 2;
const BRAND = ["#00aad8", "#3493d9", "#4878db", "#7449c5", "#be57a4"] as const;

const pct = (value: number) => `${(value / ART) * 100}%`;

function Layer({
  x,
  y,
  w,
  h,
  rotate = 0,
  delay = 0,
  className,
  children,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  rotate?: number;
  delay?: number;
  className?: string;
  children: ReactNode;
}) {
  const style = {
    left: pct(CENTER + x - w / 2),
    top: pct(CENTER + y - h / 2),
    width: pct(w),
    height: pct(h),
    "--es-r": `${rotate}deg`,
    "--es-delay": `${delay}s`,
  } as CSSProperties;
  return (
    <div className={`empty-state__layer ${className ?? ""}`} style={style}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height="100%">
        {children}
      </svg>
    </div>
  );
}

function useGradientId(): string {
  return useId().replace(/[^a-zA-Z0-9-]/g, "");
}

function BrandGradient({ id, angle = "diagonal" }: { id: string; angle?: "diagonal" | "vertical" }) {
  const coords =
    angle === "vertical"
      ? { x1: "0", y1: "1", x2: "0", y2: "0" }
      : { x1: "0", y1: "1", x2: "1", y2: "0" };
  return (
    <defs>
      <linearGradient id={id} {...coords}>
        <stop offset="0" stopColor={BRAND[0]} />
        <stop offset="0.5" stopColor={BRAND[2]} />
        <stop offset="1" stopColor={BRAND[4]} />
      </linearGradient>
    </defs>
  );
}

const PAGE_W = 46;
const PAGE_H = 58;

type PageVariant = "lines" | "image" | "media" | "blank" | "diff" | "ghost";

function Page({ variant, w = PAGE_W, h = PAGE_H }: { variant: PageVariant; w?: number; h?: number }) {
  const id = useGradientId();
  const ghost = variant === "ghost";
  return (
    <>
      <BrandGradient id={id} />
      <rect
        x={0.75}
        y={0.75}
        width={w - 1.5}
        height={h - 1.5}
        rx={9}
        className={ghost ? "es-card es-card--ghost" : "es-card"}
      />
      {variant === "lines" ? (
        <>
          <rect x={7} y={8} width={19} height={4} rx={2} fill={`url(#${id})`} opacity={0.85} />
          <rect x={7} y={18} width={w - 14} height={3} rx={1.5} className="es-line" />
          <rect x={7} y={25} width={w - 18} height={3} rx={1.5} className="es-line" />
          <rect x={7} y={32} width={w - 15} height={3} rx={1.5} className="es-line" />
          <rect x={7} y={39} width={17} height={3} rx={1.5} className="es-line" />
        </>
      ) : null}
      {variant === "image" ? (
        <>
          <rect x={6} y={6} width={w - 12} height={24} rx={5} fill={`url(#${id})`} opacity={0.9} />
          <circle cx={w - 14} cy={13} r={2.6} fill="#ffffff" opacity={0.85} />
          <path
            d={`M6 27 L17 17.5 L25 24.5 L30 20.5 L${w - 6} 28.5 L${w - 6} 30 L6 30 Z`}
            fill="#ffffff"
            opacity={0.35}
          />
          <rect x={6} y={37} width={27} height={3} rx={1.5} className="es-line" />
          <rect x={6} y={44} width={19} height={3} rx={1.5} className="es-line" />
        </>
      ) : null}
      {variant === "media" ? (
        <>
          <circle cx={w / 2} cy={22} r={10.5} fill={`url(#${id})`} opacity={0.9} />
          <path
            d={`M${w / 2 - 2.8} 17.6 L${w / 2 + 4.4} 22 L${w / 2 - 2.8} 26.4 Z`}
            fill="#ffffff"
          />
          <rect x={7} y={40} width={w - 14} height={3} rx={1.5} className="es-line" />
          <rect x={11} y={47} width={w - 22} height={3} rx={1.5} className="es-line" />
        </>
      ) : null}
      {variant === "blank" ? (
        <rect x={8} y={9} width={16} height={4} rx={2} className="es-line es-line--soft" />
      ) : null}
      {variant === "ghost" ? (
        <>
          <rect x={8} y={10} width={19} height={4} rx={2} className="es-line es-line--soft" />
          <rect x={8} y={20} width={w - 16} height={3} rx={1.5} className="es-line es-line--soft" />
          <rect x={8} y={27} width={w - 22} height={3} rx={1.5} className="es-line es-line--soft" />
          <rect x={8} y={34} width={w - 19} height={3} rx={1.5} className="es-line es-line--soft" />
        </>
      ) : null}
      {variant === "diff" ? (
        <>
          <rect x={7} y={8} width={18} height={4} rx={2} className="es-line" />
          {[18, 26, 34, 42].map((y, index) => {
            const add = index % 2 === 0;
            return (
              <g key={y}>
                <rect
                  x={5}
                  y={y - 1.5}
                  width={w - 10}
                  height={6}
                  rx={2}
                  fill={add ? BRAND[0] : BRAND[4]}
                  opacity={0.12}
                />
                <rect x={8} y={y} width={3} height={3} rx={1} fill={add ? BRAND[0] : BRAND[4]} opacity={0.85} />
                <rect
                  x={14}
                  y={y}
                  width={add ? w - 24 : w - 30}
                  height={3}
                  rx={1.5}
                  className="es-line"
                />
              </g>
            );
          })}
        </>
      ) : null}
    </>
  );
}

function FilesMotif() {
  return (
    <>
      <Layer x={-31} y={-18} w={PAGE_W} h={PAGE_H} rotate={-15} delay={0} className="es-float">
        <Page variant="lines" />
      </Layer>
      <Layer x={31} y={-18} w={PAGE_W} h={PAGE_H} rotate={15} delay={-2.4} className="es-float">
        <Page variant="media" />
      </Layer>
      <Layer x={0} y={-28} w={PAGE_W} h={PAGE_H} rotate={0} delay={-4.8} className="es-float">
        <Page variant="image" />
      </Layer>
    </>
  );
}

function SinglePageMotif({ variant, badge }: { variant: PageVariant; badge?: "retry" }) {
  const id = useGradientId();
  return (
    <>
      <Layer x={-14} y={-12} w={56} h={70} rotate={-7} className="es-float">
        <Page variant={variant} w={56} h={70} />
      </Layer>
      {badge === "retry" ? (
        <Layer x={14} y={-44} w={26} h={26} className="es-float es-float--badge" delay={-1.6}>
          <BrandGradient id={id} />
          <circle cx={13} cy={13} r={12.25} className="es-card" />
          <path
            d="M18.4 13a5.4 5.4 0 1 1-1.6-3.8"
            fill="none"
            stroke={`url(#${id})`}
            strokeWidth={2}
            strokeLinecap="round"
          />
          <path
            d="M17.6 6.6v3.2h-3.2"
            fill="none"
            stroke={`url(#${id})`}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Layer>
      ) : null}
    </>
  );
}

function SearchMotif() {
  const id = useGradientId();
  return (
    <>
      {[
        { y: -40, w: 64, delay: 0 },
        { y: 40, w: 52, delay: -3 },
      ].map((row) => (
        <Layer key={row.y} x={-6} y={row.y} w={row.w} h={14} delay={row.delay} className="es-float es-float--row">
          <rect x={0.75} y={0.75} width={row.w - 1.5} height={12.5} rx={6.25} className="es-card" />
          <circle cx={7.5} cy={7} r={2.6} className="es-line" />
          <rect x={14} y={5.5} width={row.w - 24} height={3} rx={1.5} className="es-line" />
        </Layer>
      ))}
      <Layer x={6} y={4} w={96} h={96} className="es-sweep">
        <BrandGradient id={id} />
        <path d="M69 69 L86 86" stroke={`url(#${id})`} strokeWidth={8} strokeLinecap="round" />
        <circle cx={44} cy={44} r={33} className="es-lens" />
        <path
          d="M20.5 34 A 25.5 25.5 0 0 1 34.5 20.3"
          fill="none"
          stroke="#ffffff"
          strokeOpacity={0.5}
          strokeWidth={2.5}
          strokeLinecap="round"
        />
      </Layer>
    </>
  );
}

const TILE = 26;
const TILE_R = 56;
const GLYPHS = ["circle", "square", "triangle", "circle", "square", "triangle"] as const;

function AppsMotif() {
  return (
    <div className="empty-state__orbit">
      {GLYPHS.map((glyph, index) => {
        const angle = (index / GLYPHS.length) * Math.PI * 2;
        const color = BRAND[index % BRAND.length];
        const c = TILE / 2;
        return (
          <Layer
            key={index}
            x={TILE_R * Math.sin(angle)}
            y={-TILE_R * Math.cos(angle)}
            w={TILE}
            h={TILE}
            className="es-tile"
          >
            <rect x={0.75} y={0.75} width={TILE - 1.5} height={TILE - 1.5} rx={7.5} className="es-card" />
            {glyph === "circle" ? <circle cx={c} cy={c} r={5} fill={color} /> : null}
            {glyph === "square" ? (
              <rect x={c - 4.5} y={c - 4.5} width={9} height={9} rx={2.5} fill={color} />
            ) : null}
            {glyph === "triangle" ? (
              <path d={`M${c} ${c - 5.4} L${c + 5.4} ${c + 4.2} L${c - 5.4} ${c + 4.2} Z`} fill={color} />
            ) : null}
          </Layer>
        );
      })}
    </div>
  );
}

const DIAL_R = 56;

function UpdatesMotif() {
  const id = useGradientId();
  const ticks = Array.from({ length: 12 }, (_, index) => index);
  const size = DIAL_R * 2 + 8;
  const c = size / 2;
  return (
    <>
      <Layer x={0} y={0} w={size} h={size}>
        <circle cx={c} cy={c} r={DIAL_R} fill="none" className="es-ring" />
        {ticks.map((index) => {
          const angle = (index / 12) * Math.PI * 2;
          const major = index % 3 === 0;
          const r = DIAL_R - 9;
          return (
            <circle
              key={index}
              cx={c + r * Math.sin(angle)}
              cy={c - r * Math.cos(angle)}
              r={major ? 1.8 : 1.1}
              className={major ? "es-tick es-tick--major" : "es-tick"}
            />
          );
        })}
      </Layer>
      <Layer x={0} y={0} w={size} h={size} className="es-spin">
        <BrandGradient id={`${id}-arc`} angle="vertical" />
        <path
          d={`M ${c - DIAL_R * Math.sin(1.9)} ${c - DIAL_R * Math.cos(1.9)} A ${DIAL_R} ${DIAL_R} 0 0 1 ${c} ${c - DIAL_R}`}
          fill="none"
          stroke={`url(#${id}-arc)`}
          strokeWidth={2.5}
          strokeLinecap="round"
          opacity={0.9}
        />
        <circle cx={c} cy={c - DIAL_R} r={4} fill={BRAND[4]} />
        <circle cx={c} cy={c - DIAL_R} r={1.6} fill="#ffffff" opacity={0.9} />
      </Layer>
      <Layer x={40} y={-40} w={26} h={26} className="es-float es-float--badge">
        <BrandGradient id={id} />
        <circle cx={13} cy={13} r={12} fill={`url(#${id})`} />
        <path
          d="M8.2 13.4 11.4 16.4 17.8 9.8"
          fill="none"
          stroke="#ffffff"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Layer>
    </>
  );
}

const TRAY_W = 104;

function TrashMotif({ layer }: { layer: "back" | "front" }) {
  const id = useGradientId();
  if (layer === "back") {
    return (
      <Layer x={0} y={8} w={TRAY_W} h={30}>
        <path
          d={`M10 14 Q ${TRAY_W / 2} 2 ${TRAY_W - 10} 14 L ${TRAY_W - 4} 28 L 4 28 Z`}
          className="es-card es-card--inset"
        />
      </Layer>
    );
  }
  return (
    <Layer x={0} y={38} w={TRAY_W} h={48}>
      <BrandGradient id={id} />
      <path
        d={`M4 4 L ${TRAY_W - 4} 4 L ${TRAY_W - 12} 40 Q ${TRAY_W - 13} 46 ${TRAY_W - 20} 46 L 20 46 Q 13 46 12 40 Z`}
        className="es-card"
      />
      <rect x={2} y={1} width={TRAY_W - 4} height={7} rx={3.5} className="es-card es-card--rim" />
      <rect x={TRAY_W / 2 - 14} y={22} width={28} height={4} rx={2} fill={`url(#${id})`} opacity={0.75} />
    </Layer>
  );
}

export function EmptyStateMotifArt({
  motif,
  layer = "back",
}: {
  motif: EmptyStateMotif;
  layer?: "back" | "front";
}) {
  if (layer === "front") {
    return motif === "trash" ? <TrashMotif layer="front" /> : null;
  }
  switch (motif) {
    case "files":
      return <FilesMotif />;
    case "search":
      return <SearchMotif />;
    case "unavailable":
      return <SinglePageMotif variant="ghost" />;
    case "preview":
      return <SinglePageMotif variant="lines" badge="retry" />;
    case "blank":
      return <SinglePageMotif variant="blank" />;
    case "changes":
      return <SinglePageMotif variant="diff" />;
    case "apps":
      return <AppsMotif />;
    case "trash":
      return <TrashMotif layer="back" />;
    case "updates":
      return <UpdatesMotif />;
  }
}
