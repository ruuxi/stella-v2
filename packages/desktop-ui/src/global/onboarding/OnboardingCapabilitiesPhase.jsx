/**
 * Capabilities phase — a user-paced, prompt-first demo player.
 *
 * The old version was a passive auto-cycling carousel that failed to
 * teach. This rebuild shows the real interaction loop instead: each
 * chapter types a prompt into the faithful demo shell, sends it,
 * streams work receipts, and lands the result. Chapters auto-advance
 * after a short hold, but the word nav lets the user jump or replay
 * any chapter, and Continue is never gated.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Clock, FileSpreadsheet, FileText, Globe, Presentation, RotateCcw, Smartphone, } from "@/ui/icons";
import { StellaLogoIcon } from "@/ui/stella-logo-icon";
import { DemoBubble, DemoChat, DemoComposer, DemoShell, DemoWorkCard, DemoWorking, } from "./demo/DemoShell";
import { useChoreography, useTypedText, } from "./demo/use-choreography";
import "./OnboardingCapabilitiesPhase.css";
const TYPE_CHAR_MS = 26;
const TYPE_START_DELAY_MS = 300;
const AUTO_ADVANCE_HOLD_MS = 1700;
const scriptEnd = (cues) => cues[cues.length - 1].at;
/* ── Chapter scripts ──────────────────────────────────────────────── */
const ERRANDS_CUES = [
    { id: "send", at: 1500 },
    { id: "working", at: 1900 },
    { id: "work-1", at: 3100 },
    { id: "work-1-done", at: 4100 },
    { id: "work-2", at: 4400 },
    { id: "work-2-done", at: 5300 },
    { id: "reply", at: 5900 },
    { id: "end", at: 7200 },
];
const WORK_CUES = [
    { id: "send", at: 1800 },
    { id: "working", at: 2200 },
    { id: "work-1", at: 3300 },
    { id: "work-1-done", at: 4300 },
    { id: "work-2", at: 4200 },
    { id: "work-2-done", at: 5200 },
    { id: "work-3", at: 5100 },
    { id: "work-3-done", at: 6000 },
    { id: "reply", at: 6600 },
    { id: "end", at: 7800 },
];
const PHONE_CUES = [
    { id: "msg-user", at: 600 },
    { id: "msg-reply", at: 1900 },
    { id: "link", at: 2600 },
    { id: "work-1", at: 3300 },
    { id: "work-1-done", at: 4500 },
    { id: "work-2", at: 4800 },
    { id: "work-2-done", at: 5900 },
    { id: "end", at: 6800 },
];
const CHAPTERS = [
    {
        id: "errands",
        word: "Errands",
        title: "Ask once. Consider it handled.",
        caption: "Stella drives the browser and your apps like a person would: clicking, filling forms, finishing the job.",
        durationMs: scriptEnd(ERRANDS_CUES),
    },
    {
        id: "work",
        word: "Work",
        title: "Real files. Real apps.",
        caption: "Spreadsheets, documents, slides, and websites: Stella works in the real apps on this computer.",
        durationMs: scriptEnd(WORK_CUES),
    },
    {
        id: "phone",
        word: "Phone",
        title: "Text it from the road.",
        caption: "Message from your phone and the work happens on your computer, even while you're away.",
        durationMs: scriptEnd(PHONE_CUES),
    },
];
const ERRANDS_SPEC = {
    prompt: "Book sushi for two on Friday at 8",
    workingLabel: "Browsing OpenTable…",
    reply: "Booked Kura Sushi for Friday at 8. The confirmation is in your email.",
    steps: [
        {
            cue: "work-1",
            icon: Globe,
            label: "opentable.com · Fri 8:00 PM · party of 2",
        },
        { cue: "work-2", icon: Clock, label: "Added to your calendar" },
    ],
};
const WORK_SPEC = {
    prompt: "Update the Q3 sheet and build the board deck",
    workingLabel: "Working in Excel…",
    reply: "Sheet updated and the deck is rebuilt. Want a read-through?",
    steps: [
        {
            cue: "work-1",
            icon: FileSpreadsheet,
            label: "Q3-revenue.xlsx · 214 cells updated",
        },
        { cue: "work-2", icon: Presentation, label: "Board deck.pptx · 14 slides" },
        { cue: "work-3", icon: FileText, label: "Summary.docx · drafted" },
    ],
};
/**
 * One choreography per chapter. `playNonce` bumps when the user clicks
 * a word tab — restarting the script if this chapter is the active one
 * (activation itself already starts a fresh run via the hook).
 */
