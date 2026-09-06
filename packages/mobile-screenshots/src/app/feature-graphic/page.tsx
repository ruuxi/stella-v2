import { existsSync } from "node:fs";
import path from "node:path";
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
        <div className="feature-wordmark">stella</div>
        <div className="feature-copy">
          <h1>
            Your computer.
            <br />
            From your phone.
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
      </article>
    </main>
  );
}
