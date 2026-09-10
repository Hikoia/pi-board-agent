import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { join } from "node:path";
import {
  MessageChannel,
  receiveMessageOnPort,
  Worker,
  isMainThread,
  workerData,
} from "node:worker_threads";

export const GIT_GH_TIMEOUT_MS = 120_000;
export const TELEGRAM_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const CLEANUP_TIMEOUT_MS = 2_000;

export interface ProcessResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export class ProcessTimeoutError extends Error {
  readonly command: string;
  readonly timeoutMs: number;

  constructor(command: string, timeoutMs: number) {
    super(`${command} timed out after ${timeoutMs} ms`);
    this.name = "ProcessTimeoutError";
    this.command = command;
    this.timeoutMs = timeoutMs;
  }
}

export type ProcessCommand = "git" | "gh" | "node";

export interface ProcessOptions {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

const nonInteractiveEnv = (env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...process.env,
  ...env,
  // These are policy, not caller-overridable defaults. Git's askpass precedes
  // GIT_TERMINAL_PROMPT, and OpenSSH uses the FIRST value of each -o option.
  CI: "true",
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "Never",
  GCM_GUI_PROMPT: "0",
  GIT_ASKPASS: "false",
  SSH_ASKPASS: "false",
  SSH_ASKPASS_REQUIRE: "never",
  GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oStrictHostKeyChecking=yes",
  GIT_SSH_VARIANT: "ssh",
  GH_PROMPT_DISABLED: "1",
  GIT_PAGER: "cat",
  GH_PAGER: "cat",
});

const failure = (stderr: string, timedOut = false): ProcessResult => ({
  ok: false,
  status: null,
  stdout: "",
  stderr,
  timedOut,
});

function deadline(options: ProcessOptions): number | undefined {
  const ms = options.timeoutMs ?? GIT_GH_TIMEOUT_MS;
  return Number.isSafeInteger(ms) && ms > 0
    ? Math.min(ms, GIT_GH_TIMEOUT_MS)
    : undefined;
}

const invalidDeadline = () =>
  failure("timeoutMs must be a positive finite integer");
// Worker environments are case-sensitive even on Windows.
const windowsRoot = () =>
  process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
const taskkill = () => join(windowsRoot(), "System32", "taskkill.exe");

function killGroup(pid: number): string {
  try {
    process.kill(-pid, "SIGKILL");
    return "";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH"
      ? ""
      : `Process group termination failed: ${(error as Error).message}`;
  }
}

