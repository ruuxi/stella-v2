"use client";

import { useEffect, useRef, useState } from "react";

export interface StoreAuraProps {
  /** Zero-based position in the complete store sequence. */
  index: number;
  /** Number of adjacent segments spanning the same panorama. */
  count: number;
  className?: string;
}

/**
 * The frozen website shader, with the OG's soft edge and reflected lower echo.
 * Both layers sample the same full-width panorama before their host clips it;
 * blur never runs on isolated tiles, so neighboring slides remain continuous.
 * Parent positions this band over white. Await data-aura-ready before export.
 */
export function StoreAura({ index, count, className }: StoreAuraProps) {
  const host = useRef<HTMLSpanElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let mounted = true;
    const images = [...(host.current?.querySelectorAll("img") ?? [])];
    void Promise.all(images.map(image => image.decode())).then(() => {
      if (mounted) setReady(true);
    }).catch(() => { /* Leave export blocked instead of silently dropping the aura. */ });
    return () => { mounted = false; };
  }, []);
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(index) || index < 0 || index >= count)
    throw new Error("StoreAura needs a valid zero-based index and positive count");

  const imageStyle = {
    display: "block", position: "absolute" as const, maxWidth: "none",
    width: `${count * 100}%`, height: "100%", left: `${-index * 100}%`, top: 0,
    filter: "blur(var(--store-aura-blur, 12px))",
  };
  return (
    <span ref={host} className={className} aria-hidden="true"
      data-aura-index={index} data-aura-count={count}
      data-aura-ready={ready ? "true" : "false"}
      style={{ display: "block", overflow: "hidden", pointerEvents: "none",
        maskImage: "linear-gradient(to bottom, black 84%, transparent)",
        WebkitMaskImage: "linear-gradient(to bottom, black 84%, transparent)" }}>
      <span style={{ position: "absolute", inset: "0 0 24%", overflow: "hidden",
        maskImage: "linear-gradient(to bottom, transparent, black 12%, black 87%, transparent)",
        WebkitMaskImage: "linear-gradient(to bottom, transparent, black 12%, black 87%, transparent)" }}>
        <img src="/brand/store-aura-panorama.png" alt="" draggable={false}
          data-store-aura style={imageStyle} />
      </span>
      <span style={{ position: "absolute", top: "80%", left: 0, right: 0,
        height: "76%", overflow: "hidden", opacity: 0.4,
        maskImage: "linear-gradient(to bottom, black, transparent 70%)",
        WebkitMaskImage: "linear-gradient(to bottom, black, transparent 70%)" }}>
        <img src="/brand/store-aura-panorama.png" alt="" draggable={false}
          data-store-aura style={{ ...imageStyle, transform: "scaleY(-1)" }} />
      </span>
    </span>
  );
}
