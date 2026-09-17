import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as promises from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";

let cut: (operation: string) => void = () => {};
const globals = globalThis as any;
globals.__legacyAtomic = {
  renameSync(from: fs.PathLike, to: fs.PathLike) { cut("before publish"); fs.renameSync(from, to); cut("after publish"); },
  fsyncSync(fd: number) { fs.fsyncSync(fd); cut("record flushed"); },
  async link(from: string, to: string) {
    if (to.includes("legacy-v3")) cut("before backup");
    await promises.link(from, to);
    if (to.includes("legacy-v3")) cut("after backup");
  },
};
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "node:fs" && context.parentURL === new URL("../src/ticket-worktree.ts", import.meta.url).href)
    return { url: `data:text/javascript,${encodeURIComponent("export * from 'node:fs'; export const {renameSync,fsyncSync}=globalThis.__legacyAtomic;")}`, shortCircuit: true };
  if (specifier === "node:fs/promises" && context.parentURL === new URL("../src/cleanup-snapshot.ts", import.meta.url).href)
    return { url: `data:text/javascript,${encodeURIComponent("export * from 'node:fs/promises'; export const {link}=globalThis.__legacyAtomic;")}`, shortCircuit: true };
  return next(specifier, context);
} });
try {
  const { acquireOwnerLock } = await import("../src/owner-lock.js");
  const { fixture } = await import("./legacy-migration-fixture.js");
  const { LegacyTickets } = await import("../src/legacy-tickets.js");
  const f = await fixture(), t = await f.ticket("atomic", "Ready");
  // Deliberately non-canonical source: exact bytes, not JSON reserialization.
  const raw = Buffer.from(JSON.stringify(t.record, null, "\t").replaceAll("\n", "\r\n") + "\r\n\r\n");
  fs.writeFileSync(t.file, raw);
  const backup = join(f.repo, ".pi", "board-agent", "legacy-v3", "atomic.json");
  let owner = acquireOwnerLock(f.repo, "bot");
  try {
    for (const operation of ["before backup", "after backup", "record flushed", "before publish", "after publish"]) {
      fs.writeFileSync(t.file, raw);
      if (fs.existsSync(backup)) fs.unlinkSync(backup); // fixture-owned reset, never production GC
      cut = (step) => { if (step === operation) throw new Error(`offline cut: ${step}`); };
      const report = await new LegacyTickets(f.deps).migrate(owner);
      cut = () => {};
      assert.equal(report.failures.length, 1, JSON.stringify(report));
      if (operation === "after publish") assert.equal(f.store.read(t.card.itemId)!.schemaVersion, 4);
      else assert.deepEqual(fs.readFileSync(t.file), raw);
      if (operation === "before backup") assert.equal(fs.existsSync(backup), false);
      else assert.deepEqual(fs.readFileSync(backup), raw);
      const restarted = await new LegacyTickets(f.deps).migrate(owner);
      assert.equal(restarted.failures.length, 0, JSON.stringify(restarted));
      assert.equal(restarted.converted.length, operation === "after publish" ? 0 : 1);
      assert.equal(f.store.read(t.card.itemId)!.schemaVersion, 4);
      assert.deepEqual(fs.readFileSync(backup), raw);
    }
    console.log("PASS: backup link, flush and atomic-rename cuts retain exactly v3 or whole v4; exact CRLF/raw create-only backup precedes publication and restart is reentrant");

    fs.writeFileSync(t.file, raw);
    fs.writeFileSync(backup, "unknown backup data");
    const mismatch = await new LegacyTickets(f.deps).migrate(owner);
    assert.match(mismatch.failures[0].reason, /backup differs/);
    assert.deepEqual(fs.readFileSync(t.file), raw);
    assert.equal(fs.readFileSync(backup, "utf8"), "unknown backup data");
    fs.writeFileSync(backup, raw);
    cut = (step) => { if (step === "record flushed") fs.writeFileSync(t.file, "{externally changed"); };
    const changed = await new LegacyTickets(f.deps).migrate(owner);
    cut = () => {};
    assert.match(changed.failures[0].reason, /atomic write boundary/);
    assert.equal(fs.readFileSync(t.file, "utf8"), "{externally changed");
    assert.deepEqual(fs.readFileSync(backup), raw);
    console.log("PASS: mismatching existing backup and changed/corrupt source at publication are never overwritten or called successful conversion");

    for (const stop of ["owner lost", "startup cancelled"]) {
      fs.writeFileSync(t.file, raw);
      let canMigrate = true;
      cut = (step) => { if (step === "record flushed") { if (stop === "owner lost") owner.release(); else canMigrate = false; } };
      const report = await new LegacyTickets(f.deps).migrate(owner, () => canMigrate);
      cut = () => {};
      assert.equal(report.failures.length, 1);
      assert.deepEqual(fs.readFileSync(t.file), raw);
      if (stop === "owner lost") owner = acquireOwnerLock(f.repo, "bot");
    }
    await new LegacyTickets(f.deps).migrate(owner);
    const published = fs.readFileSync(t.file);
    fs.writeFileSync(backup, "old evidence unavailable after accepted conversion");
    const again = await new LegacyTickets(f.deps).migrate(owner);
    assert.deepEqual(again.converted, []);
    assert.deepEqual(fs.readFileSync(t.file), published);
    console.log("PASS: owner loss and startup-stop races veto atomic conversion; already published v4 never replays a migration even if old backup later becomes unreadable");
  } finally { cut = () => {}; owner.release(); }
} finally { hooks.deregister(); delete globals.__legacyAtomic; }
