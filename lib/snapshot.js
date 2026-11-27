/**
 * Invalidate a server's cached session listing.
 *
 * The cache (`server.snapshot`, 10 s) predates every create/delete path, so it
 * has to be dropped whenever membership changes. The monotonic epoch stops a
 * listing that was already in flight from caching the stale value again when it
 * resolves; `collectServer` only caches when the epoch did not move.
 */
export function invalidateSnapshot(server) {
  if (server === null || typeof server !== 'object') return
  server.snapshot = undefined
  server.snapshotEpoch = (typeof server.snapshotEpoch === 'number' ? server.snapshotEpoch : 0) + 1
}