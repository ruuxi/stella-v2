import {
  AssistantReplyPeek,
  type AssistantReplyPeekProps,
} from "@/app/chat/AssistantReplyPeek";
import { ComposerActivityPill } from "@/app/chat/ComposerActivityPill";

type ComposerLeadRowProps = {

  replyPeek?: AssistantReplyPeekProps | null;

  showActivityPill?: boolean;
};

export function ComposerLeadRow({
  replyPeek,
  showActivityPill = false,
}: ComposerLeadRowProps) {
  return (
    <div className="composer-context-peek-anchor">
      {replyPeek ? <AssistantReplyPeek {...replyPeek} /> : null}
      <div className="composer-context-lead-row">
        {showActivityPill ? <ComposerActivityPill /> : null}
      </div>
    </div>
  );
}
