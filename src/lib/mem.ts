/**
 * Explicit memory release for the heavy routes. With `--expose-gc` (the dev/start scripts and the
 * Docker image run Node with it) a full GC after a request hands the multi-GB buffers of an archive
 * scan back to the OS instead of leaving them resident until the next natural collection.
 * Without the flag every function here is a no-op, so plain `next dev` still works.
 */
const gc = (globalThis as { gc?: () => void }).gc;

/** Collect now - call between database files so one big scan's buffers don't stack onto the next. */
export function releaseMemory(): void {
  if (!gc) return;
  gc();
  gc(); // a second pass collects what the first one's finalizers released
}

let scheduled = false;

/** Collect shortly after the current task, once the response has been flushed. */
export function releaseMemorySoon(): void {
  if (!gc || scheduled) return;
  scheduled = true;
  const t = setTimeout(() => {
    scheduled = false;
    releaseMemory();
    // late pass: references the response pipeline released in the meantime
    const t2 = setTimeout(releaseMemory, 2000);
    t2.unref?.();
  }, 250);
  t.unref?.();
}

// periodic sweep - a big scan can keep buffers resident long after the request ended
if (gc) {
  const sweep = setInterval(releaseMemory, 5 * 60_000);
  sweep.unref?.();
}