function useChapterScript(cues, active, playNonce, onDone) {
    const { has, restart } = useChoreography({ cues, active, onDone });
    const nonceRef = useRef(playNonce);
    useEffect(() => {
        if (nonceRef.current === playNonce)
            return;
        nonceRef.current = playNonce;
        if (active)
            restart();
    }, [active, playNonce, restart]);
    return has;
}
function WorkflowChapter({ active, playNonce, onDone, cues, spec, }) {
    const has = useChapterScript(cues, active, playNonce, onDone);
    const typed = useTypedText(spec.prompt, active && !has("send"), {
        startDelay: TYPE_START_DELAY_MS,
        charMs: TYPE_CHAR_MS,
    });
    return (<DemoShell>
      <DemoChat>
        <DemoBubble role="user" visible={has("send")}>
          {spec.prompt}
        </DemoBubble>
        <DemoWorking visible={has("working") && !has(spec.steps[0].cue)} label={spec.workingLabel}/>
        {spec.steps.map((step) => {
            const Icon = step.icon;
            return (<DemoWorkCard key={step.cue} visible={has(step.cue)} done={has(`${step.cue}-done`)} icon={<Icon size={12}/>}>
              {step.label}
            </DemoWorkCard>);
        })}
        <DemoBubble role="assistant" visible={has("reply")}>
          {spec.reply}
        </DemoBubble>
        <DemoComposer value={has("send") ? "" : typed.value} typing={typed.typing && !has("send")} sending={has("send") && !has("working")}/>
      </DemoChat>
    </DemoShell>);
}
/* ── Phone chapter (phone thread → desktop picking up the work) ───── */
function PhoneChapter({ active, playNonce, onDone }) {
    const has = useChapterScript(PHONE_CUES, active, playNonce, onDone);
    return (<div className="onboarding-cap-phone-scene">
      <div className="onboarding-cap-phone">
        <span className="onboarding-cap-phone__notch"/>
        <div className="onboarding-cap-phone__contact">
          <span className="onboarding-cap-phone__avatar">
            <StellaLogoIcon size={10} aria-hidden/>
          </span>
          Stella
        </div>
        <div className="onboarding-cap-phone__thread">
          <span className="onboarding-cap-phone__msg" data-role="user" data-visible={has("msg-user") || undefined}>
            Flight landed. Can you confirm dinner tonight at 8?
          </span>
          <span className="onboarding-cap-phone__msg" data-role="assistant" data-visible={has("msg-reply") || undefined}>
            On it. Your computer is handling it now.
          </span>
        </div>
      </div>

      <div className="onboarding-cap-phone-link" data-active={has("link") || undefined}>
        <span className="onboarding-cap-phone-link__line"/>
        <span className="onboarding-cap-phone-link__head"/>
      </div>

      <div className="onboarding-cap-phone-desktop">
        <DemoShell>
          <DemoChat>
            <DemoWorking visible={has("link") && !has("work-1")} label="Picking this up…"/>
            <DemoWorkCard visible={has("work-1")} done={has("work-1-done")} icon={<Globe size={12}/>}>
              Confirming the reservation
            </DemoWorkCard>
            <DemoWorkCard visible={has("work-2")} done={has("work-2-done")} icon={<Smartphone size={12}/>}>
              Texted you the details
            </DemoWorkCard>
            <DemoComposer value=""/>
          </DemoChat>
        </DemoShell>
      </div>
    </div>);
}
/* ── Phase shell ──────────────────────────────────────────────────── */
export function OnboardingCapabilitiesPhase({ splitTransitionActive, onContinue, }) {
    const [chapterIndex, setChapterIndex] = useState(0);
    /** Bumped on every manual play (word click / replay) to restart scripts. */
    const [playNonce, setPlayNonce] = useState(0);
    const [chapterDone, setChapterDone] = useState(false);
    const [playedChapters, setPlayedChapters] = useState(() => new Set());
    const advanceTimerRef = useRef(null);
    const clearAdvanceTimer = useCallback(() => {
        if (advanceTimerRef.current) {
            clearTimeout(advanceTimerRef.current);
            advanceTimerRef.current = null;
        }
    }, []);
    useEffect(() => clearAdvanceTimer, [clearAdvanceTimer]);
    const handleChapterDone = useCallback((index) => {
        const chapter = CHAPTERS[index];
        setPlayedChapters((prev) => {
            if (prev.has(chapter.id))
                return prev;
            const next = new Set(prev);
            next.add(chapter.id);
            return next;
        });
        setChapterDone(true);
        // Hold on the finished chapter, then advance — never past the last.
        if (index >= CHAPTERS.length - 1)
            return;
        clearAdvanceTimer();
        advanceTimerRef.current = setTimeout(() => {
            advanceTimerRef.current = null;
            setChapterDone(false);
            setChapterIndex(index + 1);
        }, AUTO_ADVANCE_HOLD_MS);
    }, [clearAdvanceTimer]);
    const playChapter = useCallback((index) => {
        clearAdvanceTimer();
        setChapterDone(false);
        setChapterIndex(index);
        setPlayNonce((nonce) => nonce + 1);
    }, [clearAdvanceTimer]);
    const renderChapter = (chapter, index) => {
        const common = {
            active: index === chapterIndex,
            playNonce,
            onDone: () => handleChapterDone(index),
        };
        switch (chapter.id) {
            case "errands":
                return (<WorkflowChapter {...common} cues={ERRANDS_CUES} spec={ERRANDS_SPEC}/>);
            case "work":
                return (<WorkflowChapter {...common} cues={WORK_CUES} spec={WORK_SPEC}/>);
            case "phone":
                return <PhoneChapter {...common}/>;
            default: {
                const exhaustive = chapter.id;
                return exhaustive;
            }
        }
    };
    const activeChapter = CHAPTERS[chapterIndex];
    return (<div className="onboarding-step-content onboarding-cap-step">
      <div className="onboarding-cap-title-slot" aria-live="polite">
        <h3 className="onboarding-cap-title" key={activeChapter.id}>
          {activeChapter.title}
        </h3>
      </div>

      <div className="onboarding-cap-frame">
        <div className="onboarding-cap-stage" aria-hidden="true">
          <div key={activeChapter.id} className="onboarding-cap-chapter" data-active>
            {renderChapter(activeChapter, chapterIndex)}
          </div>
        </div>
        <button type="button" className="onboarding-cap-replay" data-visible={chapterDone || undefined} disabled={splitTransitionActive || !chapterDone} aria-label="Replay this demo" onClick={() => playChapter(chapterIndex)}>
          <RotateCcw size={12}/>
        </button>
      </div>

      <div className="onboarding-cap-words" role="tablist" aria-label="Capability demos">
        {CHAPTERS.map((chapter, index) => {
            const isActive = index === chapterIndex;
            return (<button key={chapter.id} type="button" role="tab" aria-selected={isActive} className="onboarding-cap-words__word" data-active={isActive || undefined} data-completed={playedChapters.has(chapter.id) || undefined} disabled={splitTransitionActive} onClick={() => playChapter(index)}>
              <span className="onboarding-cap-words__label">
                {chapter.word}
              </span>
              <span className="onboarding-cap-words__track" aria-hidden="true">
                {isActive ? (<span key={playNonce} className="onboarding-cap-words__fill" style={{ animationDuration: `${chapter.durationMs}ms` }}/>) : null}
              </span>
            </button>);
        })}
      </div>

      <div className="onboarding-cap-caption-slot" aria-live="polite">
        <p className="onboarding-cap-caption__body" key={activeChapter.id}>
          {activeChapter.caption}
        </p>
      </div>

      <button className="onboarding-confirm onboarding-cap-continue" data-visible={true} data-emphasized={playedChapters.has("errands") || undefined} disabled={splitTransitionActive} onClick={onContinue}>
        Continue
      </button>
    </div>);
}
