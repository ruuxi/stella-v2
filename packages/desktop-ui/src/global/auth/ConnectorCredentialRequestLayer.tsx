import { useCallback, useEffect, useState } from "react";
import { getElectronApi } from "@/platform/electron/electron";
import { CredentialModal } from "@/global/integrations/CredentialModal";
import { ConnectorOAuthDialog } from "@/global/integrations/ConnectorOAuthDialog";

type PendingConnectorCredentialRequest = {
  requestId: string;
  tokenKey: string;
  displayName: string;
  mode: "api_key" | "oauth" | "account_origin";
  authType?: "api_key" | "oauth" | "hosted_connect" | "account_origin";
  completionMode?: "approve" | "wait";
  description?: string;
  placeholder?: string;
  originField?: {
    label?: string;
    placeholder?: string;
    value?: string;
  };
  oauthUserCode?: string;
  oauthVerificationUri?: string;
  completionError?: string;
};

export const ConnectorCredentialRequestLayer = () => {
  const [queue, setQueue] = useState<PendingConnectorCredentialRequest[]>([]);
  const pending = queue[0] ?? null;
  const apiHandle = getElectronApi();

  const removeRequest = useCallback((requestId: string) => {
    setQueue((current) =>
      current.filter((entry) => entry.requestId !== requestId),
    );
  }, []);

  useEffect(() => {
    const systemApi = apiHandle?.system;
    if (!systemApi?.onConnectorCredentialRequest) return;

    const unsubscribe = systemApi.onConnectorCredentialRequest(
      (_event, data) => {
        setQueue((current) =>
          current.some((entry) => entry.requestId === data.requestId)
            ? current
            : [...current, data],
        );
      },
    );
    return unsubscribe;
  }, [apiHandle]);

  useEffect(() => {
    const systemApi = apiHandle?.system;
    if (!systemApi?.onConnectorCredentialComplete) return;

    const unsubscribe = systemApi.onConnectorCredentialComplete(
      (_event, data) => {
        if (data.ok || data.reason === "cancelled") {
          removeRequest(data.requestId);
          return;
        }
        setQueue((current) =>
          current.map((entry) =>
            entry.requestId === data.requestId
              ? {
                  ...entry,
                  completionError:
                    data.reason === "timeout"
                      ? "Authorization timed out. Start the connection again from the Store."
                      : "The connection could not be completed. Start it again from the Store.",
                }
              : entry,
          ),
        );
      },
    );
    return unsubscribe;
  }, [apiHandle, removeRequest]);

  const handleSubmit = async ({
    label,
    secret,
    origin,
  }: {
    label: string;
    secret: string;
    origin?: string;
  }) => {
    if (!pending) return;
    const requestId = pending.requestId;
    const result = await apiHandle?.system.submitConnectorCredential?.({
      requestId,
      value: secret,
      label,
      ...(origin !== undefined ? { origin } : {}),
    });
    if (!result?.ok) {
      throw new Error(
        result?.error ?? "Could not save the connector credential.",
      );
    }
    removeRequest(requestId);
  };

  const handleCancel = async () => {
    if (!pending) return;
    const requestId = pending.requestId;
    await apiHandle?.system.cancelConnectorCredential?.({
      requestId,
    });
    removeRequest(requestId);
  };

  const handleOpenOAuth = async () => {
    if (!pending) return;
    const requestId = pending.requestId;
    const result = await apiHandle?.system.submitConnectorCredential?.({
      requestId,
      value: "open",
      label: pending.displayName,
    });
    if (!result?.ok) {
      throw new Error(result?.error ?? "Could not start the connection.");
    }
    if (pending.completionMode === "approve") {
      removeRequest(requestId);
    }
  };

  if (!pending) return null;

  if (pending.mode === "oauth") {
    return (
      <ConnectorOAuthDialog
        key={pending.requestId}
        open
        displayName={pending.displayName}
        description={pending.description}
        oauthUserCode={pending.oauthUserCode}
        waitForCompletion={pending.completionMode !== "approve"}
        completionError={pending.completionError}
        onOpenExternal={handleOpenOAuth}
        onCancel={handleCancel}
        onDismiss={() => removeRequest(pending.requestId)}
      />
    );
  }

  return (
    <CredentialModal
      key={pending.requestId}
      open
      provider={pending.tokenKey}
      label={pending.displayName}
      description={pending.description}
      placeholder={pending.placeholder ?? "Paste your key"}
      inputType={pending.mode === "account_origin" ? "url" : "password"}
      valueLabel={
        pending.mode === "account_origin" ? "Snowflake account URL" : undefined
      }
      requiredMessage={
        pending.mode === "account_origin"
          ? "Enter your Snowflake account URL."
          : undefined
      }
      submitLabel={pending.mode === "account_origin" ? "Continue" : undefined}
      submittingLabel={
        pending.mode === "account_origin" ? "Checking..." : undefined
      }
      showLabel={false}
      originField={pending.originField}
      onSubmit={handleSubmit}
      onCancel={handleCancel}
    />
  );
};
