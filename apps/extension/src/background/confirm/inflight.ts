const inflight = new Map<string, Promise<unknown>>()

/**
 * Share one run between concurrent callers of the same key: a double-click or a retried message
 * gets the first call's result (or error) instead of starting a second signing attempt, whose
 * refusal would overwrite the first one's outcome.
 */
export function coalesce<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key)
  if (existing) return existing as Promise<T>
  const promise = run().finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key)
  })
  inflight.set(key, promise)
  return promise
}

/** Test helper: drop any shared runs between cases. */
export function __resetInflightForTests(): void {
  inflight.clear()
}
