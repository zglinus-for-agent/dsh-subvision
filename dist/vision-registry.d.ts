/**
 * Durable per-parent-session registry: image content hash → the vision
 * subagent childId that owns it. Survives dsh-web restarts so follow-up
 * questions on the same image cold-resume the *same* subagent.
 */
export interface VisionChildRecord {
    /** Durable child session id returned by ctx.subagents.startContinuable. */
    childId: string;
    /** Image path at creation time (informational; identity is the hash). */
    imagePath: string;
    /** Content hash (full sha256 hex). */
    hash: string;
    /** Agent provider/model the child was created with, when known. */
    provider?: string;
    model?: string;
    createdAt: number;
    lastUsedAt: number;
}
export declare class VisionRegistry {
    private readonly parentSessionId;
    private readonly stateDir;
    private readonly mem;
    private loaded;
    constructor(parentSessionId: string, stateDir?: string);
    private get file();
    private load;
    private persist;
    /** Look up the existing child for this image hash, if any. */
    find(hash: string): Promise<VisionChildRecord | undefined>;
    /** Remember (or refresh) the child owning this image hash. */
    remember(record: VisionChildRecord): Promise<void>;
    /** Forget one hash (used when its child can no longer be reached). */
    forget(hash: string): Promise<void>;
    /** All known children of this parent session (for diagnostics/UI later). */
    all(): Promise<VisionChildRecord[]>;
    /** Read every per-parent registry file on disk: { session, children }[], oldest first. */
    static allSessions(stateDir?: string): Promise<Array<{
        session: string;
        children: VisionChildRecord[];
    }>>;
}
//# sourceMappingURL=vision-registry.d.ts.map