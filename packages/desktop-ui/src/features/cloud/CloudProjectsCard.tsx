import { useCallback, useState } from "react";
import { useAction, useConvexAuth, useMutation, useQuery } from "convex/react";
import { Button } from "@/ui/button";
import { showToast } from "@/ui/toast";
import { driveErrorText } from "@/features/drive/drive-files";
import { CloudBoundary } from "./CloudBoundary";
import { projectsApi } from "./cloud-api";

/**
 * "Cloud projects" settings card: install the GitHub App once, then list the
 * projects cloud agents can work in. Deliberately list/connect/create only —
 * a project's real management surface is chat.
 */

const PROVIDER_LABEL: Record<string, string> = {
  github: "GitHub",
  stella: "Stella-hosted",
};

function CloudProjectsCardImpl() {
  const projects = useQuery(projectsApi.listMyProjects, {});
  const github = useQuery(projectsApi.listMyGithubInstallations, {});
  const startInstall = useAction(projectsApi.startGithubAppInstall);
  const createProject = useMutation(projectsApi.createMyProject);
  const finishConnect = useMutation(projectsApi.finishGithubConnect);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [connectCode, setConnectCode] = useState("");
  const [awaitingCode, setAwaitingCode] = useState(false);
  const connections = github?.connections ?? [];

  const handleConnect = useCallback(async () => {
    setBusy(true);
    try {
      const { installUrl } = await startInstall({});
      window.open(installUrl, "_blank", "noopener");
      // The code field only appears once an install is actually in flight,
      // so the card never invites a code that came from somewhere else.
      setAwaitingCode(true);
    } catch (error) {
      showToast({ title: driveErrorText(error), variant: "error" });
    } finally {
      setBusy(false);
    }
  }, [startInstall]);

  /**
   * The bind. This is a deliberate, authenticated user action and nothing
   * else may stand in for it: reading the code out of a URL or the clipboard
   * and submitting it on load would hand the decision back to whoever
   * supplied the link, which is precisely the account-linking CSRF the
   * two-half handshake exists to close.
   */
  const handleFinishConnect = useCallback(async () => {
    const code = connectCode.trim();
    if (!code) return;
    setBusy(true);
    try {
      const result = await finishConnect({ connectCode: code });
      if (!result.ok) {
        showToast({
          title: result.reason ?? "That connect code was not accepted.",
          variant: "error",
        });
        return;
      }
      setConnectCode("");
      setAwaitingCode(false);
      // The account is named, not just acknowledged: a user who was steered
      // into someone else's handshake finds out here.
      showToast({
        title: `GitHub connected as ${result.accountLogin}.`,
        variant: "success",
      });
    } catch (error) {
      showToast({ title: driveErrorText(error), variant: "error" });
    } finally {
      setBusy(false);
    }
  }, [connectCode, finishConnect]);

  const handleCreate = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    setBusy(true);
    try {
      const remote = remoteUrl.trim();
      await createProject({
        name: trimmedName,
        ...(remote ? { remoteUrl: remote } : {}),
      });
      setName("");
      setRemoteUrl("");
    } catch (error) {
      showToast({ title: driveErrorText(error), variant: "error" });
    } finally {
      setBusy(false);
    }
  }, [createProject, name, remoteUrl]);

  return (
    <div className="settings-card">
      <h3 className="settings-card-title">Cloud projects</h3>
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">GitHub</div>
          <div className="settings-row-sublabel">
            {connections.length
              ? `Connected as ${connections
                  .map((connection) => connection.accountLogin)
                  .join(", ")}.`
              : github && !github.appConfigured
                ? "GitHub projects aren't configured on this deployment yet."
                : "Install Stella's GitHub App to give cloud agents repository access. Stella keeps only the installation id and mints short-lived tokens when an agent needs them. GitHub will show you a connect code at the end — bring it back here to finish."}
          </div>
        </div>
        <div className="settings-row-control">
          <Button
            type="button"
            variant="ghost"
            className="pill-btn"
            onClick={() => void handleConnect()}
            disabled={busy || github?.appConfigured === false}
          >
            {connections.length ? "Manage" : "Connect"}
          </Button>
        </div>
      </div>
      {awaitingCode ? (
        <div className="settings-row">
          <div className="settings-row-info" style={{ flex: 1 }}>
            <div className="settings-row-sublabel">
              Enter the connect code GitHub showed you. It expires in ten
              minutes, and it is what tells Stella the installation belongs to
              this account.
            </div>
            <input
              type="text"
              value={connectCode}
              onChange={(event) => setConnectCode(event.target.value)}
              placeholder="XXXX-XXXX-XXXX"
              autoComplete="off"
              spellCheck={false}
              style={{ width: "100%", marginTop: 6 }}
            />
          </div>
          <div className="settings-row-control">
            <Button
              type="button"
              variant="ghost"
              className="pill-btn"
              onClick={() => void handleFinishConnect()}
              disabled={busy || !connectCode.trim()}
            >
              Finish
            </Button>
          </div>
        </div>
      ) : null}
      {(projects ?? []).map((project) => (
        <div className="settings-row" key={project.projectId}>
          <div className="settings-row-info">
            <div className="settings-row-label">{project.name}</div>
            <div className="settings-row-sublabel">
              {PROVIDER_LABEL[project.provider] ?? project.provider} ·{" "}
              {project.remoteUrl ?? `project:${project.slug}`}
            </div>
          </div>
          <div className="settings-row-control">
            <span className="settings-row-sublabel">{project.status}</span>
          </div>
        </div>
      ))}
      <div className="settings-row">
        <div className="settings-row-info" style={{ flex: 1 }}>
          <div className="settings-row-sublabel">
            Add a project. Leave the repository blank for a Stella-hosted one.
          </div>
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Project name"
            autoComplete="off"
            spellCheck={false}
            style={{ width: "100%", marginTop: 6 }}
          />
          <input
            type="text"
            value={remoteUrl}
            onChange={(event) => setRemoteUrl(event.target.value)}
            placeholder="https://github.com/owner/repo (optional)"
            autoComplete="off"
            spellCheck={false}
            style={{ width: "100%", marginTop: 6 }}
          />
        </div>
        <div className="settings-row-control">
          <Button
            type="button"
            variant="ghost"
            className="pill-btn"
            onClick={() => void handleCreate()}
            disabled={busy || !name.trim()}
          >
            Add
          </Button>
        </div>
      </div>
    </div>
  );
}

export function CloudProjectsCard() {
  const { isAuthenticated } = useConvexAuth();
  if (!isAuthenticated) return null;
  return (
    <CloudBoundary>
      <CloudProjectsCardImpl />
    </CloudBoundary>
  );
}
