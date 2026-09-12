import type { Context } from "@deepseek-ai/cordis";
import type { ToolRestriction } from "@deepseek-ai/dsh-tools";

/**
 * Child tool scoping for recognition subagents.
 *
 * A vision child is a plain delegation target: it must not spawn, fork, steer,
 * or interrupt further subagents (that would nest children inside whichever
 * conversation asked for the recognition, and `image_recognize` could recurse).
 * DSH enforces this through `SubagentStartRequest.toolFilter`, which the spawn
 * provider applies as a scoped `tools.restrict()` in the child's creation
 * window: the named tools disappear from the child's prompt AND refuse to run.
 *
 * `tools.restrict()` rejects unknown global tool names loudly, so candidate
 * names are intersected with the tools this deployment actually registered —
 * a generic default list therefore stays safe across deployments.
 */

interface ToolsLike {
  get?(name: string, scope?: unknown): unknown;
}

/** Candidate names that exist in this deployment's global tool registry. */
export function registeredToolNames(ctx: Context, candidates: readonly string[]): string[] {
  let tools: ToolsLike | undefined;
  try {
    tools = (ctx as unknown as { tools?: ToolsLike }).tools;
  } catch {
    tools = undefined;
  }
  if (tools === undefined || typeof tools.get !== "function") return [];
  const found: string[] = [];
  for (const name of candidates) {
    try {
      if (tools.get(name) !== undefined) found.push(name);
    } catch {
      // Unreadable/never-registered name: skip rather than fail the child start.
    }
  }
  return found;
}

/**
 * `{ deny }` filter hiding the delegation tools from a recognition child.
 * Returns `undefined` when none of the candidates exist, so callers omit
 * `toolFilter` entirely instead of sending an empty (rejected) filter.
 */
export function childDelegationFilter(ctx: Context, deny: readonly string[]): ToolRestriction | undefined {
  const names = registeredToolNames(ctx, deny);
  return names.length === 0 ? undefined : { deny: names };
}
