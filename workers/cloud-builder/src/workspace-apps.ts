import type { CreateAppResult } from "@cloudflare/worker-bundler";
import type { WorldSqlStore } from "./world/store.js";

const SLUG = /^[a-z][a-z0-9-]{0,31}$/;
const REVISION = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_BYTES = 2 * 1024 * 1024;
const decoder = new TextDecoder();
import type { WorkspaceApp } from "@stella/contracts/workspace-apps";
export type { WorkspaceApp } from "@stella/contracts/workspace-apps";
type Release = { app: WorkspaceApp; chunks: number };
const DEFAULT_SERVER = `import { DurableObject } from 'cloudflare:workers'; export class App extends DurableObject { fetch() { return new Response('Not found', {status:404}); } }`;

export function parseAppManifest(text: string, slug: string) {
  const value = JSON.parse(text);
  if (
    !SLUG.test(slug) ||
    value?.schemaVersion !== 1 ||
    value.slug !== slug ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 100 ||
    typeof value.revision !== "string" ||
    !REVISION.test(value.revision)
  )
    throw new Error("Invalid stella.app.json.");
  return { slug, name: value.name.trim(), revision: value.revision };
}

/** One owner workspace supervises isolated app facets, never passing host bindings. */
export class WorkspaceApps {
  private bundles = new Map<
    string,
    { revision: string; result: CreateAppResult }
  >();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private world: WorldSqlStore,
    private ctx: DurableObjectState,
    private env: Env,
  ) {}

  private async bundle(files: Record<string, string>) {
    const { createApp } = await import("@cloudflare/worker-bundler");
    const assets: Record<string, string> = {};
    const source: Record<string, string> = {};
    for (const [path, text] of Object.entries(files)) {
      if (path.startsWith("public/")) assets["/" + path.slice(7)] = text;
      else if (path.startsWith("src/") || path === "package.json")
        source[path] = text;
    }
    if (!assets["/index.html"]) throw new Error("Missing public/index.html.");
    source["src/server.ts"] ??= DEFAULT_SERVER;
    return createApp({
      files: source,
      server: "src/server.ts",
      ...(source["src/client.tsx"] ? { client: "src/client.tsx" } : {}),
      assets,
      jsx: "automatic",
      assetConfig: { not_found_handling: "none" },
    });
  }

  reconcile(): Promise<WorkspaceApp[]> {
    const next = this.queue.then(() => this.reconcileNow());
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async reconcileNow(): Promise<WorkspaceApp[]> {
    const listing = await this.world.list("apps", { limit: 5000 });
    if (listing.cursor)
      throw new Error("Apps folder exceeds the 5000-file limit.");
    const manifests = listing.entries.filter(
      (e) =>
        /^apps\/[a-z][a-z0-9-]{0,31}\/stella\.app\.json$/.test(e.path) &&
        e.kind === "file",
    );
    if (manifests.length > 50)
      throw new Error("At most 50 apps are supported.");
    const apps: WorkspaceApp[] = [];
    for (const entry of manifests) {
      const slug = entry.path.split("/")[1]!;
      let manifest;
      try {
        if (entry.size > 4096) throw new Error("Manifest too large.");
        manifest = parseAppManifest(
          decoder.decode((await this.world.readFile(entry.path))!),
          slug,
        );
      } catch {
        continue;
      }
      const key = `workspace-app:${slug}`;
      const old = await this.ctx.storage.get<Release>(key);
      const attemptKey = `workspace-app-attempt:${slug}`;
      const attempted = await this.ctx.storage.get<WorkspaceApp>(attemptKey);
      if (attempted?.revision === manifest.revision) {
        apps.push(
          old
            ? {
                ...old.app,
                ...(attempted?.error ? { error: attempted.error } : {}),
              }
            : attempted!,
        );
        continue;
      }
      const now = Date.now();
      const app: WorkspaceApp = {
        appId: slug,
        slug,
        title: manifest.name,
        revision: manifest.revision,
        status: "ready",
        createdAt: old?.app.createdAt ?? now,
        updatedAt: now,
      };
      try {
        const prefix = `apps/${slug}/revisions/${manifest.revision}/`;
        const entries = listing.entries.filter((e) =>
          e.path.startsWith(prefix),
        );
        if (
          entries.length > 200 ||
          entries.reduce((sum, e) => sum + e.size, 0) > MAX_BYTES
        )
          throw new Error("App exceeds 200 files or 2 MiB.");
        const files: Record<string, string> = {};
        for (const file of entries) {
          if (file.kind === "dir") continue;
          if (file.kind !== "file")
            throw new Error("Symlinks are not supported in apps.");
          files[file.path.slice(prefix.length)] = decoder.decode(
            (await this.world.readFile(file.path))!,
          );
        }
        const result = await this.bundle(files);
        // Ensure the manifest was not replaced while npm dependencies were resolving.
        const current = decoder.decode(
          (await this.world.readFile(entry.path))!,
        );
        if (parseAppManifest(current, slug).revision !== manifest.revision)
          continue;
        const encoded = new TextEncoder().encode(JSON.stringify(files));
        const chunks = Math.ceil(encoded.length / 65536);
        for (let i = 0; i < chunks; i++)
          await this.ctx.storage.put(
            `${key}:source:${app.revision}:${i}`,
            encoded.slice(i * 65536, (i + 1) * 65536),
          );
        await this.ctx.storage.put(key, { app, chunks } satisfies Release);
        if (old && old.app.revision !== app.revision) {
          for (let i = 0; i < old.chunks; i++)
            await this.ctx.storage.delete(
              `${key}:source:${old.app.revision}:${i}`,
            );
        }
        this.ctx.facets.abort(`app:${slug}`, new Error("App updated"));
        if (this.bundles.size >= 8)
          this.bundles.delete(this.bundles.keys().next().value!);
        this.bundles.set(slug, { revision: app.revision, result });
      } catch (error) {
        app.status = "error";
        app.error = (
          error instanceof Error ? error.message : "App build failed."
        ).slice(0, 2000);
      }
      await this.ctx.storage.put(attemptKey, app);
      await this.world.writeFile(
        `apps/${slug}/build-status.json`,
        new TextEncoder().encode(JSON.stringify(app, null, 2)),
      );
      apps.push(
        app.status === "error" && old ? { ...old.app, error: app.error } : app,
      );
    }
    return apps;
  }

  private async readReleaseFiles(
    slug: string,
    release: Release,
  ): Promise<Record<string, string>> {
    // Migration from the first development build; new releases use bounded chunks.
    if ("files" in release)
      return (release as Release & { files: Record<string, string> }).files;
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < release.chunks; i++) {
      const chunk = await this.ctx.storage.get<Uint8Array>(
        `workspace-app:${slug}:source:${release.app.revision}:${i}`,
      );
      if (!chunk) throw new Error("App source is unavailable.");
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(decoder.decode(bytes));
  }

  async fetch(slug: string, request: Request): Promise<Response> {
    if (
      !SLUG.test(slug) ||
      !(await this.world.stat(`apps/${slug}/stella.app.json`))
    )
      return new Response("App not found", { status: 404 });
    const release = await this.ctx.storage.get<Release>(
      `workspace-app:${slug}`,
    );
    if (!release)
      return new Response("App has not built successfully.", { status: 409 });
    let cached = this.bundles.get(slug);
    if (!cached || cached.revision !== release.app.revision) {
      cached = {
        revision: release.app.revision,
        result: await this.bundle(await this.readReleaseFiles(slug, release)),
      };
      // Bound per-isolate bundle retention; source remains durable.
      if (this.bundles.size >= 8)
        this.bundles.delete(this.bundles.keys().next().value!);
      this.bundles.set(slug, cached);
    }
    const { result } = cached;
    const { createMemoryStorage, handleAssetRequest } =
      await import("@cloudflare/worker-bundler");
    const asset = await handleAssetRequest(
      request,
      result.assetManifest,
      createMemoryStorage(result.assets),
      result.assetConfig,
    );
    if (asset) return asset;
    const worker = this.env.LOADER.get(
      `app:${this.ctx.id}:${slug}:${cached.revision}`,
      () => ({
        mainModule: result.mainModule,
        modules: result.modules,
        compatibilityDate: "2026-07-22",
        globalOutbound: null,
      }),
    );
    return this.ctx.facets
      .get(`app:${slug}`, () => ({
        class: worker.getDurableObjectClass("App"),
      }))
      .fetch(request);
  }
}
