import { existsSync } from "node:fs";
import path from "node:path";
import { devices, slides, type Device } from "@/store/slides";
import { supportingArtifacts } from "@/store/supporting";
import "./store.css";
import { CapabilityComposition } from "@/components/CapabilityComposition";
import { StoreAura } from "@/components/StoreAura";
import { BrandCharacter } from "@/components/BrandCharacter";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const device: Device =
    typeof query.device === "string" && Object.hasOwn(devices, query.device)
      ? (query.device as Device)
      : "iphone";
  const size = devices[device];
  const exportMode = query.export === "1";
  const requestedSlugs = typeof query.slides === "string" ? query.slides.split(",") : null;
  const activeSlides = requestedSlugs ? requestedSlugs.flatMap(slug => slides.filter(slide => slide.slug === slug)) : slides;
  return (
    <main className={`store-studio ${exportMode ? "export-mode" : ""}`}>
      {!exportMode && (
        <header className="studio-toolbar">
          <div>
            <strong>Stella / Store images</strong>
            <p>Real app captures. Ready for review before export.</p>
          </div>
          <nav>
            {Object.entries(devices).map(([id, value]) => (
              <a
                key={id}
                aria-current={id === device ? "page" : undefined}
                href={`/?device=${id}`}
              >
                {value.label}
              </a>
            ))}
            <a href="/animation">Icon studio</a>
          </nav>
        </header>
      )}
      <div className="store-gallery">
        {activeSlides.map((slide, slideIndex) => {
          const captureSlug = "captureSlug" in slide ? slide.captureSlug : slide.slug;
          const source = `/captures/${device}/${captureSlug}.png`;
          const available = existsSync(
            path.join(process.cwd(), "public", source),
          );
          const supporting = supportingArtifacts[slide.slug];
          const hasSupporting =
            supporting &&
            existsSync(path.join(process.cwd(), "public", supporting.source));
          return (
            <section
              key={slide.slug}
              className="slide-preview"
              style={{ aspectRatio: `${size.width}/${size.height}` }}
            >
              <article
                data-export-slide={slide.slug}
                data-capture-ready={available ? "true" : "false"}
                className={`store-slide scene-${slide.slug} device-${device} ${hasSupporting ? "has-supporting" : ""}`}
                style={
                  {
                    width: size.width,
                    height: size.height,
                    background: slide.background,
                    color: slide.ink,
                    "--accent": slide.accent,
                    "--canvas-width": `${size.width}px`,
                  } as React.CSSProperties
                }
              >
                <StoreAura index={slideIndex} count={activeSlides.length} className="slide-aura" />
                <div className="slide-wordmark">Stella</div>
                <BrandCharacter shape="blob" className="slide-mascot" eyeColor={slide.background} />
                <div className="slide-copy">
                  <h1>{slide.title.split("\n").map((line, index) => <span key={line} className={index === 1 ? "headline-accent" : undefined}>{line}</span>)}</h1>
                  {slide.subtitle && <p>{slide.subtitle}</p>}
                </div>
                {slide.slug === "assistant" && <CapabilityComposition />}
                {hasSupporting && (
                  <figure className="supporting-artifact">
                    <img
                      data-supporting-artifact
                      src={supporting.source}
                      alt={supporting.alt}
                    />
                    {(slide.slug === "computer" || slide.slug === "browser") && <BrandCharacter shape="cursor" className="artifact-cursor" />}
                  </figure>
                )}
                <div className="screen-stage">
                  <div className="capture-frame">
                    {device === "iphone" && <img className="iphone-hardware" data-device-frame src="/devices/iphone-17.png" alt="" />}
                    {available ? (
                      <img
                        data-native-capture
                        src={source}
                        alt={`Stella ${size.label} — ${slide.slug}`}
                      />
                    ) : (
                      <div className="capture-missing">
                        <strong>Native capture pending</strong>
                        <p>
                          {size.label} / {slide.slug}
                        </p>
                        <small>
                          Export stays blocked until the current app is
                          captured.
                        </small>
                      </div>
                    )}
                  </div>
                </div>
              </article>
            </section>
          );
        })}
      </div>
    </main>
  );
}
