import assert from "node:assert/strict";
import {
  ProcessTimeoutError,
  processFailure,
  runProcess,
  type ProcessResult,
} from "../src/process-runner.js";

const result = await runProcess("node", [
  "-e",
  "process.stdout.write('CONFLICT (content): Merge conflict in shared.txt\\n', () => process.exit(1))",
]);
assert.equal(result.ok, false);
assert.equal(result.status, 1);
assert.equal(result.timedOut, false);
assert.equal(result.stderr, "");
assert.match(
  processFailure("git", ["merge-tree", "--write-tree"], result).message,
  /CONFLICT \(content\): Merge conflict in shared\.txt/,
);
console.log("PASS: processFailure preserves useful stdout-only failure diagnostics");

for (const [label, stderr, stdout, args] of [
  ["both streams", "ERR: permission detail", "OUT: conflict detail", []],
  ["long stderr", "ERR:" + "e".repeat(20_000), "OUT: useful stdout", []],
  ["long stdout", "ERR: useful stderr", "OUT:" + "o".repeat(20_000), []],
  ["both long UTF-8 streams", "ERR:" + "漢😀".repeat(4_000), "OUT:" + "é☃".repeat(4_000), []],
  ["long arguments", "ERR: useful stderr", "OUT: useful stdout", ["x".repeat(20_000)]],
] as const) {
  const failed: ProcessResult = { ok: false, status: 1, timedOut: false, stderr, stdout };
  const before = structuredClone(failed);
  const message = processFailure("git", [...args], failed).message;
  assert.match(message, /ERR:/, `${label}: retains stderr`);
  assert.match(message, /OUT:/, `${label}: retains stdout even when stderr is present`);
  assert.ok(Buffer.byteLength(message, "utf8") <= 8 * 1024, `${label}: entire diagnostic fits 8 KiB`);
  assert.ok(!message.includes("\ufffd"), `${label}: truncation does not split UTF-8 characters`);
  assert.deepEqual(failed, before, "formatting must not alter the process result");
  console.log(`PASS: ${label} keeps both diagnostic streams within a fixed total 8 KiB`);
}

const timed = processFailure("git", ["fetch", "origin"], {
  ok: false, status: 1, timedOut: true,
  stderr: "ERR: process tree termination detail " + "e".repeat(20_000),
  stdout: "OUT: partial output " + "o".repeat(20_000),
}, 1234);
assert.ok(timed instanceof ProcessTimeoutError);
assert.equal(timed.name, "ProcessTimeoutError");
assert.equal(timed.command, "git fetch origin");
assert.equal(timed.timeoutMs, 1234);
assert.match(timed.message, /timed out after 1234 ms/);
assert.match(timed.message, /ERR: process tree termination detail/);
assert.match(timed.message, /OUT: partial output/);
assert.ok(Buffer.byteLength(timed.message) <= 8 * 1024);
console.log("PASS: timeout type and metadata survive with bounded partial-output and containment diagnostics");

const tail = processFailure("git", ["merge-tree", "--write-tree"], {
  ok: false, status: 1, timedOut: false,
  stderr: "ERR-START\n" + "warnings\n".repeat(2_000) + "ERR-END: object write failed",
  stdout: "OUT-START\n" + "100644 file stage\n".repeat(2_000) + "OUT-END: CONFLICT (content): Merge conflict in final.txt",
}).message;
for (const marker of ["ERR-START", "ERR-END", "OUT-START", "OUT-END"])
  assert.ok(tail.includes(marker), `${marker}: long diagnostics keep useful beginning AND final error detail`);
assert.ok(Buffer.byteLength(tail) <= 8 * 1024);
assert.match(tail, /\[truncated\]/);
console.log("PASS: large merge-tree stage listings do not hide final conflict diagnostics from either stream");

for (const status of [1, null]) {
  const empty = processFailure("git", ["fetch"], {
    ok: false, status, timedOut: false, stdout: " \n", stderr: " \n",
  });
  assert.equal(empty.message, `git fetch failed: exit ${status ?? "unknown"}`);
}
console.log("PASS: empty diagnostics retain the exit-status fallback");
