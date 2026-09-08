/**
 * Thumbnail longest-edge bound (px). The devices page renders thumbnails in a
 * 46px box, so even 192px is comfortably retina-sharp while keeping the cached
 * file tiny (single-digit KB for PNG at this size).
 */
export declare const THUMB_LONG_EDGE = 192;
/** Deterministic thumbnail path for one hash: converted copies are PNG, verbatim snapshots keep their source ext. */
export declare function thumbPath(hash: string, ext?: string): string;
/**
 * Look up an existing cached thumbnail for `hash` across every possible name
 * (`<hash>.png` from conversion, `<hash><ext>` from verbatim snapshots).
 * Returns the resolved path (with its real extension) or undefined.
 */
export declare function findThumbnail(hash: string): Promise<string | undefined>;
export interface EnsureThumbnailOptions {
    /** The original image path (raw bytes). Used first for generation and snapshot. */
    originalPath: string;
    /**
     * Optional extra readable copies tried after the original (e.g. a
     * standardized copy), useful when the original itself is unreadable.
     */
    fallbackPaths?: string[];
}
/**
 * Make sure a small display thumbnail for `hash` exists inside the plugin
 * cache (`subvision-cache/thumbnails/`), decoupled from the original file so
 * the devices page keeps showing it after the original is moved/deleted.
 *
 * Strategy, first hit wins:
 *  1. an existing cached thumbnail (any name) → reuse;
 *  2. ImageMagick is available and any source reads → downscale/transcode the
 *     first frame to `<hash>.png` (192px bound, shrink-only, auto-orient);
 *  3. otherwise verbatim-copy the first browser-displayable source to
 *     `<hash><ext>` (a "snapshot" cache — not resized, but still survives the
 *     original disappearing);
 *  4. nothing doable → null (caller renders the placeholder).
 *
 * This never throws for normal image/IO failures — each strategy degrades to
 * the next; callers may still wrap it defensively.
 */
export declare function ensureThumbnail(hash: string, options: EnsureThumbnailOptions): Promise<string | null>;
//# sourceMappingURL=thumb.d.ts.map