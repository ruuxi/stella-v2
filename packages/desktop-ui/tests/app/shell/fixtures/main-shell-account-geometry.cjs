const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sourceRoot = process.env.STELLA_GEOMETRY_SOURCE_ROOT;
if (!sourceRoot) {
  throw new Error("STELLA_GEOMETRY_SOURCE_ROOT is required");
}

const readCss = (relativePath) =>
  fs.readFileSync(path.join(sourceRoot, relativePath), "utf8");

const probeLayout = async () => {
  const shell = document.querySelector("#shell");
  const main = document.querySelector("#main");
  const actions = document.querySelector("#actions");
  const account = document.querySelector("#account");
  const sidebar = document.querySelector("#sidebar");
  const openPanel = document.querySelector("#open-panel");

  const nextFrame = () =>
    new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  const sleep = (durationMs) =>
    new Promise((resolve) => setTimeout(resolve, durationMs));
  const waitForWidthTransition = () =>
    new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        sidebar.removeEventListener("transitionend", onTransitionEnd);
        resolve();
      };
      const onTransitionEnd = (event) => {
        if (event.target === sidebar && event.propertyName === "width") finish();
      };
      sidebar.addEventListener("transitionend", onTransitionEnd);
      setTimeout(finish, 700);
    });
  const rect = (element) => {
    const value = element.getBoundingClientRect();
    return {
      left: value.left,
      right: value.right,
      width: value.width,
    };
  };
  const sample = (label) => ({
    label,
    shell: rect(shell),
    main: rect(main),
    actions: rect(actions),
    account: rect(account),
    accountRendered: account.getClientRects().length > 0,
    sidebar: rect(sidebar),
  });

  const desiredGap = Number.parseFloat(
    getComputedStyle(actions).getPropertyValue("--main-shell-sidebar-gap"),
  );
  const samples = [sample("closed")];

  const opened = waitForWidthTransition();
  sidebar.classList.add(
    "right-sidebar--open",
    "right-sidebar--shell-visible",
  );
  openPanel.style.display = "none";
  actions.dataset.panelOpen = "true";
  await nextFrame();
  samples.push(sample("default-open-start"));
  await sleep(140);
  samples.push(sample("default-open-mid"));
  await opened;
  samples.push(sample("default-open-end"));

  sidebar.classList.add("right-sidebar--resizing");
  document.documentElement.style.setProperty("--display-panel-width", "640px");
  await nextFrame();
  samples.push(sample("resized-open-640"));
  document.documentElement.style.setProperty("--display-panel-width", "420px");
  await nextFrame();
  samples.push(sample("resized-open-420"));
  shell.style.width = "1000px";
  await nextFrame();
  samples.push(sample("resized-open-narrow-shell"));
  shell.style.width = "1600px";
  await nextFrame();
  samples.push(sample("resized-open-wide-shell"));
  shell.style.width = "1280px";
  await nextFrame();

  sidebar.classList.remove("right-sidebar--resizing");
  const resized = waitForWidthTransition();
  document.documentElement.style.setProperty("--display-panel-width", "560px");
  await sleep(140);
  samples.push(sample("resized-open-animation-mid"));
  await resized;
  samples.push(sample("resized-open-animation-end"));

  const actionsParent = actions.parentElement;
  const actionsNextSibling = actions.nextSibling;
  actions.remove();
  sidebar.classList.add("right-sidebar--expanded");
  document.documentElement.dataset.displayPanelExpanded = "true";
  await nextFrame();
  samples.push(sample("expanded-panel"));
  sidebar.classList.remove("right-sidebar--expanded");
  delete document.documentElement.dataset.displayPanelExpanded;
  actionsParent.insertBefore(actions, actionsNextSibling);
  await nextFrame();
  samples.push(sample("restored-from-expanded"));

  const closed = waitForWidthTransition();
  sidebar.classList.remove(
    "right-sidebar--open",
    "right-sidebar--shell-visible",
  );
  openPanel.style.removeProperty("display");
  actions.dataset.panelOpen = "false";
  await sleep(140);
  samples.push(sample("close-animation-mid"));
  await closed;
  samples.push(sample("closed-end"));

  return { desiredGap, samples };
};

app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("no-sandbox");
const userDataPath = fs.mkdtempSync(
  path.join(os.tmpdir(), "stella-shell-geometry-"),
);
app.setPath("userData", userDataPath);

app.whenReady().then(async () => {
  const css = [
    readCss("shell/full-shell.layout.css"),
    readCss("shell/right-sidebar.css"),
    readCss("shell/right-sidebar-panel.css"),
    readCss("shell/shell-junction.css"),
    readCss("shell/sidebar/topbar-nav.css"),
  ].join("\n");
  const html = [
    "<!doctype html>",
    '<html data-shell-panel-chrome="true">',
    "<head>",
    '<meta charset="utf-8">',
    "<style>",
    css,
    "html, body, #fixture { width: 100%; height: 100%; margin: 0; }",
    "#shell { width: 1280px; height: 720px; }",
    ".left-sidebar { flex: 0 0 0; width: 0; }",
    "</style>",
    "</head>",
    "<body>",
    '<div id="fixture" class="window-shell full">',
    '<div id="shell" class="full-body">',
    '<aside class="left-sidebar"></aside>',
    '<div style="display: contents">',
    '<main id="main" class="content-area">',
    '<div id="actions" class="main-shell-top-actions" data-platform="other" data-panel-open="false">',
    '<button id="open-panel" class="shell-topbar-icon-btn" type="button">P</button>',
    '<div id="account" class="shell-topbar-account">',
    '<button class="shell-topbar-account-signin" type="button">Sign in</button>',
    '<button class="shell-topbar-account-settings" type="button">Settings</button>',
    "</div>",
    "</div>",
    "</main>",
    "</div>",
    '<aside id="sidebar" class="right-sidebar right-sidebar-panel">',
    '<div class="right-sidebar-inner right-sidebar-panel__frame"></div>',
    "</aside>",
    "</div>",
    "</div>",
    "</body>",
    "</html>",
  ].join("\n");

  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    webPreferences: {
      backgroundThrottling: false,
      offscreen: true,
    },
  });
  await window.loadURL(
    "data:text/html;base64," + Buffer.from(html).toString("base64"),
  );
  const result = await window.webContents.executeJavaScript(
    "(" + probeLayout.toString() + ")()",
  );
  process.stdout.write(
    "STELLA_GEOMETRY_RESULT=" + JSON.stringify(result) + "\n",
  );
  window.destroy();
  app.quit();
}).catch((error) => {
  process.stderr.write(String(error?.stack ?? error) + "\n");
  app.exit(1);
});

app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => {
  fs.rmSync(userDataPath, { force: true, recursive: true });
});
