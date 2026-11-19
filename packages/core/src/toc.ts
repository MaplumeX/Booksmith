import { dirname, splitFragment, resolvePath } from './path'

export interface TocEntry {
  label: string
  /** href as written in the nav/ncx document (fragment included, percent-encoded). */
  href: string
  /** Serialized inner markup of the label anchor, kept so inline MathML survives a rebuild. */
  rawHtml?: string
  children: TocEntry[]
}

export function cloneToc(entries: TocEntry[]): TocEntry[] {
  return entries.map((entry) => ({ ...entry, children: cloneToc(entry.children) }))
}

export function countTocEntries(entries: TocEntry[]): number {
  return entries.reduce((sum, entry) => sum + 1 + countTocEntries(entry.children), 0)
}

export function flattenToc(entries: TocEntry[], depth = 0): Array<{ entry: TocEntry; depth: number }> {
  return entries.flatMap((entry) => [{ entry, depth }, ...flattenToc(entry.children, depth + 1)])
}

export interface BrokenAnchor {
  label: string
  href: string
  reason: 'missing-file' | 'missing-fragment'
}

/**
 * Checks every toc href against the archive. Fragments are matched by scanning for
 * `id="…"` / `name="…"`, which is enough for EPUB content and avoids parsing 25 chapters.
 */
export function findBrokenAnchors(
  entries: TocEntry[],
  tocPath: string,
  files: Map<string, string>,
): BrokenAnchor[] {
  const broken: BrokenAnchor[] = []
  const baseDir = dirname(tocPath)

  for (const { entry } of flattenToc(entries)) {
    if (!entry.href) continue
    const { path, fragment } = splitFragment(entry.href)
    const target = resolvePath(baseDir, path)
    const text = files.get(target)
    if (text === undefined) {
      broken.push({ label: entry.label, href: entry.href, reason: 'missing-file' })
      continue
    }
    if (!fragment) continue
    const decoded = decodeURIComponent(fragment)
    const pattern = new RegExp(`(?:id|name)\\s*=\\s*["']${escapeRegExp(decoded)}["']`)
    if (!pattern.test(text)) {
      broken.push({ label: entry.label, href: entry.href, reason: 'missing-fragment' })
    }
  }

  return broken
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function elementChildrenOf(node: Element): Element[] {
  const out: Element[] = []
  for (let index = 0; index < node.childNodes.length; index += 1) {
    const child = node.childNodes.item(index)
    if (child && child.nodeType === 1) out.push(child as Element)
  }
  return out
}

/** Location of an entry inside the toc tree: one array index per nesting level. */
export type TocPath = number[]

/** The sibling list that holds the entry at `path`. */
function siblingsAt(entries: TocEntry[], path: TocPath): TocEntry[] | null {
  if (path.length <= 1) return entries
  const [head, ...rest] = path
  const parent = entries[head ?? -1]
  if (!parent) return null
  return siblingsAt(parent.children, rest)
}

/** Rewrites the sibling list that holds the entry at `path`. An empty path targets the root. */
function mutateAt(
  entries: TocEntry[],
  path: TocPath,
  mutate: (siblings: TocEntry[], index: number) => TocEntry[],
): TocEntry[] {
  if (path.length === 0) return mutate(entries, -1)
  const [head, ...rest] = path
  if (head === undefined) return entries
  if (rest.length === 0) return mutate(entries, head)
  return entries.map((entry, index) =>
    index === head ? { ...entry, children: mutateAt(entry.children, rest, mutate) } : entry,
  )
}

/** Rewrites the children of the entry at `path`. */
function mapChildren(
  entries: TocEntry[],
  path: TocPath,
  update: (children: TocEntry[]) => TocEntry[],
): TocEntry[] {
  return mutateAt(entries, path, (siblings, index) =>
    siblings.map((entry, at) => (at === index ? { ...entry, children: update(entry.children) } : entry)),
  )
}

export function updateTocEntry(
  entries: TocEntry[],
  path: TocPath,
  update: (entry: TocEntry) => TocEntry,
): TocEntry[] {
  return mutateAt(entries, path, (siblings, index) =>
    siblings.map((entry, at) => (at === index ? update(entry) : entry)),
  )
}

export function removeTocEntry(entries: TocEntry[], path: TocPath): TocEntry[] {
  if (path.length === 0) return entries
  return mutateAt(entries, path, (siblings, index) => siblings.filter((_, at) => at !== index))
}

/** Moves an entry one slot up or down among its siblings. */
export function moveTocEntry(entries: TocEntry[], path: TocPath, delta: -1 | 1): TocEntry[] {
  const index = path[path.length - 1]
  if (index === undefined || path.length === 0) return entries
  const siblings = siblingsAt(entries, path)
  const target = index + delta
  if (!siblings || target < 0 || target >= siblings.length) return entries

  return mutateAt(entries, path, (list, at) => {
    if (at < 0) return list
    const next = [...list]
    const moved = next[at]
    const swapped = next[target]
    if (!moved || !swapped) return list
    next[at] = swapped
    next[target] = moved
    return next
  })
}

/** Inserts `entry` right after the one at `path`; an empty path appends to the root. */
export function insertTocEntry(entries: TocEntry[], path: TocPath, entry: TocEntry): TocEntry[] {
  return mutateAt(entries, path, (siblings, index) => {
    const next = [...siblings]
    if (index < 0) next.push(entry)
    else next.splice(index + 1, 0, entry)
    return next
  })
}

/** Makes an entry the last child of its previous sibling. */
export function indentTocEntry(entries: TocEntry[], path: TocPath): TocEntry[] {
  const index = path[path.length - 1]
  if (index === undefined || index === 0) return entries
  const moved = siblingsAt(entries, path)?.[index]
  if (!moved) return entries

  const removed = removeTocEntry(entries, path)
  return mapChildren(removed, [...path.slice(0, -1), index - 1], (children) => [...children, moved])
}

/** Lifts an entry to sit right after its parent. */
export function outdentTocEntry(entries: TocEntry[], path: TocPath): TocEntry[] {
  if (path.length < 2) return entries
  const index = path[path.length - 1]
  const parentPath = path.slice(0, -1)
  const parentIndex = parentPath[parentPath.length - 1]
  if (index === undefined || parentIndex === undefined) return entries

  const moved = siblingsAt(entries, path)?.[index]
  if (!moved) return entries

  const removed = removeTocEntry(entries, path)
  return mutateAt(removed, parentPath, (siblings, at) => {
    if (at < 0) return siblings
    const next = [...siblings]
    next.splice(Math.min(parentIndex + 1, next.length), 0, moved)
    return next
  })
}
