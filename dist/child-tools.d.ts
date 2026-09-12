import type { Context } from "@deepseek-ai/cordis";
import type { ToolRestriction } from "@deepseek-ai/dsh-tools";
/** Candidate names that exist in this deployment's global tool registry. */
export declare function registeredToolNames(ctx: Context, candidates: readonly string[]): string[];
/**
 * `{ deny }` filter hiding the delegation tools from a recognition child.
 * Returns `undefined` when none of the candidates exist, so callers omit
 * `toolFilter` entirely instead of sending an empty (rejected) filter.
 */
export declare function childDelegationFilter(ctx: Context, deny: readonly string[]): ToolRestriction | undefined;
//# sourceMappingURL=child-tools.d.ts.map