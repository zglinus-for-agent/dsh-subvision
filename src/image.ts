import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/** Durable cache root (survives restarts; avoids the service-private /tmp). */
export function cacheRoot(): string {
  return path.join(process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), "subvision-cache");
}

export interface ResolvedImage {
  /** Absolute path on this host that the subagent/vision model can read. */
  path: string;
  /** Lowercase hex digest of the exact file bytes (identity key). */
  hash: string;
  /** File extension including the dot, used only for hints. */
  ext: string;
}

export async function sha256Hex(data: Buffer): Promise<string> {
  return createHash("sha256").update(data).digest("hex");
}

/** Short stable marker used in the subagent title: first 16 hex chars. */
export function hashMarker(hash: string): string {
  return hash.slice(0, 16);
}

function extOfName(name: string): string {
  const base = name.split("?")[0] ?? name;
  const dot = base.lastIndexOf(".");
  if (dot < 0 || dot === base.length - 1) return ".img";
  const ext = base.slice(dot).toLowerCase();
  return /^\.(png|jpe?g|webp|gif|bmp|heic|avif)$/.test(ext) ? ext : ".img";
}

/**
 * Resolve the tool's `image` argument to a local readable file.
 * Local absolute paths are used as-is; http(s) URLs are downloaded once into
 * the process cache and re-used by content hash.
 */
export async function resolveImage(image: string): Promise<ResolvedImage> {
  const trimmed = image.trim();
  if (trimmed.length === 0) throw new Error("image must not be empty");
  if (/^https?:\/\//i.test(trimmed)) {
    return resolveUrlImage(trimmed);
  }
  const abs = path.resolve(trimmed);
  const stat = await fs.stat(abs).catch(() => null);
  if (stat === null || !stat.isFile()) {
    throw new Error(`image file not found or not a regular file: ${trimmed}`);
  }
  const data = await fs.readFile(abs);
  const hash = await sha256Hex(data);
  return { path: abs, hash, ext: path.extname(abs).toLowerCase() || ".img" };
}

async function resolveUrlImage(url: string): Promise<ResolvedImage> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`failed to download image ${url}: HTTP ${response.status} ${response.statusText}`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  const hash = await sha256Hex(data);
  const downloadDir = path.join(cacheRoot(), "downloads");
  await fs.mkdir(downloadDir, { recursive: true });
  const ext = extOfName(new URL(url).pathname);
  const cached = path.join(downloadDir, `${hash}${ext}`);
  await fs.writeFile(cached, data, { flag: "wx" }).catch(() => undefined);
  return { path: cached, hash, ext };
}
