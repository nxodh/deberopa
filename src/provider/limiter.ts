/**
 * A counting semaphore for requests to one model server. A local server has a fixed number of
 * slots; sending more than that at once only earns 429s, so requests wait their turn here instead.
 *
 * Properties the agent loop relies on:
 *  - a waiting request that is aborted leaves the queue at once and never holds a slot;
 *  - a release can be called any number of times and frees the slot exactly once;
 *  - `normal` requests are served before `low` ones (titles must not overtake real work).
 */
export type Priority = "normal" | "low"

export interface Limiter {
  readonly max: number
  /** Resolves with a release function once a slot is free. Rejects with an AbortError if `signal` aborts first. */
  acquire(signal?: AbortSignal, priority?: Priority): Promise<() => void>
  stats(): { active: number; waiting: number }
}

interface Waiter {
  grant(release: () => void): void
  cancel(): void
}

const abortError = () => Object.assign(new Error("Aborted"), { name: "AbortError" })

export function createLimiter(max: number): Limiter {
  let active = 0
  const queues: Record<Priority, Waiter[]> = { normal: [], low: [] }

  const release = () => {
    let done = false
    return () => {
      if (done) return
      done = true
      active--
      drain()
    }
  }

  function drain() {
    while (active < max) {
      const next = queues.normal.shift() ?? queues.low.shift()
      if (!next) return
      active++
      next.grant(release())
    }
  }

  return {
    max,
    acquire(signal, priority = "normal") {
      if (signal?.aborted) return Promise.reject(abortError())
      // when a slot is free the queues are empty (drain() runs on every release), so no queue jumping
      if (active < max) {
        active++
        return Promise.resolve(release())
      }
      return new Promise<() => void>((resolve, reject) => {
        const queue = queues[priority]
        const onAbort = () => {
          const index = queue.indexOf(waiter)
          if (index !== -1) queue.splice(index, 1)
          reject(abortError())
        }
        const waiter: Waiter = {
          grant: (fn) => {
            signal?.removeEventListener("abort", onAbort)
            resolve(fn)
          },
          cancel: () => signal?.removeEventListener("abort", onAbort),
        }
        queue.push(waiter)
        signal?.addEventListener("abort", onAbort, { once: true })
      })
    },
    stats: () => ({ active, waiting: queues.normal.length + queues.low.length }),
  }
}

const limiters = new Map<string, Limiter>()

/** One limiter per server (provider id plus address), shared by every session in the process. */
export function limiterFor(key: string, max: number): Limiter {
  const existing = limiters.get(key)
  if (existing && existing.max === max) return existing
  // a changed limit starts a new queue; requests already running keep the old one's slots until they end
  const created = createLimiter(max)
  limiters.set(key, created)
  return created
}

export function resetLimiters() {
  limiters.clear()
}
