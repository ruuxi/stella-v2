import { ActivityContextChip, AppSelectionChips, FileContextChips, PastedTextChips, PendingCaptureChip, ScreenshotContextChips, SelectedTextChip, WindowContextChip, } from "./ComposerContextChips";
import { getComposerAppSelections } from "@/features/chat/composer-context";
import "./composer-context.css";
/* The chip visuals live entirely in the shared components
 * (`ContextPill`, `ImageAttachmentChip`, `FileAttachmentChip`) so the
 * composer and the sent message row cannot drift apart. The variant maps
 * below only add layout constraints (the compact composer's tighter width
 * cap) plus the pending-capture shimmer's size classes. */
const captureVariantClassNames = {
    full: {
        containerClassName: null,
        pendingClassName: "chat-composer-context-chip chat-composer-context-chip--pending composer-context-chip composer-context-chip--pending",
        pendingInnerClassName: "chat-composer-context-pending-inner composer-context-pending-inner",
    },
    compact: {
        containerClassName: null,
        pendingClassName: "chat-composer-context-chip chat-composer-context-chip--pending compact-context-chip compact-context-chip--pending",
        pendingInnerClassName: "chat-composer-context-pending-inner compact-context-pending-inner",
    },
};
const pillVariantClassNames = {
    full: {
        containerClassName: null,
        chipClassName: undefined,
    },
    compact: {
        containerClassName: null,
        chipClassName: "context-pill--compact",
    },
};
export function ComposerWindowContextSection({ variant, chatContext, setChatContext, }) {
    if (!chatContext?.window) {
        return null;
    }
    const sharedProps = {
        chatWindow: chatContext.window,
        chatWindowScreenshot: chatContext.windowScreenshot,
        capturePending: chatContext.capturePending,
        setChatContext,
        className: "chat-composer-context-chip chat-composer-context-chip--window composer-context-chip composer-context-chip--window",
        toggleClassName: "composer-context-window-toggle",
        textClassName: "chat-composer-context-window composer-context-window",
        textFormatter: (chatWindow) => chatWindow.title
            ? `${chatWindow.app} — ${chatWindow.title}`
            : chatWindow.app,
    };
    if (variant === "compact") {
        return <WindowContextChip {...sharedProps}/>;
    }
    return <WindowContextChip {...sharedProps}/>;
}
export function ComposerCaptureContextSection({ variant, chatContext, setChatContext, onPreviewScreenshot, }) {
    const screenshots = chatContext?.regionScreenshots ?? [];
    const hasScreenshots = screenshots.length > 0;
    // Only render the standalone pending-capture shimmer when there's no
    // window chip in flight — the window chip renders its own pending
    // treatment so users see one loading indicator, not two.
    const hasWindow = Boolean(chatContext?.window);
    const isCapturePending = Boolean(chatContext?.capturePending) && !hasWindow;
    if (!hasScreenshots && !isCapturePending) {
        return null;
    }
    const classes = captureVariantClassNames[variant];
    const content = (<>
      {hasScreenshots ? (<ScreenshotContextChips screenshots={screenshots} setChatContext={setChatContext} onPreviewScreenshot={onPreviewScreenshot}/>) : null}
      {isCapturePending ? (<PendingCaptureChip className={classes.pendingClassName} innerClassName={classes.pendingInnerClassName}/>) : null}
    </>);
    if (!classes.containerClassName) {
        return content;
    }
    return <div className={classes.containerClassName}>{content}</div>;
}
export function ComposerFileContextSection({ chatContext, setChatContext, }) {
    const files = chatContext?.files ?? [];
    if (files.length === 0)
        return null;
    return <FileContextChips files={files} setChatContext={setChatContext}/>;
}
export function ComposerPastedTextContextSection({ variant, chatContext, setChatContext, }) {
    const pastedTexts = chatContext?.pastedTexts ?? [];
    if (pastedTexts.length === 0)
        return null;
    const classes = pillVariantClassNames[variant];
    const content = (<PastedTextChips pastedTexts={pastedTexts} setChatContext={setChatContext} className={classes.chipClassName}/>);
    if (!classes.containerClassName)
        return content;
    return <div className={classes.containerClassName}>{content}</div>;
}
export function ComposerAppSelectionContextSection({ variant, chatContext, setChatContext, }) {
    const appSelections = getComposerAppSelections(chatContext);
    if (appSelections.length === 0) {
        return null;
    }
    const classes = pillVariantClassNames[variant];
    const content = (<AppSelectionChips appSelections={appSelections} setChatContext={setChatContext} className={classes.chipClassName}/>);
    if (!classes.containerClassName)
        return content;
    return <div className={classes.containerClassName}>{content}</div>;
}
export function ComposerActivityContextSection({ variant, chatContext, setChatContext, }) {
    if (!chatContext?.activity) {
        return null;
    }
    const classes = pillVariantClassNames[variant];
    const content = (<ActivityContextChip activity={chatContext.activity} setChatContext={setChatContext} className={classes.chipClassName}/>);
    if (!classes.containerClassName)
        return content;
    return <div className={classes.containerClassName}>{content}</div>;
}
export function ComposerSelectedTextContextSection({ variant, selectedText, setSelectedText, setChatContext, }) {
    if (!selectedText) {
        return null;
    }
    const classes = pillVariantClassNames[variant];
    const content = (<SelectedTextChip selectedText={selectedText} setSelectedText={setSelectedText} setChatContext={setChatContext} className={classes.chipClassName}/>);
    if (!classes.containerClassName) {
        return content;
    }
    return <div className={classes.containerClassName}>{content}</div>;
}
