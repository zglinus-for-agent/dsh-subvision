/** Candidate names that exist in this deployment's global tool registry. */
export function registeredToolNames(ctx, candidates) {
    let tools;
    try {
        tools = ctx.tools;
    }
    catch {
        tools = undefined;
    }
    if (tools === undefined || typeof tools.get !== "function")
        return [];
    const found = [];
    for (const name of candidates) {
        try {
            if (tools.get(name) !== undefined)
                found.push(name);
        }
        catch {
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
export function childDelegationFilter(ctx, deny) {
    const names = registeredToolNames(ctx, deny);
    return names.length === 0 ? undefined : { deny: names };
}
//# sourceMappingURL=child-tools.js.map