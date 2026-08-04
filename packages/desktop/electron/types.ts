export const toChatContextWindow = (windowInfo) => {
    if (!windowInfo || (!windowInfo.title && !windowInfo.process)) {
        return null;
    }
    return {
        title: windowInfo.title,
        app: windowInfo.process,
        bounds: windowInfo.bounds,
    };
};
