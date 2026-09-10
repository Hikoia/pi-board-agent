// Package-shape smoke only. Real clean-clone/pack/install verification is a
// release gate performed separately; this offline check installs nothing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
assert.ok(process.env.TMP_DIR && process.env.npm_config_cache?.startsWith(process.env.TMP_DIR),
  "Run via bash tests/run-offline.sh with disposable npm configuration/cache");
// Bash is the supported runner on both Linux and Git Bash; don't try to execute
// npm.cmd as an exe or interpolate a shell command containing an untrusted path.
const packed = spawnSync("bash", ["-c", "npm pack --dry-run --json --ignore-scripts --offline"], {
  cwd: fileURLToPath(root), env: process.env, encoding: "utf8", timeout: 60000,
});
assert.ifError(packed.error);
assert.equal(packed.status, 0, packed.stderr || packed.stdout);
const [report] = JSON.parse(packed.stdout);
assert.equal(report.name, "@mancioshell/pi-board-agent");
assert.equal(report.version, "0.2.0");
assert.deepEqual(report.bundled, []);
const files = new Set(report.files.map((file) => file.path));
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
for (const path of [
  "package.json", "config-template.yml", "README.md", "CHANGELOG.md", "LICENSE",
  "docs/architecture.md", "docs/runbook.md", "scripts/setup.sh", "scripts/verify-board-agent-fleet.mjs",
  "agents/board-agent-builder.md", "skills/board-agent/SKILL.md",
  ...pkg.pi.extensions.map((path) => path.replace(/^\.\//, "")),
  ...pkg.pi.skills.map((path) => `${path.replace(/^\.\//, "")}/SKILL.md`),
  ...readdirSync(new URL("src", root)).filter((name) => name.endsWith(".ts")).map((name) => `src/${name}`),
]) assert.ok(files.has(path), `missing packaged resource: ${path}`);
console.log("PASS: npm dry-run includes the extension, all source modules, skill, agent, config template, release docs, and operator scripts");

for (const path of files) {
  assert.ok(!/^(?:node_modules|tests|\.pi|\.git|\.github)(?:\/|$)/.test(path), `unexpected runtime/development payload: ${path}`);
  assert.ok(!/(?:^|\/)(?:\.env(?:\..*)?|Dockerfile|docker-compose\.yml|entrypoint\.sh|\.dockerignore)$/.test(path), `unexpected removed/private artifact: ${path}`);
  assert.ok(!["src/inflight.ts", "docs/docker.md", "docs/implementation-plan.md", "docs/overengineering-audit.md"].includes(path), `unexpected legacy/user-owned file: ${path}`);
}
assert.equal(pkg.private, true, "Git-only release must stay private");
assert.ok(!("bundledDependencies" in pkg) && !("bundleDependencies" in pkg));
assert.ok(pkg.dependencies["@quintinshaw/pi-dynamic-workflows"] && pkg.dependencies.yaml, "runtime dependencies must be installed, not removed with bundle metadata");
console.log("PASS: Git-only package excludes dependencies, tests, runtime state, secrets, removed artifacts, and the user-owned audit document");
