/**
 * Local inflight registry: lockfiles under `.pi/board-agent/inflight/`.
 *
 * Purpose:
 *  - Survive a pi restart: if a wave was interrupted, the lockfile tells us
 *    which cards were in-flight so we can rehydrate state from GitHub.
 *  - Close the 10-30s race between "claim assignee" and the worker being
 *    spawned by pi-dynamic-workflows. The lockfile is written *before*
 *    the assignee claim is attempted; if the process dies in between, the
 *    next tick's orphan-scan will detect it and clean up.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

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
  list(): InflightRecord[] {
    if (!existsSync(this.dir)) return [];
    const out: InflightRecord[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try { out.push(JSON.parse(readFileSync(join(this.dir, f), "utf-8")) as InflightRecord); } catch { /* skip */ }
    }
    return out;
  }
  listByPlan(planSlug: string): InflightRecord[] {
    return this.list().filter((r) => r.plan === planSlug);
  }
}
