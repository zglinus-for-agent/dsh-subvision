import type { Context } from "@deepseek-ai/cordis";

/**
 * Shared provider/model catalog for the vision plugin.
 *
 * The catalog is the single source of truth for both:
 *  - the "图片代理" settings page (`vision-devices.ts`), which lists every
 *    model and marks the image-capable ones「视觉」; and
 *  - the "auto" resolution in `index.ts`, which picks the first
 *    vision-capable model so a recognition subagent never inherits a
 *    text-only supervisor model (`deepseek-v4-flash` cannot read images).
 *
 * Source: `ctx.llm.listProviders → listModels → resolveModelInfo`; a model
 * counts as vision-capable when `inputModalities` contains `"image"`.
 */

export interface LlmModelInfo {
  id?: string;
  name?: string;
  model?: string;
}

/** Subset of the harness `llm` service this plugin relies on. */
export interface LlmLike {
  listProviders(): Array<{ id: string; name: string }>;
  listModels(provider: string): Promise<readonly LlmModelInfo[]>;
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ inputModalities?: readonly string[] }>;
}

export interface ProviderCatalogEntry {
  models: string[];
  vision: string[];
  loadedAt: number;
}

export interface ModelCatalog {
  models: Record<string, string[]>;
  vision: Record<string, string[]>;
  providers: Array<{ id: string; name: string }>;
}

/** Provider-level cache TTL, so the page's 3s polling never pounds adapters. */
export const CATALOG_TTL_MS = 60_000;
/** Whole provider list timeout (remote catalogs such as opencode are slow). */
export const MODELS_TIMEOUT_MS = 10_000;
/** Per-model capability probe timeout. */
export const MODEL_INFO_TIMEOUT_MS = 4_000;

/** `ctx.llm` is optional; never let a missing service throw. */
export function llmOf(ctx: Context): LlmLike | undefined {
  try {
    return (ctx as unknown as { llm?: LlmLike }).llm;
  } catch {
    return undefined;
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => { setTimeout(() => resolve(null), ms).unref?.(); }),
  ]);
}

/** Load one provider's model ids plus the vision-capable subset (cached). */
export async function loadProviderCatalog(
  llm: LlmLike,
  providerId: string,
  cache: Map<string, ProviderCatalogEntry>,
  ttlMs: number = CATALOG_TTL_MS,
): Promise<ProviderCatalogEntry> {
  const cached = cache.get(providerId);
  if (cached !== undefined && Date.now() - cached.loadedAt <= ttlMs) return cached;
  const infos = (await withTimeout(llm.listModels(providerId), MODELS_TIMEOUT_MS)) ?? [];
  const names = infos.map((info) => info.id ?? info.model ?? "").filter(Boolean);
  const vision: string[] = [];
  for (const modelName of names) {
    const resolved = await withTimeout(
      llm.resolveModelInfo(providerId, modelName, new AbortController().signal),
      MODEL_INFO_TIMEOUT_MS,
    );
    if (resolved?.inputModalities?.includes("image") === true) vision.push(modelName);
  }
  const entry: ProviderCatalogEntry = { models: names, vision, loadedAt: Date.now() };
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
export async function firstVisionModel(
  ctx: Context,
  cache: Map<string, ProviderCatalogEntry>,
  ttlMs: number = CATALOG_TTL_MS,
): Promise<{ provider: string; model: string } | undefined> {
  const llm = llmOf(ctx);
  if (llm === undefined) return undefined;
  try {
    for (const provider of llm.listProviders()) {
      const entry = await loadProviderCatalog(llm, provider.id, cache, ttlMs);
      const model = entry.vision[0];
      if (model !== undefined) return { provider: provider.id, model };
    }
  } catch {
    return undefined;
  }
  return undefined;
}
