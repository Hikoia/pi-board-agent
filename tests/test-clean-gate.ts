import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isClean } from "../src/git-helpers.js";

const root = mkdtempSync(join(tmpdir(), "board-clean-gate-"));
const home = join(root, "home");
const repo = join(root, "repo");
mkdirSync(home);
mkdirSync(repo);
const saved = { ...process.env };
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: home,
  GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "0",
});
for (const key of [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_CONFIG_PARAMETERS",
])
  delete process.env[key];
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) process.exitCode = 1;
};
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, stdio: "ignore", timeout: 5_000 });
const write = (path: string, text = "data\n") => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};

try {
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  write("source.ts", "export const value = 1;\n");
  // Tracked files in reserved directories must never disappear from the gate.
  write(".pi/board-agent/tracked.ts");
  write(".pi/worktrees/tracked.ts");
  write(".pi/board-agent.yml");
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-m", "base");
  check(isClean(repo), "clean gate accepts a clean checkout");

  write(".pi/board-agent/runtime.json", "{}");
  write(".pi/board-agent/workflows/run.json", "{}");
  write(".pi/worktrees/review/agent.log", "log");
  check(isClean(repo), "untracked agent runtime does not block the clean gate");

  for (const path of [
    "source.ts",
    ".pi/board-agent/tracked.ts",
    ".pi/worktrees/tracked.ts",
    ".pi/board-agent.yml",
  ]) {
    write(path, "changed\n");
    check(!isClean(repo), `tracked changes remain dirty: ${path}`);
    git("checkout", "--", path);
  }
  write(".pi/board-agent/new-tracked.ts");
  git("add", ".pi/board-agent/new-tracked.ts");
  check(!isClean(repo), "staged runtime-directory source is not excluded");
  git("reset", "--", ".pi/board-agent/new-tracked.ts");
  rmSync(join(repo, ".pi/board-agent/new-tracked.ts"));

  git("mv", "source.ts", ".pi/worktrees/renamed source.ts");
  check(!isClean(repo), "a rename into runtime directories remains dirty");
  git("reset", "--hard", "HEAD");

  for (const path of [
    "new source.ts",
    ".pi/settings.json",
    ".pi/board-agent.yml.local",
    ".pi/board-agent-extra/runtime.json",
    ".pi/worktrees-extra/user.txt",
  ]) {
    write(path);
    check(!isClean(repo), `untracked user/source paths remain dirty: ${path}`);
    rmSync(join(repo, path));
  }
  if (process.platform !== "win32") {
    write(".pi/board-agent\nuser-source.ts");
    check(
      !isClean(repo),
      "newline-containing user paths cannot spoof runtime paths",
    );
    rmSync(join(repo, ".pi/board-agent\nuser-source.ts"));
  }
  mkdirSync(join(repo, "subdir"));
  write("source.ts", "changed outside cwd\n");
  check(
    !isClean(join(repo, "subdir")),
    "a subdirectory cwd still checks the whole checkout",
  );
  git("checkout", "--", "source.ts");
  check(
    isClean(join(repo, "subdir")),
    "runtime exclusions are repository-root relative",
  );
  check(!isClean(home), "Git failures fail closed rather than reporting clean");
  assert.equal(process.exitCode ?? 0, 0, "clean-gate regression(s) failed");
} finally {
  for (const key of Object.keys(process.env))
    if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  rmSync(root, { recursive: true, force: true });
}
