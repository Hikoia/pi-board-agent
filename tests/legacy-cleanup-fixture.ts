// Construct historical v3 evidence explicitly. Production never creates these
// snapshots/receipts now; fixture construction is not conversion or cleanup.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { fixture } from "./cleanup-fixture.js";
import { git } from "./cleanup-fixture.js";
const { cleanupSnapshot, directoryStamps } = await import("../src/cleanup-snapshot.js");
export async function historicalReceipt(f: Omit<Awaited<ReturnType<typeof fixture>>, "finish">, fullyRemoved = false) {
  const result = git(f.repo, "commit-tree", `${f.taskSha}^{tree}`, "-p", f.base, "-p", f.taskSha, "-m", "old merge result");
  git(f.repo, "push", "origin", `${result}:refs/heads/main`);
  const bytes = readFileSync(f.recordFile), record = JSON.parse(bytes.toString("utf8"));
  const receipt = { schemaVersion: 1, itemId: record.itemId, issueNumber: record.issueNumber,
    taskBranch: record.taskBranch, baseBranch: record.baseBranch, taskSha: f.taskSha, resultSha: result, record,
    recordHash: createHash("sha256").update(bytes).digest("hex"),
    snapshots: [await cleanupSnapshot(record.path), await cleanupSnapshot(f.admin)],
    parents: await directoryStamps(f.receipt), gitParents: await directoryStamps(join(dirname(dirname(f.admin)), "probe")), backup: null };
  writeFileSync(f.receipt, JSON.stringify(receipt, null, 2));
  git(f.repo, "push", "origin", `:refs/heads/${f.task.taskBranch}`);
  if (fullyRemoved) {
    git(f.repo, "worktree", "remove", record.path);
    git(f.repo, "update-ref", "--no-deref", "-d", `refs/heads/${f.task.taskBranch}`, f.taskSha);
    unlinkSync(f.recordFile);
  } else f.vanish();
  return receipt;
}
