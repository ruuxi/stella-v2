import { useState, useRef, useCallback } from "react";
import { ArrowUp } from "@/ui/icons";
export function SocialComposer({ onSend, armed = false, placeholder, }) {
    const [message, setMessage] = useState("");
    const textareaRef = useRef(null);
    const handleSend = useCallback(() => {
        const trimmed = message.trim();
        if (!trimmed)
            return;
        onSend(trimmed);
        setMessage("");
        requestAnimationFrame(() => {
            textareaRef.current?.focus();
        });
    }, [message, onSend]);
    const resolvedPlaceholder = placeholder ?? (armed ? "Tell Stella what you want..." : "Write a message...");
    return (<div className="social-composer">
      <div className="social-composer-input-wrap" data-armed={armed || undefined}>
        {armed && (<span className="social-composer-stella-chip">
            <img src="stella-logo.svg" alt="" className="social-composer-stella-chip-logo"/>
            Stella
          </span>)}
        <textarea ref={textareaRef} className="social-composer-input" placeholder={resolvedPlaceholder} value={message} onChange={(e) => setMessage(e.target.value)} onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
            }
        }} rows={1}/>
        <button type="button" className="social-composer-send" data-armed={armed || undefined} disabled={!message.trim()} onClick={handleSend} aria-label={armed ? "Tell Stella" : "Send"}>
          <ArrowUp size={14} strokeWidth={2.5}/>
        </button>
      </div>
    </div>);
}
