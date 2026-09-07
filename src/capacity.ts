export const MAX_VIRTUAL_USERS = 1_000
export const MAX_CONCURRENCY = 50
export const DEFAULT_MAX_CONCURRENCY = 25
const MEMORY_PER_CONTEXT_BYTES = 250 * 1024 * 1024

export function recommendedConcurrency(options?: {
  cpus?: number
  freeMem?: number
}): number {
  const cpus = Math.max(1, options?.cpus ?? 1)
  const freeMem = Math.max(0, options?.freeMem ?? 0)
  const byCpu = Math.max(1, (cpus - 1) * 3)
  const byMem = Math.max(1, Math.floor(freeMem / MEMORY_PER_CONTEXT_BYTES) || 1)
  return Math.max(1, Math.min(DEFAULT_MAX_CONCURRENCY, byCpu, byMem, MAX_CONCURRENCY))
}

export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  shouldStop?: () => boolean,
): Promise<R[]> {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1))
  const results = new Array<R>(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      if (shouldStop?.()) return
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}
