import { SessionId } from "@deepseek-ai/dsh-session";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { VisionRegistry } from "./vision-registry.js";
import { cacheRoot, hashMarker } from "./image.js";
import { standardizeImage } from "./image-std.js";
const BASE = "/dsh-subvision/v1";
function json(res, code, body) {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" });
    res.end(JSON.stringify(body));
}
function sameOrigin(req) {
    const origin = req.headers?.origin;
    if (!origin)
        return true;
    try {
        return new URL(origin).host === (req.headers?.host ?? "");
    }
    catch {
        return false;
    }
}
async function readBody(req) {
    let data = "";
    for await (const chunk of req) {
        data += chunk;
        if (data.length > 1 << 16)
            break;
    }
    return data;
}
/** Deterministic standardized-cache path for one hash + long edge (mirrors image-std). */
function stdCachePath(record, longEdge) {
    const ext = path.extname(record.imagePath).toLowerCase();
    const readable = [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext);
    const name = readable
        ? `${record.hash}-s${longEdge}${ext}`
        : `${record.hash}-s${longEdge}.png`;
    return path.join(cacheRoot(), "standardized", name);
}
/**
 * Server half of the "识图设备" page: same-origin HTTP API under
 * `/dsh-subvision/v1` exposing the durable per-image vision-subagent
 * registry, configured models for dropdowns, and a per-device "rebuild with
 * another model" action.
 */
