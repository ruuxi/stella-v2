import { promises as fs } from "fs";
import {
  BrowserWindow,
  dialog,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
} from "electron";
import path from "path";
import {
  ensurePrivateDir,
  writePrivateFile,
} from "@stella/runtime/kernel/home/private-fs";
import type { WindowManagerTarget } from "@stella/runtime/kernel/lifecycle-targets";
import { t } from "./i18n-service.js";

const SECURITY_POLICY_VERSION = 2;
const SECURITY_APPROVAL_PREFIX = "v1:";

type PersistedSecurityPolicy = {
  approved?: unknown;
};

export type ComputerUseAppApprovalRequest = {
  bundleIdentifier: string;
  displayName: string;
  risk?: string;
  warningSubtitle?: string;
  allowPersistentApproval: boolean;
};

export type ComputerUseAppApprovalResult =
  | { decision: "approved"; scope: "session" | "persistent" }
  | { decision: "declined"; scope: "none" };

export class SecurityPolicyService {
  private securityPolicyPath: string | null = null;
  private readonly trustedPrivilegedActions = new Set<string>();

  constructor(
    private readonly options: {
      windowManagerTarget: WindowManagerTarget<BrowserWindow>;
    },
  ) {}

  setSecurityPolicyPath(policyPath: string) {
    this.securityPolicyPath = policyPath;
  }

  async loadPolicy() {
    this.clearAll();
    if (!this.securityPolicyPath) return;
    try {
      const raw = await fs.readFile(this.securityPolicyPath, "utf-8");
      const parsed = JSON.parse(raw) as PersistedSecurityPolicy;
      const approved = Array.isArray(parsed?.approved) ? parsed.approved : [];
      for (const entry of approved) {
        if (
          typeof entry === "string" &&
          entry.startsWith(SECURITY_APPROVAL_PREFIX)
        ) {
          this.trustedPrivilegedActions.add(entry);
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        console.debug(
          "[security-policy] No persisted policy yet, treating as no approvals",
        );
        return;
      }
      console.debug(
        "[security-policy] Policy file invalid, treating as no approvals:",
        err,
      );
    }
  }

  private async persistPolicy() {
    if (!this.securityPolicyPath) return;
    try {
      await ensurePrivateDir(path.dirname(this.securityPolicyPath));
      await writePrivateFile(
        this.securityPolicyPath,
        JSON.stringify(
          {
            version: SECURITY_POLICY_VERSION,
            approved: [...this.trustedPrivilegedActions].sort(),

            computerUseAppApprovals: {},
          },
          null,
          2,
        ),
      );
    } catch (err) {
      console.debug(
        "[security-policy] Failed to persist policy (best-effort):",
        err,
      );
    }
  }

  async ensureApproval(
    action: string,
    message: string,
    detail: string,
    event?: IpcMainEvent | IpcMainInvokeEvent,
  ) {
    const key = `${SECURITY_APPROVAL_PREFIX}${action}`;
    if (this.trustedPrivilegedActions.has(key)) {
      return true;
    }

    const windowManager = this.options.windowManagerTarget.getWindowManager();
    const ownerWindow =
      (event ? BrowserWindow.fromWebContents(event.sender) : null) ??
      BrowserWindow.getFocusedWindow() ??
      windowManager?.getFullWindow() ??
      undefined;

    const dialogOptions: MessageBoxOptions = {
      type: "warning",
      title: t("desktop.security.confirmationTitle"),
      message,
      detail,
      buttons: [t("desktop.security.allow"), t("desktop.security.deny")],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      checkboxLabel: t("desktop.security.rememberDecision"),
      checkboxChecked: true,
    };

    const choice = ownerWindow
      ? await dialog.showMessageBox(ownerWindow, dialogOptions)
      : await dialog.showMessageBox(dialogOptions);

    if (choice.response !== 0) {
      return false;
    }

    if (choice.checkboxChecked) {
      this.trustedPrivilegedActions.add(key);
      await this.persistPolicy();
    }

    return true;
  }

  async ensureComputerUseAppApproval(
    request: ComputerUseAppApprovalRequest,
  ): Promise<ComputerUseAppApprovalResult> {

    void request;
    return { decision: "approved", scope: "session" };
  }

  clearAll() {
    this.trustedPrivilegedActions.clear();
  }
}
