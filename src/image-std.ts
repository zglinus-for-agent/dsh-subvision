import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { cacheRoot, type ResolvedImage } from "./image.js";

const execFileAsync = promisify(execFile);

/** Formats the base read_image tool can hand straight to the model. */
const READABLE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export interface StandardizedImage {
  /** Path the vision subagent should read. Equals the original when untouched. */
  path: string;
  /** True when a standardized (downscaled / transcoded) copy was produced. */
  changed: boolean;
}

let toolCache: string | undefined;
/** Probe for an installed ImageMagick binary (`magick` preferred, `convert` fallback); result cached per process. */
export async function findConverter(): Promise<string | undefined> {
  if (toolCache !== undefined) return toolCache === "" ? undefined : toolCache;
  for (const tool of ["magick", "convert"]) {
    try {
      await execFileAsync(tool, ["-version"], { timeout: 10000 });
      toolCache = tool;
      return tool;
    } catch {
      // try the next candidate
    }
  }
  toolCache = "";
  return undefined;
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
export async function standardizeImage(
  resolved: ResolvedImage,
  longEdge: number,
  enabled: boolean,
): Promise<StandardizedImage> {
  if (!enabled || longEdge <= 0) return { path: resolved.path, changed: false };
  const converter = await findConverter();
  if (converter === undefined) return { path: resolved.path, changed: false };

  const stdDir = path.join(cacheRoot(), "standardized");
  await fs.mkdir(stdDir, { recursive: true }).catch(() => undefined);
  const readable = READABLE_EXTS.has(resolved.ext);
  // Transcode unreadable formats to PNG; readable ones keep their extension.
  const outName = readable
    ? `${resolved.hash}-s${longEdge}${resolved.ext}`
    : `${resolved.hash}-s${longEdge}.png`;
  const outPath = path.join(stdDir, outName);

  const exists = await fs.access(outPath).then(() => true, () => false);
  if (!exists) {
    const args = [
      resolved.path,
      "-auto-orient",
      "-strip",
      "-resize",
      `${longEdge}x${longEdge}>`,
      outPath,
    ];
    try {
      await execFileAsync(converter, args, { timeout: 60000 });
    } catch {
      // Generation failed: fall back to the original file.
      return { path: resolved.path, changed: false };
    }
  }
  const stat = await fs.stat(outPath).catch(() => null);
  if (stat === null || stat.size === 0) return { path: resolved.path, changed: false };
  return { path: outPath, changed: true };
}
