export interface SearchOptions {
  caseSensitive?: boolean
  regex?: boolean
  maxResults?: number
}

export interface SearchMatch {
  path: string
  /** Character offset inside the file. */
  offset: number
  /** 1-based line number. */
  line: number
  /** 1-based column inside the line. */
  column: number
  preview: string
}

export interface SearchFile {
  path: string
  text: string
}

export interface SearchResult {
  matches: SearchMatch[]
  truncated: boolean
}

const PREVIEW_RADIUS = 40

export function buildSearchPattern(query: string, options: SearchOptions = {}): RegExp | null {
  if (!query) return null
  const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  try {
    return new RegExp(source, options.caseSensitive ? 'g' : 'gi')
  } catch {
    return null
  }
}

function positionOf(text: string, offset: number): { line: number; column: number } {
  let line = 1
  let lineStart = 0
  for (let index = text.indexOf('\n'); index !== -1 && index < offset; index = text.indexOf('\n', index + 1)) {
    line += 1
    lineStart = index + 1
  }
  return { line, column: offset - lineStart + 1 }
}

function previewOf(text: string, offset: number, length: number): string {
  const start = Math.max(0, offset - PREVIEW_RADIUS)
  const end = Math.min(text.length, offset + length + PREVIEW_RADIUS)
  const snippet = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${snippet}${end < text.length ? '…' : ''}`
}

/**
 * Searches every text file of a book. Results keep file order so the caller can
 * group them without re-sorting, and every match carries its line/column for reveal.
 */
export function searchBook(files: SearchFile[], query: string, options: SearchOptions = {}): SearchResult {
  const pattern = buildSearchPattern(query, options)
  if (!pattern) return { matches: [], truncated: false }

  const maxResults = options.maxResults ?? 2000
  const matches: SearchMatch[] = []

  for (const file of files) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null = pattern.exec(file.text)
    while (match) {
      if (match[0].length === 0) {
        pattern.lastIndex += 1
      } else {
        const { line, column } = positionOf(file.text, match.index)
        matches.push({
          path: file.path,
          offset: match.index,
          line,
          column,
          preview: previewOf(file.text, match.index, match[0].length),
        })
        if (matches.length >= maxResults) return { matches, truncated: true }
      }
      match = pattern.exec(file.text)
    }
  }

  return { matches, truncated: false }
}

export function groupMatches(matches: SearchMatch[]): Array<{ path: string; matches: SearchMatch[] }> {
  const groups = new Map<string, SearchMatch[]>()
  for (const match of matches) {
    const bucket = groups.get(match.path)
    if (bucket) bucket.push(match)
    else groups.set(match.path, [match])
  }
  return [...groups].map(([path, entries]) => ({ path, matches: entries }))
}
