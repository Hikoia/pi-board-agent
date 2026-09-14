// Test-only writer for pre-upgrade artifacts. Production reads these formats only.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, symlink, open, link, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { cleanupSnapshot, directoryStamps, verifyParents, verifySnapshot, readRegular, readSymlink, type CleanupSnapshot } from "../src/cleanup-snapshot.js";
import { git, type fixture } from "./cleanup-fixture.js";
const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const equal = (a: unknown,b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Atomic, create-only publication. A failed publish never overwrites retry evidence. */
export async function writeCleanupEvidence(
  path: string,
  bytes: string | Buffer,
): Promise<void> {
  const parents = await directoryStamps(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await verifyParents(parents);
  await link(temporary, path);
  await unlink(temporary);
  // Windows cannot fsync directory handles; the published file itself is flushed.
  if (process.platform !== "win32") {
    const dir = await open(dirname(path), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
}

/** Copy everything, verify the copy, then prove the entire source is unchanged. Never GC. */
export async function backupSnapshots(
  path: string,
  snapshots: CleanupSnapshot[],
): Promise<void> {
  await mkdir(path); // unique destination; failures/incomplete copies are retained, never reused
  for (const [i, snapshot] of snapshots.entries()) {
    for (const entry of snapshot.entries) {
      await verifyParents(snapshot.parents);
      const destination = join(path, String(i), entry.path);
      await directoryStamps(destination);
      if (entry.type === "directory") await mkdir(destination);
      else if (entry.type === "symlink") {
        const source = await readSymlink(join(snapshot.path, entry.path));
        if (
          source.target !== entry.target ||
          source.linkType !== entry.linkType
        )
          throw new Error("Backup source symlink changed");
        await symlink(entry.target, destination, entry.linkType);
      } else {
        const bytes = await readRegular(join(snapshot.path, entry.path));
        if (
          digest(bytes) !== entry.sha256 ||
          String(bytes.length) !== entry.size
        )
          throw new Error("Backup source changed");
        await writeCleanupEvidence(destination, bytes);
      }
    }
    if (snapshot.entries.length) {
      const copy = await cleanupSnapshot(join(path, String(i)));
      const contents = (s: CleanupSnapshot) =>
        s.entries.map(({ identity: _identity, ...entry }) => entry);
      if (!equal(contents(copy), contents(snapshot)))
        throw new Error("Cleanup backup verification failed");
    }
  }
  for (const snapshot of snapshots) await verifySnapshot(snapshot, false);
  await writeCleanupEvidence(
    join(path, "verified.json"),
    JSON.stringify({ schemaVersion: 1, snapshots }),
  );
}


export async function legacyReceipt(f: Awaited<ReturnType<typeof fixture>>, options: { strategy?: "merge" | "squash"; backup?: boolean; nullRecord?: boolean } = {}) {
  const old = { ...f.record, schemaVersion: 3 as const };
  if (!options.nullRecord) writeFileSync(f.recordFile, JSON.stringify(old, null, "\t") + "\r\n");
  const bytes = options.nullRecord ? null : readFileSync(f.recordFile);
  const resultSha = git(f.repo, "commit-tree", `${f.taskSha}^{tree}`, "-p", f.base,
    ...(options.strategy === "squash" ? [] : ["-p", f.taskSha]), "-m", "old integrated result");
  git(f.repo, "push", "origin", `${resultSha}:refs/heads/main`);
  const snapshots = [await cleanupSnapshot(f.record.path)];
  if (existsSync(f.admin)) snapshots.push(await cleanupSnapshot(f.admin));
  let backup: string | null = null;
  if (options.backup) {
    const parent = join(f.repo, ".pi/board-agent/cleanup-backups"); mkdirSync(parent, { recursive: true });
    backup = join(parent, "original-backup"); await backupSnapshots(backup, snapshots);
    await writeCleanupEvidence(join(backup, "record.json"), bytes!);
  }
  mkdirSync(join(f.repo, ".pi/board-agent/cleanup"), { recursive: true });
  const receipt = { schemaVersion: 1, itemId: f.task.itemId, issueNumber: f.task.issueNumber,
    taskBranch: f.task.taskBranch, baseBranch: f.task.baseBranch, taskSha: f.taskSha, resultSha,
    record: options.nullRecord ? null : old, recordHash: bytes ? digest(bytes) : null, snapshots,
    parents: await directoryStamps(f.receipt), gitParents: await directoryStamps(join(f.repo, ".git/probe")), backup };
  await writeCleanupEvidence(f.receipt, JSON.stringify(receipt));
  return receipt;
}
