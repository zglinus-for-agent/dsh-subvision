import type { Context } from "@deepseek-ai/cordis";
// Pull the cordis Context augmentations for the services this file uses.
import type {} from "@deepseek-ai/dsh-subagent";
import type {} from "@deepseek-ai/dsh-agent";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { SessionId } from "@deepseek-ai/dsh-session";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PluginConfig } from "./config.js";
import { VisionRegistry, type VisionChildRecord } from "./vision-registry.js";
import { cacheRoot, hashMarker, type ResolvedImage } from "./image.js";
import { standardizeImage } from "./image-std.js";
import { ensureThumbnail } from "./thumb.js";
import {
  CATALOG_TTL_MS,
  firstVisionModel,
  llmOf,
  loadProviderCatalog,
  type ModelCatalog,
  type ProviderCatalogEntry,
} from "./vision-models.js";
import { childDelegationFilter } from "./child-tools.js";

const BASE = "/dsh-subvision/v1";

type Req = IncomingMessage;
type Res = ServerResponse;

interface RegisterOptions {
  kind: "prefix";
  path: string;
  handler: (req: Req, res: Res) => unknown | Promise<unknown>;
}

interface DeviceApiCtx {
  webServer?: { register(options: RegisterOptions): () => void };
}

function json(res: Res, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" });
  res.end(JSON.stringify(body));
}

function sameOrigin(req: Req): boolean {
  const origin = req.headers?.origin;
  if (!origin) return true;
  try { return new URL(origin).host === (req.headers?.host ?? ""); } catch { return false; }
}

async function readBody(req: Req): Promise<string> {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1 << 16) break;
  }
  return data;
}

/** Deterministic standardized-cache path for one hash + long edge (mirrors image-std). */
function stdCachePath(record: Pick<VisionChildRecord, "hash" | "imagePath">, longEdge: number): string {
  const ext = path.extname(record.imagePath).toLowerCase();
  const readable = [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext);
  const name = readable
    ? `${record.hash}-s${longEdge}${ext}`
    : `${record.hash}-s${longEdge}.png`;
  return path.join(cacheRoot(), "standardized", name);
}

export interface DeviceApiDeps {
  currentConfig: () => PluginConfig;
}

/**
 * Server half of the "识图设备" page: same-origin HTTP API under
 * `/dsh-subvision/v1` exposing the durable per-image vision-subagent
 * registry, configured models for dropdowns, and a per-device "rebuild with
 * another model" action.
 */
