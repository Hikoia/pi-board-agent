import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { ReviewInput } from "../src/review.js";

// Own all repositories, Git configuration, and Pi state, even when run directly.
const root = mkdtempSync(join(tmpdir(), "board-review-isolation-"));
const home = join(root, "home");
mkdirSync(home);
const savedEnv = { ...process.env };
const savedCwd = process.cwd();
for (const key of Object.keys(process.env)) {
  if (
    /^(GIT_|PI_|GH_|GITHUB_|SSH_)/i.test(key) ||
    /(?:API_KEY|TOKEN)$/.test(key)
  )
    delete process.env[key];
}
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: home,
  PI_CODING_AGENT_DIR: join(home, "agent"),
  GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "0",
  GIT_ALLOW_PROTOCOL: "file",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  }).trim();
const write = (cwd: string, path: string, text = "data\n") => {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), text);
};
const mainState = (cwd: string) => ({
  branch: git(cwd, "branch", "--show-current"),
  head: git(cwd, "rev-parse", "HEAD"),
  status: git(cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"),
  staged: git(cwd, "diff", "--cached", "--binary"),
  unstaged: git(cwd, "diff", "--binary"),
});
const registered = (cwd: string) =>
  git(cwd, "worktree", "list", "--porcelain", "-z")
    .split("\0")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => resolve(line.slice(9)).toLowerCase());
const pass = { result: { verdict: "pass", summary: "ok", findings: [] } };

