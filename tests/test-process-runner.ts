import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runProcess,
  runProcessSync,
  type ProcessOptions,
  type ProcessResult,
} from "../src/process-runner.js";

const root = mkdtempSync(join(tmpdir(), "board-process-runner-"));
const home = join(root, "home");
mkdirSync(home);
const env: NodeJS.ProcessEnv = {
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: home,
  GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "0",
  GIT_CONFIG_PARAMETERS: undefined,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
  GH_TOKEN: undefined,
  GITHUB_TOKEN: undefined,
  GH_CONFIG_DIR: home,
};
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) process.exitCode = 1;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    // Linux may leave an orphan as a zombie until init reaps it. It cannot run.
    if (
      process.platform === "linux" &&
      /\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"))
    )
      return false;
    return true;
  } catch (error) {
    return !["ESRCH", "ENOENT"].includes(
      (error as NodeJS.ErrnoException).code ?? "",
    );
  }
};
const fixture = join(root, "tree.cjs");
writeFileSync(
  fixture,
  `
const {spawn} = require('node:child_process');
const {writeFileSync, appendFileSync} = require('node:fs');
const {join} = require('node:path');
const [dir, mode] = process.argv.slice(2);
process.on('SIGTERM', () => {});
// Safety net for a broken runner; assertions run well before this expiry.
setTimeout(() => process.exit(0), 12000);
if (mode === 'leaf') {
  writeFileSync(join(dir, 'leaf.pid'), String(process.pid));
  // Append: SIGKILL between truncate/write must not erase proof of liveness.
  const beat = () => appendFileSync(join(dir, 'heartbeat'), Date.now() + '\\n');
  beat(); setInterval(beat, 30);
  process.send('ready');
} else {
  writeFileSync(join(dir, 'parent.pid'), String(process.pid));
  // libuv puts non-detached Windows children in a kill-on-parent-exit job.
  // Detached Windows descendants model Git/SSH helpers that outlive the root;
  // on POSIX they must remain in the runner's process group.
  const leaf = spawn(process.execPath, [__filename, dir, 'leaf'], {stdio: ['ignore', 'inherit', 'inherit', 'ipc'], detached: process.platform === 'win32'});
  leaf.on('message', () => {
    writeFileSync(join(dir, 'ready'), 'yes');
    if (mode === 'orphan') process.exit(0);
  });
}
`,
);