export function installDevicesApi(ctx: Context & DeviceApiCtx, deps: DeviceApiDeps): void {
  if (ctx.webServer === undefined) {
    ctx.logger?.warn?.("[dsh-subvision] webServer unavailable; device API not mounted");
    return;
  }
  // Provider/model catalog (shared with the "auto" resolution in index.ts via
  // vision-models.ts: ctx.llm.listProviders → listModels → resolveModelInfo).
  // Cached 60s so the page's 3s polling never pounds adapters (esp. remote
  // catalogs like opencode).
  const providerCatalog = new Map<string, ProviderCatalogEntry>();

  const buildCatalog = async (): Promise<ModelCatalog> => {
    const llm = llmOf(ctx);
    if (llm === undefined) return { models: {}, vision: {}, providers: [] };

    const cfg = deps.currentConfig();
    const wanted = new Map<string, string>();
    for (const provider of llm.listProviders()) wanted.set(provider.id, provider.name);
    if (cfg.model?.provider) wanted.set(cfg.model.provider, cfg.model.provider);
    if (!wanted.has("deepseek-official")) wanted.set("deepseek-official", "deepseek-official");

    const models: Record<string, string[]> = {};
    const vision: Record<string, string[]> = {};
    const providers: Array<{ id: string; name: string }> = [];

    for (const [id, name] of wanted) {
      const entry = await loadProviderCatalog(llm, id, providerCatalog, CATALOG_TTL_MS);
      if (entry.models.length > 0) {
        models[id] = [...entry.models];
        if (entry.vision.length > 0) vision[id] = [...entry.vision];
        providers.push({ id, name });
      }
    }
    return { models, vision, providers };
  };

  /** Bytes inside one cache subdirectory (recursive). */
  const dirBytes = async (dir: string): Promise<number> => {
    let total = 0;
    const walk = async (d: string): Promise<void> => {
      const names = await fs.readdir(d).catch(() => []);
      for (const name of names) {
        const full = path.join(d, name);
        const stat = await fs.stat(full).catch(() => null);
        if (stat === null) continue;
        if (stat.isFile()) total += stat.size;
        else if (stat.isDirectory()) await walk(full);
      }
    };
    await walk(dir);
    return total;
  };

  /** File count inside one directory (recursive). */
  const countFiles = async (dir: string): Promise<number> => {
    let count = 0;
    const walk = async (d: string): Promise<void> => {
      const names = await fs.readdir(d).catch(() => []);
      for (const name of names) {
        const full = path.join(d, name);
        const stat = await fs.stat(full).catch(() => null);
        if (stat === null) continue;
        if (stat.isFile()) count += 1;
        else if (stat.isDirectory()) await walk(full);
      }
    };
    await walk(dir);
    return count;
  };

  /** Cache usage summary for the page: standardized copies + downloaded originals + thumbnails. */
  const cacheStats = async (): Promise<{
    standardizedBytes: number; downloadBytes: number; thumbnailBytes: number; files: number;
  }> => {
    const root = cacheRoot();
    return {
      standardizedBytes: await dirBytes(path.join(root, "standardized")),
      downloadBytes: await dirBytes(path.join(root, "downloads")),
      thumbnailBytes: await dirBytes(path.join(root, "thumbnails")),
      files: await countFiles(root),
    };
  };

  /** 全盘扫描：任一工作区下是否存在该会话（session.jsonl.zstd） */
  const sessionExists = async (id: string): Promise<boolean> => {
    const sessionsRoot = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), "sessions");
    const workspaces = await fs.readdir(sessionsRoot).catch(() => []);
    for (const workspace of workspaces) {
      const marker = path.join(sessionsRoot, workspace, id, "session.jsonl.zstd");
      if (await fs.access(marker).then(() => true, () => false)) return true;
    }
    return false;
  };

  /** 归档会话判定：读取 ~/.dsh/storages/workspace.json 的 global.archivedSessionIds（10s 缓存）。 */
  let archivedAt = 0;
  let archivedIds: Set<string> = new Set();
  const readArchivedSessionIds = async (): Promise<Set<string>> => {
    const now = Date.now();
    if (now - archivedAt > 10_000) {
      const file = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), "storages", "workspace.json");
      const raw = await fs.readFile(file, "utf8").catch(() => null);
      const ids: string[] = [];
      if (raw !== null) {
        try {
          const parsed = JSON.parse(raw) as { global?: { archivedSessionIds?: unknown } };
          if (Array.isArray(parsed.global?.archivedSessionIds)) {
            for (const id of parsed.global.archivedSessionIds) {
              if (typeof id === "string") ids.push(id);
            }
          }
        } catch {
          // ignore malformed workspace file
        }
      }
      archivedIds = new Set(ids);
      archivedAt = now;
    }
    return archivedIds;
  };

  /** 删除某个图片哈希在标准化/下载/缩略图缓存里的全部文件。 */
  const removeHashFiles = async (hash: string): Promise<number> => {
    let removed = 0;
    const root = cacheRoot();
    for (const dir of ["standardized", "downloads", "thumbnails"]) {
      const full = path.join(root, dir);
      const names = await fs.readdir(full).catch(() => []);
      for (const name of names) {
        if (name.startsWith(hash + ".") || name.startsWith(hash + "-")) {
          await fs.rm(path.join(full, name), { force: true }).catch(() => undefined);
          removed += 1;
        }
      }
    }
    return removed;
  };

  /** Build the exact seed text the vision subagent receives (mirrors index.ts). */
  const buildSeedText = (
    cfg: PluginConfig,
    readPath: string,
    originalPath: string,
    marker: string,
    question: string,
  ): string => (
    "你是一个专职图片识别子代理。本次任务对应一张图片：\n"
    + `- 图片路径：${readPath}\n`
    + (readPath === originalPath ? "" : `- 原图路径：${originalPath}（已由插件标准化：最长边缩至 ${cfg.normalizeLongEdge}px，仅缩不放）\n`)
    + `- 图片内容哈希（标题标记）：${marker}\n`
    + "请先调用 read_image 工具读取这张图片（若工具返回的图片没有随消息显示，仍以工具读取为准），然后回答下面的问题。"
    + "回答要尽量详细准确；看不清、不确定或图片无法读取时如实说明，不要编造。\n\n"
    + `问题：${question}`
  );

  const handle = async (req: Req, res: Res): Promise<void> => {
    if (!sameOrigin(req)) return json(res, 403, { ok: false, error: "forbidden" });
    const url = new URL(req.url ?? "/", "http://dsh.internal");
    const p = url.pathname;
    const method = req.method ?? "GET";
    try {
      if (p === `${BASE}/devices` && method === "GET") {
        const cfg = deps.currentConfig();
        const records = await VisionRegistry.allSessions();
        const archivedIds = await readArchivedSessionIds();
        // 逐会话标注：exists=磁盘存在；archived=workspace.json 归档列表
        const sessions = [];
        for (const record of records) {
          sessions.push({
            ...record,
            exists: await sessionExists(record.session),
            archived: archivedIds.has(record.session),
          });
        }
        const catalog = await buildCatalog();
        // What "auto" currently resolves to (first image-capable model), so the
        // page can show it instead of the old "跟随主管" wording.
        const autoModel = await firstVisionModel(ctx, providerCatalog, CATALOG_TTL_MS);
        const cache = await cacheStats();
        return json(res, 200, {
          ok: true,
          defaultModel: cfg.model ?? null,
          autoModel: autoModel ?? null,
          normalize: cfg.normalize,
          normalizeLongEdge: cfg.normalizeLongEdge,
          models: catalog.models,
          vision: catalog.vision,
          providers: catalog.providers,
          cache,
          sessions,
        });
      }
      if (p === `${BASE}/thumbnail` && method === "GET") {
        const session = url.searchParams.get("session");
        const hash = url.searchParams.get("hash");
        if (typeof session !== "string" || session.length === 0) return json(res, 400, { ok: false, error: "session required" });
        if (typeof hash !== "string" || hash.length === 0) return json(res, 400, { ok: false, error: "hash required" });
        const record = await new VisionRegistry(session).find(hash);
        if (record === undefined) return json(res, 404, { ok: false, error: "unknown device" });
        // Serve the plugin-cached thumbnail (generated eagerly at recognition
        // time, or lazily here while the original still exists) instead of the
        // original file, so the card keeps its picture after the original is
        // deleted/moved. Returns 404 only when no cache exists and the
        // original is gone too.
        const cfg = deps.currentConfig();
        const thumb = await ensureThumbnail(record.hash, {
          originalPath: record.imagePath,
          fallbackPaths: [stdCachePath(record, cfg.normalizeLongEdge)],
        });
        if (thumb === null) return json(res, 404, { ok: false, error: "thumbnail unavailable: no cached copy and original image file is gone" });
        const bytes = await fs.readFile(thumb).catch(() => null);
        if (bytes === null) return json(res, 404, { ok: false, error: "thumbnail file unreadable" });
        const mime: Record<string, string> = {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".webp": "image/webp",
          ".gif": "image/gif",
        };
        res.writeHead(200, {
          "content-type": mime[path.extname(thumb).toLowerCase()] ?? "application/octet-stream",
          "cache-control": "public, max-age=86400, immutable",
        });
        res.end(bytes);
        return;
      }
      if (p === `${BASE}/cache` && method === "POST") {
        const root = cacheRoot();
        const removed = await countFiles(root);
        for (const dir of ["standardized", "downloads", "thumbnails"]) {
          await fs.rm(path.join(root, dir), { recursive: true, force: true }).catch(() => undefined);
          await fs.mkdir(path.join(root, dir), { recursive: true }).catch(() => undefined);
        }
        return json(res, 200, { ok: true, removed });
      }
      if (p === `${BASE}/cache/session` && method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as { session?: string };
        const session = body.session ?? url.searchParams.get("session");
        if (typeof session !== "string" || session.length === 0) return json(res, 400, { ok: false, error: "session required" });
        const records = await new VisionRegistry(session).all();
        let removed = 0;
        for (const record of records) removed += await removeHashFiles(record.hash);
        return json(res, 200, { ok: true, removed });
      }
      if (p === `${BASE}/device/delete` && method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as { session?: string; hash?: string };
        const session = body.session ?? url.searchParams.get("session");
        const hash = body.hash ?? url.searchParams.get("hash");
        if (typeof session !== "string" || session.length === 0) return json(res, 400, { ok: false, error: "session required" });
        if (typeof hash !== "string" || hash.length === 0) return json(res, 400, { ok: false, error: "hash required" });
        const registry = new VisionRegistry(session);
        const record = await registry.find(hash);
        if (record === undefined) return json(res, 404, { ok: false, error: "no device record for this hash" });
        const removed = await removeHashFiles(record.hash);
        await registry.forget(hash);
        return json(res, 200, { ok: true, removed, deletedHash: hash });
      }
      if (p === `${BASE}/device/recreate` && method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as {
          session?: string; hash?: string; provider?: string; model?: string;
        };
        const session = body.session ?? url.searchParams.get("session");
        const hash = body.hash ?? url.searchParams.get("hash");
        if (typeof session !== "string" || session.length === 0) return json(res, 400, { ok: false, error: "session required" });
        if (typeof hash !== "string" || hash.length === 0) return json(res, 400, { ok: false, error: "hash required" });
        const registry = new VisionRegistry(session);
        const record = await registry.find(hash);
        if (record === undefined) return json(res, 404, { ok: false, error: "no device record for this hash" });
        const parent: Agent | undefined = ctx.agents.get(SessionId(session));
        if (parent === undefined) return json(res, 409, { ok: false, error: "父会话(主管)当前不在线，无法为它重建识别子代理" });
        const exists = await fs.stat(record.imagePath).then((s) => s.isFile(), () => false);
        if (!exists) return json(res, 400, { ok: false, error: `原图已不可用：${record.imagePath}（请重新通过 image_recognize 提交）` });

        // Opportunistically ensure the cached thumbnail while the original is available.
        await ensureThumbnail(record.hash, { originalPath: record.imagePath }).catch(() => undefined);

        const cfg = deps.currentConfig();
        const bodyProvider = (body.provider ?? "").trim();
        const bodyModel = (body.model ?? "").trim();
        // Empty provider/model means "auto": the configured default model when
        // set, otherwise the first vision-capable model in the catalog (never a
        // text-only supervisor model, which would refuse the image).
        let provider = bodyProvider;
        let model = bodyModel;
        if (provider === "" || model === "") {
          const fixed = cfg.model;
          const auto = fixed !== undefined && fixed.provider !== "" && fixed.model !== ""
            ? { provider: fixed.provider, model: fixed.model }
            : await firstVisionModel(ctx, providerCatalog, CATALOG_TTL_MS);
          if (auto !== undefined) {
            if (provider === "") provider = auto.provider;
            if (model === "") model = auto.model;
          }
        }
        if (provider === "") provider = "deepseek-official";
        if (model === "") {
          return json(res, 400, {
            ok: false,
            error: "无法自动选择视觉模型（llm 目录不可用，或没有任何模型声明 image 模态）：请显式指定 provider/model",
          });
        }

        // Reuse the standardized cache when present (or generate it again).
        let readPath = record.imagePath;
        const original: ResolvedImage = {
          path: record.imagePath,
          hash: record.hash,
          ext: path.extname(record.imagePath).toLowerCase() || ".img",
        };
        if (cfg.normalize) {
          const std = await standardizeImage(original, cfg.normalizeLongEdge, true);
          if (std.changed) readPath = std.path;
          else {
            const cached = stdCachePath(record, cfg.normalizeLongEdge);
            if (await fs.access(cached).then(() => true, () => false)) readPath = cached;
          }
        }

        const marker = hashMarker(record.hash);
        const title = `识图 | ${record.imagePath} | ${marker}`;
        const question = "用一两句话简述这张图片的内容。";
        const seedText = buildSeedText(cfg, readPath, record.imagePath, marker, question);
        const oldChildId = record.childId;

        // Interrupt a live old child (user authority); an absent target is a no-op.
        ctx.subagents.interrupt(SessionId(oldChildId), { kind: "user", parentSessionId: SessionId(session) });

        // Same nesting guard as the tool path: a rebuilt recognition child never
        // receives the delegation tools (it must not spawn further subagents).
        const toolFilter = childDelegationFilter(ctx, cfg.denyChildTools);
        const spec = {
          provider: cfg.provider,
          label: title,
          request: {
            prompt: [{ type: "text" as const, text: seedText }],
            parent,
            agentOptions: { provider, model },
            ...(toolFilter === undefined ? {} : { toolFilter }),
          },
          signal: new AbortController().signal,
        };
        let start: Awaited<ReturnType<typeof ctx.subagents.startContinuable>>;
        try {
          start = await ctx.subagents.startContinuable(spec as Parameters<typeof ctx.subagents.startContinuable>[0]);
        } catch (error) {
          if (toolFilter === undefined) throw error;
          ctx.logger?.warn?.(
            "[dsh-subvision] child tool filter rejected on rebuild (%s); rebuilding without the nested-delegation guard",
            String((error as Error)?.message ?? error),
          );
          delete (spec.request as { toolFilter?: unknown }).toolFilter;
          start = await ctx.subagents.startContinuable(spec as Parameters<typeof ctx.subagents.startContinuable>[0]);
        }
        const newChildId = String(start.childId);
        await registry.remember({
          childId: newChildId,
          imagePath: record.imagePath,
          hash: record.hash,
          provider,
          model,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
        });
        return json(res, 200, { ok: true, oldChildId, newChildId, title });
      }
      return json(res, 404, { ok: false });
    } catch (error) {
      return json(res, 500, { ok: false, error: String((error as Error)?.message ?? error) });
    }
  };

  ctx.effect(() => {
    const dispose = ctx.webServer!.register({ kind: "prefix", path: BASE, handler: handle });
    ctx.logger?.info?.("[dsh-subvision] device API mounted at %s", BASE);
    return () => dispose();
  }, "dsh-subvision device API");
}
