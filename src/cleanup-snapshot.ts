// Read-only v3 filesystem evidence and verified residual removal. No new cleanup snapshots are persisted.
import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import {
  lstat,
  open,
  readdir,
  readlink,
  link,
  unlink,
  rmdir,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { processFailure, runProcess } from "./process-runner.js";
import { checkOperation, operationCheckpoint, type OperationControl } from "./operation.js";

export type DirectoryIdentity = { dev: string; ino: string; birth: string };
type Stamp = { path: string; identity: DirectoryIdentity };
export type SnapshotEntry = { path: string; identity: DirectoryIdentity } & (
  | { type: "directory" }
  | { type: "file"; size: string; sha256: string }
  | { type: "symlink"; target: string; linkType: "file" | "dir" | "junction" }
);
export interface CleanupSnapshot {
  path: string;
  parents: Stamp[];
  entries: SnapshotEntry[];
}

const identity = (stat: Awaited<ReturnType<typeof statAt>>) => ({
  dev: String(stat!.dev),
  ino: String(stat!.ino),
  birth: String(stat!.birthtimeNs),
});
async function statAt(path: string) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export const exactKeys = (value: any, keys: string[]) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const isIdentity = (value: any) =>
  exactKeys(value, ["dev", "ino", "birth"]) &&
  [value.dev, value.ino, value.birth].every(
    (v) => typeof v === "string" && /^\d+$/.test(v),
  );
const relativePath = (value: unknown): value is string =>
  typeof value === "string" &&
  (value === "" ||
    value
      .split("/")
      .every(
        (part) =>
          part &&
          part !== "." &&
          part !== ".." &&
          !/[\\:\x00-\x1f\x7f]/.test(part),
      ));
const linkTarget = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  !value.includes("\0") &&
  Buffer.from(value).toString("utf8") === value;
function parentPaths(path: string): string[] {
  const paths: string[] = [];
  for (let p = dirname(resolve(path)); ; p = dirname(p)) {
    paths.unshift(p);
    if (dirname(p) === p) return paths;
  }
}
export function isCleanupSnapshot(value: any): value is CleanupSnapshot {
  if (
    !exactKeys(value, ["path", "parents", "entries"]) ||
    typeof value.path !== "string" ||
    !isAbsolute(value.path) ||
    !Array.isArray(value.parents) ||
    !Array.isArray(value.entries)
  )
    return false;
  const parents = parentPaths(value.path);
  if (
    value.parents.length > parents.length ||
    !value.parents.every(
      (s: any, i: number) =>
        exactKeys(s, ["path", "identity"]) &&
        s.path === parents[i] &&
        isIdentity(s.identity),
    )
  )
    return false;
  const seen = new Map<string, SnapshotEntry>();
  for (const entry of value.entries) {
    if (
      !entry ||
      !relativePath(entry.path) ||
      !isIdentity(entry.identity) ||
      seen.has(entry.path)
    )
      return false;
    if (entry.type === "directory") {
      if (!exactKeys(entry, ["path", "identity", "type"])) return false;
    } else if (entry.type === "file") {
      if (
        !exactKeys(entry, ["path", "identity", "type", "size", "sha256"]) ||
        typeof entry.size !== "string" ||
        !/^\d+$/.test(entry.size) ||
        typeof entry.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(entry.sha256)
      )
        return false;
    } else if (entry.type === "symlink") {
      if (
        !exactKeys(entry, ["path", "identity", "type", "target", "linkType"]) ||
        !linkTarget(entry.target) ||
        !["file", "dir", "junction"].includes(entry.linkType) ||
        (entry.linkType === "junction" && !isAbsolute(entry.target))
      )
        return false;
    } else return false;
    if (
      entry.path === ""
        ? entry.type !== "directory"
        : seen.get(
            entry.path.includes("/")
              ? entry.path.slice(0, entry.path.lastIndexOf("/"))
              : "",
          )?.type !== "directory"
    )
      return false;
    seen.set(entry.path, entry);
  }
  return true;
}
export async function directoryStamps(path: string): Promise<Stamp[]> {
  const stamps: Stamp[] = [];
  for (const p of parentPaths(path)) {
    const stat = await statAt(p);
    if (!stat) break;
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`Unsafe cleanup directory (symlink/replacement): ${p}`);
    stamps.push({ path: p, identity: identity(stat) });
  }
  return stamps;
}
export async function verifyParents(
  stamps: Stamp[],
  missing = false,
): Promise<void> {
  for (const stamp of stamps) {
    const stat = await statAt(stamp.path);
    if (!stat && missing) continue;
    if (
      !stat?.isDirectory() ||
      stat.isSymbolicLink() ||
      !equal(identity(stat), stamp.identity)
    )
      throw new Error(`Cleanup directory identity changed: ${stamp.path}`);
  }
}

