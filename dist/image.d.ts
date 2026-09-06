/** Durable cache root (survives restarts; avoids the service-private /tmp). */
export declare function cacheRoot(): string;
export interface ResolvedImage {
    /** Absolute path on this host that the subagent/vision model can read. */
    path: string;
    /** Lowercase hex digest of the exact file bytes (identity key). */
    hash: string;
    /** File extension including the dot, used only for hints. */
    ext: string;
}
export declare function sha256Hex(data: Buffer): Promise<string>;
/** Short stable marker used in the subagent title: first 16 hex chars. */
export declare function hashMarker(hash: string): string;
/**
 * Resolve the tool's `image` argument to a local readable file.
 * Local absolute paths are used as-is; http(s) URLs are downloaded once into
 * the process cache and re-used by content hash.
 */
export declare function resolveImage(image: string): Promise<ResolvedImage>;
//# sourceMappingURL=image.d.ts.map