/** taskkill itself is bounded, has no inherited pipes, and handles spawn errors. */
function terminateTree(pid: number): Promise<string> {
  if (process.platform !== "win32") return Promise.resolve(killGroup(pid));
  return new Promise((resolve) => {
    const killer = spawn(taskkill(), ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      shell: false,
      windowsHide: true,
      timeout: CLEANUP_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    killer.on("error", (error) =>
      resolve(`Process tree termination failed: ${error.message}`),
    );
    killer.on("close", (code) =>
      resolve(
        code === 0
          ? ""
          : `Process tree termination failed: taskkill exit ${code}`,
      ),
    );
  });
}

// taskkill /T loses descendants when an intermediate parent exits. A Windows
// job retains them instead. Create suspended -> assign -> resume closes the
// spawn race; no breakaway is allowed, and closing the job kills ALL members.
// PowerShell is an OS-provided native API bridge, not a shell for user arguments.
// Its own lifetime (including Add-Type) is bounded by the outer supervisor.
const WINDOWS_JOB = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class BoardAgentJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup {
    public uint Size;
    public string Reserved, Desktop, Title;
    public uint X, Y, Width, Height, CharsX, CharsY, Fill, Flags;
    public ushort Show, ReservedSize;
    public IntPtr ReservedBytes, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr Process, Thread;
    public uint ProcessId, ThreadId;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attr, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app, StringBuilder line, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  public static int Run(string file, string line) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception();
    ProcessInfo process = new ProcessInfo();
    try {
      Limits limits = new Limits();
      limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) throw new Win32Exception();
      Startup startup = new Startup();
      startup.Size = (uint)Marshal.SizeOf(startup);
      startup.Flags = 0x100; // STARTF_USESTDHANDLES
      startup.Input = GetStdHandle(-10); startup.Output = GetStdHandle(-11); startup.Error = GetStdHandle(-12);
      if (!CreateProcess(file, new StringBuilder(line), IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, null, ref startup, out process)) throw new Win32Exception();
      if (!AssignProcessToJobObject(job, process.Process)) throw new Win32Exception();
      if (ResumeThread(process.Thread) == UInt32.MaxValue) throw new Win32Exception();
      if (WaitForSingleObject(process.Process, UInt32.MaxValue) != 0) throw new Win32Exception();
      uint code;
      if (!GetExitCodeProcess(process.Process, out code)) throw new Win32Exception();
      return unchecked((int)code);
    } finally {
      // Also covers a suspended process when assignment/resume fails.
      if (process.Process != IntPtr.Zero) { TerminateProcess(process.Process, 1); CloseHandle(process.Process); }
      if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
      CloseHandle(job);
    }
  }
}
'@
  $command = $env:BOARD_AGENT_PROCESS_COMMAND | ConvertFrom-Json
  [Environment]::SetEnvironmentVariable('BOARD_AGENT_PROCESS_COMMAND', $null, 'Process')
  $file = (Get-Command -Name $command.file -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  exit [BoardAgentJob]::Run($file, $command.line)
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;
const WINDOWS_JOB_ENCODED = Buffer.from(WINDOWS_JOB, "utf16le").toString(
  "base64",
);
// Microsoft CRT argv quoting, NOT PowerShell syntax.
const windowsArg = (arg: string) =>
  `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/g, "$&$&")}"`;

function execute(
  command: ProcessCommand,
  args: string[],
  options: ProcessOptions,
  onSpawn?: (pid: number) => void,
): Promise<ProcessResult> {
  const timeoutMs = deadline(options);
  if (timeoutMs === undefined) return Promise.resolve(invalidDeadline());
  if (command !== "git" && command !== "gh" && command !== "node")
    return Promise.resolve(failure("Unsupported process command"));
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      const file = command === "node" ? process.execPath : command;
      if (process.platform === "win32") {
        child = spawn(
          join(
            windowsRoot(),
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
          ),
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            WINDOWS_JOB_ENCODED,
          ],
          {
            cwd: options.cwd,
            env: {
              ...nonInteractiveEnv(options.env),
              BOARD_AGENT_PROCESS_COMMAND: JSON.stringify({
                file,
                line: [file, ...args].map(windowsArg).join(" "),
              }),
            },
            stdio: "pipe",
            shell: false,
            windowsHide: true,
          },
        );
      } else {
        const spawnOptions = {
          cwd: options.cwd,
          env: nonInteractiveEnv(options.env),
          stdio: "pipe" as const,
          shell: false,
          detached: true,
        };
        child =
          command === "git"
            ? spawn("git", args, spawnOptions)
            : command === "gh"
              ? spawn("gh", args, spawnOptions)
              : spawn(process.execPath, args, spawnOptions);
      }
    } catch (error) {
      resolve(failure((error as Error).message));
      return;
    }
    if (child.pid) onSpawn?.(child.pid);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    let stopping = false;
    let finished = false;
    let error = "";
    let status: number | null = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        ok: !timedOut && !error && status === 0,
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: [Buffer.concat(stderr).toString("utf8"), error]
          .filter(Boolean)
          .join("\n"),
        timedOut,
      });
    };
    const stop = async () => {
      if (stopping || finished) return;
      stopping = true;
      clearTimeout(timer);
      if (child.pid) {
        const cleanupError = await terminateTree(child.pid);
        if (cleanupError) {
          error = [error, cleanupError].filter(Boolean).join("\n");
          child.kill("SIGKILL");
        }
      }
      // Do not wait for 'close': a descendant may retain/escape inherited pipes.
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      finish();
    };
    const capture = (chunks: Buffer[], chunk: Buffer) => {
      if (stopping || finished) return;
      const keep = Math.min(chunk.length, MAX_OUTPUT_BYTES - bytes);
      if (keep) chunks.push(chunk.subarray(0, keep));
      bytes += keep;
      if (keep < chunk.length) {
        error = `Process output exceeded the ${MAX_OUTPUT_BYTES} byte limit`;
        void stop();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.on("error", (cause) => {
      error = cause.message;
    });
    child.on("close", (code) => {
      status = code;
      if (!stopping) finish();
    });
    // A command may legitimately exit without consuming all its input. Both
    // EPIPE (POSIX) and EOF (Windows) must be handled, not emitted uncaught.
    child.stdin.on("error", () => {});
    for (const stream of [child.stdout, child.stderr])
      stream.on("error", (cause) => {
        error = cause.message;
        void stop();
      });
    const timer = setTimeout(() => {
      timedOut = true;
      void stop();
    }, timeoutMs);
    child.stdin.end(options.input);
  });
}

function startSupervisor(
  command: ProcessCommand,
  args: string[],
  options: ProcessOptions,
  timeoutMs: number,
) {
  const state = new Int32Array(new SharedArrayBuffer(8)); // ready, process-group/root pid
  const { port1, port2 } = new MessageChannel();
  try {
    const worker = new Worker(new URL(import.meta.url), {
      execArgv: [
        "--experimental-strip-types",
        "--disable-warning=ExperimentalWarning",
      ],
      workerData: {
        boardAgentProcessRunner: true,
        command,
        args,
        options,
        deadline: Date.now() + timeoutMs,
        state,
        port: port2,
      },
      transferList: [port2],
    });
    // The synchronous caller cannot dispatch this event while in Atomics.wait.
    worker.on("error", () => {});
    return { state, port: port1, worker };
  } catch (error) {
    port1.close();
    port2.close();
    throw error;
  }
}

