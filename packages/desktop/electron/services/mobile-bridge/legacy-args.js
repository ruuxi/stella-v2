import { IPC_PAYLOAD_CONTRACT, } from "./ipc-payload-contract.generated.js";

const objectContract = (channel) => {
    const contract = IPC_PAYLOAD_CONTRACT[channel];
    return contract?.kind === "object" ? contract : null;
};

export const adaptLegacyMobileArgs = (channel, args) => {
    const contract = objectContract(channel);
    if (!contract || args.length === 0)
        return args;

    const [first] = args;
    if (args.length === 1 &&
        typeof first === "object" &&
        first !== null &&
        !Array.isArray(first)) {
        return args;
    }
    const payload = {};
    contract.fields.forEach((field, index) => {
        if (index < args.length && args[index] !== undefined) {
            payload[field] = args[index];
        }
    });
    return [payload];
};
