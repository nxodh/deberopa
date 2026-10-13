/** Process-wide event bus. Everything the UI or server shows flows through here. */
export interface BusEvent<T = unknown> {
  type: string
  properties: T
}

type Listener = (event: BusEvent<any>) => void

const listeners = new Map<string, Set<Listener>>()

export function publish<T>(type: string, properties: T) {
  const event: BusEvent<T> = { type, properties }
  for (const key of [type, "*"]) {
    const set = listeners.get(key)
    if (!set) continue
    for (const fn of [...set]) {
      try {
        fn(event)
      } catch {
        // a broken subscriber must never take down the publisher
      }
    }
  }
}

/** Subscribe to one event type, or "*" for all. Returns an unsubscribe function. */
export function subscribe<T = any>(type: string, fn: (event: BusEvent<T>) => void): () => void {
  let set = listeners.get(type)
  if (!set) listeners.set(type, (set = new Set()))
  set.add(fn as Listener)
  return () => set!.delete(fn as Listener)
}
