// Bounded-I/O regression for the real prepare/remove/finish primitives (no timing benchmark).
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { mkdirSync, writeFileSync, unlinkSync, renameSync, existsSync, lstatSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
const root = process.env.TMP_DIR!;
assert.ok(root);
let metrics = { opens: 0, bytes: 0, metadata: 0, handles: 0 }, enabled = false;
let hook: (op: string, path: string) => void = () => {};
const globals = globalThis as any;
globals.__linearFs = async (op: keyof typeof fs, path: string, ...args: any[]) => {
  if (enabled) { if (op === "open") metrics.opens++; else metrics.metadata++; }
  const result = await (fs[op] as any)(path, ...args);
  if (op === "open") {
    const read = result.read.bind(result), close = result.close.bind(result);
    if (enabled) metrics.handles++;
    const counted = enabled;
    result.read = async (...a: any[]) => { const r = await read(...a); if (enabled) metrics.bytes += r.bytesRead; hook("read", String(path)); return r; };
    result.close = async () => { try { return await close(); } finally { if (counted) metrics.handles--; } };
  }
  hook(op, String(path));
  return result;
};
globals.__linearStat = (...args: Parameters<typeof lstatSync>) => { if (enabled) metrics.metadata++; return lstatSync(...args); };
const url = new URL("../src/cleanup-snapshot.ts", import.meta.url).href;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "node:fs" && context.parentURL === url)
    return { url: `data:text/javascript,${encodeURIComponent("export * from 'node:fs'; export const lstatSync = globalThis.__linearStat;")}`, shortCircuit: true };
  if (specifier === "node:fs/promises" && context.parentURL === url)
    return { url: `data:text/javascript,${encodeURIComponent(`export * from 'node:fs/promises'; ${["open", "lstat", "readdir", "readlink", "unlink", "rmdir"].map((op) => `export const ${op} = (...a) => globalThis.__linearFs('${op}', ...a);`).join("\n")}`)}`, shortCircuit: true };
  return next(specifier, context);
} });
const { cleanupSnapshot, prepareSnapshot, removeSnapshot, removalBatch, verifyBackupSnapshots, readEvidence, verifyEvidence, verifyEvidenceNow } = await import("../src/cleanup-snapshot.js");
let serial = 0;
async function fixture(n: number, removed = 0, large = false) {
  const dir = join(root, `linear-${++serial}`), source = join(dir, "source"), backup = join(dir, "backup");
  mkdirSync(join(source, "wide"), { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(join(source, "wide", `f${String(i).padStart(4, "0")}`), Buffer.alloc(large ? 3 * 1024 * 1024 + 7 : 1024, i % 256));
  const snapshot = await cleanupSnapshot(source);
  await fs.cp(source, join(backup, "0"), { recursive: true });
  writeFileSync(join(backup, "verified.json"), JSON.stringify({ schemaVersion: 1, snapshots: [snapshot] }));
  for (let i = 0; i < removed; i++) unlinkSync(join(source, "wide", `f${String(i).padStart(4, "0")}`));
  return { source, backup, snapshot };
}
async function prepare(f: Awaited<ReturnType<typeof fixture>>) {
  const backup = await verifyBackupSnapshots(f.backup, [f.snapshot]);
  const source = await prepareSnapshot(f.snapshot);
  source.backup = backup.copies[0];
  return { source, backup };
}
try {
  for (const partial of [false, true]) {
    const samples = [];
    for (const n of [64, 128]) {
      const f = await fixture(n, partial ? n - 4 : 0);
      metrics = { opens: 0, bytes: 0, metadata: 0, handles: 0 }; enabled = true;
      let manifests = 0;
      hook = (op, path) => { if (op === "open" && path === join(f.backup, "verified.json")) manifests++; };
      const p = await prepare(f);
      const control = { check: () => verifyEvidenceNow(p.backup.manifest) };
      await removeSnapshot(p.source, removalBatch(async () => {}, () => verifyEvidence(p.backup.manifest), control), control);
      await verifyBackupSnapshots(f.backup, [f.snapshot]);
      assert.equal(manifests, 2, "at most two full backup verifications per attempt");
      assert.equal(metrics.handles, 0);
      assert.equal(existsSync(f.source), false);
      samples.push({ ...metrics }); enabled = false; hook = () => {};
    }
    for (const metric of ["opens", "bytes", "metadata"] as const)
      assert.ok(samples[1][metric] / samples[0][metric] <= 2.5, `${metric} quadratic: ${JSON.stringify(samples)}`);
    console.log(`PASS: doubling fixed-depth wide files (${partial ? "mostly removed" : "all present"}) keeps opens/hash bytes/metadata <=2.5x: ${JSON.stringify(samples)}`);
  }
  {
    let now = 0, refreshes = 0, local = 0;
    const controller = new AbortController();
    const batch = removalBatch(async () => { refreshes++; now += 5000; }, async () => { local++; }, { signal: controller.signal }, () => now);
    for (let i = 0; i < 32; i++) { await batch.check(); batch.removed(); }
    assert.equal(refreshes, 1); await batch.check(); assert.equal(refreshes, 2);
    now += 1000; await batch.check(); assert.equal(refreshes, 3);
    controller.abort(); await assert.rejects(batch.check(), /abort/i); assert.equal(refreshes, 3); assert.equal(local, 34);
    console.log("PASS: batch window starts after remote observation; 33rd delete/1s expiry refresh, cancellation bypasses cache");
  }
  {
    const f = await fixture(1, 0, true), p = await prepare(f);
    let now = 0, refreshes = 0, chunks = 0, expired = false;
    const batch = removalBatch(async () => { refreshes++; }, async () => {}, undefined, () => now);
    hook = (op, path) => {
      if (op === "read" && path.includes("f0000")) { chunks++; if (!expired) { expired = true; now += 1000; } }
      if (op === "unlink") assert.ok(refreshes >= 2, "long hash expiry must refresh before unlink");
    };
    await removeSnapshot(p.source, batch);
    hook = () => {};
    assert.ok(chunks >= 8, "large file hashed in 1 MiB chunks for source AND backup");
    console.log("PASS: a long hash crossing the deadline refreshes authorization before deleting its freshly pinned file");
  }
  for (const race of ["source", "backup", "receipt", "stop", "owner"] as const) {
    const f = await fixture(1, 0, true), p = await prepare(f), controller = new AbortController();
    let now = 0, refreshes = 0, owner = true;
    const control = { signal: controller.signal, check: () => { if (!owner) throw new Error("owner lost"); verifyEvidenceNow(p.backup.manifest); } };
    const batch = removalBatch(async () => {
      if (++refreshes !== 2) return;
      if (race === "source") writeFileSync(join(f.source, "wide", "f0000"), "changed");
      if (race === "backup") writeFileSync(join(f.backup, "0", "wide", "f0000"), "changed");
      if (race === "receipt") writeFileSync(join(f.backup, "verified.json"), "{}");
      if (race === "stop") controller.abort();
      if (race === "owner") owner = false;
    }, () => verifyEvidence(p.backup.manifest), control, () => now);
    hook = (op, path) => { if (op === "read" && path.includes("f0000")) now = 1000; };
    await assert.rejects(removeSnapshot(p.source, batch, control));
    assert.equal(refreshes, 2); assert.ok(existsSync(join(f.source, "wide", "f0000")));
    hook = () => {};
    console.log(`PASS: ${race} during expired-window authorization is rechecked before the already-hashed file can be deleted`);
  }
  for (const race of ["source", "backup", "receipt", "recreate", "late-file", "stop", "owner"] as const) {
    const f = await fixture(3), p = await prepare(f);
    const receipt = join(f.backup, "verified.json"), evidence = await readEvidence(receipt);
    let changed = false, owner = true;
    const controller = new AbortController();
    const control = { signal: controller.signal, check: () => { if (!owner) throw new Error("owner lost"); verifyEvidenceNow(evidence.evidence); } };
    const batch = removalBatch(async () => {}, () => verifyEvidence(evidence.evidence), control);
    hook = (op, path) => {
      if (changed || op !== "lstat" || !path.endsWith("f0002")) return;
      changed = true;
      if (race === "source") writeFileSync(join(f.source, "wide", "f0002"), "changed");
      if (race === "backup") writeFileSync(join(f.backup, "0", "wide", "f0002"), "changed");
      if (race === "receipt") writeFileSync(receipt, "{}");
      if (race === "recreate") { const file = join(f.source, "wide", "f0002"); renameSync(file, join(root, `saved-${serial}`)); writeFileSync(file, Buffer.alloc(1024, 2)); }
      if (race === "late-file") writeFileSync(join(f.source, "wide", "unknown"), "keep");
      if (race === "stop") controller.abort();
      if (race === "owner") owner = false;
    };
    await assert.rejects(removeSnapshot(p.source, batch, control));
    assert.ok(changed); assert.ok(existsSync(f.source));
    hook = () => {};
    console.log(`PASS: ${race} after preparation blocks cleanup without accepting new evidence`);
  }
  {
    const f = await fixture(2, 0, true), controller = new AbortController();
    metrics.handles = 0; enabled = true;
    hook = (op) => { if (op === "read") controller.abort(); };
    await assert.rejects(prepareSnapshot(f.snapshot, { signal: controller.signal }), /abort/i);
    assert.equal(metrics.handles, 0); enabled = false; hook = () => {};
    const p = await prepare(f); let deleted = 0;
    hook = (op) => { if (op === "unlink" && ++deleted === 1) throw new Error("partial cut"); };
    await assert.rejects(removeSnapshot(p.source, removalBatch(async () => {}, async () => {})), /partial cut/);
    hook = () => {};
    const retry = await prepare(f);
    assert.equal(retry.source.remaining.length, p.source.remaining.length - 1);
    await removeSnapshot(retry.source, removalBatch(async () => {}, async () => {}));
    console.log("PASS: chunk cancellation closes all handles; fresh attempt resumes only surviving items after partial unlink");
  }
} finally {
  enabled = false; hook = () => {}; hooks.deregister(); delete globals.__linearFs; delete globals.__linearStat;
}
