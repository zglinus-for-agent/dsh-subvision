import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { cacheRoot } from "./image.js";
import { findConverter } from "./image-std.js";

const execFileAsync = promisify(execFile);

/**
 * Thumbnail longest-edge bound (px). The devices page renders thumbnails in a
 * 46px box, so even 192px is comfortably retina-sharp while keeping the cached
 * file tiny (single-digit KB for PNG at this size).
 */
export const THUMB_LONG_EDGE = 192;

/** Extensions a browser can render directly (verbatim snapshot fallback). */
const DISPLAYABLE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

function thumbDir(): string {
  return path.join(cacheRoot(), "thumbnails");
}

/** Deterministic thumbnail path for one hash: converted copies are PNG, verbatim snapshots keep their source ext. */
export function thumbPath(hash: string, ext = ".png"): string {
  return path.join(thumbDir(), `${hash}${ext}`);
}

/**
 * Look up an existing cached thumbnail for `hash` across every possible name
 * (`<hash>.png` from conversion, `<hash><ext>` from verbatim snapshots).
 * Returns the resolved path (with its real extension) or undefined.
 */
export async function findThumbnail(hash: string): Promise<string | undefined> {
  const names = await fs.readdir(thumbDir()).catch(() => []);
  const prefix = `${hash}.`;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const full = path.join(thumbDir(), name);
    const stat = await fs.stat(full).catch(() => null);
    if (stat !== null && stat.isFile() && stat.size > 0) return full;
  }
  return undefined;
}

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
export async function ensureThumbnail(hash: string, options: EnsureThumbnailOptions): Promise<string | null> {
  const cached = await findThumbnail(hash);
  if (cached !== undefined) return cached;

  await fs.mkdir(thumbDir(), { recursive: true }).catch(() => undefined);
  const sources = [options.originalPath, ...(options.fallbackPaths ?? [])];

  // Strategy 2: real downscaled thumbnail via ImageMagick.
  const converter = await findConverter();
  if (converter !== undefined) {
    const outPath = thumbPath(hash, ".png");
    for (const source of sources) {
      const ok = await fs.stat(source).then((s) => s.isFile(), () => false);
      if (!ok) continue;
      // `[0]` reads only the first frame (animated GIFs → static thumbnail).
      const args = [`${source}[0]`, "-auto-orient", "-strip", "-resize", `${THUMB_LONG_EDGE}x${THUMB_LONG_EDGE}>`, outPath];
      try {
        await execFileAsync(converter, args, { timeout: 20000 });
        const stat = await fs.stat(outPath).catch(() => null);
        if (stat !== null && stat.size > 0) return outPath;
      } catch {
        // try the next source / degrade to snapshot
      }
    }
  }

  // Strategy 3: verbatim snapshot of the first displayable source.
  for (const source of sources) {
    const ext = path.extname(source).toLowerCase();
    if (!DISPLAYABLE_EXTS.has(ext)) continue;
    const ok = await fs.stat(source).then((s) => s.isFile(), () => false);
    if (!ok) continue;
    const outPath = thumbPath(hash, ext);
    try {
      await fs.copyFile(source, outPath);
      const stat = await fs.stat(outPath).catch(() => null);
      if (stat !== null && stat.size > 0) return outPath;
    } catch {
      // keep trying
    }
  }

  return null;
}