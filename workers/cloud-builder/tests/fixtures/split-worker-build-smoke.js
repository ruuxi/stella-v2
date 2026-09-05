// Smoke entry for the split-worker build test. The placeholder inside
// `Promise.all` becomes a dynamic import of every emitted bundle module.
export * from "./index.js";
import { BuildSession } from "./index.js";

export class BuildSessionProbe extends BuildSession {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/__test/arm") {
      await this.ctx.storage.setAlarm(Date.now() + 100);
      return Response.json({ armed: true });
    }
    if (path === "/__test/status") {
      return Response.json({
        alarmRan: (await this.ctx.storage.get("alarmRan")) === true,
      });
    }
    return super.fetch(request);
  }

  async alarm() {
    await super.alarm();
    await this.ctx.storage.put("alarmRan", true);
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/build-session")) {
      const suffix = path.slice("/build-session".length) || "/";
      return env.BUILD_SESSIONS.getByName("probe").fetch(
        new Request(new URL(suffix, request.url), request),
      );
    }
    const modules = await Promise.all([__LAZY_MODULE_IMPORTS__]);
    const entry = await import("./index.js");
    return Response.json({
      loaded: modules.length,
      exports: Object.keys(entry),
    });
  },
};