const fileStamp = (stat: NonNullable<Awaited<ReturnType<typeof statAt>>>) => ({
  ...identity(stat), size: String(stat.size), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
});
export interface FileEvidence {
  path: string;
  parents: Stamp[];
  stamp: ReturnType<typeof fileStamp>;
}
export async function verifyEvidence(evidence: FileEvidence): Promise<void> {
  await verifyParents(evidence.parents);
  const stat = await statAt(evidence.path);
  if (!stat || !equal(fileStamp(stat), evidence.stamp))
    throw new Error(`Cleanup file changed or replaced: ${evidence.path}`);
}

/** Cheap final veto after the last await; never reads/hashes large evidence.
 * Paired with async full verification, not a replacement for it. */
export function verifyEvidenceNow(evidence: FileEvidence): void {
  for (const parent of evidence.parents) {
    const stat = lstatSync(parent.path, { bigint: true, throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink() || !equal(identity(stat), parent.identity))
      throw new Error(`Cleanup directory identity changed: ${parent.path}`);
  }
  const stat = lstatSync(evidence.path, { bigint: true, throwIfNoEntry: false });
  if (!stat || !equal(fileStamp(stat), evidence.stamp))
    throw new Error(`Cleanup file changed or replaced: ${evidence.path}`);
}

/** Bounded, non-following reads. The handle always drains/closes before cancellation returns. */
async function readChunks(
  path: string,
  consume: (bytes: Buffer) => void,
  checkpoint: () => Promise<void>,
): Promise<FileEvidence> {
  await checkpoint();
  const parents = await directoryStamps(path);
  const before = await statAt(path);
  if (!before?.isFile() || before.isSymbolicLink())
    throw new Error(`Not a regular cleanup file: ${path}`);
  const evidence = { path, parents, stamp: fileStamp(before) };
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!equal(evidence.stamp, fileStamp(await handle.stat({ bigint: true }))))
      throw new Error(`Cleanup file replaced: ${path}`);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let read = 0n;
    while (read < before.size) {
      await checkpoint();
      const { bytesRead } = await handle.read(buffer, 0, Number(before.size - read < BigInt(buffer.length) ? before.size - read : BigInt(buffer.length)), null);
      if (!bytesRead) throw new Error(`Cleanup file truncated: ${path}`);
      consume(buffer.subarray(0, bytesRead));
      read += BigInt(bytesRead);
    }
    await checkpoint();
    await verifyEvidence(evidence);
    return evidence;
  } finally {
    await handle.close();
  }
}
export async function readEvidence(path: string, control?: OperationControl) {
  const chunks: Buffer[] = [];
  const evidence = await readChunks(path, (chunk) => chunks.push(Buffer.from(chunk)), operationCheckpoint(control));
  return { bytes: Buffer.concat(chunks), evidence };
}
export async function readRegular(path: string, control?: OperationControl): Promise<Buffer> {
  return (await readEvidence(path, control)).bytes;
}
async function hashRegular(path: string, checkpoint: () => Promise<void>, onBytes?: (n: number) => void) {
  const hash = createHash("sha256");
  const evidence = await readChunks(path, (chunk) => { hash.update(chunk); onBytes?.(chunk.length); }, checkpoint);
  return { evidence, sha256: hash.digest("hex"), size: evidence.stamp.size };
}