try {
  for (const [label, run] of [
    ["async", runProcess],
    ["sync", runProcessSync],
  ] as const) {
    const node = (
      args: string[],
      options: ProcessOptions = {},
    ): ProcessResult | Promise<ProcessResult> =>
      run("node", args, { cwd: root, env, timeoutMs: 2_000, ...options });

    for (const mode of ["hanging-parent", "orphan"]) {
      const dir = join(root, `${label}-${mode}`);
      mkdirSync(dir);
      const started = Date.now();
      const result = await node([fixture, dir, mode], { timeoutMs: 2_000 });
      const elapsed = Date.now() - started;
      // A Windows job may finish early by killing the pipe holder on root exit.
      // That is valid only if the independent PID/heartbeat checks below agree.
      const bounded =
        elapsed < 5_000 &&
        ((result.timedOut && !result.ok) || (mode === "orphan" && result.ok));
      if (!bounded)
        console.log(
          `${label}/${mode}: ${JSON.stringify({ elapsed, ...result, stdout: result.stdout.slice(0, 500), stderr: result.stderr.slice(0, 500) })}`,
        );
      const ids = ["parent.pid", "leaf.pid"]
        .filter((name) => existsSync(join(dir, name)))
        .map((name) => Number(readFileSync(join(dir, name), "utf8")));
      try {
        check(
          existsSync(join(dir, "ready")) && ids.length === 2,
          `${label}/${mode}: child AND grandchild reached the deadline fixture`,
        );
        check(
          bounded,
          `${label}/${mode}: deadline returns promptly (including inherited pipes)`,
        );
        for (let i = 0; i < 20 && ids.some(alive); i++) await sleep(40);
        check(
          ids.length === 2 && ids.every((pid) => !alive(pid)),
          `${label}/${mode}: child AND grandchild are no longer running`,
        );
        const heartbeat = existsSync(join(dir, "heartbeat"))
          ? readFileSync(join(dir, "heartbeat"), "utf8")
          : undefined;
        await sleep(120);
        check(
          !!heartbeat &&
            readFileSync(join(dir, "heartbeat"), "utf8") === heartbeat,
          `${label}/${mode}: grandchild heartbeat actually stopped`,
        );
      } finally {
        for (const pid of ids)
          if (alive(pid))
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              /* already exited */
            }
      }
    }

    const settings = [
      "CI",
      "GIT_TERMINAL_PROMPT",
      "GCM_INTERACTIVE",
      "SSH_ASKPASS_REQUIRE",
      "GH_PROMPT_DISABLED",
      "GIT_ASKPASS",
      "SSH_ASKPASS",
      "GIT_SSH_COMMAND",
    ];
    const nonInteractive = await node(
      [
        "-e",
        `console.log(JSON.stringify(${JSON.stringify(settings)}.map(key => process.env[key])))`,
      ],
      {
        env: {
          ...env,
          CI: "false",
          GIT_TERMINAL_PROMPT: "1",
          GCM_INTERACTIVE: "Always",
          SSH_ASKPASS_REQUIRE: "force",
          GH_PROMPT_DISABLED: "0",
          GIT_ASKPASS: "unexpected-prompt",
          SSH_ASKPASS: "unexpected-prompt",
          GIT_SSH_COMMAND: "ssh -oBatchMode=no",
        },
      },
    );
    const values = nonInteractive.ok ? JSON.parse(nonInteractive.stdout) : [];
    check(
      JSON.stringify(values.slice(0, 5)) ===
        JSON.stringify(["true", "0", "Never", "never", "1"]) &&
        values[5] === "false" &&
        values[6] === "false" &&
        /^ssh -oBatchMode=yes -oStrictHostKeyChecking=yes$/.test(
          values[7] ?? "",
        ),
      `${label}: callers cannot re-enable Git/SSH/GH credential prompts`,
    );

    const output = await node([
      "-e",
      "process.stdout.write(Buffer.alloc(12 * 1024 * 1024, 120)); setInterval(() => {}, 1000);",
    ]);
    check(
      !output.ok &&
        Buffer.byteLength(output.stdout) <= 4 * 1024 * 1024 &&
        /output.*limit/i.test(output.stderr),
      `${label}: excessive output is bounded and fails, not silently truncated success`,
    );

    const unicode = "snow ☃ café 漢字";
    const bytes = await node([
      "-e",
      `const b = Buffer.from(${JSON.stringify(unicode)}); let i=0; const t=setInterval(()=>{process.stdout.write(b.subarray(i, ++i)); if(i===b.length) clearInterval(t)}, 2);`,
    ]);
    check(
      bytes.ok && bytes.stdout === unicode,
      `${label}: split UTF-8 output is preserved`,
    );
    const literal = "spaces ; $HOME & | ' \"";
    const echo = await node(
      [
        "-e",
        "process.stdin.pipe(process.stdout); process.stderr.write(process.argv[1]);",
        "--",
        literal,
      ],
      { input: "input\n" },
    );
    check(
      echo.ok && echo.stdout === "input\n" && echo.stderr === literal,
      `${label}: argv and stdin are not shell-interpreted`,
    );
    const specialArgs = [
      "",
      "two words",
      "C:\\trailing space\\",
      'backslash\\"quote',
      "%UNEXPANDED%",
      "$(no-shell)",
      "line\nbreak",
    ];
    const argv = await node([
      "-e",
      "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
      "--",
      ...specialArgs,
    ]);
    check(
      argv.ok && argv.stdout === JSON.stringify(specialArgs),
      `${label}: empty, quoted, backslash and newline argv round-trip exactly`,
    );
    const exit = await node([
      "-e",
      "process.stderr.write('expected failure'); process.exit(23)",
    ]);
    check(
      !exit.ok &&
        exit.status === 23 &&
        !exit.timedOut &&
        exit.stderr === "expected failure",
      `${label}: exit status and diagnostics survive`,
    );
    const missing = await node(["-e", ""], { cwd: join(root, "missing") });
    check(
      !missing.ok && !missing.timedOut && !!missing.stderr,
      `${label}: spawn errors are reported`,
    );
    // Untrusted JS/worker input cannot rely on TypeScript's command union.
    const unsupported = await run(
      "not-allowlisted" as Parameters<typeof run>[0],
      [],
    );
    check(
      !unsupported.ok && unsupported.stderr === "Unsupported process command",
      `${label}: runtime command allowlist rejects unsupported executables`,
    );
    for (const timeoutMs of [0, -1, NaN, Infinity]) {
      const invalid = await node(["-e", ""], { timeoutMs });
      check(
        !invalid.ok && /timeout/i.test(invalid.stderr),
        `${label}: invalid deadline ${timeoutMs} cannot disable the bound`,
      );
    }
    const closedInput = await node(["-e", "process.exit(0)"], {
      input: "x".repeat(4 * 1024 * 1024),
    });
    check(
      !closedInput.timedOut,
      `${label}: early stdin closure does not raise an unhandled EPIPE`,
    );
  }

  {
    const dir = join(root, "blocked-caller");
    mkdirSync(dir);
    const pending = runProcess("node", [fixture, dir, "hang"], {
      cwd: root,
      timeoutMs: 2_000,
      env,
    });
    for (let i = 0; i < 150 && !existsSync(join(dir, "ready")); i++)
      await sleep(10);
    const ready = existsSync(join(dir, "ready"));
    const ids = ["parent.pid", "leaf.pid"]
      .filter((name) => existsSync(join(dir, name)))
      .map((name) => Number(readFileSync(join(dir, name), "utf8")));
    // Production has sync Git callers. Blocking their event loop must not
    // prevent a concurrently running async Git/GH deadline from killing its tree.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3_500);
    const killedWhileBlocked =
      ids.length === 2 && ids.every((pid) => !alive(pid));
    const result = await pending;
    check(
      ready && result.timedOut && killedWhileBlocked,
      "async process tree deadline survives a blocked caller event loop",
    );
    for (const pid of ids)
      if (alive(pid))
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already exited */
        }
  }

  if (process.platform === "win32") {
    // The disposable lookup tree contains the real PowerShell bridge but no
    // taskkill. No OS files change. Override BOTH spellings in the child env:
    // Worker env keys are case-sensitive, unlike Windows process.env.
    const systemRoot = process.env.SystemRoot!;
    const fakeSystem = join(root, "missing-taskkill");
    mkdirSync(join(fakeSystem, "System32"), { recursive: true });
    symlinkSync(
      join(systemRoot, "System32", "WindowsPowerShell"),
      join(fakeSystem, "System32", "WindowsPowerShell"),
      "junction",
    );
    try {
      process.env.SystemRoot = fakeSystem;
      for (const [label, run] of [
        ["async", runProcess],
        ["sync", runProcessSync],
      ] as const) {
        const dir = join(root, `${label}-taskkill-error`);
        mkdirSync(dir);
        const result = await run("node", [fixture, dir, "hang"], {
          cwd: root,
          timeoutMs: 2_000,
          env: { ...env, SystemRoot: systemRoot, SYSTEMROOT: systemRoot },
        });
        const ids = ["parent.pid", "leaf.pid"]
          .filter((name) => existsSync(join(dir, name)))
          .map((name) => Number(readFileSync(join(dir, name), "utf8")));
        try {
          for (let i = 0; i < 20 && ids.some(alive); i++) await sleep(40);
          check(
            existsSync(join(dir, "ready")) &&
              result.timedOut &&
              /termination failed:.*ENOENT/i.test(result.stderr) &&
              ids.length === 2 &&
              ids.every((pid) => !alive(pid)),
            `${label}: taskkill spawn error is handled and job-owner fallback kills the tree`,
          );
        } finally {
          for (const pid of ids)
            if (alive(pid))
              try {
                process.kill(pid, "SIGKILL");
              } catch {
                /* already exited */
              }
        }
      }
    } finally {
      process.env.SystemRoot = systemRoot;
    }
  }

  // Actual Git credential plumbing, with no network or access to user config.
  const prompt = join(root, "prompt-used");
  const credential = await runProcess(
    "git",
    [
      "-c",
      "credential.helper=",
      "-c",
      `core.askPass=echo unexpected > '${prompt.replaceAll("\\", "/")}'`,
      "credential",
      "fill",
    ],
    {
      cwd: root,
      env,
      timeoutMs: 2_000,
      input: "protocol=https\nhost=offline.invalid\n\n",
    },
  );
  check(
    !credential.ok && !credential.timedOut && !existsSync(prompt),
    "Git credential lookup fails without invoking configured askpass or contacting a host",
  );
  assert.equal(process.exitCode ?? 0, 0, "process-runner regression(s) failed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
