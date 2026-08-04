import { Notification } from "electron";
import { randomUUID } from "node:crypto";
const notificationRoutes = new Map();
const liveNotifications = new Set();
const notificationModule = Notification;
const routeFromActivationArguments = (args) => {
    if (!args)
        return null;
    for (const [id, route] of notificationRoutes) {
        if (args.includes(id))
            return route;
    }
    return null;
};
const activateNotificationRoute = (context, route) => {
    if (!context.state.windowManager) {
        context.state.processRuntime.setManagedTimeout(() => {
            activateNotificationRoute(context, route);
        }, 250);
        return;
    }
    context.state.windowManager.showWindow();
};
export const configureNotificationActivationHandling = (context) => {
    if (process.platform === "win32" && notificationModule.handleActivation) {
        notificationModule.handleActivation((details) => {
            activateNotificationRoute(context, routeFromActivationArguments(details.arguments) ?? {
                kind: "open-window",
            });
        });
    }
    if (process.platform === "darwin" && notificationModule.getHistory) {
        void notificationModule
            .getHistory()
            .then((notifications) => {
            for (const notification of notifications) {
                const route = notificationRoutes.get(notification.id);
                notification.on("click", () => activateNotificationRoute(context, route ?? null));
                liveNotifications.add(notification);
            }
        })
            .catch(() => undefined);
    }
};
export const showStellaNotification = (context, options, route = { kind: "open-window" }) => {
    if (!Notification.isSupported())
        return false;
    const id = options.id?.trim() || `stella-${randomUUID()}`;
    notificationRoutes.set(id, route);
    const notification = new Notification({
        ...options,
        id,
    });
    liveNotifications.add(notification);
    notification.on("click", () => activateNotificationRoute(context, route));
    notification.on("action", () => activateNotificationRoute(context, route));
    notification.on("reply", () => activateNotificationRoute(context, route));
    notification.on("close", () => {
        liveNotifications.delete(notification);
    });
    notification.on("failed", (_event, error) => {
        console.warn("Stella notification failed:", error);
    });
    notification.show();
    return true;
};
