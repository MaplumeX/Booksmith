import { buildSearchPattern, type SearchOptions } from '@booksmith/core'

/**
 * Plans a book-wide replacement without touching the editor. The caller applies the result and
 * keeps the previous text so one action can be reverted in one action.
 * See ADR 2026-11-19-book-wide-replace.
 */

export interface ReplaceRequest extends SearchOptions {
  query: string
  replacement: string
}

export interface ReplaceFileResult {
  path: string
  /** Text after replacement. */
  text: string
  count: number
}

export interface ReplacePlan {
  total: number
  files: ReplaceFileResult[]
}

export function planReplace(files: Map<string, string>, request: ReplaceRequest): ReplacePlan {
  const pattern = buildSearchPattern(request.query, request)
  if (!pattern) return { total: 0, files: [] }

  const results: ReplaceFileResult[] = []
  let total = 0

  for (const [path, text] of files) {
    const count = [...text.matchAll(new RegExp(pattern.source, pattern.flags))].length
    if (count === 0) continue
    // `$1` and friends are expanded by String.replace itself; writing our own parser here would
    // only re-implement a well-defined platform behaviour.
    results.push({ path, text: text.replace(pattern, request.replacement), count })
    total += count
  }

  return { total, files: results }
}
