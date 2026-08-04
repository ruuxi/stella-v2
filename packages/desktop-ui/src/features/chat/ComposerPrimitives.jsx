import { forwardRef, } from "react";
import { motion } from "motion/react";
import { cn } from "@/shared/lib/utils";
import { ArrowUp, Mic, Plus, Square } from "@/ui/icons";
import "./composer-primitives.css";
function AddIcon() {
    return <Plus size={16} strokeWidth={1.75}/>;
}
function StopIcon() {
    return <Square size={16} fill="currentColor" stroke="none"/>;
}
function MicIcon() {
    return <Mic size={16} strokeWidth={1.75}/>;
}
function SpinnerIcon() {
    // Three-quarter ring on top of a faint full ring so rotation reads
    // unambiguously regardless of background contrast.
    return (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="chat-composer-spinner-svg" aria-hidden>
      <circle cx="12" cy="12" r="9" opacity="0.2"/>
      <path d="M21 12a9 9 0 0 0-9-9"/>
    </svg>);
}
function SendIcon() {
    return <ArrowUp size={16} strokeWidth={1.75}/>;
}
export const ComposerAddButton = forwardRef(function ComposerAddButton({ className, children, onClick, disabled, ...props }, ref) {
    const isDisabled = disabled ?? !onClick;
    return (<button ref={ref} type="button" className={cn("chat-composer-icon-button chat-composer-icon-button--add", className)} onClick={onClick} disabled={isDisabled} {...props}>
        {children ?? <AddIcon />}
      </button>);
});
export const ComposerStopButton = forwardRef(function ComposerStopButton({ className, children, ...props }, ref) {
    return (<button ref={ref} type="button" className={cn("chat-composer-icon-button chat-composer-icon-button--stop", className)} {...props}>
        {children ?? <StopIcon />}
      </button>);
});
export const ComposerMicButton = forwardRef(function ComposerMicButton({ className, isTranscribing, children, title, ...props }, ref) {
    const computedTitle = title ?? (isTranscribing ? "Transcribing…" : "Start dictation");
    return (<button ref={ref} type="button" className={cn("chat-composer-icon-button chat-composer-icon-button--mic", isTranscribing && "chat-composer-icon-button--mic-transcribing", className)} title={computedTitle} aria-label={computedTitle} aria-busy={Boolean(isTranscribing)} {...props}>
      {children ?? (isTranscribing ? <SpinnerIcon /> : <MicIcon />)}
    </button>);
});
export function ComposerSubmitButton({ animated = false, className, children, disabled, ...props }) {
    const sharedClassName = cn("chat-composer-icon-button chat-composer-icon-button--submit", className);
    if (animated) {
        const canSubmit = !disabled;
        // Motion reuses onDrag* for pan gestures; strip DOM drag handlers so types align.
        const { onDrag: _d0, onDragCapture: _d0c, onDragStart: _ds, onDragStartCapture: _dsc, onDragEnd: _de, onDragEndCapture: _dec, onAnimationStart: _as, onAnimationStartCapture: _asc, onAnimationEnd: _ae, onAnimationEndCapture: _aec, onAnimationIteration: _ai, onAnimationIterationCapture: _aic, ...motionButtonProps } = props;
        return (<motion.button type="submit" className={sharedClassName} disabled={disabled} animate={{
                opacity: canSubmit ? 1 : 0.4,
                scale: canSubmit ? 1 : 0.92,
            }} whileHover={canSubmit ? { opacity: 0.9 } : {}} transition={{ type: "spring", duration: 0.2, bounce: 0 }} {...motionButtonProps}>
        {children ?? <SendIcon />}
      </motion.button>);
    }
    return (<button type="submit" className={sharedClassName} disabled={disabled} {...props}>
      {children ?? <SendIcon />}
    </button>);
}
export const ComposerTextarea = forwardRef(function ComposerTextarea({ className, tone = "default", ...props }, ref) {
    return (<textarea ref={ref} className={cn("chat-composer-field chat-composer-textarea", tone === "orb" && "chat-composer-field--orb", className)} {...props}/>);
});
