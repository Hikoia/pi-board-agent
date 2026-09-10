import assert from "node:assert/strict";
import { sendTelegram } from "../src/notify.js";
import { TELEGRAM_TIMEOUT_MS } from "../src/process-runner.js";

// No network, credentials, real Pi state, or 15-second sleeps. Accelerate only
// the clock factory and assert the production bound passed to it.
const originalFetch = globalThis.fetch;
const originalTimeout = AbortSignal.timeout;
const originalError = console.error;
const timers: ReturnType<typeof setTimeout>[] = [];
const input = { botToken: "offline-test-token", chatId: "offline-test-chat", title: "test" };
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) process.exitCode = 1;
};
let deadlines = 0;
AbortSignal.timeout = (ms) => {
  assert.equal(ms, TELEGRAM_TIMEOUT_MS);
  deadlines++;
  const abort = new AbortController();
  timers.push(setTimeout(() => abort.abort(new DOMException("deadline", "TimeoutError")), 20));
  return abort.signal;
};
console.error = () => {};
const waitForAbort = (signal: AbortSignal) => new Promise<never>((_, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});

try {
  for (const stage of ["headers", "body"]) {
    const caller = new AbortController();
    let supplied: AbortSignal | undefined;
    globalThis.fetch = async (_url, options) => {
      supplied = options!.signal!;
      if (stage === "headers") return waitForAbort(supplied);
      return new Response(new ReadableStream({
        start(controller) {
          void waitForAbort(supplied!).catch((error) => controller.error(error));
        },
      }));
    };
    const before = deadlines;
    const pending = sendTelegram({ ...input, signal: caller.signal });
    const result = await Promise.race([pending, new Promise<string>((resolve) => {
      timers.push(setTimeout(() => resolve("missing hard deadline"), 150));
    })]);
    check(result === false && deadlines === before + 1 && !!supplied?.aborted && !caller.signal.aborted,
      `Telegram ${stage} obeys its own deadline even with a live caller signal`);
    // Release the intentionally hanging stub even against a broken implementation.
    caller.abort();
    await pending;
  }
  const caller = new AbortController();
  caller.abort();
  let cancelled = false;
  globalThis.fetch = async (_url, options) => {
    cancelled = options?.signal?.aborted === true;
    throw options?.signal?.reason;
  };
  check(await sendTelegram({ ...input, signal: caller.signal }) === false && cancelled, "Telegram preserves caller cancellation");
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }));
  check(await sendTelegram(input), "Telegram successful response still succeeds");
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false }));
  check(await sendTelegram(input) === false, "Telegram API failures remain non-throwing");
  assert.equal(process.exitCode ?? 0, 0, "notification regression(s) failed");
} finally {
  globalThis.fetch = originalFetch;
  AbortSignal.timeout = originalTimeout;
  console.error = originalError;
  for (const timer of timers) clearTimeout(timer);
}
