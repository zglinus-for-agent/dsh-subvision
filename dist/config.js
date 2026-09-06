import z from "@deepseek-ai/schemastery";
export const Config = z.object({
    provider: z.string().default("spawn"),
    toolName: z.string().default("image_recognize"),
    model: z.object({
        provider: z.string().min(1),
        model: z.string().min(1),
    }).default(undefined),
    maxTokens: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).step(1).default(undefined),
    questionDefault: z.string().default("识别这张图片，尽量详细准确地描述内容（主体/物体/文字/布局/场景）；看不清或无法确认的地方如实说明。"),
    normalize: z.boolean().default(true),
    normalizeLongEdge: z.natural().min(128).max(8192).step(16).default(1024),
});
export function normalizeConfig(input = {}) {
    const model = input.model;
    if (model !== undefined && model !== null) {
        const provider = model.provider;
        const m = model.model;
        if (typeof provider !== "string" || provider.trim().length === 0
            || typeof m !== "string" || m.trim().length === 0) {
            throw new Error("model.provider and model.model must be provided together");
        }
    }
    const maxTokens = input.maxTokens;
    if (maxTokens !== undefined) {
        if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) {
            throw new Error("maxTokens must be a positive safe integer");
        }
    }
    const normalizeLongEdge = input.normalizeLongEdge ?? 1024;
    if (!Number.isSafeInteger(normalizeLongEdge) || normalizeLongEdge < 128 || normalizeLongEdge > 8192) {
        throw new Error("normalizeLongEdge must be an integer between 128 and 8192");
    }
    const questionDefault = (input.questionDefault ?? "识别这张图片，尽量详细准确地描述内容（主体/物体/文字/布局/场景）；看不清或无法确认的地方如实说明。").trim();
    if (questionDefault.length === 0) {
        throw new Error("questionDefault must not be empty");
    }
    return {
        provider: (input.provider ?? "spawn").trim(),
        toolName: (input.toolName ?? "image_recognize").trim(),
        ...(model === undefined || model === null ? {} : {
            model: {
                provider: model.provider.trim(),
                model: model.model.trim(),
            },
        }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
        questionDefault,
        normalize: input.normalize ?? true,
        normalizeLongEdge,
    };
}
//# sourceMappingURL=config.js.map