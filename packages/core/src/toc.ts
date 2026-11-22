import { dirname, relativePath, resolvePath, splitFragment } from './path'

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

/**
 * Rewrites relative hrefs when mirroring a TOC tree between two TOC documents in different
 * directories (e.g. `EPUB/nav.xhtml` and `EPUB/text/toc.ncx`), keeping fragments and `rawHtml`.
 */
export function rebaseTocHrefs(entries: TocEntry[], fromTocPath: string, toTocPath: string): TocEntry[] {
  const fromDir = dirname(fromTocPath)
  const toDir = dirname(toTocPath)
  if (fromDir === toDir) return cloneToc(entries)

  const rebase = (list: TocEntry[]): TocEntry[] =>
    list.map((entry) => {
      if (!entry.href || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(entry.href) || entry.href.startsWith('#')) {
        return { ...entry, children: rebase(entry.children) }
      }
      const { path, fragment } = splitFragment(entry.href)
      if (!path) return { ...entry, children: rebase(entry.children) }
      const resolved = resolvePath(fromDir, path)
      const rel = relativePath(toDir, resolved)
      return {
        ...entry,
        href: fragment ? `${rel}#${fragment}` : rel,
        children: rebase(entry.children),
      }
    })

  return rebase(entries)
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
    let decoded = fragment
    try {
      decoded = decodeURIComponent(fragment)
    } catch {
      decoded = fragment
    }
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

export type TocInsertPosition = 'before' | 'after' | 'inside'

export function getTocEntry(entries: TocEntry[], path: TocPath): TocEntry | null {
  if (path.length === 0) return null
  let list = entries
  let current: TocEntry | undefined
  for (const index of path) {
    current = list[index]
    if (!current) return null
    list = current.children
  }
  return current ?? null
}

export function compareTocPaths(a: TocPath, b: TocPath): number {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return a.length - b.length
}

export function isSameOrDescendantTocPath(ancestor: TocPath, candidate: TocPath): boolean {
  if (candidate.length < ancestor.length) return false
  for (let i = 0; i < ancestor.length; i += 1) {
    if (ancestor[i] !== candidate[i]) return false
  }
  return true
}

/**
 * Deduplicates paths, drops any path whose ancestor is also selected (so subtrees are never
 * transformed twice), and sorts the result in document order.
 */
export function normalizeTocPaths(paths: TocPath[]): TocPath[] {
  const sorted = paths
    .filter((path) => path.length > 0)
    .map((path) => [...path])
    .sort(compareTocPaths)
  const kept: TocPath[] = []
  for (const path of sorted) {
    const last = kept[kept.length - 1]
    if (last && isSameOrDescendantTocPath(last, path)) continue
    kept.push(path)
  }
  return kept
}

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

function findTocPathByRef(entries: TocEntry[], target: TocEntry, prefix: TocPath = []): TocPath | null {
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    if (!entry) continue
    const nextPath = [...prefix, i]
    if (entry === target) return nextPath
    const nested = findTocPathByRef(entry.children, target, nextPath)
    if (nested) return nested
  }
  return null
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

export function removeTocEntry(
  entries: TocEntry[],
  path: TocPath,
  options?: { keepChildren?: boolean },
): TocEntry[] {
  if (path.length === 0) return entries
  return mutateAt(entries, path, (siblings, index) => {
    if (index < 0 || index >= siblings.length) return siblings
    if (!options?.keepChildren) return siblings.filter((_, at) => at !== index)
    const target = siblings[index]
    const next = [...siblings]
    next.splice(index, 1, ...(target?.children ?? []))
    return next
  })
}

/** Moves an entry (with its entire subtree) one slot up or down among its siblings. */
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

/**
 * Inserts `entry` relative to `path`: `'after'` (default), `'before'`, or `'inside'` (as last child).
 * An empty path appends at the root (or prepends when `position === 'before'`).
 */
export function insertTocEntry(
  entries: TocEntry[],
  path: TocPath,
  entry: TocEntry,
  position: TocInsertPosition = 'after',
): TocEntry[] {
  if (path.length === 0) {
    return position === 'before' ? [entry, ...entries] : [...entries, entry]
  }
  if (position === 'inside') {
    return mapChildren(entries, path, (children) => [...children, entry])
  }
  return mutateAt(entries, path, (siblings, index) => {
    if (index < 0 || index >= siblings.length) return siblings
    const next = [...siblings]
    next.splice(position === 'before' ? index : index + 1, 0, entry)
    return next
  })
}

export interface TocBatchMutationResult {
  entries: TocEntry[]
  paths: TocPath[]
  changed: boolean
}

export interface TocSingleMutationResult {
  entries: TocEntry[]
  path: TocPath | null
  changed: boolean
}

/**
 * Moves a node (with its subtree) to sit before, after, or inside `toPath`, returning both the
 * updated tree and the moved node's resulting path.
 * Refuses drops onto the node itself or any of its descendants so cycles cannot form.
 */
export function moveTocSubtreeWithPath(
  entries: TocEntry[],
  fromPath: TocPath,
  toPath: TocPath,
  position: TocInsertPosition,
): TocSingleMutationResult {
  if (fromPath.length === 0 || toPath.length === 0) return { entries, path: null, changed: false }
  if (isSameOrDescendantTocPath(fromPath, toPath)) return { entries, path: fromPath, changed: false }
  const cloned = cloneToc(entries)
  const moved = getTocEntry(cloned, fromPath)
  const target = getTocEntry(cloned, toPath)
  if (!moved || !target) return { entries, path: null, changed: false }

  // Adjust target path coordinates after removing `fromPath` when both share `fromPath`'s parent.
  const depth = fromPath.length - 1
  const adjustedTo = [...toPath]
  let sharedParent = adjustedTo.length > depth
  for (let i = 0; i < depth && sharedParent; i += 1) {
    if (fromPath[i] !== adjustedTo[i]) sharedParent = false
  }
  if (sharedParent && (fromPath[depth] ?? 0) < (adjustedTo[depth] ?? 0)) {
    adjustedTo[depth] = (adjustedTo[depth] ?? 0) - 1
  }

  const removed = removeTocEntry(cloned, fromPath)
  const next = insertTocEntry(removed, adjustedTo, moved, position)
  const nextPath = findTocPathByRef(next, moved)
  const changed = nextPath !== null && compareTocPaths(fromPath, nextPath) !== 0
  return { entries: changed ? next : entries, path: nextPath ?? fromPath, changed }
}

/**
 * Moves a node (with its subtree) to sit before, after, or inside `toPath`.
 * Refuses drops onto the node itself or any of its descendants so cycles cannot form.
 */
export function moveTocSubtree(
  entries: TocEntry[],
  fromPath: TocPath,
  toPath: TocPath,
  position: TocInsertPosition,
): TocEntry[] {
  return moveTocSubtreeWithPath(entries, fromPath, toPath, position).entries
}

/** Makes an entry (and its subtree) the last child of its previous sibling. */
export function indentTocEntry(entries: TocEntry[], path: TocPath): TocEntry[] {
  const index = path[path.length - 1]
  if (index === undefined || index === 0) return entries
  const moved = siblingsAt(entries, path)?.[index]
  if (!moved) return entries

  const removed = removeTocEntry(entries, path)
  return mapChildren(removed, [...path.slice(0, -1), index - 1], (children) => [...children, moved])
}

/**
 * Lifts an entry to sit right after its parent, absorbing any following siblings under the old
 * parent into the lifted node's children so book reading order never inverts.
 */
export function outdentTocEntry(entries: TocEntry[], path: TocPath): TocEntry[] {
  if (path.length < 2) return entries
  const index = path[path.length - 1]
  const parentPath = path.slice(0, -1)
  const parentIndex = parentPath[parentPath.length - 1]
  if (index === undefined || parentIndex === undefined) return entries

  const siblings = siblingsAt(entries, path)
  const moved = siblings?.[index]
  if (!siblings || !moved) return entries

  // Absorbing trailing siblings prevents Parent -> A -> B -> C from flipping to Parent -> A -> C -> B.
  // See ADR 2026-11-20-toc-workbench-enhancements.
  const trailing = siblings.slice(index + 1)
  const lifted: TocEntry = trailing.length > 0 ? { ...moved, children: [...moved.children, ...trailing] } : moved

  const trimmedParent = mapChildren(entries, parentPath, (children) => children.slice(0, index))
  return mutateAt(trimmedParent, parentPath, (parentSiblings, at) => {
    if (at < 0) return parentSiblings
    const next = [...parentSiblings]
    next.splice(Math.min(parentIndex + 1, next.length), 0, lifted)
    return next
  })
}

/** Batch-indents normalized selections while keeping un-indentable leading blocks aligned and returning new paths. */
export function indentTocEntriesWithPaths(entries: TocEntry[], paths: TocPath[]): TocBatchMutationResult {
  const normalized = normalizeTocPaths(paths)
  if (normalized.length === 0) return { entries, paths: [], changed: false }
  let current = cloneToc(entries)
  const targets = normalized
    .map((path) => getTocEntry(current, path))
    .filter((entry): entry is TocEntry => entry !== null)
  const skipped = new Set<TocEntry>()
  let changed = false

  for (const target of targets) {
    const livePath = findTocPathByRef(current, target)
    if (!livePath) continue
    const index = livePath[livePath.length - 1] ?? 0
    const siblings = siblingsAt(current, livePath)
    const prev = index > 0 ? siblings?.[index - 1] : undefined
    if (index === 0 || (prev && skipped.has(prev))) {
      skipped.add(target)
      continue
    }
    current = indentTocEntry(current, livePath)
    changed = true
  }

  const nextPaths = targets
    .map((target) => findTocPathByRef(current, target))
    .filter((path): path is TocPath => path !== null)
  return { entries: changed ? current : entries, paths: nextPaths, changed }
}

/** Batch-indents normalized selections while keeping un-indentable leading blocks aligned. */
export function indentTocEntries(entries: TocEntry[], paths: TocPath[]): TocEntry[] {
  return indentTocEntriesWithPaths(entries, paths).entries
}

/** Batch-outdents normalized selections in reverse document order and returns their resulting paths. */
export function outdentTocEntriesWithPaths(entries: TocEntry[], paths: TocPath[]): TocBatchMutationResult {
  const normalized = normalizeTocPaths(paths)
  if (normalized.length === 0) return { entries, paths: [], changed: false }
  let current = cloneToc(entries)
  const targets = normalized
    .map((path) => getTocEntry(current, path))
    .filter((entry): entry is TocEntry => entry !== null)
  let changed = false

  for (let i = targets.length - 1; i >= 0; i -= 1) {
    const target = targets[i]
    if (!target) continue
    const livePath = findTocPathByRef(current, target)
    if (!livePath || livePath.length < 2) continue
    const parentPath = livePath.slice(0, -1)
    const parentIndex = parentPath[parentPath.length - 1]
    if (parentIndex === undefined) continue
    current = outdentTocEntry(current, livePath)
    changed = true
    // `outdentTocEntry` clones the lifted node when absorbing trailing siblings, so rebind our tracked ref.
    const liftedPath = [...parentPath.slice(0, -1), parentIndex + 1]
    const liftedNode = getTocEntry(current, liftedPath)
    if (liftedNode) targets[i] = liftedNode
  }

  const nextPaths = targets
    .map((target) => findTocPathByRef(current, target))
    .filter((path): path is TocPath => path !== null)
  return { entries: changed ? current : entries, paths: nextPaths, changed }
}

/** Batch-outdents normalized selections in reverse document order to keep order-preserving lifting stable. */
export function outdentTocEntries(entries: TocEntry[], paths: TocPath[]): TocEntry[] {
  return outdentTocEntriesWithPaths(entries, paths).entries
}

/** Batch-moves normalized selections up or down among their respective siblings and returns their resulting paths. */
export function moveTocEntriesWithPaths(
  entries: TocEntry[],
  paths: TocPath[],
  delta: -1 | 1,
): TocBatchMutationResult {
  const normalized = normalizeTocPaths(paths)
  if (normalized.length === 0) return { entries, paths: [], changed: false }
  let current = cloneToc(entries)
  const targets = normalized
    .map((path) => getTocEntry(current, path))
    .filter((entry): entry is TocEntry => entry !== null)
  const ordered = delta === -1 ? targets : [...targets].reverse()
  const blocked = new Set<TocEntry>()
  let changed = false

  for (const target of ordered) {
    const livePath = findTocPathByRef(current, target)
    if (!livePath) continue
    const index = livePath[livePath.length - 1] ?? 0
    const siblings = siblingsAt(current, livePath)
    if (!siblings) continue
    const neighborIndex = index + delta
    if (neighborIndex < 0 || neighborIndex >= siblings.length) {
      blocked.add(target)
      continue
    }
    const neighbor = siblings[neighborIndex]
    if (neighbor && blocked.has(neighbor)) {
      blocked.add(target)
      continue
    }
    current = moveTocEntry(current, livePath, delta)
    changed = true
  }

  const nextPaths = targets
    .map((target) => findTocPathByRef(current, target))
    .filter((path): path is TocPath => path !== null)
  return { entries: changed ? current : entries, paths: nextPaths, changed }
}

/** Batch-moves normalized selections up or down among their respective siblings without collapsing blocks. */
export function moveTocEntries(entries: TocEntry[], paths: TocPath[], delta: -1 | 1): TocEntry[] {
  return moveTocEntriesWithPaths(entries, paths, delta).entries
}

/** Batch-removes normalized selections in reverse order. */
export function removeTocEntries(
  entries: TocEntry[],
  paths: TocPath[],
  options?: { keepChildren?: boolean },
): TocEntry[] {
  const normalized = normalizeTocPaths(paths)
  if (normalized.length === 0) return entries
  let current = cloneToc(entries)
  const targets = normalized
    .map((path) => getTocEntry(current, path))
    .filter((entry): entry is TocEntry => entry !== null)

  for (let i = targets.length - 1; i >= 0; i -= 1) {
    const target = targets[i]
    if (!target) continue
    const livePath = findTocPathByRef(current, target)
    if (!livePath) continue
    current = removeTocEntry(current, livePath, options)
  }
  return current
}

/**
 * Removes every entry whose href fails `findBrokenAnchors`, lifting valid descendants up a level
 * so cleaning a broken wrapper section never discards valid child chapters.
 */
export function removeBrokenTocEntries(
  entries: TocEntry[],
  tocPath: string,
  files: Map<string, string>,
): { entries: TocEntry[]; removedCount: number } {
  const brokenHrefs = new Set(findBrokenAnchors(entries, tocPath, files).map((item) => item.href))
  if (brokenHrefs.size === 0) return { entries: cloneToc(entries), removedCount: 0 }

  let removedCount = 0
  const prune = (list: TocEntry[]): TocEntry[] =>
    list.flatMap((entry) => {
      const nextChildren = prune(entry.children)
      if (entry.href && brokenHrefs.has(entry.href)) {
        removedCount += 1
        return nextChildren
      }
      return [{ ...entry, children: nextChildren }]
    })

  return { entries: prune(entries), removedCount }
}
