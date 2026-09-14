import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, type WriteFileOptions } from "node:fs";
import { join } from "node:path";
import { registerHooks } from "node:module";
import type { TicketExecutionRecord } from "../src/ticket-worktree.js";

const root = process.env.TMP_DIR!;
assert.ok(root, "Use the offline runner");
let cut: string | undefined, reached = false;
const globals = globalThis as any;
const interrupt = (edge: string) => { if (cut === edge) { reached = true; throw new Error(`cut:${edge}`); } };
globals.__legacyWrite = (path: string, value: string | Buffer, options: WriteFileOptions) => {
  assert.equal(typeof options === "object" && options?.flag, "wx");
  assert.equal(typeof options === "object" && options?.flush, true);
  const backup = path.endsWith(".v3.bak");
  const edge = backup ? "backup" : "v4";
  interrupt(`before-${edge}`);
  writeFileSync(path, cut === `partial-${edge}` ? (Buffer.isBuffer(value) ? value.subarray(0, 3) : value.slice(0, 3)) : value, options);
  interrupt(`partial-${edge}`); interrupt(`after-${edge}`);
};
globals.__legacyRename = (from: string, to: string) => {
  interrupt("before-rename"); renameSync(from, to); interrupt("after-rename");
};
const url = new URL("../src/ticket-worktree.ts", import.meta.url).href;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === url && specifier === "node:fs") return {
    url: `data:text/javascript,${encodeURIComponent(`export * from 'node:fs';
      export const writeFileSync = (...a) => globalThis.__legacyWrite(...a);
      export const renameSync = (...a) => globalThis.__legacyRename(...a);`)}`, shortCircuit: true };
  return next(specifier, context);
} });
const { TicketWorktrees } = await import("../src/ticket-worktree.js");
let seq = 0;
function fixture() {
  const repo = join(root, `publish-${++seq}`); mkdirSync(repo);
  const store = new TicketWorktrees(repo);
  const record: TicketExecutionRecord = { schemaVersion: 3, itemId: "ITEM", issueNumber: 1, taskKey: "T001", plan: "original-plan",
    path: join(repo, ".pi/worktrees/ticket-issue-1-item"), taskBranch: "task/issue-1", baseBranch: "main", createdAt: 42,
    activeRunId: "original-run", activeRunStartedAt: 123 };
  const file = join(repo, ".pi/board-agent/ticket-worktrees/item.json");
  writeFileSync(file, JSON.stringify(record, null, "\t") + "\r\n");
  return { store, record, file, before: readFileSync(file), next: { ...record, schemaVersion: 4 as const } };
}
try {
  for (const edge of ["before-backup", "partial-backup", "after-backup", "before-v4", "partial-v4", "after-v4", "before-rename", "after-rename"]) {
    const f = fixture(); cut = edge; reached = false;
    assert.throws(() => f.store.publishLegacy(f.next, f.before), /cut:/); assert.ok(reached, edge); cut = undefined;
    assert.deepEqual(f.store.read("ITEM"), edge === "after-rename" ? f.next : f.record);
    if (edge !== "after-rename") assert.deepEqual(readFileSync(f.file), f.before);
    if (edge === "partial-backup") {
      const damaged = readFileSync(f.file + ".v3.bak");
      assert.throws(() => f.store.publishLegacy(f.next, f.before), /backup differs/);
      assert.deepEqual(readFileSync(f.file), f.before); assert.deepEqual(readFileSync(f.file + ".v3.bak"), damaged);
    } else if (edge === "after-rename") {
      assert.throws(() => f.store.publishLegacy(f.next, f.before), /source changed/);
      assert.deepEqual(readFileSync(f.file + ".v3.bak"), f.before);
    } else {
      f.store.publishLegacy(f.next, f.before);
      assert.deepEqual(readFileSync(f.file + ".v3.bak"), f.before); assert.deepEqual(f.store.read("ITEM"), f.next);
    }
    assert.ok(readdirSync(join(f.file, "..")).every((n) => n === "item.json" || n === "item.json.v3.bak"));
  }
  console.log("PASS: backup/v4 partial-write and rename cuts publish only complete old/new state; exact flushed create-only backup precedes v4; damaged backup retained and blocks conversion");
  {
    const f = fixture(); writeFileSync(f.file + ".v3.bak", "other original evidence");
    assert.throws(() => f.store.publishLegacy(f.next, f.before), /backup differs/);
    assert.deepEqual(readFileSync(f.file), f.before);
    assert.equal(readFileSync(f.file + ".v3.bak", "utf8"), "other original evidence");
    assert.throws(() => f.store.publishLegacy({ ...f.next, path: "elsewhere" }, f.before), /source changed/);
    assert.throws(() => f.store.publishLegacy(f.next), /existing record/);
  }
  console.log("PASS: existing backup and original identity cannot be replaced; receipt restore cannot overwrite any existing record");
} finally { cut = undefined; hooks.deregister(); delete globals.__legacyWrite; delete globals.__legacyRename; }