export function installDevicesApi(ctx, deps) {
    if (ctx.webServer === undefined) {
        ctx.logger?.warn?.("[dsh-subvision] webServer unavailable; device API not mounted");
        return;
    }
    const providerCatalog = new Map();
    const CATALOG_TTL_MS = 60_000;
    const withTimeout = (promise, ms) => Promise.race([
        promise,
        new Promise((resolve) => { setTimeout(() => resolve(null), ms).unref?.(); }),
    ]);
    const buildCatalog = async () => {
        let llm;
        try {
            llm = ctx.llm;
        }
        catch {
            llm = undefined;
        }
        if (llm === undefined)
            return { models: {}, vision: {}, providers: [] };
        const cfg = deps.currentConfig();
        const wanted = new Map();
        for (const provider of llm.listProviders())
            wanted.set(provider.id, provider.name);
        if (cfg.model?.provider)
            wanted.set(cfg.model.provider, cfg.model.provider);
        if (!wanted.has("deepseek-official"))
            wanted.set("deepseek-official", "deepseek-official");
        const now = Date.now();
        const models = {};
        const vision = {};
        const providers = [];
        for (const [id, name] of wanted) {
            let entry = providerCatalog.get(id);
            if (entry === undefined || now - entry.loadedAt > CATALOG_TTL_MS) {
                const infos = (await withTimeout(llm.listModels(id), 10_000)) ?? [];
                const names = infos.map((info) => info.id ?? info.model ?? "").filter(Boolean);
                const visionNames = [];
                for (const modelName of names) {
                    const resolved = await withTimeout(llm.resolveModelInfo(id, modelName, new AbortController().signal), 4_000);
                    if (resolved?.inputModalities !== undefined && resolved.inputModalities.includes("image")) {
                        visionNames.push(modelName);
                    }
                }
                entry = { models: names, vision: visionNames, loadedAt: Date.now() };
                providerCatalog.set(id, entry);
            }
            if (entry.models.length > 0) {
                models[id] = [...entry.models];
                if (entry.vision.length > 0)
                    vision[id] = [...entry.vision];
                providers.push({ id, name });
            }
        }
        return { models, vision, providers };
    };
    /** Bytes inside one cache subdirectory (recursive). */
    const dirBytes = async (dir) => {
        let total = 0;
        const walk = async (d) => {
            const names = await fs.readdir(d).catch(() => []);
            for (const name of names) {
                const full = path.join(d, name);
                const stat = await fs.stat(full).catch(() => null);
                if (stat === null)
                    continue;
                if (stat.isFile())
                    total += stat.size;
                else if (stat.isDirectory())
                    await walk(full);
            }
        };
        await walk(dir);
        return total;
    };
    /** File count inside one directory (recursive). */
    const countFiles = async (dir) => {
        let count = 0;
        const walk = async (d) => {
            const names = await fs.readdir(d).catch(() => []);
            for (const name of names) {
                const full = path.join(d, name);
                const stat = await fs.stat(full).catch(() => null);
                if (stat === null)
                    continue;
                if (stat.isFile())
                    count += 1;
                else if (stat.isDirectory())
                    await walk(full);
            }
        };
        await walk(dir);
        return count;
    };
    /** Cache usage summary for the page: standardized copies + downloaded originals. */
    const cacheStats = async () => {
        const root = cacheRoot();
        return {
            standardizedBytes: await dirBytes(path.join(root, "standardized")),
            downloadBytes: await dirBytes(path.join(root, "downloads")),
            files: await countFiles(root),
        };
    };
    /** 全盘扫描：任一工作区下是否存在该会话（session.jsonl.zstd） */
    const sessionExists = async (id) => {
        const sessionsRoot = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), "sessions");
        const workspaces = await fs.readdir(sessionsRoot).catch(() => []);
        for (const workspace of workspaces) {
            const marker = path.join(sessionsRoot, workspace, id, "session.jsonl.zstd");
            if (await fs.access(marker).then(() => true, () => false))
                return true;
        }
        return false;
    };
    /** 归档会话判定：读取 ~/.dsh/storages/workspace.json 的 global.archivedSessionIds（10s 缓存）。 */
    let archivedAt = 0;
    let archivedIds = new Set();
    const readArchivedSessionIds = async () => {
        const now = Date.now();
        if (now - archivedAt > 10_000) {
            const file = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), "storages", "workspace.json");
            const raw = await fs.readFile(file, "utf8").catch(() => null);
            const ids = [];
            if (raw !== null) {
                try {
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed.global?.archivedSessionIds)) {
                        for (const id of parsed.global.archivedSessionIds) {
                            if (typeof id === "string")
                                ids.push(id);
                        }
                    }
                }
                catch {
                    // ignore malformed workspace file
                }
            }
            archivedIds = new Set(ids);
            archivedAt = now;
        }
        return archivedIds;
    };
    /** 删除某个图片哈希在标准化/下载缓存里的全部文件。 */
    const removeHashFiles = async (hash) => {
        let removed = 0;
        const root = cacheRoot();
        for (const dir of ["standardized", "downloads"]) {
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
    const buildSeedText = (cfg, readPath, originalPath, marker, question) => ("你是一个专职图片识别子代理。本次任务对应一张图片：\n"
        + `- 图片路径：${readPath}\n`
        + (readPath === originalPath ? "" : `- 原图路径：${originalPath}（已由插件标准化：最长边缩至 ${cfg.normalizeLongEdge}px，仅缩不放）\n`)
        + `- 图片内容哈希（标题标记）：${marker}\n`
        + "请先调用 read_image 工具读取这张图片（若工具返回的图片没有随消息显示，仍以工具读取为准），然后回答下面的问题。"
        + "回答要尽量详细准确；看不清、不确定或图片无法读取时如实说明，不要编造。\n\n"
        + `问题：${question}`);
    const handle = async (req, res) => {
        if (!sameOrigin(req))
            return json(res, 403, { ok: false, error: "forbidden" });
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
                const cache = await cacheStats();
                return json(res, 200, {
                    ok: true,
                    defaultModel: cfg.model ?? null,
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
                if (typeof session !== "string" || session.length === 0)
                    return json(res, 400, { ok: false, error: "session required" });
                if (typeof hash !== "string" || hash.length === 0)
                    return json(res, 400, { ok: false, error: "hash required" });
                const record = await new VisionRegistry(session).find(hash);
                if (record === undefined)
                    return json(res, 404, { ok: false, error: "unknown device" });
                const bytes = await fs.readFile(record.imagePath).catch(() => null);
                if (bytes === null)
                    return json(res, 404, { ok: false, error: "image file unavailable" });
                const mime = {
                    ".png": "image/png",
                    ".jpg": "image/jpeg",
                    ".jpeg": "image/jpeg",
                    ".webp": "image/webp",
                    ".gif": "image/gif",
                };
                res.writeHead(200, {
                    "content-type": mime[path.extname(record.imagePath).toLowerCase()] ?? "application/octet-stream",
                    "cache-control": "public, max-age=86400, immutable",
                });
                res.end(bytes);
                return;
            }
            if (p === `${BASE}/cache` && method === "POST") {
                const root = cacheRoot();
                const removed = await countFiles(root);
                for (const dir of ["standardized", "downloads"]) {
                    await fs.rm(path.join(root, dir), { recursive: true, force: true }).catch(() => undefined);
                    await fs.mkdir(path.join(root, dir), { recursive: true }).catch(() => undefined);
                }
                return json(res, 200, { ok: true, removed });
            }
            if (p === `${BASE}/cache/session` && method === "POST") {
                const body = JSON.parse((await readBody(req)) || "{}");
                const session = body.session ?? url.searchParams.get("session");
                if (typeof session !== "string" || session.length === 0)
                    return json(res, 400, { ok: false, error: "session required" });
                const records = await new VisionRegistry(session).all();
                let removed = 0;
                for (const record of records)
                    removed += await removeHashFiles(record.hash);
                return json(res, 200, { ok: true, removed });
            }
            if (p === `${BASE}/device/delete` && method === "POST") {
                const body = JSON.parse((await readBody(req)) || "{}");
                const session = body.session ?? url.searchParams.get("session");
                const hash = body.hash ?? url.searchParams.get("hash");
                if (typeof session !== "string" || session.length === 0)
                    return json(res, 400, { ok: false, error: "session required" });
                if (typeof hash !== "string" || hash.length === 0)
                    return json(res, 400, { ok: false, error: "hash required" });
                const registry = new VisionRegistry(session);
                const record = await registry.find(hash);
                if (record === undefined)
                    return json(res, 404, { ok: false, error: "no device record for this hash" });
                const removed = await removeHashFiles(record.hash);
                await registry.forget(hash);
                return json(res, 200, { ok: true, removed, deletedHash: hash });
            }
            if (p === `${BASE}/device/recreate` && method === "POST") {
                const body = JSON.parse((await readBody(req)) || "{}");
                const session = body.session ?? url.searchParams.get("session");
                const hash = body.hash ?? url.searchParams.get("hash");
                if (typeof session !== "string" || session.length === 0)
                    return json(res, 400, { ok: false, error: "session required" });
                if (typeof hash !== "string" || hash.length === 0)
                    return json(res, 400, { ok: false, error: "hash required" });
                const registry = new VisionRegistry(session);
                const record = await registry.find(hash);
                if (record === undefined)
                    return json(res, 404, { ok: false, error: "no device record for this hash" });
                const parent = ctx.agents.get(SessionId(session));
                if (parent === undefined)
                    return json(res, 409, { ok: false, error: "父会话(主管)当前不在线，无法为它重建识别子代理" });
                const exists = await fs.stat(record.imagePath).then((s) => s.isFile(), () => false);
                if (!exists)
                    return json(res, 400, { ok: false, error: `原图已不可用：${record.imagePath}（请重新通过 image_recognize 提交）` });
                const cfg = deps.currentConfig();
                const bodyProvider = (body.provider ?? "").trim();
                const bodyModel = (body.model ?? "").trim();
                const provider = bodyProvider !== "" ? bodyProvider : (cfg.model?.provider ?? "deepseek-official");
                const model = bodyModel !== "" ? bodyModel : (cfg.model?.model ?? "");
                if (model.length === 0)
                    return json(res, 400, { ok: false, error: "model required (provider/model 或 bare model)" });
                // Reuse the standardized cache when present (or generate it again).
                let readPath = record.imagePath;
                const original = {
                    path: record.imagePath,
                    hash: record.hash,
                    ext: path.extname(record.imagePath).toLowerCase() || ".img",
                };
                if (cfg.normalize) {
                    const std = await standardizeImage(original, cfg.normalizeLongEdge, true);
                    if (std.changed)
                        readPath = std.path;
                    else {
                        const cached = stdCachePath(record, cfg.normalizeLongEdge);
                        if (await fs.access(cached).then(() => true, () => false))
                            readPath = cached;
                    }
                }
                const marker = hashMarker(record.hash);
                const title = `识图 | ${record.imagePath} | ${marker}`;
                const question = "用一两句话简述这张图片的内容。";
                const seedText = buildSeedText(cfg, readPath, record.imagePath, marker, question);
                const oldChildId = record.childId;
                // Interrupt a live old child (user authority); an absent target is a no-op.
                ctx.subagents.interrupt(SessionId(oldChildId), { kind: "user", parentSessionId: SessionId(session) });
                const start = await ctx.subagents.startContinuable({
                    provider: cfg.provider,
                    label: title,
                    request: {
                        prompt: [{ type: "text", text: seedText }],
                        parent,
                        agentOptions: { provider, model },
                    },
                    signal: new AbortController().signal,
                });
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
        }
        catch (error) {
            return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
    };
    ctx.effect(() => {
        const dispose = ctx.webServer.register({ kind: "prefix", path: BASE, handler: handle });
        ctx.logger?.info?.("[dsh-subvision] device API mounted at %s", BASE);
        return () => dispose();
    }, "dsh-subvision device API");
}
//# sourceMappingURL=vision-devices.js.map