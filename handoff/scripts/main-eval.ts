// Evaluate an async expression in Electron main via the inspector: bun main-eval.ts <port> '<expr using ctx>'
const [port, expr] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { webSocketDebuggerUrl: string }[];
const ws = new WebSocket(targets[0]!.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
const result = await new Promise<any>((resolve) => {
  ws.onmessage = (m) => { const d = JSON.parse(String(m.data)); if (d.id === 1) resolve(d); };
  ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: {
    expression: `(async () => { const ctx = globalThis.__stellaHarnessContext; return JSON.stringify(await (${expr})); })()`,
    awaitPromise: true, returnByValue: true } }));
});
console.log(result.result?.result?.value ?? JSON.stringify(result.result?.exceptionDetails ?? result));
ws.close();
