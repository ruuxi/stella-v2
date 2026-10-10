/**
 * The above-composer lead row shared by every chat composer surface (full
 * shell + sidebar/wide panel). It carries the optional assistant reply peek.
 *
 * It used to carry an Activity pill as well, as a stand-in for the standalone
 * Activity surface whenever that surface was hidden. Background work is now
 * read from the top bar on every surface and at every width, so a second
 * running-work marker above the composer would only say the same thing twice.
 */

import { memo } from "react";
import {
  AssistantReplyPeek,
  type AssistantReplyPeekProps,
} from "@/app/chat/AssistantReplyPeek";

type ComposerLeadRowProps = {
  /** When present, the assistant reply peek renders flush above the row. */
  replyPeek?: AssistantReplyPeekProps | null;
};

export const ComposerLeadRow = memo(function ComposerLeadRow({
  replyPeek,
}: ComposerLeadRowProps) {
  return (
    <div className="composer-context-peek-anchor">
      {replyPeek ? <AssistantReplyPeek {...replyPeek} /> : null}
      <div className="composer-context-lead-row" />
    </div>
  );
});
