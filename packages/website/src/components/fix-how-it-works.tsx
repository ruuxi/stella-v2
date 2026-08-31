"use client";

import { CopyPromptButton } from "./copy-prompt-button";
import { StellaMiniChat, type StellaMiniChatExchange } from "./stella-mini-chat";

export function FixHowItWorks({
  prompt,
  exchanges,
}: {
  prompt: string;
  exchanges: StellaMiniChatExchange[];
}) {
  return (
    <section className="fix-section fix-how section-border">
      <header className="fix-section__header">
        <p className="fix-eyebrow">How it works</p>
        <h2>Tell Stella. It works your computer. Done.</h2>
      </header>

      <div className="fix-how__layout">
        <div className="fix-how__copy">
          <ol className="fix-how__beats">
            <li>
              <span>1</span>
              You describe the problem in your own words.
            </li>
            <li>
              <span>2</span>
              Stella uses your apps, browser, and files.
            </li>
            <li>
              <span>3</span>
              You watch every step. Destructive work waits.
            </li>
          </ol>

          <div className="fix-prompt">
            <div className="fix-prompt__top">
              <p className="fix-prompt__label">Try this prompt</p>
              <CopyPromptButton text={prompt} className="fix-prompt__copy" />
            </div>
            <p className="fix-prompt__text">&ldquo;{prompt}&rdquo;</p>
          </div>
        </div>

        {exchanges.length > 0 ? (
          <div className="fix-how__chat">
            <StellaMiniChat exchanges={exchanges} themeId="sage" />
          </div>
        ) : null}
      </div>
    </section>
  );
}
