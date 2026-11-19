export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const relative = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })

export function formatRelative(iso: string, now = Date.now()): string {
  const diffMs = new Date(iso).getTime() - now
  const minutes = Math.round(diffMs / 60000)
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return relative.format(hours, 'hour')
  const days = Math.round(hours / 24)
  if (Math.abs(days) < 30) return relative.format(days, 'day')
  return new Date(iso).toLocaleDateString('zh-CN')
}