/** Read link metadata, not the target. Windows needs a creation kind that lstat omits. */
export async function readSymlink(
  path: string,
  control?: OperationControl,
): Promise<{ target: string; linkType: "file" | "dir" | "junction" }> {
  checkOperation(control);
  const parents = await directoryStamps(path);
  const before = await statAt(path);
  if (!before?.isSymbolicLink())
    throw new Error(`Not a cleanup symlink: ${path}`);
  const bytes = await readlink(path, { encoding: "buffer" });
  const target = bytes.toString("utf8");
  if (!linkTarget(target) || !Buffer.from(target).equals(bytes))
    throw new Error(`Unsupported cleanup symlink target: ${path}`);
  // POSIX ignores the creation kind. Never stat a target (including dangling links).
  let linkType: "file" | "dir" | "junction" = "file";
  if (process.platform === "win32") {
    const result = await runProcess("windows-link-kind", [path], {
      timeoutMs: 10_000,
    });
    if (!result.ok)
      throw processFailure("windows-link-kind", [path], result, 10_000);
    const kind = result.stdout.trim();
    if (kind !== "file" && kind !== "dir" && kind !== "junction")
      throw new Error(`Unsupported cleanup symlink/reparse state: ${path}`);
    linkType = kind;
    if (kind === "junction" && !isAbsolute(target))
      throw new Error(`Unsupported cleanup junction target: ${path}`);
  }
  const after = await statAt(path);
  if (
    !after?.isSymbolicLink() ||
    !equal(identity(before), identity(after)) ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    !(await readlink(path, { encoding: "buffer" })).equals(bytes)
  )
    throw new Error(`Cleanup symlink changed or replaced: ${path}`);
  await verifyParents(parents);
  checkOperation(control);
  return { target, linkType };
}

/** Full async traversal, including ignored files and empty directories; never follows links. */
export async function cleanupSnapshot(path: string, control?: OperationControl, onBytes?: (n: number) => void): Promise<CleanupSnapshot> {
  const checkpoint = operationCheckpoint(control);
  await checkpoint();
  const parents = await directoryStamps(path);
  const entries: SnapshotEntry[] = [];
  async function visit(rel: string): Promise<void> {
    await checkpoint();
    const target = join(path, rel);
    const stat = await statAt(target);
    if (!stat && rel === "") return;
    if (!stat || (!rel && stat.isSymbolicLink()))
      throw new Error(`Missing or symlinked cleanup root: ${target}`);
    if (!relativePath(rel))
      throw new Error(`Unsafe cleanup filename: ${target}`);
    const name = rel.split("/").at(-1)!;
    if (name.toLowerCase() === ".git" && (rel !== ".git" || !stat.isFile()))
      throw new Error(`Nested Git identity: ${target}`);
    if (stat.isSymbolicLink()) {
      const metadata = await readSymlink(target, control);
      const after = await statAt(target);
      if (!after?.isSymbolicLink() || !equal(identity(stat), identity(after)))
        throw new Error(`Cleanup symlink replaced: ${target}`);
      entries.push({
        path: rel,
        identity: identity(stat),
        type: "symlink",
        ...metadata,
      });
    } else if (stat.isDirectory()) {
      entries.push({ path: rel, identity: identity(stat), type: "directory" });
      const names = (await readdir(target)).sort();
      if (
        names.includes("HEAD") &&
        names.includes("objects") &&
        names.includes("refs")
      )
        throw new Error(`Nested Git identity: ${target}`);
      for (const name of names) await visit(rel ? `${rel}/${name}` : name);
      const after = await statAt(target);
      if (
        !after?.isDirectory() ||
        !equal(identity(stat), identity(after)) ||
        !equal(names, (await readdir(target)).sort())
      )
        throw new Error(`Cleanup directory changed: ${target}`);
    } else if (stat.isFile() && rel) {
      const file = await hashRegular(target, checkpoint, onBytes);
      if (!equal(file.evidence.stamp, fileStamp(stat)))
        throw new Error(`Cleanup file changed: ${target}`);
      entries.push({ path: rel, identity: identity(stat), type: "file", size: file.size, sha256: file.sha256 });
    } else throw new Error(`Special cleanup file: ${target}`);
  }
  await visit("");
  await verifyParents(parents);
  return { path, parents, entries };
}

