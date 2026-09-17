// Construct historical v3 evidence explicitly. Production never creates these
// snapshots/receipts now; fixture construction is not conversion or cleanup.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, copyFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { fixture } from "./cleanup-fixture.js";
import { git } from "./cleanup-fixture.js";
const { cleanupSnapshot, directoryStamps } = await import("../src/cleanup-snapshot.js");
export async function historicalReceipt(f: Omit<Awaited<ReturnType<typeof fixture>>, "finish">, fullyRemoved = false, withBackup = false) {
  const result = git(f.repo, "commit-tree", `${f.taskSha}^{tree}`, "-p", f.base, "-p", f.taskSha, "-m", "old merge result");
  git(f.repo, "push", "origin", `${result}:refs/heads/main`);
  const bytes = readFileSync(f.recordFile), record = JSON.parse(bytes.toString("utf8"));
  const receipt = { schemaVersion: 1, itemId: record.itemId, issueNumber: record.issueNumber,
    taskBranch: record.taskBranch, baseBranch: record.baseBranch, taskSha: f.taskSha, resultSha: result, record,
    recordHash: createHash("sha256").update(bytes).digest("hex"),
    snapshots: [await cleanupSnapshot(record.path), await cleanupSnapshot(f.admin)],
    parents: await directoryStamps(f.receipt), gitParents: await directoryStamps(join(dirname(dirname(f.admin)), "probe")), backup: null as string | null };
  if (withBackup) {
    receipt.backup = join(f.repo, ".pi", "board-agent", "cleanup-backups", "historical-fixture");
    mkdirSync(receipt.backup, { recursive: true });
    // Match the old backup's entry-wise copy: recursive cp follows Windows junctions.
    for (const [i, snapshot] of receipt.snapshots.entries()) {
      for (const entry of snapshot.entries) {
        const destination = join(receipt.backup, String(i), entry.path);
        if (entry.type === "directory") mkdirSync(destination);
        else if (entry.type === "symlink") symlinkSync(entry.target, destination, entry.linkType);
        else copyFileSync(join(snapshot.path, entry.path), destination);
      }
    }
    writeFileSync(join(receipt.backup, "record.json"), bytes);
    writeFileSync(join(receipt.backup, "verified.json"), JSON.stringify({ schemaVersion: 1, snapshots: receipt.snapshots }));
  }
  writeFileSync(f.receipt, JSON.stringify(receipt, null, 2));
  git(f.repo, "push", "origin", `:refs/heads/${f.task.taskBranch}`);
  if (fullyRemoved) {
    git(f.repo, "worktree", "remove", record.path);
    git(f.repo, "update-ref", "--no-deref", "-d", `refs/heads/${f.task.taskBranch}`, f.taskSha);
    unlinkSync(f.recordFile);
  } else f.vanish();
  return receipt;
}

// Invoke the real owner-held adapter; tests never synthesize a v4 authorization.
export async function migrateCleanup(f: Omit<Awaited<ReturnType<typeof fixture>>, "finish">) {
  const { LegacyTickets } = await import("../src/legacy-tickets.js");
  const { acquireOwnerLock } = await import("../src/owner-lock.js");
  const { _DEFAULTS } = await import("../src/config.js");
  const adapter = new LegacyTickets({ worktrees: f.store, cfg: structuredClone(_DEFAULTS), botLogin: "bot", repoOwner: "owner", repoName: "repo",
    board: { getCard: async () => ({ itemId: f.task.itemId, number: f.task.issueNumber, title: f.task.title, body: f.task.body, type: "Task", contentType: "Issue", status: "Done", closed: true, assignees: [], plan: "demo", repoOwner: "owner", repoName: "repo" }),
      setStatus: async () => { throw new Error("unexpected migration write"); } } });
  const owner = acquireOwnerLock(f.repo, "bot");
  try {
    const report = await adapter.migrate(owner);
    if (report.failures.length) throw new Error(report.failures.map((f) => f.reason).join("; "));
  } finally { owner.release(); }
  return async () => {
    const result = await f.store.finalizeAccepted(f.task, "merge", undefined,
      (record, remove, guard) => adapter.cleanupResidual(record, remove, guard), (record) => adapter.approvedTaskSha(record));
    if (result) await f.store.completeFinalization(f.task, result, async () => {});
    return result;
  };
}
