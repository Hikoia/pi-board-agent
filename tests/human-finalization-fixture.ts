// Low-level cleanup acceptance: production prepares a PR head, the harness acts
// as the human, then production consumes explicit immutable merge evidence.
import type { TicketWorktrees, TicketPullRequestIntegration } from "../src/ticket-worktree.js";
import type { BuilderTask } from "../src/workflow-prompt.js";
import type { PullRequestInfo } from "../src/gh.js";
import type { OperationControl } from "../src/operation.js";
import { fakePullRequests, testOwner } from "./pr-fixture.js";
export async function simulateHumanFinalization(store: TicketWorktrees, task: BuilderTask,
  assertCurrent: () => Promise<void> = async () => {}, control?: OperationControl) {
  const owner = testOwner(store.repoRoot);
  const scope = { owner: "owner", repo: "repo", base: task.baseBranch, head: task.taskBranch };
  let record = store.read(task.itemId);
  if (!record) {
    store.cleanupRecordV5(task);
    record = store.createV5({ schemaVersion: 5, itemId: task.itemId, issueNumber: task.issueNumber, taskKey: task.taskKey,
      taskBranch: task.taskBranch, baseBranch: task.baseBranch, path: store.pathFor(task.itemId, task.issueNumber), createdAt: Date.now() }, owner, () => {});
  }
  if (record.integration?.kind === "legacy-completed") return store.cleanupLegacyCompleted(task, owner, assertCurrent, undefined, control);
  if (record.integration?.phase !== "merged") {
    record = await store.preparePullRequest(task, scope, owner, assertCurrent, control);
    const api = fakePullRequests(store.repoRoot);
    const pr = await api.api.createPullRequest(scope, "Offline human acceptance", "Refs #1");
    api.merge(api.prs[0], false);
    const merged = await api.api.getPullRequest(scope, pr.number);
    record = store.progressPullRequest(record, { ...record.integration as TicketPullRequestIntegration, phase: "merged", prNumber: merged.number,
      prUrl: merged.url, mergedHeadSha: merged.headSha, mergeCommitSha: merged.mergeCommitSha! }, { stage: "cleanup", reason: "Simulated human merge" }, owner, () => {});
  }
  const state = record.integration;
  if (state?.kind !== "pr" || state.phase !== "merged") throw new Error("Missing simulated human proof");
  const pr: PullRequestInfo = { scope, number: state.prNumber, url: state.prUrl, body: "Refs #1", state: "closed", merged: true,
    headSha: state.mergedHeadSha, mergeCommitSha: state.mergeCommitSha };
  return store.cleanupMergedPullRequest(task, pr, owner, assertCurrent, control);
}
