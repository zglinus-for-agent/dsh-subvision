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
     * Omit for "auto": the plugin then picks the first vision-capable model in the
     * llm catalog (a model whose inputModalities include "image"), and only falls
     * back to the supervisor agent's own provider/model when the catalog exposes
     * no vision model at all.
     */
    model?: VisionModel;
    /** Optional per-child maxTokens bound. */
    maxTokens?: number;
    /**
     * Tools removed from every recognition child (`SubagentStartRequest.toolFilter`
     * deny): a vision subagent must never spawn, steer, or fork further subagents,
     * so recognition stays a single flat delegation instead of nesting children
     * under the calling session. Names not registered in this deployment are
     * skipped, so the list is safe to keep generic.
     */
    denyChildTools: string[];
    /** Default question asked when the tool is called without one. */
    questionDefault: string;
    /** Standardize image size before recognition (downscale oversized images). */
    normalize: boolean;
    /** User-customizable longest-edge bound (px) applied when normalize is on. */
    normalizeLongEdge: number;
}
/**
 * Delegation-capable tools hidden from recognition children by default: the
 * spawners/forkers plus the subagent-control tools (a vision child has no
 * children of its own, and `send_message` could otherwise steer its parent).
 * `image_recognize` is included so a vision child can never recurse.
 */
export declare const DEFAULT_DENY_CHILD_TOOLS: readonly string[];
export declare const Config: z<PluginConfig>;
export declare function normalizeConfig(input?: {
    provider?: string;
    toolName?: string;
    model?: Partial<VisionModel> | null;
    maxTokens?: number;
    denyChildTools?: readonly string[] | null;
    questionDefault?: string;
    normalize?: boolean;
    normalizeLongEdge?: number;
}): PluginConfig;
//# sourceMappingURL=config.d.ts.map