import { AudioLines, Box } from "@/ui/icons";
import { ClaudeLogoIcon } from "@/ui/claude-logo-icon";
import { StellaLogoIcon } from "@/ui/stella-logo-icon";
import { BRAND_ICON_COLOR_MARKUP, BRAND_ICON_MARKUP, } from "@/ui/brand-icon-paths";
/** Provider key → brand glyph key. Unlisted keys use the key itself. */
const BRAND_KEY_ALIASES = {
    "openai-codex": "openai",
    "google-gemini-cli": "gemini",
    "google-antigravity": "gemini",
    "kimi-coding": "kimi",
    "vercel-ai-gateway": "vercel",
    "github-copilot": "githubcopilot",
};
/**
 * Canonical accents for brands whose logos are monochrome. Brands whose
 * mark is genuinely black (xAI, Vercel, GitHub) stay on `currentColor`.
 */
const BRAND_TINTS = {
    openai: "#10a37f",
    groq: "#f55036",
    openrouter: "#6467f2",
};
const FALLBACK_ICONS = {
    inworld: (props) => <AudioLines {...props}/>,
};
export function BrandIcon({ brand, size = 16, className }) {
    if (brand === "stella") {
        return <StellaLogoIcon size={size} className={className} aria-hidden/>;
    }
    if (brand === "anthropic") {
        return (<ClaudeLogoIcon size={size} variant="mark" className={className} aria-hidden/>);
    }
    const key = BRAND_KEY_ALIASES[brand] ?? brand;
    const colorMarkup = BRAND_ICON_COLOR_MARKUP[key];
    if (colorMarkup) {
        return (<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size}
        // Paths without an explicit brand fill (e.g. Cerebras' letterform)
        // follow text color so they stay visible in dark mode.
        fill="currentColor" className={className} aria-hidden dangerouslySetInnerHTML={{ __html: colorMarkup }}/>);
    }
    const markup = BRAND_ICON_MARKUP[key];
    if (!markup) {
        const Fallback = FALLBACK_ICONS[key] ?? Box;
        return (<Fallback size={size} strokeWidth={1.75} className={className} aria-hidden/>);
    }
    const tint = BRAND_TINTS[key];
    return (<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="currentColor" fillRule="evenodd" className={className} style={tint ? { color: tint } : undefined} aria-hidden dangerouslySetInnerHTML={{ __html: markup }}/>);
}
