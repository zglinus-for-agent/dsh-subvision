import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

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

function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

export class VisionRegistry {
  private readonly mem = new Map<string, VisionChildRecord>();
  private loaded = false;

  constructor(
    private readonly parentSessionId: string,
    private readonly stateDir = path.join(
      process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"),
      "subvision-state",
    ),
  ) {}

  private get file(): string {
    return path.join(this.stateDir, `${sanitize(this.parentSessionId)}.json`);
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const raw = await fs.readFile(this.file, "utf8").catch(() => null);
    if (raw === null) return;
    try {
      const parsed = JSON.parse(raw) as { children?: VisionChildRecord[] };
      for (const record of parsed.children ?? []) {
        if (typeof record?.childId === "string" && typeof record?.hash === "string") {
          this.mem.set(record.hash, record);
        }
      }
    } catch (error) {
      // Corrupt state file: ignore and fall back to an empty registry.
      console.warn(`[dsh-subvision] ignoring corrupt registry ${this.file}: ${String(error)}`);
    }
  }

  private async persist(): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true });
    const payload = JSON.stringify({ children: [...this.mem.values()] }, null, 2);
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, payload, "utf8");
    await fs.rename(tmp, this.file).catch(async () => {
      // rename can fail across some mounts; fall back to direct write
      await fs.writeFile(this.file, payload, "utf8");
    });
  }

  /** Look up the existing child for this image hash, if any. */
  async find(hash: string): Promise<VisionChildRecord | undefined> {
    await this.load();
    const record = this.mem.get(hash);
    if (record !== undefined) {
      record.lastUsedAt = Date.now();
      void this.persist();
    }
    return record;
  }

  /** Remember (or refresh) the child owning this image hash. */
  async remember(record: VisionChildRecord): Promise<void> {
    await this.load();
    this.mem.set(record.hash, record);
    await this.persist();
  }

  /** Forget one hash (used when its child can no longer be reached). */
  async forget(hash: string): Promise<void> {
    await this.load();
    if (this.mem.delete(hash)) await this.persist();
  }

  /** All known children of this parent session (for diagnostics/UI later). */
  async all(): Promise<VisionChildRecord[]> {
    await this.load();
    return [...this.mem.values()];
  }

  /** Read every per-parent registry file on disk: { session, children }[], oldest first. */
  static async allSessions(stateDir = path.join(
    process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"),
    "subvision-state",
  )): Promise<Array<{ session: string; children: VisionChildRecord[] }>> {
    const entries = await fs.readdir(stateDir).catch(() => []);
    const out: Array<{ session: string; children: VisionChildRecord[] }> = [];
    for (const name of entries) {
      if (!name.endsWith(".json") || name.endsWith(".tmp")) continue;
      const raw = await fs.readFile(path.join(stateDir, name), "utf8").catch(() => null);
      if (raw === null) continue;
      try {
        const parsed = JSON.parse(raw) as { children?: VisionChildRecord[] };
        const children = (parsed.children ?? []).filter(
          (r) => typeof r?.childId === "string" && typeof r?.hash === "string",
        );
        if (children.length > 0) out.push({ session: name.slice(0, -5), children });
      } catch {
        // skip corrupt file
      }
    }
    out.sort((a, b) => (a.children[0]?.createdAt ?? 0) - (b.children[0]?.createdAt ?? 0));
    return out;
  }
}
