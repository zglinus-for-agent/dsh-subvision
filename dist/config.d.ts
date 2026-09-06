import z from "@deepseek-ai/schemastery";
export interface VisionModel {
    provider: string;
    model: string;
}
export interface PluginConfig {
    /** Backend subagent provider name; the base "spawn" provider creates a fresh child agent. */
    provider: string;
    /** Model-facing tool name registered on every agent. */
    toolName: string;
    /**
     * Default vision model for recognition subagents, e.g. { provider: "deepseek", model: "deepseek-v4-flash" }.
     * Omit to inherit the supervisor agent's own provider/model.
     */
    model?: VisionModel;
    /** Optional per-child maxTokens bound. */
    maxTokens?: number;
    /** Default question asked when the tool is called without one. */
    questionDefault: string;
    /** Standardize image size before recognition (downscale oversized images). */
    normalize: boolean;
    /** User-customizable longest-edge bound (px) applied when normalize is on. */
    normalizeLongEdge: number;
}
export declare const Config: z<PluginConfig>;
export declare function normalizeConfig(input?: {
    provider?: string;
    toolName?: string;
    model?: Partial<VisionModel> | null;
    maxTokens?: number;
    questionDefault?: string;
    normalize?: boolean;
    normalizeLongEdge?: number;
}): PluginConfig;
//# sourceMappingURL=config.d.ts.map