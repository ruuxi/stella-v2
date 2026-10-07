import fs from "fs";
import path from "path";
import {
  effectiveEscalationCeiling,
  isWithinQuietHours,
  nextEscalationLevel,
  USER_ASK_ESCALATION_STEP_MS,
} from "@stella/contracts/user-ask";
import { writePrivateFileSync } from "@stella/runtime/kernel/shared/private-fs";
const ESCALATION_BUDGET_FILE = "user-ask-escalations.json";
const BUDGET_WINDOW_MS = 60 * 60_000;
const MAX_BUDGET_EVENTS = 200;
export const localTimeZone = () => {
    try {
        return new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    }
    catch {
        return "UTC";
    }
};
export const minuteOfDayAt = (at, timeZone) => {
    const zone = timeZone || localTimeZone();
    try {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: zone,
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
        }).formatToParts(new Date(at));
        const hour = Number(parts.find((part) => part.type === "hour")?.value);
        const minute = Number(parts.find((part) => part.type === "minute")?.value);
        if (Number.isFinite(hour) && Number.isFinite(minute)) {
            return hour * 60 + minute;
        }
    }
    catch {
        const utc = new Date(at);
        return utc.getUTCHours() * 60 + utc.getUTCMinutes();
    }
    const utc = new Date(at);
    return utc.getUTCHours() * 60 + utc.getUTCMinutes();
};
const readBudgetEvents = (stellaAppDir) => {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(stellaAppDir, ESCALATION_BUDGET_FILE), "utf-8"));
        if (parsed?.version !== 1 || !Array.isArray(parsed.events)) {
            return [];
        }
        return parsed.events.filter((at) => typeof at === "number" && Number.isFinite(at));
    }
    catch {
        return [];
    }
};
const writeBudgetEvents = (stellaAppDir, events) => {
    try {
        writePrivateFileSync(path.join(stellaAppDir, ESCALATION_BUDGET_FILE), JSON.stringify({ version: 1, events: events.slice(-MAX_BUDGET_EVENTS) }, null, 2));
    }
    catch {
        return;
    }
};
export class UserAskEscalationEngine {
    options;
    timers = new Map();
    constructor(options) {
        this.options = options;
    }
    start(askId) {
        this.arm(askId, USER_ASK_ESCALATION_STEP_MS);
    }
    stop(askId) {
        const timer = this.timers.get(askId);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(askId);
        }
    }
    stopAll() {
        for (const askId of [...this.timers.keys()]) {
            this.stop(askId);
        }
    }
    arm(askId, delayMs) {
        this.stop(askId);
        const timer = setTimeout(() => {
            this.timers.delete(askId);
            void this.step(askId);
        }, delayMs);
        timer.unref?.();
        this.timers.set(askId, timer);
        return Date.now() + delayMs;
    }
    async step(askId) {
        const ask = this.options.getAsk(askId);
        if (!ask || ask.state !== "pending") {
            return;
        }
        const policy = await this.options.getPolicy();
        if (!this.options.getAsk(askId) || this.options.getAsk(askId).state !== "pending") {
            return;
        }
        const now = Date.now();
        const minuteOfDay = minuteOfDayAt(now, policy.timeZone);
        const ceiling = effectiveEscalationCeiling(policy, ask.urgency, minuteOfDay);
        const level = nextEscalationLevel(ask.escalationLevel, ceiling);
        if (level === null) {
            this.arm(askId, USER_ASK_ESCALATION_STEP_MS);
            return;
        }
        if (!this.consumeBudget(policy, now)) {
            this.arm(askId, USER_ASK_ESCALATION_STEP_MS);
            return;
        }
        const nextEscalationAt = this.arm(askId, USER_ASK_ESCALATION_STEP_MS);
        try {
            await this.options.applyLevel(ask, level, {
                policy,
                quietHours: isWithinQuietHours(policy.quietHours, minuteOfDay),
                nextEscalationAt,
            });
        }
        catch {
            return;
        }
    }
    consumeBudget(policy, now) {
        const stellaAppDir = this.options.getStellaAppDir();
        if (!stellaAppDir) {
            return true;
        }
        const events = readBudgetEvents(stellaAppDir).filter((at) => now - at < BUDGET_WINDOW_MS);
        if (events.length >= policy.maxPerHour) {
            writeBudgetEvents(stellaAppDir, events);
            return false;
        }
        writeBudgetEvents(stellaAppDir, [...events, now]);
        return true;
    }
}