export async function verifySnapshot(
  expected: CleanupSnapshot,
  partial = true,
  control?: OperationControl,
): Promise<CleanupSnapshot> {
  await verifyParents(expected.parents, partial);
  const progress = byteProgress([expected], "verify-source", control);
  const actual = await cleanupSnapshot(expected.path, control, progress);
  const entries = new Map(expected.entries.map((entry) => [entry.path, entry]));
  if (
    (!partial && actual.entries.length !== expected.entries.length) ||
    actual.parents.some((stamp, i) => !equal(stamp, expected.parents[i]))
  )
    throw new Error(`Cleanup snapshot changed: ${expected.path}`);
  for (const entry of actual.entries)
    if (!equal(entry, entries.get(entry.path)))
      throw new Error(
        `Cleanup snapshot changed or added${entry.type === "symlink" ? " (symlink)" : ""}: ${join(expected.path, entry.path)}`,
      );
  return actual;
}

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

function byteProgress(snapshots: CleanupSnapshot[], phase: "verify-source" | "verify-backup", control?: OperationControl) {
  const total = snapshots.reduce((sum, s) => sum + s.entries.reduce((n, e) => n + (e.type === "file" ? Number(e.size) : 0), 0), 0);
  let completed = 0;
  const advance = (bytes: number) => {
    completed += bytes;
    control?.onProgress?.({ phase, completed, total, unit: "bytes" });
  };
  advance(0);
  return advance;
}

export interface PreparedSnapshot {
  snapshot: CleanupSnapshot;
  entries: Map<string, SnapshotEntry>;
  remaining: SnapshotEntry[];
  backup?: PreparedSnapshot;
}
export async function prepareSnapshot(snapshot: CleanupSnapshot, control?: OperationControl): Promise<PreparedSnapshot> {
  const actual = await verifySnapshot(snapshot, true, control);
  return { snapshot, entries: new Map(snapshot.entries.map((e) => [e.path, e])), remaining: actual.entries };
}

/** A batch is scoped to ONE attempt, and starts its window AFTER remote observation. */
export function removalBatch(
  authorize: () => Promise<void>,
  local: () => Promise<void>,
  control?: OperationControl,
  now = () => performance.now(),
) {
  let used = 32, expires = -Infinity;
  const current = () => used < 32 && now() < expires;
  return {
    current,
    removed: () => { used++; },
    async check() {
      checkOperation(control);
      await local();
      if (!current()) {
        await authorize();
        checkOperation(control);
        used = 0;
        // authorize includes fresh local Git/record guards. Do not spend the
        // newly observed window repeating them (slow Git can exceed 1s).
        expires = now() + 1000;
      }
      checkOperation(control);
    },
  };
}

function entryParents(prepared: PreparedSnapshot, entry: SnapshotEntry): Stamp[] {
  const stamps = [...prepared.snapshot.parents];
  const parts = entry.path.split("/");
  for (let i = 0; i < parts.length && entry.path; i++) {
    const path = parts.slice(0, i).join("/");
    const parent = prepared.entries.get(path);
    if (parent?.type !== "directory") throw new Error("Missing cleanup parent evidence.");
    stamps.push({ path: join(prepared.snapshot.path, path), identity: parent.identity });
  }
  return stamps;
}

