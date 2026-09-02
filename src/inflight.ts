/** Legacy inflight registry. New execution uses TicketWorktrees + WorkflowManager;
 * these files are read only for one-time quarantine and forensic archival. */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface InflightRecord {
  itemId: string;          // ProjectV2 item id
  issueNumber?: number;
  cardTitle: string;
  plan: string;            // plan slug
  taskBranch: string;
  planBranch: string;
  startedAt: number;       // epoch ms
  workflowRunId?: string;  // pi-dynamic-workflows run id, when known
}

export class Inflight {
  private dir: string;
  constructor(cwd: string) {
    this.dir = resolve(cwd, ".pi", "board-agent", "inflight");
    mkdirSync(this.dir, { recursive: true });
  }
  private pathFor(itemId: string): string {
    return join(this.dir, `${itemId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  }
  has(itemId: string): boolean {
    return existsSync(this.pathFor(itemId));
  }
  write(rec: InflightRecord): void {
    writeFileSync(this.pathFor(rec.itemId), JSON.stringify(rec, null, 2), "utf-8");
  }
  read(itemId: string): InflightRecord | undefined {
    const p = this.pathFor(itemId);
    if (!existsSync(p)) return undefined;
    try { return JSON.parse(readFileSync(p, "utf-8")) as InflightRecord; } catch { return undefined; }
  }
  clear(itemId: string): void {
    const p = this.pathFor(itemId);
    if (existsSync(p)) rmSync(p, { force: true });
  }
  archive(itemId: string): string | undefined {
    const source = this.pathFor(itemId);
    if (!existsSync(source)) return undefined;
    const archiveDir = resolve(dirname(this.dir), "forensic-archive", "inflight");
    mkdirSync(archiveDir, { recursive: true });
    const target = join(archiveDir, `${Date.now()}-${itemId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
    renameSync(source, target);
    return target;
  }
  list(): InflightRecord[] {
    if (!existsSync(this.dir)) return [];
    const out: InflightRecord[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      const itemId = f.slice(0, -5);
      try {
        const record = JSON.parse(readFileSync(join(this.dir, f), "utf-8")) as InflightRecord;
        if (!record || record.itemId !== itemId) throw new Error("legacy inflight identity mismatch");
        out.push(record);
      } catch {
        out.push({
          itemId,
          issueNumber: 0,
          cardTitle: "(corrupt legacy inflight record)",
          plan: "",
          taskBranch: "",
          planBranch: "",
          startedAt: 0,
        });
      }
    }
    return out;
  }
  listByPlan(planSlug: string): InflightRecord[] {
    return this.list().filter((r) => r.plan === planSlug);
  }
}
