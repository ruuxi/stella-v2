import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { useEdgeFadeRef } from "@/shared/hooks/use-edge-fade";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogBody, DialogCloseButton, } from "@/ui/dialog";
import { LEGAL_TITLES, TERMS_OF_SERVICE, PRIVACY_POLICY, } from "./legal-text";
import "./legal-dialog.css";
const CONTENT = {
    terms: TERMS_OF_SERVICE,
    privacy: PRIVACY_POLICY,
};
const SUBTITLE = {
    terms: "How Stella works, and what you agree to when you use it.",
    privacy: "What we collect, what we don't, and how we keep it safe.",
};
export const LegalDialog = ({ document, onOpenChange }) => {
    const title = document ? LEGAL_TITLES[document] : "";
    const subtitle = document ? SUBTITLE[document] : "";
    const scrollRef = useEdgeFadeRef({ axis: "vertical" });
    return (<Dialog open={document !== null} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="legal-dialog-content">
        <VisuallyHidden asChild>
          <DialogTitle>{title}</DialogTitle>
        </VisuallyHidden>
        <VisuallyHidden asChild>
          <DialogDescription>{subtitle}</DialogDescription>
        </VisuallyHidden>
        <DialogCloseButton className="legal-dialog-close"/>
        <DialogBody className="legal-dialog-body">
          <header className="legal-dialog-header">
            <p className="legal-dialog-title">{title}</p>
            {subtitle ? <p className="legal-dialog-sub">{subtitle}</p> : null}
          </header>
          <div ref={scrollRef} className="legal-dialog-scroll">
            <article className="legal-dialog-text">
              {document ? CONTENT[document] : ""}
            </article>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>);
};
