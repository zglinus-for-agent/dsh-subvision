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
export const DEFAULT_DENY_CHILD_TOOLS: readonly string[] = [
  "subagent",
  "subagent_fork",
  "workflow",
  "ralph",
  "image_recognize",
  "list_agents",
  "send_message",
  "interrupt_agent",
];

export const Config = z.object({
  provider: z.string().default("spawn"),
  toolName: z.string().default("image_recognize"),
  model: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
  }).default(undefined as never),
  maxTokens: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).step(1).default(undefined as never),
  denyChildTools: z.array(z.string()).default([...DEFAULT_DENY_CHILD_TOOLS]),
  questionDefault: z.string().default("识别这张图片，尽量详细准确地描述内容（主体/物体/文字/布局/场景）；看不清或无法确认的地方如实说明。"),
  normalize: z.boolean().default(true),
  normalizeLongEdge: z.natural().min(128).max(8192).step(16).default(1024),
}) as unknown as z<PluginConfig>;

export function normalizeConfig(input: {
  provider?: string;
  toolName?: string;
  model?: Partial<VisionModel> | null;
  maxTokens?: number;
  denyChildTools?: readonly string[] | null;
  questionDefault?: string;
  normalize?: boolean;
  normalizeLongEdge?: number;
} = {}): PluginConfig {
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
  const denyChildTools: string[] = [];
  for (const name of input.denyChildTools ?? DEFAULT_DENY_CHILD_TOOLS) {
    if (typeof name !== "string") {
      throw new Error("denyChildTools entries must be strings");
    }
    const trimmed = name.trim();
    if (trimmed.length === 0) continue;
    if (!denyChildTools.includes(trimmed)) denyChildTools.push(trimmed);
  }
  return {
    provider: (input.provider ?? "spawn").trim(),
    toolName: (input.toolName ?? "image_recognize").trim(),
    ...(model === undefined || model === null ? {} : {
      model: {
        provider: model.provider!.trim(),
        model: model.model!.trim(),
      },
    }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    denyChildTools,
    questionDefault,
    normalize: input.normalize ?? true,
    normalizeLongEdge,
  };
}
