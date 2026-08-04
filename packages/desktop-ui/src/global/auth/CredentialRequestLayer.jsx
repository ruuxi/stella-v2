import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/api";
import { getElectronApi } from "@/platform/electron/electron";
import { CredentialModal } from "@/global/integrations/CredentialModal";
export const CredentialRequestLayer = () => {
    const createSecret = useMutation(api.data.secrets.createSecret);
    const [pending, setPending] = useState(null);
    const apiHandle = getElectronApi();
    useEffect(() => {
        const systemApi = apiHandle?.system;
        if (!systemApi?.onCredentialRequest) {
            return;
        }
        const unsubscribe = systemApi.onCredentialRequest((_event, data) => {
            setPending(data);
        });
        return () => unsubscribe();
    }, [apiHandle]);
    const handleSubmit = async ({ label, secret }) => {
        if (!pending)
            return;
        const result = await createSecret({
            provider: pending.provider,
            label,
            plaintext: secret,
        });
        const secretId = result.secretId;
        await apiHandle?.system.submitCredential?.({
            requestId: pending.requestId,
            secretId,
            provider: pending.provider,
            label,
        });
        setPending(null);
    };
    const handleCancel = async () => {
        if (!pending)
            return;
        await apiHandle?.system.cancelCredential?.({ requestId: pending.requestId });
        setPending(null);
    };
    if (!pending)
        return null;
    return (<CredentialModal open={true} provider={pending.provider} label={pending.label} description={pending.description} placeholder={pending.placeholder} onSubmit={handleSubmit} onCancel={handleCancel}/>);
};
