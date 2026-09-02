import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

export interface OwnerLockRecord {
  pid: number;
  hostname: string;
  token: string;
  botLogin: string;
  startedAt: string;
}

export interface OwnerLock {
  path: string;
  record: OwnerLockRecord;
  release(): void;
}

function repoRoot(cwd: string): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : resolve(cwd);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code !== "ESRCH";
  }
}

/** Keep non-owner Pi processes from overwriting the active owner's runtime heartbeat. */
export function ownerLockHeldByOther(cwd: string): boolean {
  const path = join(repoRoot(cwd), ".pi", "board-agent", "owner.lock");
  if (!existsSync(path)) return false;
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as OwnerLockRecord;
    if (record.hostname.toLowerCase() !== hostname().toLowerCase()) return true;
    return record.pid !== process.pid && processIsAlive(record.pid);
  } catch {
    return true;
  }
}

export function acquireOwnerLock(cwd: string, botLogin: string): OwnerLock {
  const dir = join(repoRoot(cwd), ".pi", "board-agent");
  const path = join(dir, "owner.lock");
  mkdirSync(dir, { recursive: true });

  const record: OwnerLockRecord = {
    pid: process.pid,
    hostname: hostname(),
    token: randomUUID(),
    botLogin,
    startedAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(record, null, 2), "utf8");
      } finally {
        closeSync(fd);
      }
      return {
        path,
        record,
        release() {
          if (!existsSync(path)) return;
          try {
            const current = JSON.parse(readFileSync(path, "utf8")) as OwnerLockRecord;
            if (current.token === record.token) unlinkSync(path);
          } catch {
            // A corrupt or replaced lock is not ours to remove.
          }
        },
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      let current: OwnerLockRecord;
      try {
        current = JSON.parse(readFileSync(path, "utf8")) as OwnerLockRecord;
      } catch {
        throw new Error(`Board-agent owner lock is corrupt; remove it manually: ${path}`);
      }
      if (current.hostname.toLowerCase() !== record.hostname.toLowerCase()) {
        throw new Error(`Board-agent is owned by ${current.hostname} (pid ${current.pid}); refusing cross-host takeover.`);
      }
      if (processIsAlive(current.pid)) {
        throw new Error(`Board-agent is already running locally (pid ${current.pid}, bot ${current.botLogin || "unknown"}).`);
      }
      try {
        unlinkSync(path);
      } catch (unlinkError: any) {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      }
    }
  }
  throw new Error(`Could not acquire board-agent owner lock: ${path}`);
}
