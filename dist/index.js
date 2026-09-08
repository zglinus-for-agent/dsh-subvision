import { defineTool } from "@deepseek-ai/dsh-tools";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { Config, normalizeConfig } from "./config.js";
import { resolveImage, hashMarker } from "./image.js";
import { standardizeImage } from "./image-std.js";
import { ensureThumbnail } from "./thumb.js";
import { VisionRegistry } from "./vision-registry.js";
import { installDevicesApi } from "./vision-devices.js";
export { Config, normalizeConfig } from "./config.js";
export { VisionRegistry } from "./vision-registry.js";
export const name = "dsh-subvision";
export const inject = ["tools", "subagents", "agents", "llm", "webServer"];
const SETTINGS_NAMESPACE = settingsNamespace("subvision");
/** One in-process queue per (parent session, image hash) so racing calls cannot create two children. */
const createLocks = new Map();
function withLock(key, operation) {
    const previous = createLocks.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const tail = next.then(() => undefined, () => undefined);
    createLocks.set(key, tail);
    void tail.then(() => {
        if (createLocks.get(key) === tail)
            createLocks.delete(key);
    });
    return next;
}
function parseModelOverride(value, parentProvider) {
    if (value === undefined)
        return {};
    const trimmed = value.trim();
    if (trimmed.length === 0)
        return {};
    const slash = trimmed.indexOf("/");
    if (slash < 0) {
        // Bare model name: keep the parent's provider.
        const model = trimmed;
        return {
            ...(parentProvider === undefined ? {} : { provider: parentProvider }),
            model,
        };
    }
    const provider = trimmed.slice(0, slash).trim();
    const model = trimmed.slice(slash + 1).trim();
    if (provider.length === 0 || model.length === 0) {
        throw new Error(`invalid model override "${value}": expected provider/model or a bare model name`);
    }
    return { provider, model };
}
function titleFor(imagePath, marker) {
    return `识图 | ${imagePath} | ${marker}`;
}
export function apply(ctx, config) {
    const normalized = normalizeConfig(config);
    let currentSource = () => normalized;
    const currentConfig = () => normalizeConfig(currentSource());
    const registries = new Map();
    const registryFor = (parentSessionId) => {
        let registry = registries.get(parentSessionId);
        if (registry === undefined) {
            registry = new VisionRegistry(parentSessionId);
            registries.set(parentSessionId, registry);
        }
        return registry;
    };
    installSettingsSection(ctx, SETTINGS_NAMESPACE, Config, normalized, {
        setSource: source => {
            currentSource = source;
        },
        validate: value => {
            normalizeConfig(value);
        },
        onChange: () => {
            void currentConfig();
        },
    });
    // 识图设备页服务端 API：/dsh-subvision/v1/{devices,models,device/recreate}
    installDevicesApi(ctx, { currentConfig });
    ctx.tools.register(defineTool({
        name: currentConfig().toolName,
        description: "Identify/recognize one image with a dedicated vision subagent. Each distinct image (by content hash) owns exactly one subagent titled 识图 | <path> | <hash>; asking again about the same image continues the SAME subagent (its conversation remembers the image), including after restarts. The recognized answer arrives as a completion notice when the subagent settles. Optionally override its model per call.",
        parameters: {
            image: {
                type: "string",
                required: true,
                description: "Image to recognize: a local absolute path (recommended) or an http(s) URL that is downloaded into the cache first.",
            },
            question: {
                type: "string",
                description: "Question to ask about the image. Omit for a detailed default recognition description (subjects/objects/text/layout/scene). A later call with the same image and a new question continues the same subagent.",
            },
            model: {
                type: "string",
                description: 'Optional vision model override for the subagent, "provider/model" or a bare model name (keeps the current provider). Defaults to the plugin setting subvision.model, then to the supervisor model. Only applies when a new subagent is created for this image.',
            },
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    action: {
                        type: "string",
                        required: true,
                        enum: ["created", "followup"],
                    },
                    imageKey: { type: "string", required: true },
                    subagentId: { type: "string", required: true },
                    title: { type: "string", required: true },
                    note: { type: "string", required: true },
                },
            },
            render: (_args, value) => [{
                    type: "text",
                    text: value.note,
                }],
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const parent = exec.agent;
            if (parent === undefined)
                throw new Error("image_recognize requires a calling agent (exec.agent was undefined)");
            const cfg = currentConfig();
            const resolved = await resolveImage(args.image);
            // User-customizable size standardization: downscale (and, when needed,
            // transcode) oversized/exotic images before the vision subagent reads them.
            const standardized = await standardizeImage(resolved, cfg.normalizeLongEdge, cfg.normalize);
            // Eagerly cache a small display thumbnail while the original file is
            // guaranteed to exist, so the devices page keeps showing it after the
            // original is deleted/moved (may also lazily regenerate on demand).
            await ensureThumbnail(resolved.hash, {
                originalPath: resolved.path,
                fallbackPaths: standardized.changed ? [standardized.path] : [],
            }).catch(() => undefined);
            const readPath = standardized.path;
            const marker = hashMarker(resolved.hash);
            const parentSessionId = String(parent.id);
            const registry = registryFor(parentSessionId);
            const question = (args.question ?? "").trim() || cfg.questionDefault;
            const override = parseModelOverride(args.model, parent.options?.provider);
            const configuredModel = cfg.model;
            const provider = override.provider ?? configuredModel?.provider ?? parent.options?.provider;
            const model = override.model ?? configuredModel?.model ?? parent.options?.model;
            const agentOptions = {
                ...(provider === undefined ? {} : { provider }),
                ...(model === undefined ? {} : { model }),
                ...(cfg.maxTokens === undefined ? {} : { maxTokens: cfg.maxTokens }),
            };
            const hasAgentOptions = provider !== undefined || model !== undefined || cfg.maxTokens !== undefined;
            const title = titleFor(resolved.path, marker);
            const lockKey = `${parentSessionId}\u0000${resolved.hash}`;
            const run = withLock(lockKey, async () => {
                const existing = await registry.find(resolved.hash);
                if (existing !== undefined) {
                    const message = [
                        {
                            type: "text",
                            text: `继续识别这张图片（${resolved.path}，哈希 ${marker}）的追问：${question}`,
                        },
                    ];
                    await ctx.subagents.followup(parent, SessionId(existing.childId), message, {
                        source: {
                            kind: "coordinator",
                            form: "relay",
                            senderSessionId: parent.id,
                        },
                        signal: exec.signal,
                    });
                    existing.lastUsedAt = Date.now();
                    return { action: "followup", childId: existing.childId };
                }
                const prompt = [
                    {
                        type: "text",
                        text: "你是一个专职图片识别子代理。本次任务对应一张图片：\n"
                            + `- 图片路径：${readPath}\n`
                            + (readPath === resolved.path
                                ? ""
                                : `- 原图路径：${resolved.path}（已由插件标准化：最长边缩至 ${cfg.normalizeLongEdge}px，仅缩不放；原图坐标若需换算请按缩放比例推算）\n`)
                            + `- 图片内容哈希（标题标记）：${marker}\n`
                            + "请先调用 read_image 工具读取这张图片（若工具返回的图片没有随消息显示，仍以工具读取为准），然后回答下面的问题。"
                            + "回答要尽量详细准确；看不清、不确定或图片无法读取时如实说明，不要编造。\n\n"
                            + `问题：${question}`,
                    },
                ];
                const request = {
                    label: title,
                    prompt,
                    parent,
                };
                if (hasAgentOptions)
                    request.agentOptions = agentOptions;
                const start = await ctx.subagents.startContinuable({
                    provider: cfg.provider,
                    label: title,
                    request: request,
                    signal: exec.signal,
                });
                const childId = String(start.childId);
                await registry.remember({
                    childId,
                    imagePath: resolved.path,
                    hash: resolved.hash,
                    ...(provider === undefined ? {} : { provider }),
                    ...(model === undefined ? {} : { model }),
                    createdAt: Date.now(),
                    lastUsedAt: Date.now(),
                });
                return { action: "created", childId };
            });
            const result = await run;
            const note = result.action === "created"
                ? `已为该图片（哈希 ${marker}）创建专属识别子代理 ${result.childId}（标题：${title}），识别结果完成后会以通知送达。之后对同一图片再次调用本工具即继续同一子代理。`
                : `追问已送达该图片（哈希 ${marker}）的同一识别子代理 ${result.childId}，其回答完成后会以通知送达。`;
            return {
                action: result.action,
                imageKey: marker,
                subagentId: result.childId,
                title,
                note,
            };
        },
    }));
}
export default { name, inject, Config, apply };
//# sourceMappingURL=index.js.map