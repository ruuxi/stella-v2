import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportRendererError } from "@/platform/diagnostics/report-error";
import { useT } from "@/shared/i18n";
import { EmptyState } from "@/ui/empty-state/EmptyState";
import { RotateCcw } from "@/ui/icons";
import { PREVIEW_UNAVAILABLE } from "./use-preview-parser";

const READABLE_ERROR_MAX = 120;

const isReadableError = (error: string): boolean =>
  error.length <= READABLE_ERROR_MAX &&
  !/(^|\s)(\/|[A-Za-z]:\\)\S/u.test(error) &&
  !/^[\w.-]+:[\w.-]+\b/u.test(error);

export function PreviewProblem({
  error,
  missing = false,
  onRetry,
  size = "regular",
  title,
}: {
  error?: string | null | undefined;
  missing?: boolean;
  onRetry?: (() => void) | undefined;
  size?: "regular" | "compact";
  title?: string | undefined;
}) {
  const t = useT();
  const message = error?.trim() ?? "";
  if (missing) {
    return (
      <EmptyState
        motif="unavailable"
        size={size}
        title={title ?? t("shell.display.preview.unavailableTitle")}
        body={message || undefined}
      />
    );
  }
  const readable =
    message.length > 0 &&
    message !== t(PREVIEW_UNAVAILABLE) &&
    isReadableError(message);
  return (
    <EmptyState
      motif="preview"
      size={size}
      title={title ?? t("shell.display.preview.failedTitle")}
      body={readable ? message : t("shell.display.preview.failedBody")}
      bodyHint={message && !readable ? message : undefined}
      {...(onRetry
        ? {
            action: {
              label: t("common.tryAgain"),
              icon: RotateCcw,
              onClick: onRetry,
            },
          }
        : {})}
    />
  );
}

export function PreviewEmpty({
  title,
  body,
  motif = "blank",
  size = "regular",
}: {
  title: string;
  body?: string | undefined;
  motif?: "blank" | "changes";
  size?: "regular" | "compact";
}) {
  return <EmptyState motif={motif} size={size} title={title} body={body} />;
}

type PreviewBoundaryState = { error: Error | null; attempt: number };

export class PreviewBoundary extends Component<
  { children: ReactNode },
  PreviewBoundaryState
> {
  state: PreviewBoundaryState = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<PreviewBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportRendererError({
      kind: "react",
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
      source: info.componentStack?.trim().split("\n")[0]?.trim() ?? "preview",
    });
  }

  retry = () => {
    this.setState((state) => ({ error: null, attempt: state.attempt + 1 }));
  };

  render() {
    if (this.state.error) {
      return <PreviewProblem error={this.state.error.message} onRetry={this.retry} />;
    }
    return <PreviewBoundaryKey key={this.state.attempt}>{this.props.children}</PreviewBoundaryKey>;
  }
}

function PreviewBoundaryKey({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
