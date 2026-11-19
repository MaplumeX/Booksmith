import { dirname, relativePath, resolvePath, splitFragment } from './path'

/**
 * Text-level reference scanning. Chapters are never parsed as XML here on purpose: the editor's
 * non-negotiable rule is that prose files only ever go through string replacement, so a rename
 * cannot reformat a chapter. See ADR 2026-11-19-file-structure-editing.
 */

export interface BookReference {
  /** The file that contains the reference. */
  from: string
  /** The raw attribute or `url()` value, e.g. `../images/figure3.png#frag`. */
  raw: string
  /** Character offset of the value inside `from`, so a caller can report a line number. */
  offset: number
  /** Resolved archive path of the target, fragment stripped. */
  targetPath: string
  fragment: string
}

const ATTRIBUTE = String.raw`(\b(?:href|src|xlink:href)\s*=\s*)(?:"([^"]*)"|'([^']*)')`
const CSS_URL = String.raw`(url\(\s*)(?:"([^"]*)"|'([^']*)'|([^)\s]*))(\s*\))`

function extensionOf(path: string): string {
  const index = path.lastIndexOf('.')
  return index < 0 ? '' : path.slice(index + 1).toLowerCase()
}

function patternFor(path: string): RegExp {
  return new RegExp(extensionOf(path) === 'css' ? CSS_URL : ATTRIBUTE, 'g')
}

/** Archive path a raw value points at, or null for external URLs and empty values. */
function targetOf(from: string, raw: string): string | null {
  const { path } = splitFragment(raw.trim())
  // `#frag` alone points back into the same file.
  if (!path) return raw.trim().startsWith('#') ? from : null
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path) || path.startsWith('//')) return null
  try {
    return resolvePath(dirname(from), path)
  } catch {
    // A stray `%` makes decodeURIComponent throw; such a value is not a usable reference.
    return null
  }
}

interface RawMatch {
  prefixLength: number
  index: number
  raw: string
  quote: boolean
  /** Where the value itself starts, past the quote when there is one. */
  valueStart: number
}

function rawMatches(path: string, text: string): RawMatch[] {
  const out: RawMatch[] = []
  for (const match of text.matchAll(patternFor(path))) {
    const prefix = match[1] ?? ''
    const double = match[2]
    const single = match[3]
    const bare = match[4]
    const raw = double ?? single ?? bare
    if (raw === undefined) continue
    const quote = double !== undefined || single !== undefined
    out.push({
      prefixLength: prefix.length,
      index: match.index,
      raw,
      quote,
      valueStart: match.index + prefix.length + (quote ? 1 : 0),
    })
  }
  return out
}

/** Every reference inside the given text files, in file order. */
export function collectReferences(files: Map<string, string>): BookReference[] {
  const out: BookReference[] = []
  for (const [path, text] of files) {
    for (const match of rawMatches(path, text)) {
      const targetPath = targetOf(path, match.raw)
      if (!targetPath) continue
      out.push({
        from: path,
        raw: match.raw,
        offset: match.valueStart,
        targetPath,
        fragment: splitFragment(match.raw).fragment,
      })
    }
  }
  return out
}

/**
 * Rewrites references whose target was renamed. Only values that resolve to a renamed path are
 * touched; every other byte of the chapter stays as it was.
 */
export function rewriteReferences(
  files: Map<string, string>,
  renames: Map<string, string>,
): { files: Map<string, string>; touched: BookReference[] } {
  const next = new Map(files)
  const touched: BookReference[] = []
  if (renames.size === 0) return { files: next, touched }

  for (const [path, text] of files) {
    const edits: Array<{ start: number; end: number; value: string }> = []
    for (const match of rawMatches(path, text)) {
      const targetPath = targetOf(path, match.raw)
      if (!targetPath) continue
      const renamed = renames.get(targetPath)
      if (!renamed) continue

      const { fragment } = splitFragment(match.raw)
      const value = relativePath(dirname(path), renamed) + (fragment ? `#${fragment}` : '')
      const start = match.valueStart
      edits.push({ start, end: start + match.raw.length, value })
      touched.push({ from: path, raw: match.raw, offset: start, targetPath, fragment })
    }
    if (edits.length === 0) continue

    let rewritten = text
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
      rewritten = rewritten.slice(0, edit.start) + edit.value + rewritten.slice(edit.end)
    }
    next.set(path, rewritten)
  }

  return { files: next, touched }
}

/** References pointing at a path the archive does not contain. */
export function collectBrokenReferences(
  files: Map<string, string>,
  knownPaths: Set<string>,
): BookReference[] {
  return collectReferences(files).filter((reference) => !knownPaths.has(reference.targetPath))
}