export function runProcess(
  command: ProcessCommand,
  args: string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  const timeoutMs = deadline(options);
  if (timeoutMs === undefined) return Promise.resolve(invalidDeadline());
  return new Promise<ProcessResult>((resolve) => {
    const { worker, state, port } = startSupervisor(
      command,
      args,
      options,
      timeoutMs,
    );
    let finished = false;
    let failing = false;
    const finish = (result: ProcessResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      port.close();
      void worker.terminate().catch(() => {});
      resolve(result);
    };
    const failed = async (result: ProcessResult) => {
      if (finished || failing) return;
      failing = true;
      const pid = Atomics.load(state, 1);
      if (pid) {
        const error = await terminateTree(pid);
        if (error) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* already exited */
          }
          result.stderr += `\n${error}`;
        }
      }
      finish(result);
    };
    port.once("message", (result: ProcessResult) => {
      if (!failing) finish(result);
    });
    worker.once("error", (error) => {
      void failed(failure(String(error)));
    });
    worker.once("exit", () => {
      // A successfully posted result may be waiting in MessagePort's queue.
      if (Atomics.load(state, 0) !== 1)
        void failed(failure("Process supervisor exited without a result"));
    });
    const timer = setTimeout(
      () => {
        void failed(
          failure("Process supervisor exceeded its cleanup deadline", true),
        );
      },
      timeoutMs + CLEANUP_TIMEOUT_MS + 3_000,
    );
  }).catch((error) => failure(String(error)));
}

/**
 * The same async supervisor runs on an independent event loop while this caller
 * blocks. spawnSync's timeout kills only its direct child on POSIX and can wait
 * forever on inherited pipes; killing the tree AFTER it returns is too late.
 * Node >=22.19 loads this erasable-TypeScript worker without a loader dependency.
 */
export function runProcessSync(
  command: ProcessCommand,
  args: string[],
  options: ProcessOptions = {},
): ProcessResult {
  const timeoutMs = deadline(options);
  if (timeoutMs === undefined) return invalidDeadline();
  let supervisor: ReturnType<typeof startSupervisor> | undefined;
  try {
    supervisor = startSupervisor(command, args, options, timeoutMs);
    const { state, port } = supervisor;
    Atomics.wait(state, 0, 0, timeoutMs + CLEANUP_TIMEOUT_MS + 3_000);
    if (Atomics.load(state, 0) === 1) {
      return receiveMessageOnPort(port)!.message as ProcessResult;
    }
    // A worker startup/crash must not leave this synchronous caller blocked or
    // a known tree running. This fallback uses no piped stdio and a hard kill.
    const pid = Atomics.load(state, 1);
    if (pid) {
      if (process.platform === "win32") {
        const killed = spawnSync(
          taskkill(),
          ["/pid", String(pid), "/T", "/F"],
          {
            stdio: "ignore",
            shell: false,
            windowsHide: true,
            timeout: CLEANUP_TIMEOUT_MS,
            killSignal: "SIGKILL",
          },
        );
        if (killed.error || killed.status !== 0) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* already exited */
          }
        }
      } else killGroup(pid);
    }
    return failure("Process supervisor exceeded its cleanup deadline", true);
  } catch (error) {
    return failure((error as Error).message);
  } finally {
    supervisor?.port.close();
    if (supervisor) void supervisor.worker.terminate().catch(() => {});
  }
}

// Internal worker entry point; ordinary imports (including imports in unrelated
// workers) have no side effects. MessagePort transports the bounded result;
// Atomics lets the sync caller receive it without running its own event loop.
if (!isMainThread && workerData?.boardAgentProcessRunner === true) {
  const { command, args, options, deadline: end, state, port } = workerData;
  const remaining = end - Date.now();
  const result =
    remaining <= 0
      ? Promise.resolve(
          failure("Process deadline elapsed during supervisor startup", true),
        )
      : execute(command, args, { ...options, timeoutMs: remaining }, (pid) =>
          Atomics.store(state, 1, pid),
        );
  void result
    .catch((error) => failure(String(error)))
    .then((value) => {
      port.postMessage(value);
      Atomics.store(state, 0, 1);
      Atomics.notify(state, 0);
      port.close();
    });
}

export function processFailure(
  command: ProcessCommand,
  args: string[],
  result: ProcessResult,
  timeoutMs = GIT_GH_TIMEOUT_MS,
): Error {
  if (result.timedOut)
    return new ProcessTimeoutError(`${command} ${args.join(" ")}`, timeoutMs);
  return new Error(
    `${command} ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.status ?? "unknown"}`}`,
  );
}
