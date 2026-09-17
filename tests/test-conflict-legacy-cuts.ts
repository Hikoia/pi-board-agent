import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { link, unlink } from "node:fs/promises";
import { join } from "node:path";
let fault: (operation: string, edge: string, path: string) => void = () => {};
const globals = globalThis as any;
globals.__legacyLink = async (from: string, to: string) => {
  fault("archive", "before", to);
  await link(from, to);
  fault("archive", "after", to);
};
globals.__legacyUnlink = async (path: string) => {
  fault("unlink", "before", path);
  await unlink(path);
  fault("unlink", "after", path);
};
globals.__legacyRename = (from: string, to: string) => {
  const value = JSON.parse(readFileSync(from, "utf8"));
  const clear = to.includes("ticket-worktrees") && !value.finalization;
  if (clear) fault("clear", "before", to);
  renameSync(from, to);
  if (clear) fault("clear", "after", to);
};
const urls = [
  new URL("../src/ticket-worktree.ts", import.meta.url).href,
  new URL("../src/cleanup-snapshot.ts", import.meta.url).href,
];
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (urls.includes(context.parentURL!)) {
      if (specifier === "node:fs")
        return {
          url: `data:text/javascript,${encodeURIComponent(`export * from 'node:fs'; export const renameSync = (...args) => globalThis.__legacyRename(...args);`)}`,
          shortCircuit: true,
        };
      if (specifier === "node:fs/promises")
        return {
          url: `data:text/javascript,${encodeURIComponent(`export * from 'node:fs/promises'; export const link = (...args) => globalThis.__legacyLink(...args); export const unlink = (...args) => globalThis.__legacyUnlink(...args);`)}`,
          shortCircuit: true,
        };
    }
    return next(specifier, context);
  },
});
const { fixture, git } = await import("./conflict-handoff-fixture.js");
try {
  for (const operation of ["archive", "clear"])
    for (const edge of ["before", "after"] as const) {
      const f = await fixture();
      let cut = false;
      f.store.update(f.card.itemId, (r) => ({
        ...r,
        finalization: {
          targetBranch: "main",
          baseSha: f.baseSha,
          taskSha: f.taskSha,
        },
      }));
      const file = join(
          f.repo,
          ".pi/board-agent/ticket-worktrees",
          `${f.card.itemId.toLowerCase()}.json`,
        ),
        bytes = readFileSync(file);
      fault = (op, when, path) => {
        if (
          !cut &&
          op === operation &&
          when === edge &&
          (operation === "clear" || path.includes("repair-intent-backups"))
        ) {
          cut = true;
          throw new Error(`offline ${edge} ${operation}`);
        }
      };
      try {
        await f.loop.tickNow();
        assert.ok(cut);
        assert.equal(f.comments.length, 0);
        if (operation !== "clear" || edge !== "after")
          assert.deepEqual(
            readFileSync(file),
            bytes,
            "source remains until verified atomic clear",
          );
        await f.loop.stop();
        fault = () => {};
        const next = f.make();
        try {
          await next.loop.tickNow();
          assert.equal(
            f.card.status,
            f.cfg.columns.ready,
            f.notices.join("\n"),
          );
          assert.equal(f.card.closed, false);
          assert.equal(f.store.read(f.card.itemId)?.finalization, undefined);
          const dir = join(f.repo, ".pi/board-agent/repair-intent-backups");
          const archives = readdirSync(dir).filter((n) => n.endsWith(".json"));
          assert.equal(archives.length, 1);
          assert.deepEqual(readFileSync(join(dir, archives[0])), bytes);
          assert.equal(
            f.events.filter((e) => e === "request-comment").length,
            1,
          );
          assert.equal(f.calls(), 0);
          assert.equal(
            git(f.origin, "rev-parse", "refs/heads/main"),
            f.baseSha,
          );
          console.log(
            `PASS: legacy ${edge} ${operation} fault/restart retains exact durable archive, checked-clears only proven pre-push, and creates one request`,
          );
        } finally {
          await next.loop.stop();
        }
      } finally {
        fault = () => {};
        await f.loop.stop();
      }
    }
  for (const mutation of ["archive", "source", "human"]) {
    const f = await fixture();
    let changed = false;
    f.store.update(f.card.itemId, (r) => ({
      ...r,
      finalization: {
        targetBranch: "main",
        baseSha: f.baseSha,
        taskSha: f.taskSha,
      },
    }));
    fault = (op, edge, path) => {
      if (
        !changed &&
        op === "archive" &&
        edge === "after" &&
        path.includes("repair-intent-backups")
      ) {
        changed = true;
        if (mutation === "archive") writeFileSync(path, "corrupt backup");
        if (mutation === "source")
          f.store.update(f.card.itemId, (r) => ({
            ...r,
            lastRunId: "changed",
          }));
        if (mutation === "human") f.card.assignees = ["maintainer"];
      }
    };
    try {
      await f.loop.tickNow();
      assert.ok(changed);
      assert.ok(f.store.read(f.card.itemId)?.finalization);
      assert.equal(f.events.length, 0);
      assert.equal(f.calls(), 0);
      assert.equal(git(f.origin, "rev-parse", "refs/heads/main"), f.baseSha);
      console.log(
        `PASS: legacy ${mutation} mutation after archival prevents clearing/requesting and preserves intent`,
      );
    } finally {
      fault = () => {};
      await f.loop.stop();
    }
  }
  {
    const f = await fixture(false);
    let cut = false;
    fault = (op, edge, path) => {
      if (
        !cut &&
        op === "unlink" &&
        edge === "before" &&
        /[\\/]cleanup[\\/][^\\/]+\.json$/.test(path)
      ) {
        cut = true;
        throw new Error("receipt deletion interrupted");
      }
    };
    try {
      await f.loop.tickNow();
      assert.ok(cut);
      assert.equal(f.store.hasCleanupReceipt(f.card.itemId), true);
      const pushed = git(f.origin, "rev-parse", "refs/heads/main");
      await f.loop.stop();
      fault = () => {};
      const next = f.make();
      try {
        await next.loop.tickNow();
        await next.loop.tickNow();
        assert.equal(f.store.hasCleanupReceipt(f.card.itemId), false);
        assert.equal(git(f.origin, "rev-parse", "refs/heads/main"), pushed);
        assert.equal(f.calls(), 0);
        assert.deepEqual(f.events, [`status:${f.cfg.columns.backlog}`]);
        assert.equal(f.card.closed, true);
        console.log(
          "PASS: already-pushed cleanup receipt survives no-local-ref restart and finishes T12 cleanup ONLY, never requests or launches repair",
        );
      } finally {
        await next.loop.stop();
      }
    } finally {
      fault = () => {};
      await f.loop.stop();
    }
  }
} finally {
  hooks.deregister();
  delete globals.__legacyLink;
  delete globals.__legacyRename;
  delete globals.__legacyUnlink;
}