async function verifyEntry(prepared: PreparedSnapshot, entry: SnapshotEntry, checkpoint: () => Promise<void>, control?: OperationControl, phase: "verify-source" | "verify-backup" = "verify-source"): Promise<FileEvidence> {
  const path = join(prepared.snapshot.path, entry.path);
  const parents = entryParents(prepared, entry);
  await verifyParents(parents);
  const stat = await statAt(path);
  if (!stat || !equal(identity(stat), entry.identity))
    throw new Error(`Cleanup entry changed or replaced: ${path}`);
  if (entry.type === "file") {
    let completed = 0;
    // Small files report item progress; long hashes must expose byte progress,
    // not look stalled for the entire file. Chunk size is the same 1 MiB bound.
    const file = await hashRegular(path, checkpoint, Number(entry.size) > 1024 * 1024
      ? (n) => control?.onProgress?.({ phase, completed: completed += n, total: Number(entry.size), unit: "bytes" })
      : undefined);
    if (!stat.isFile() || file.size !== entry.size || file.sha256 !== entry.sha256 || !equal(file.evidence.stamp, fileStamp(stat)))
      throw new Error(`Cleanup file changed: ${path}`);
  } else if (entry.type === "symlink") {
    const metadata = await readSymlink(path, control);
    if (metadata.target !== entry.target || metadata.linkType !== entry.linkType)
      throw new Error(`Cleanup symlink changed: ${path}`);
  } else if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Cleanup directory changed: ${path}`);
  }
  const evidence = { path, parents, stamp: fileStamp(stat) };
  await verifyEvidence(evidence);
  return evidence;
}

/** No recursive removal or whole-tree rescans. Removed receipt entries are never revisited. */
export async function removeSnapshot(
  prepared: PreparedSnapshot,
  guard: ReturnType<typeof removalBatch>,
  control?: OperationControl,
): Promise<void> {
  const checkpoint = operationCheckpoint(control);
  const total = prepared.remaining.length;
  let completed = 0;
  control?.onProgress?.({ phase: "remove", completed, total, unit: "items" });
  for (const entry of [...prepared.remaining].reverse()) {
    await checkpoint();
    // Check stop/owner/evidence BEFORE reading a potentially long file, too.
    await guard.check();
    const source = await verifyEntry(prepared, entry, checkpoint, control);
    const backup = prepared.backup;
    const copy = backup ? await verifyEntry(backup, backup.entries.get(entry.path)!, checkpoint, control, "verify-backup") : undefined;
    if (entry.type === "directory" && (await readdir(source.path)).length)
      throw new Error(`Unknown cleanup directory contents: ${source.path}`);
    // A long hash may consume the entire window. Refresh, then recheck the
    // exact just-verified identities/content stamps and ancestors, not the tree.
    do {
      await guard.check();
      if (copy) await verifyEvidence(copy);
      await verifyEvidence(source);
      checkOperation(control);
    } while (!guard.current());
    if (entry.type === "directory") await rmdir(source.path);
    else await unlink(source.path);
    guard.removed();
    control?.onProgress?.({ phase: "remove", completed: ++completed, total, unit: "items" });
  }
  await verifyParents(prepared.snapshot.parents, true);
  if (await statAt(prepared.snapshot.path))
    throw new Error(`Cleanup directory remains: ${prepared.snapshot.path}`);
}

export async function verifyBackupSnapshots(
  path: string,
  snapshots: CleanupSnapshot[],
  control?: OperationControl,
): Promise<{ copies: PreparedSnapshot[]; manifest: FileEvidence }> {
  try {
    const progress = byteProgress(snapshots, "verify-backup", control);
    const manifest = await readEvidence(join(path, "verified.json"), control);
    if (!equal(JSON.parse(manifest.bytes.toString("utf8")), { schemaVersion: 1, snapshots }))
      throw new Error("manifest changed");
    const copies: PreparedSnapshot[] = [];
    for (const [i, snapshot] of snapshots.entries()) {
      const copy = await cleanupSnapshot(join(path, String(i)), control, progress);
      const contents = (s: CleanupSnapshot) => s.entries.map(({ identity: _identity, ...entry }) => entry);
      if (!equal(contents(copy), contents(snapshot))) throw new Error("copy changed");
      copies.push({ snapshot: copy, entries: new Map(copy.entries.map((e) => [e.path, e])), remaining: copy.entries });
    }
    return { copies, manifest: manifest.evidence };
  } catch (error) {
    checkOperation(control);
    throw new Error(`Cleanup backup verification failed: ${path}`, { cause: error });
  }
}
