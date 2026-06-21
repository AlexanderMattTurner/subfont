// Run an async worker over each item with a bounded number of in-flight tasks.
// Tasks may complete out of order. The first rejection propagates (matching a
// serial loop's fail-fast behavior) AND stops the remaining runners from
// pulling new items, so no further work (e.g. opening new puppeteer tabs) is
// started after a failure. Tasks already in flight when the first rejection
// occurs are allowed to settle.
export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  const effectiveLimit = Math.max(1, Math.min(limit, items.length));
  let nextIndex = 0;
  let stopped = false;
  async function runner(): Promise<void> {
    while (nextIndex < items.length && !stopped) {
      const item = items[nextIndex++];
      try {
        await worker(item);
      } catch (err) {
        // Signal sibling runners to stop pulling new items, then propagate.
        stopped = true;
        throw err;
      }
    }
  }
  await Promise.all(Array.from({ length: effectiveLimit }, () => runner()));
}
