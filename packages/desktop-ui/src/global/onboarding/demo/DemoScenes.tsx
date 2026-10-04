/**
 * The memory step's two mocks: the chatbot everyone knows (a sidebar of
 * threads, no memory of last week) and Stella's one conversation, where the
 * same question gets answered by looking back. Presentation-only CSS;
 * `has(cue)` decides each state.
 */
import { History } from "@/ui/icons";
import { StellaLogoIcon } from "@/ui/stella-logo-icon";
import "./demo-scenes.css";

export type Has = (cue: string) => boolean;

/* ── Memory step: the chatbot everyone knows, then Stella ──────────── */

const CHATBOT_THREADS = [
  "Dinner ideas for Friday",
  "Trip to Lisbon",
  "Fix my resume",
  "Sushi near me",
  "Q3 numbers",
  "Gift for mom",
  "Untitled",
  "New chat",
];

export function ChatbotMock({ has }: { has: Has }) {
  return (
    <div className="ochatbot">
      <div className="ochatbot__sidebar">
        <span className="ochatbot__new">+ New chat</span>
        {CHATBOT_THREADS.map((thread, index) => (
          <span className="ochatbot__thread" key={thread} data-active={index === 7 || undefined}>
            {thread}
          </span>
        ))}
      </div>
      <div className="ochatbot__main">
        <span className="ochatbot__bubble" data-role="user" data-visible={has("q") || undefined}>
          Book that sushi place again for Friday
        </span>
        <span className="ochatbot__bubble" data-role="assistant" data-visible={has("reply") || undefined}>
          I don't have access to your previous conversations. Which restaurant did you mean?
        </span>
        <span className="ochatbot__composer">Message…</span>
      </div>
    </div>
  );
}

export function StellaMemoryMock({ has }: { has: Has }) {
  const searching = has("recall") && !has("found");
  return (
    <div className="ostella">
      <div className="ostella__bar">
        <StellaLogoIcon size={11} aria-hidden />
        <span>One conversation</span>
      </div>
      <div className="ostella__main">
        <div className="ostella__history" aria-hidden="true">
          <span className="ochatbot__bubble" data-role="user" data-visible>
            Fix the typo on slide 3 and re-export
          </span>
          <span className="ochatbot__bubble" data-role="assistant" data-visible>
            Done. The new PDF is on your desktop.
          </span>
        </div>
        <span className="ochatbot__bubble" data-role="user" data-visible={has("q") || undefined}>
          Book that sushi place again for Friday
        </span>
        <div className="orecall" data-visible={has("recall") || undefined} data-found={has("found") || undefined}>
          <span className="orecall__head">
            <History size={10} />
            {searching ? "Looking back…" : "From last Friday"}
            <i className="orecall__scan" aria-hidden="true" />
          </span>
          <span className="orecall__quote">
            Booked Kura Sushi for two, Friday 8:00 PM. Confirmation is in your email.
          </span>
        </div>
        <span className="ochatbot__bubble" data-role="assistant" data-visible={has("reply") || undefined}>
          Kura Sushi again, table for two at 8? Booking it now.
        </span>
        <span className="ochatbot__composer">Do anything</span>
      </div>
    </div>
  );
}
