export function mergePendingUpdate(previous, newStatus, extra) {
  const prev = previous || {}
  const prevExtra = prev.extra || {}
  const nextExtra = extra || {}
  const mergedExtra = { ...prevExtra, ...nextExtra }
  const resolvedStatus = newStatus !== undefined ? newStatus : prev.newStatus
  return { newStatus: resolvedStatus, extra: mergedExtra }
}
