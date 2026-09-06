import { existsSync } from "node:fs";
import path from "node:path";
import { StoreAura } from "@/components/StoreAura";
import { BrandCharacter } from "@/components/BrandCharacter";
import "./feature-graphic.css";

export default async function FeatureGraphic({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const outputSource = "/supporting/computer.png";
  const nativeSource = "/captures/android/computer.png";
  const outputReady = existsSync(
    path.join(process.cwd(), "public", outputSource),
  );
  const nativeReady = existsSync(
    path.join(process.cwd(), "public", nativeSource),
  );
  const showNative = nativeReady && query.native !== "0";

  return (
    <main className="feature-studio">
      <article
        className={`feature-graphic ${showNative ? "with-native" : "output-only"}`}
        data-export-feature-graphic
        data-output-ready={String(outputReady)}
        data-native-ready={String(showNative)}
      >
        <StoreAura index={0} count={1} className="feature-aura" />
        <div className="feature-wordmark">Stella</div>
        <BrandCharacter
          shape="blob"
          className="feature-mascot"
          eyeColor="#faf9f7"
        />
        <div className="feature-copy">
          <h1>
            Your computer.
            <br />
            <span>From your phone.</span>
          </h1>
          <p>Work with your apps and files.</p>
        </div>
        {outputReady && (
          <img
            className="feature-output"
            data-feature-source
            src={outputSource}
            alt="September sales presentation made with Stella"
          />
        )}
        {showNative && (
          <img
            className="feature-native"
            data-feature-source
            src={nativeSource}
            alt="The current Stella Android app"
          />
        )}
        <BrandCharacter shape="cursor" className="feature-cursor" />
      </article>
    </main>
  );
}
