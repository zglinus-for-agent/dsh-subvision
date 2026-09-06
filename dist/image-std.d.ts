import { type ResolvedImage } from "./image.js";
export interface StandardizedImage {
    /** Path the vision subagent should read. Equals the original when untouched. */
    path: string;
    /** True when a standardized (downscaled / transcoded) copy was produced. */
    changed: boolean;
}
/**
 * Standardize an image for recognition:
 * - downscale so its longest edge is at most `longEdge` px (shrink-only,
 *   aspect preserved, auto-orient), cached under the content hash; and
 * - transcode formats read_image cannot ingest (e.g. heic/avif/bmp) to PNG.
 *
 * User-customizable through the `subvision` settings: set `normalize: false`
 * to disable, or tune `normalizeLongEdge` for the pixel bound. Falls back to
 * the original file whenever no converter is installed or generation fails.
 */
export declare function standardizeImage(resolved: ResolvedImage, longEdge: number, enabled: boolean): Promise<StandardizedImage>;
//# sourceMappingURL=image-std.d.ts.map