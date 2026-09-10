import { runProcessSync } from "./process-runner.js";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { assertSupportedState } from "./unsupported-state.js";

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
  const result = runProcessSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
  });
  return result.ok ? result.stdout.trim() : resolve(cwd);
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

function readOwnerLock(path: string): OwnerLockRecord {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Not a regular owner lock");
  let value: Partial<OwnerLockRecord> | null;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid owner lock JSON: ${path}`, { cause: error });
  }
  if (
    !value ||
    !Number.isSafeInteger(value.pid) ||
    value.pid! <= 0 ||
    value.pid! > 2_147_483_647 ||
    typeof value.hostname !== "string" ||
    !value.hostname.trim() ||
    value.hostname !== value.hostname.trim() ||
    typeof value.token !== "string" ||
    !value.token.trim() ||
    typeof value.botLogin !== "string" ||
    typeof value.startedAt !== "string" ||
    !Number.isFinite(Date.parse(value.startedAt))
  ) {
    throw new Error("Invalid owner lock record");
  }
  return value as OwnerLockRecord;
}

function releaseToken(path: string, token: string): void {
  try {
    if (readOwnerLock(path).token === token) unlinkSync(path);
  } catch {
    // A corrupt, missing or replaced lock is not ours to remove.
  }
}

/** Keep non-owner Pi processes from overwriting the active owner's runtime heartbeat. */
export function ownerLockHeldByOther(cwd: string): boolean {
  const path = join(repoRoot(cwd), ".pi", "board-agent", "owner.lock");
  try {
    const record = readOwnerLock(path);
    if (record.hostname.toLowerCase() !== hostname().toLowerCase()) return true;
    return record.pid !== process.pid && processIsAlive(record.pid);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

export function acquireOwnerLock(cwd: string, botLogin: string): OwnerLock {
  assertSupportedState(cwd);
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
          releaseToken(path, record.token);
        },
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      // Serialize stale removal. A check-then-unlink without this guard can delete
      // another contender's newly acquired live lock. An interrupted reclaim is
      // deliberately manual recovery, rather than recursively stealing its guard.
      const reclaimPath = `${path}.reclaim`;
      let fd: number;
      try {
        fd = openSync(reclaimPath, "wx", 0o600);
      } catch {
        throw new Error(
          `Owner lock recovery is busy or interrupted. Inspect ${reclaimPath}; remove it manually only after all contenders have stopped.`,
        );
      }
      try {
        writeFileSync(fd, JSON.stringify(record), "utf8");
      } finally {
        closeSync(fd);
      }
      try {
        let current: OwnerLockRecord;
        try {
          current = readOwnerLock(path);
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw new Error(
            `Board-agent owner lock is corrupt; inspect and repair it manually: ${path}`,
          );
        }
        if (current.hostname.toLowerCase() !== record.hostname.toLowerCase()) {
          throw new Error(
            `Board-agent is owned by ${current.hostname} (pid ${current.pid}); refusing cross-host takeover.`,
          );
        }
        if (processIsAlive(current.pid)) {
          throw new Error(
            `Board-agent is already running locally (pid ${current.pid}, bot ${current.botLogin || "unknown"}).`,
          );
        }
        unlinkSync(path);
      } finally {
        releaseToken(reclaimPath, record.token);
      }
    }
  }
  throw new Error(`Could not acquire board-agent owner lock: ${path}`);
}
