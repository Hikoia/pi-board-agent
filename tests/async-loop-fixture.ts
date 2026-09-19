import type { BoardLoop } from "../src/loop.js";

/** Legacy outcome fixtures assert after settlement, not merely admission. Keep
 * production tickNow nonblocking; concurrency tests use the unwrapped loop. */
export function settledTicks(loop: BoardLoop): void {
  const tick = loop.tickNow.bind(loop);
  loop.tickNow = async () => {
    await tick();
    await (loop as unknown as { finalization?: { promise: Promise<void> } }).finalization?.promise;
  };
}

/** Test observation only, never production scheduling or authorization. */
export async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Offline observation did not settle");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
