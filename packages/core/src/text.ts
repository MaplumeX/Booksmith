/**
 * Which archive entries are text.
 *
 * Two callers with two policies: the editor decodes every text entry into `texts`, while page
 * history skips the zip container's own metadata (`mimetype`, `META-INF/`) — it describes the
 * archive rather than the book, so snapshotting it buys nothing.
 * See ADR 2026-11-19-page-level-snapshots.
 */
const TEXT_EXTENSIONS = new Set(['xhtml', 'html', 'htm', 'css', 'opf', 'ncx', 'xml', 'svg', 'js', 'txt'])

export function isTextEntry(path: string): boolean {
  const index = path.lastIndexOf('.')
  if (index < 0) return false
  return TEXT_EXTENSIONS.has(path.slice(index + 1).toLowerCase())
}

export function hasPageHistory(path: string): boolean {
  return isTextEntry(path) && path !== 'mimetype' && !path.startsWith('META-INF/')
}
