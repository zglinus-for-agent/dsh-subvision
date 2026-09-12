/** Provider-level cache TTL, so the page's 3s polling never pounds adapters. */
export const CATALOG_TTL_MS = 60_000;
/** Whole provider list timeout (remote catalogs such as opencode are slow). */
export const MODELS_TIMEOUT_MS = 10_000;
/** Per-model capability probe timeout. */
export const MODEL_INFO_TIMEOUT_MS = 4_000;
/** `ctx.llm` is optional; never let a missing service throw. */
export function llmOf(ctx) {
    try {
        return ctx.llm;
    }
    catch {
        return undefined;
    }
}
export function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((resolve) => { setTimeout(() => resolve(null), ms).unref?.(); }),
    ]);
}
/** Load one provider's model ids plus the vision-capable subset (cached). */
export async function loadProviderCatalog(llm, providerId, cache, ttlMs = CATALOG_TTL_MS) {
    const cached = cache.get(providerId);
    if (cached !== undefined && Date.now() - cached.loadedAt <= ttlMs)
        return cached;
    const infos = (await withTimeout(llm.listModels(providerId), MODELS_TIMEOUT_MS)) ?? [];
    const names = infos.map((info) => info.id ?? info.model ?? "").filter(Boolean);
    const vision = [];
    for (const modelName of names) {
        const resolved = await withTimeout(llm.resolveModelInfo(providerId, modelName, new AbortController().signal), MODEL_INFO_TIMEOUT_MS);
        if (resolved?.inputModalities?.includes("image") === true)
            vision.push(modelName);
    }
    const entry = { models: names, vision, loadedAt: Date.now() };
    cache.set(providerId, entry);
    return entry;
}
/**
 * "Auto" vision model: the first image-capable model in catalog order
 * (provider order from `listProviders`, then model order from `listModels`).
 * Returns `undefined` when the llm service is unavailable or no provider
 * declares an image-capable model — callers then fall back to the supervisor
 * model, i.e. the historical "跟随主管" behaviour.
 */
export async function firstVisionModel(ctx, cache, ttlMs = CATALOG_TTL_MS) {
    const llm = llmOf(ctx);
    if (llm === undefined)
        return undefined;
    try {
        for (const provider of llm.listProviders()) {
            const entry = await loadProviderCatalog(llm, provider.id, cache, ttlMs);
            const model = entry.vision[0];
            if (model !== undefined)
                return { provider: provider.id, model };
        }
    }
    catch {
        return undefined;
    }
    return undefined;
}
//# sourceMappingURL=vision-models.js.map