import type { UserAskRecord } from "@stella/contracts/user-ask-deck";
import { useT } from "@/shared/i18n";
import "./user-ask-card.css";

export function UserAskRecordCard({ record }: { record: UserAskRecord }) {
  const t = useT();
  return (
    <div className="user-ask-record" data-ask-id={record.id}>
      {record.answers.map((answer, index) => (
        <div className="user-ask-record__item" key={`${record.id}:${index}`}>
          <p className="user-ask-record__question">{answer.question}</p>
          <p
            className="user-ask-record__answer"
            data-kind={answer.kind}
          >
            {answer.kind === "skipped"
              ? t("userAsk.question.skipped")
              : answer.answer}
            {record.defaulted ? (
              <span className="user-ask-record__tag">
                {t("userAsk.question.default")}
              </span>
            ) : null}
          </p>
        </div>
      ))}
    </div>
  );
}
