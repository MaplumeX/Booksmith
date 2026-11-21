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

function skipCommentOrCdata(text: string, index: number): number {
  if (text.startsWith('<!--', index)) {
    const end = text.indexOf('-->', index + 4)
    return end >= 0 ? end + 3 : text.length
  }
  if (text.startsWith('<![CDATA[', index)) {
    const end = text.indexOf(']]>', index + 9)
    return end >= 0 ? end + 3 : text.length
  }
  return index
}

/** Collects every `id` / `name` attribute value declared inside element start tags of an XHTML/XML file. */
export function collectDocumentIds(xhtml: string): Set<string> {
  const ids = new Set<string>()
  const attrPattern = /\b(?:id|name)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let index = 0

  while (index < xhtml.length) {
    const skipped = skipCommentOrCdata(xhtml, index)
    if (skipped !== index) {
      index = skipped
      continue
    }
    if (xhtml[index] !== '<') {
      index += 1
      continue
    }
    const nextChar = xhtml[index + 1]
    if (!nextChar || nextChar === '/' || nextChar === '?' || nextChar === '!') {
      const close = xhtml.indexOf('>', index + 1)
      index = close >= 0 ? close + 1 : xhtml.length
      continue
    }

    // Scan to the end of this start tag while respecting quoted attribute values.
    let end = index + 1
    while (end < xhtml.length) {
      const ch = xhtml[end]
      if (ch === '"' || ch === "'") {
        end += 1
        while (end < xhtml.length && xhtml[end] !== ch) end += 1
        if (end < xhtml.length) end += 1
        continue
      }
      if (ch === '>') {
        end += 1
        break
      }
      end += 1
    }

    const tagText = xhtml.slice(index, end)
    for (const match of tagText.matchAll(attrPattern)) {
      const value = (match[1] ?? match[2] ?? '').trim()
      if (value) ids.add(value)
    }
    index = end
  }

  return ids
}

export interface WholeFileMove {
  path: string
  /** Optional fragment appended when an incoming reference had no fragment of its own. */
  defaultFragment?: string
}

export interface AnchorRewriteOptions {
  /** Maps `sourcePath -> (anchorId -> destinationPath)` for IDs moved during a chapter split. */
  anchorMoves?: Map<string, Map<string, string>>
  /** Maps `absorbedPath -> { path, defaultFragment? }` for chapters absorbed during a merge. */
  wholeFileMoves?: Map<string, WholeFileMove>
  /** Archive paths to skip completely (e.g. `content.opf`, whose manifest is updated separately). */
  skipPaths?: Set<string>
}

function decodeFragmentSafe(fragment: string): string {
  try {
    return decodeURIComponent(fragment)
  } catch {
    return fragment
  }
}

/**
 * Rewrites book-wide text references when anchors move across chapters (split) or entire chapters
 * merge into another document. Keeps untouched bytes verbatim so prose files are never reformatted.
 * See ADR 2026-11-21-chapter-structure-and-resource-tools.
 */
export function rewriteAnchorReferences(
  files: Map<string, string>,
  options: AnchorRewriteOptions,
): { files: Map<string, string>; touched: BookReference[] } {
  const next = new Map(files)
  const touched: BookReference[] = []
  const anchorMoves = options.anchorMoves
  const wholeFileMoves = options.wholeFileMoves
  const skipPaths = options.skipPaths

  if ((!anchorMoves || anchorMoves.size === 0) && (!wholeFileMoves || wholeFileMoves.size === 0)) {
    return { files: next, touched }
  }

  for (const [path, text] of files) {
    if (skipPaths?.has(path)) continue
    const edits: Array<{ start: number; end: number; value: string }> = []

    for (const match of rawMatches(path, text)) {
      const targetPath = targetOf(path, match.raw)
      if (!targetPath) continue
      const { fragment } = splitFragment(match.raw)

      let nextPath: string | null = null
      let nextFragment = fragment

      if (fragment && anchorMoves) {
        const moveMap = anchorMoves.get(targetPath)
        const mapped = moveMap?.get(fragment) ?? moveMap?.get(decodeFragmentSafe(fragment))
        if (mapped && mapped !== targetPath) {
          nextPath = mapped
        }
      }

      if (!nextPath && wholeFileMoves) {
        const whole = wholeFileMoves.get(targetPath)
        if (whole) {
          nextPath = whole.path
          if (!nextFragment && whole.defaultFragment) {
            nextFragment = whole.defaultFragment
          }
        }
      }

      if (!nextPath) continue

      const value =
        nextPath === path && nextFragment
          ? `#${nextFragment}`
          : relativePath(dirname(path), nextPath) + (nextFragment ? `#${nextFragment}` : '')

      if (value === match.raw) continue

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