try {
  // Dynamic import is intentional: never initialize the workflow package against
  // the developer's active Pi home. Every run below supplies a fake reviewer.
  process.chdir(root);
  const { runReview, parseReviewOutput } = await import("../src/review.js");
  assert.equal(
    parseReviewOutput({ verdict: "pass", summary: "ok", findings: [42] }),
    null,
  );
  assert.equal(
    parseReviewOutput({
      verdict: "fail",
      summary: "bug",
      findings: ["location", null],
    }),
    null,
  );
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  mkdirSync(seed);
  git(root, "init", "--bare", origin);
  git(seed, "init", "-b", "main");
  write(seed, "base.txt", "base\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "base");
  const baseSha = git(seed, "rev-parse", "HEAD");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "origin", "main");
  git(seed, "checkout", "-b", "task/issue-42");
  write(seed, "reviewed.txt", "review this exact content\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "task");
  git(seed, "push", "origin", "task/issue-42");
  const taskSha = git(seed, "rev-parse", "HEAD");
  let cases = 0;
  const test = async (
    label: string,
    body: (repo: string, input: ReviewInput) => Promise<void>,
  ) => {
    if (process.argv[2] && !label.includes(process.argv[2])) return;
    const repo = join(root, `repo-${++cases}`);
    git(root, "clone", "--branch", "main", origin, repo);
    const input: ReviewInput = {
      cwd: repo,
      taskKey: "T042",
      title: "Review",
      body: "acceptance",
      issueNumber: 42,
      baseBranch: "main",
      taskBranch: "task/issue-42",
      model: "never-called",
      timeoutMs: 5_000,
    };
    try {
      await body(repo, input);
      console.log(`PASS: ${label}`);
    } catch (error) {
      process.exitCode = 1;
      console.error(
        `FAIL: ${label}\n${error instanceof Error ? error.stack : error}`,
      );
    }
  };
  const cleaned = (repo: string, path?: string) => {
    if (path)
      assert.equal(existsSync(path), false, "review directory was removed");
    assert.deepEqual(
      registered(repo),
      [resolve(repo).toLowerCase()],
      "no review registration remains",
    );
    assert.equal(
      git(
        repo,
        "for-each-ref",
        "--format=%(refname)",
        "refs/board-agent/reviews/",
      ),
      "",
      "no private fetch refs remain",
    );
    const paths = git(
      repo,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    );
    assert.ok(
      !paths.includes(".pi/worktrees/review-"),
      "no partial setup files remain",
    );
  };

  await test("fresh SHA ignores stale origin cache, pins once, and ignores model-echoed SHA", async (repo, input) => {
    // Fetching by short branch name does NOT update a remote-tracking ref that
    // the configured refspec omits. A successful fetch is not proof of freshness.
    git(
      repo,
      "config",
      "remote.origin.fetch",
      "+refs/heads/main:refs/remotes/origin/main",
    );
    git(repo, "update-ref", "refs/remotes/origin/task/issue-42", baseSha);
    const before = mainState(repo);
    let path = "";
    const result = await runReview(input, async (source, options) => {
      path = options.cwd;
      assert.notEqual(resolve(path), resolve(repo));
      assert.equal(dirname(resolve(path)), resolve(repo, ".pi", "worktrees"));
      assert.equal(
        git(path, "rev-parse", "--show-toplevel").replace(/\\/g, "/"),
        path.replace(/\\/g, "/"),
      );
      assert.equal(git(path, "branch", "--show-current"), "");
      assert.equal(git(path, "rev-parse", "HEAD"), taskSha);
      assert.equal(
        readFileSync(join(path, "reviewed.txt"), "utf8"),
        "review this exact content\n",
      );
      assert.ok(source.includes(taskSha));
      assert.ok(
        !source.includes("isolation:"),
        "no upstream worktree fallback",
      );
      // Move both the remote and its shared cache after launch. Neither may
      // become the approved SHA, nor may an extra property returned by the model.
      git(origin, "update-ref", "refs/heads/task/issue-42", baseSha);
      git(repo, "update-ref", "refs/remotes/origin/task/issue-42", baseSha);
      write(path, "review-only.tmp", "dirty scratch output\n");
      return { result: { ...pass.result, taskSha: baseSha } };
    }).finally(() =>
      git(origin, "update-ref", "refs/heads/task/issue-42", taskSha),
    );
    assert.equal(result.taskSha, taskSha);
    assert.equal(result.verdict, "pass");
    assert.deepEqual(mainState(repo), before);
    assert.equal(existsSync(join(repo, "reviewed.txt")), false);
    cleaned(repo, path);
  });

  await test("unignored agent runtime is excluded but the rest of .pi is preserved", async (repo, input) => {
    write(repo, ".pi/board-agent/state.json", "before\n");
    write(repo, ".pi/settings.json", "user settings\n");
    const result = await runReview(input, async (_source, { cwd }) => {
      write(repo, ".pi/board-agent/state.json", "after\n");
      write(
        repo,
        ".pi/worktrees/other-runtime/log.json",
        "background builder\n",
      );
      write(cwd, "scratch.tmp");
      return pass;
    });
    assert.equal(result.taskSha, taskSha);
    assert.equal(git(repo, "branch", "--show-current"), "main");
    assert.equal(git(repo, "rev-parse", "HEAD"), baseSha);
    assert.equal(
      readFileSync(join(repo, ".pi/settings.json"), "utf8"),
      "user settings\n",
    );
    assert.equal(
      readFileSync(join(repo, ".pi/board-agent/state.json"), "utf8"),
      "after\n",
    );
    cleaned(repo);
  });

  for (const path of [
    "base.txt",
    "untracked.txt",
    ".pi/settings.json",
    ".pi/board-agent-extra/data.json",
    ".pi/worktrees-extra/data.json",
  ]) {
    await test(`same-porcelain dirty content changes fail closed: ${path}`, async (repo, input) => {
      write(repo, path, "before\n");
      let reviewPath = "";
      await assert.rejects(
        runReview(input, async (_source, { cwd }) => {
          reviewPath = cwd;
          const status = mainState(repo).status;
          write(repo, path, "after!\n");
          assert.equal(
            mainState(repo).status,
            status,
            "the status text is deliberately unchanged",
          );
          return pass;
        }),
        /Main checkout changed/,
      );
      assert.equal(
        readFileSync(join(repo, path), "utf8"),
        "after!\n",
        "do not revert unexpected user changes",
      );
      cleaned(repo, reviewPath);
    });
  }

  for (const path of [
    "base.txt",
    ".pi/board-agent/tracked.ts",
    ".pi/worktrees/tracked.ts",
  ]) {
    await test(`same-porcelain staged content is not excluded: ${path}`, async (repo, input) => {
      write(repo, path, "before\n");
      git(repo, "add", "--", path);
      await assert.rejects(
        runReview(input, async () => {
          const status = mainState(repo).status;
          write(repo, path, "after!\n");
          git(repo, "add", "--", path);
          assert.equal(mainState(repo).status, status);
          return pass;
        }),
        /Main checkout changed/,
      );
      cleaned(repo);
    });
  }

  await test("raw dirty bytes are checked even when Git normalizes them to the same diff", async (repo, input) => {
    git(repo, "config", "core.autocrlf", "true");
    write(repo, "base.txt", "dirty\n");
    await assert.rejects(
      runReview(input, async () => {
        const before = mainState(repo);
        write(repo, "base.txt", "dirty\r\n");
        assert.deepEqual(
          mainState(repo),
          before,
          "Git status AND diffs are deliberately unchanged",
        );
        return pass;
      }),
      /Main checkout changed/,
    );
    cleaned(repo);
  });

  for (const path of [".pi/board-agent/source.ts", ".pi/worktrees/source.ts"]) {
    await test(`tracked runtime-directory files are never excluded: ${path}`, async (repo, input) => {
      write(repo, path, "committed\n");
      git(repo, "add", path);
      git(repo, "commit", "-m", "tracked source inside runtime directory");
      write(repo, path, "before\n");
      await assert.rejects(
        runReview(input, async () => {
          const status = mainState(repo).status;
          write(repo, path, "after!\n");
          assert.equal(mainState(repo).status, status);
          return pass;
        }),
        /Main checkout changed/,
      );
      cleaned(repo);
    });
  }

  for (const switched of ["HEAD", "branch"]) {
    await test(`reviewer ${switched} switch invalidates PASS and is force-cleaned`, async (repo, input) => {
      const before = mainState(repo);
      let path = "";
      await assert.rejects(
        runReview(input, async (_source, { cwd }) => {
          path = cwd;
          if (switched === "HEAD") git(cwd, "checkout", "--detach", baseSha);
          else git(cwd, "checkout", "-b", "reviewer-switched-branch");
          return pass;
        }),
        /review worktree|review revision/i,
      );
      cleaned(repo, path);
      assert.deepEqual(mainState(repo), before);
    });
  }

  for (const switched of ["HEAD", "branch", "status"]) {
    await test(`main ${switched} changes are detected without destructive restoration`, async (repo, input) => {
      let path = "";
      await assert.rejects(
        runReview(input, async (_source, { cwd }) => {
          path = cwd;
          if (switched === "HEAD") git(repo, "reset", "--hard", taskSha);
          else if (switched === "branch")
            git(repo, "checkout", "-b", "human-branch");
          else write(repo, "new-user-file.txt");
          return pass;
        }),
        /Main checkout changed/,
      );
      cleaned(repo, path);
      if (switched === "HEAD")
        assert.equal(git(repo, "rev-parse", "HEAD"), taskSha);
      else if (switched === "branch")
        assert.equal(git(repo, "branch", "--show-current"), "human-branch");
      else assert.equal(existsSync(join(repo, "new-user-file.txt")), true);
    });
  }

  await test("dirty locked worktrees are removed on success without pruning unrelated registrations", async (repo, input) => {
    const unrelated = join(root, "unrelated-worktree");
    git(repo, "worktree", "add", "--detach", unrelated, baseSha);
    // An unrelated missing, unlocked registration must NOT be pruned by review.
    rmSync(unrelated, { recursive: true, force: true });
    let path = "";
    const result = await runReview(input, async (_source, { cwd }) => {
      path = cwd;
      write(cwd, "scratch.tmp");
      git(repo, "worktree", "lock", "--reason", "review scratch", cwd);
      return pass;
    });
    assert.equal(result.taskSha, taskSha);
    assert.equal(existsSync(path), false);
    assert.deepEqual(
      registered(repo).sort(),
      [repo, unrelated].map((p) => resolve(p).toLowerCase()).sort(),
    );
  });

  for (const result of ["throw", "invalid", "fail"]) {
    await test(`reviewer ${result} still removes dirty locked worktree`, async (repo, input) => {
      const before = mainState(repo);
      let path = "";
      const run = runReview(input, async (_source, { cwd }) => {
        path = cwd;
        write(cwd, "scratch.tmp");
        git(repo, "worktree", "lock", cwd);
        if (result === "throw") throw new Error("sentinel reviewer failure");
        if (result === "invalid") return { result: { verdict: "unknown" } };
        return {
          result: {
            verdict: "fail",
            summary: "bug",
            findings: ["base.txt: blocking bug"],
          },
        };
      });
      if (result === "fail") assert.equal((await run).verdict, "fail");
      else
        await assert.rejects(
          run,
          result === "throw" ? /sentinel reviewer failure/ : /invalid result/,
        );
      cleaned(repo, path);
      assert.deepEqual(mainState(repo), before);
    });
  }

  for (const lost of ["directory", "registration", "gitfile"]) {
    await test(`missing review ${lost} fails closed and cleans both directory and registration`, async (repo, input) => {
      let path = "";
      await assert.rejects(
        runReview(input, async (_source, { cwd }) => {
          path = cwd;
          if (lost === "directory") {
            git(repo, "worktree", "lock", cwd);
            rmSync(cwd, { recursive: true, force: true });
          } else if (lost === "registration") {
            const admin = resolve(git(cwd, "rev-parse", "--absolute-git-dir"));
            assert.ok(
              admin.startsWith(`${resolve(repo, ".git", "worktrees")}${sep}`),
            );
            rmSync(admin, { recursive: true, force: true });
          } else rmSync(join(cwd, ".git"));
          return pass;
        }),
        /review worktree|review revision|git .*failed/i,
      );
      cleaned(repo, path);
      assert.equal(git(repo, "branch", "--show-current"), "main");
      assert.equal(git(repo, "rev-parse", "HEAD"), baseSha);
    });
  }

  await test("fetch failure with a stale cached task never launches the agent", async (repo, input) => {
    git(repo, "update-ref", "refs/remotes/origin/task/missing", taskSha);
    const before = mainState(repo);
    let calls = 0;
    await assert.rejects(
      runReview({ ...input, taskBranch: "task/missing" }, async () => {
        calls++;
        return pass;
      }),
      /fetch/,
    );
    assert.equal(calls, 0);
    cleaned(repo);
    assert.deepEqual(mainState(repo), before);
  });

  await test("worktree setup hook failure cleans partial registration and prevents launch", async (repo, input) => {
    const hooks = join(root, "hooks");
    write(hooks, "post-checkout", "#!/bin/sh\nexit 23\n");
    chmodSync(join(hooks, "post-checkout"), 0o755);
    git(repo, "config", "core.hooksPath", hooks);
    const before = mainState(repo);
    let calls = 0;
    await assert.rejects(
      runReview(input, async () => {
        calls++;
        return pass;
      }),
      /worktree add/,
    );
    assert.equal(calls, 0);
    cleaned(repo);
    assert.deepEqual(mainState(repo), before);
  });

  await test("missing setup gitfile never falls back even if main is detached at the task SHA", async (repo, input) => {
    git(repo, "checkout", "--detach", taskSha);
    const hooks = join(root, "missing-gitfile-hooks");
    write(
      hooks,
      "post-checkout",
      '#!/bin/sh\ncase "$PWD" in\n  */.pi/worktrees/review-*) rm -f .git ;;\n  *) exit 91 ;;\nesac\n',
    );
    chmodSync(join(hooks, "post-checkout"), 0o755);
    git(repo, "config", "core.hooksPath", hooks);
    const before = mainState(repo);
    let calls = 0;
    await assert.rejects(
      runReview(input, async () => {
        calls++;
        return pass;
      }),
      /review worktree|worktree add/i,
    );
    assert.equal(calls, 0);
    cleaned(repo);
    assert.deepEqual(mainState(repo), before);
  });

  await test("invalid branch refspecs are rejected before fetch or agent launch", async (repo, input) => {
    const before = mainState(repo);
    let calls = 0;
    await assert.rejects(
      runReview({ ...input, taskBranch: "main:refs/heads/main" }, async () => {
        calls++;
        return pass;
      }),
      /check-ref-format|Invalid review branch/,
    );
    assert.equal(calls, 0);
    cleaned(repo);
    assert.deepEqual(mainState(repo), before);
  });

  await test("subdirectory input still uses a verified managed worktree under the repository root", async (repo, input) => {
    const subdir = join(repo, "subdir");
    mkdirSync(subdir);
    const before = mainState(repo);
    const result = await runReview(
      { ...input, cwd: subdir },
      async (_source, { cwd }) => {
        assert.equal(dirname(resolve(cwd)), resolve(repo, ".pi", "worktrees"));
        assert.equal(git(cwd, "rev-parse", "HEAD"), taskSha);
        return pass;
      },
    );
    assert.equal(result.taskSha, taskSha);
    cleaned(repo);
    assert.deepEqual(mainState(repo), before);
  });

  await test("symlinked managed directory prevents setup without touching its target", async (repo, input) => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    write(outside, "sentinel.txt", "preserve\n");
    mkdirSync(join(repo, ".pi"));
    symlinkSync(
      outside,
      join(repo, ".pi", "worktrees"),
      process.platform === "win32" ? "junction" : "dir",
    );
    let calls = 0;
    await assert.rejects(
      runReview(input, async () => {
        calls++;
        return pass;
      }),
      /unmanaged|symlink|managed directory/i,
    );
    assert.equal(calls, 0);
    assert.equal(
      readFileSync(join(outside, "sentinel.txt"), "utf8"),
      "preserve\n",
    );
    assert.deepEqual(registered(repo), [resolve(repo).toLowerCase()]);
  });

  await test("Git cleanup failure cannot return PASS and still checks the main checkout", async (repo, input) => {
    const configPath = join(repo, ".git", "config");
    const originalConfig = readFileSync(configPath, "utf8");
    let path = "";
    try {
      await assert.rejects(
        runReview(input, async (_source, { cwd }) => {
          path = cwd;
          write(cwd, "scratch.tmp");
          git(repo, "worktree", "lock", cwd);
          // A real Git registration/removal failure, not a mocked successful rm.
          writeFileSync(configPath, "[invalid configuration\n");
          return pass;
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /cleanup/i);
          assert.match(
            error.message,
            /main checkout/i,
            "cleanup errors must not skip the final main check",
          );
          return true;
        },
      );
      assert.equal(
        existsSync(path),
        false,
        "even failed Git cleanup attempts owned filesystem cleanup",
      );
    } finally {
      writeFileSync(configPath, originalConfig);
      // Deliberately broken Git may prevent unregistering. Test teardown is the
      // only place that repairs it; production must report this failure.
      if (path && registered(repo).includes(resolve(path).toLowerCase()))
        git(repo, "worktree", "remove", "--force", "--force", path);
      for (const ref of git(
        repo,
        "for-each-ref",
        "--format=%(refname)",
        "refs/board-agent/reviews/",
      )
        .split(/\r?\n/)
        .filter(Boolean))
        git(repo, "update-ref", "-d", ref);
    }
    cleaned(repo, path);
  });

  assert.ok(cases > 0, "test filter must select at least one case");
} finally {
  for (const key of Object.keys(process.env))
    if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  process.chdir(savedCwd);
  rmSync(root, { recursive: true, force: true });
}
