// The fixed Windows metadata query uses the same contained process boundary.
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runProcess, runProcessSync } from "../src/process-runner.js";

const root = process.env.TMP_DIR!;
assert.ok(root, "Run via bash tests/run-offline.sh");
const invalid = await runProcess("windows-link-kind", [
  root,
  "arbitrary script",
]);
assert.equal(invalid.ok, false);
assert.match(invalid.stderr, /one valid path on Windows/);
console.log(
  "PASS: cleanup metadata operation rejects extra command arguments without spawning a shell",
);
if (process.platform === "win32") {
  const target = join(root, "external-target"),
    link = join(root, "link ' $(throw 'injection')");
  mkdirSync(target);
  writeFileSync(join(target, "keep.txt"), "external data");
  symlinkSync(target, link, "junction");
  const result = await runProcess("windows-link-kind", [link], {
    timeoutMs: 10_000,
  });
  assert.equal(result.ok, true, result.stderr);
  assert.equal(result.stdout.trim(), "junction");
  assert.equal(readFileSync(join(target, "keep.txt"), "utf8"), "external data");
  assert.equal((await runProcess("windows-link-kind", [target])).ok, false);
  assert.equal(
    runProcessSync("windows-link-kind", [link], { timeoutMs: 1 }).timedOut,
    true,
  );
  console.log(
    "PASS: contained Windows metadata query treats shell-looking paths literally, preserves targets and honors the supervisor deadline",
  );
} else {
  assert.equal((await runProcess("windows-link-kind", [root])).ok, false);
  console.log(
    "PASS: Windows-only cleanup metadata fails closed on non-Windows hosts",
  );
}
