// Filesystem evidence for cleanup, deliberately independent of Git and v3 records.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  readlink,
  symlink,
  mkdir,
  link,
  unlink,
  rmdir,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { processFailure, runProcess } from "./process-runner.js";

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
const digest = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
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

/** Open non-following, compare the handle to lstat, then recheck after the read. */
export async function readRegular(path: string): Promise<Buffer> {
  const parents = await directoryStamps(path);
  const before = await statAt(path);
  if (!before?.isFile() || before.isSymbolicLink())
    throw new Error(`Not a regular cleanup file: ${path}`);
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (!equal(identity(before), identity(opened)))
      throw new Error(`Cleanup file replaced: ${path}`);
    const bytes = await handle.readFile();
    const after = await statAt(path);
    if (
      !after?.isFile() ||
      !equal(identity(before), identity(after)) ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error(`Cleanup file changed: ${path}`);
    await verifyParents(parents);
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Read link metadata, not the target. Windows needs a creation kind that lstat omits. */
export async function readSymlink(
  path: string,
): Promise<{ target: string; linkType: "file" | "dir" | "junction" }> {
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
  return { target, linkType };
}

/** Full async traversal, including ignored files and empty directories; never follows links. */
export async function cleanupSnapshot(path: string): Promise<CleanupSnapshot> {
  const parents = await directoryStamps(path);
  const entries: SnapshotEntry[] = [];
  async function visit(rel: string): Promise<void> {
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
      const metadata = await readSymlink(target);
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
      const bytes = await readRegular(target);
      const after = await statAt(target);
      if (
        !after ||
        !equal(identity(stat), identity(after)) ||
        stat.size !== BigInt(bytes.length)
      )
        throw new Error(`Cleanup file changed: ${target}`);
      entries.push({
        path: rel,
        identity: identity(stat),
        type: "file",
        size: String(bytes.length),
        sha256: digest(bytes),
      });
    } else throw new Error(`Special cleanup file: ${target}`);
  }
  await visit("");
  await verifyParents(parents);
  return { path, parents, entries };
}

export async function verifySnapshot(
  expected: CleanupSnapshot,
  partial = true,
): Promise<void> {
  await verifyParents(expected.parents, partial);
  const actual = await cleanupSnapshot(expected.path);
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

/** No recursive removal: every surviving entry and every ancestor is checked again. */
export async function removeSnapshot(
  snapshot: CleanupSnapshot,
  guard: () => Promise<void>,
): Promise<void> {
  await guard();
  for (const entry of [...snapshot.entries].reverse()) {
    const path = join(snapshot.path, entry.path);
    if (!(await statAt(path))) continue;
    await guard();
    // ponytail: full rechecks are O(n²); favor conservative cleanup over a second mutable journal.
    await verifySnapshot(snapshot);
    if (entry.type === "directory") await rmdir(path);
    else await unlink(path);
  }
  if (await statAt(snapshot.path))
    throw new Error(`Cleanup directory remains: ${snapshot.path}`);
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

export async function verifyBackupSnapshots(
  path: string,
  snapshots: CleanupSnapshot[],
): Promise<void> {
  try {
    const manifest = JSON.parse(
      (await readRegular(join(path, "verified.json"))).toString("utf8"),
    );
    if (!equal(manifest, { schemaVersion: 1, snapshots }))
      throw new Error("manifest changed");
    for (const [i, snapshot] of snapshots.entries()) {
      const copy = await cleanupSnapshot(join(path, String(i)));
      const contents = (s: CleanupSnapshot) =>
        s.entries.map(({ identity: _identity, ...entry }) => entry);
      if (!equal(contents(copy), contents(snapshot)))
        throw new Error("copy changed");
    }
  } catch (error) {
    throw new Error(`Cleanup backup verification failed: ${path}`, {
      cause: error,
    });
  }
}
