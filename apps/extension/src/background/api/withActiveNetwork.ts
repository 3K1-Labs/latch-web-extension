/**
 * Drop a caller-supplied `network`. The deployment's network is implied:
 * an omitted field is accepted, and the other network is rejected.
 */
export async function withActiveNetwork<T extends object>(req: T): Promise<Omit<T, 'network'>> {
  if (!('network' in req)) return req
  const copy = { ...req } as T & { network?: unknown }
  delete copy.network
  return copy
}
