import { dirname, relativePath, resolvePath, splitFragment } from './path'
import { cloneToc, flattenToc, getTocEntry, normalizeTocPaths, type TocEntry, type TocPath } from './toc'
import type { EpubPackage } from './types'
import type { XmlCodec } from './xml'

export interface DocumentAnchor {
  id: string
  tag: string
  label: string
}

export interface ScannedHeading {
  /** Stable key `${path}#${headingIndex}` used to identify candidates across preview interactions. */
  key: string
  /** Archive path of the chapter containing this heading. */
  path: string
  /** Heading level 1..6 (0 for untitled spine fallback entries). */
  level: number
  /** Plain normalized text of the heading. */
  label: string
  /** Existing element id (or inner anchor id/name), or empty string if absent. */
  id: string
  /** 0-based order among all h1–h6 headings in `path`, or -1 for untitled fallback. */
  headingIndex: number
  /** 1-based line number of the opening `<h1..h6>` tag in the chapter source, when located. */
  line?: number
}

export interface ScanHeadingsOptions {
  /** Heading levels to include (1..6). Defaults to all levels [1, 2, 3, 4, 5, 6]. */
  levels?: number[]
  /** When true, spine documents without matched headings produce a level-0 fallback candidate. */
  includeUntitledSpine?: boolean
}

export interface GeneratedTocCandidate extends ScannedHeading {
  /** Resolved href relative to `tocPath` (using existing or planned id). */
  href: string
  /** True when applying with `injectMissingIds` will write a new id into the chapter. */
  willInjectId: boolean
  /** True when an existing TOC already references this target. */
  alreadyInToc: boolean
}

export interface GenerateTocOptions {
  /** Heading levels to include (1..6). Defaults to [1, 2, 3]. */
  levels?: number[]
  /** Include spine chapters that have no matching headings using `<title>` or filename. */
  includeUntitledSpine?: boolean
  /** Write unique `toc-N` ids to selected headings that lack an id. Defaults to true. */
  injectMissingIds?: boolean
  /** `'replace'` builds a fresh tree; `'append_missing'` preserves existing entries and appends new ones. */
  mode?: 'replace' | 'append_missing'
  /** Existing TOC tree, required for `append_missing` and `alreadyInToc` flags. */
  existingEntries?: TocEntry[]
  /** Optional whitelist of candidate keys to include (used by interactive preview). */
  selectedKeys?: ReadonlySet<string> | string[]
  /** Optional per-candidate level overrides (used by interactive preview). */
  levelOverrides?: Readonly<Record<string, number>>
}

export interface GenerateTocResult {
  entries: TocEntry[]
  addedCount: number
  injectedIdCount: number
  updatedChapters: Map<string, string>
  candidates: GeneratedTocCandidate[]
}

export interface RefreshTocLabelsOptions {
  /** When provided, only entries at these paths are refreshed; otherwise all entries. */
  paths?: TocPath[]
  /** When false (default), entries with inline markup such as MathML in `rawHtml` are skipped. */
  overwriteRichHtml?: boolean
}

export interface RefreshTocLabelsResult {
  entries: TocEntry[]
  updatedCount: number
  skippedRichCount: number
}

function localTagName(element: Element): string {
  const raw = element.localName || element.tagName || ''
  const colon = raw.indexOf(':')
  return (colon >= 0 ? raw.slice(colon + 1) : raw).toLowerCase()
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function walkElements(root: Node | null, visit: (element: Element) => void): void {
  if (!root) return
  for (let i = 0; i < root.childNodes.length; i += 1) {
    const child = root.childNodes.item(i)
    if (!child || child.nodeType !== 1) continue
    const el = child as Element
    visit(el)
    walkElements(el, visit)
  }
}

function findAnchorIdInside(heading: Element): string {
  const direct = heading.getAttribute('id')?.trim()
  if (direct) return direct
  let nested = ''
  walkElements(heading, (el) => {
    if (nested) return
    const id = el.getAttribute('id')?.trim()
    if (id) {
      nested = id
      return
    }
    if (localTagName(el) === 'a') {
      const name = el.getAttribute('name')?.trim()
      if (name) nested = name
    }
  })
  return nested
}

function spineChapterPaths(pkg: EpubPackage): string[] {
  const byId = new Map(pkg.manifest.map((item) => [item.id, item]))
  const paths: string[] = []
  const seen = new Set<string>()
  for (const idref of pkg.spine) {
    const item = byId.get(idref)
    if (!item) continue
    if (item.path === pkg.navPath) continue
    if (seen.has(item.path)) continue
    seen.add(item.path)
    paths.push(item.path)
  }
  return paths
}

function fallbackChapterTitle(doc: Document, path: string): string {
  let titleText = ''
  walkElements(doc.documentElement, (el) => {
    if (titleText) return
    if (localTagName(el) === 'title') {
      const text = normalizeText(el.textContent)
      if (text) titleText = text
    }
  })
  if (titleText) return titleText
  const slash = path.lastIndexOf('/')
  const name = slash >= 0 ? path.slice(slash + 1) : path
  return name.replace(/\.[^.]+$/, '') || name
}

function normalizeTargetKey(tocBaseDir: string, href: string): string {
  const { path, fragment } = splitFragment(href)
  if (!path) return ''
  const resolved = resolvePath(tocBaseDir, path)
  if (!fragment) return resolved
  let decoded = fragment
  try {
    decoded = decodeURIComponent(fragment)
  } catch {
    decoded = fragment
  }
  return `${resolved}#${decoded}`
}

/** Extracts all linkable `#id` / `<a name>` targets in document order for anchor picking. */
export function listDocumentAnchors(xhtml: string, codec: XmlCodec): DocumentAnchor[] {
  let doc: Document
  try {
    doc = codec.parse(xhtml)
  } catch {
    return []
  }
  const anchors: DocumentAnchor[] = []
  const seen = new Set<string>()
  walkElements(doc.documentElement, (el) => {
    const tag = localTagName(el)
    const id = el.getAttribute('id')?.trim() || (tag === 'a' ? el.getAttribute('name')?.trim() : '') || ''
    if (!id || seen.has(id)) return
    seen.add(id)
    const text = normalizeText(el.textContent)
    anchors.push({ id, tag, label: text.slice(0, 80) })
  })
  return anchors
}

function findHeadingSourceLines(xhtml: string): number[] {
  const lines: number[] = []
  let line = 1
  let i = 0

  const advance = (end: number) => {
    while (i < end && i < xhtml.length) {
      if (xhtml[i] === '\n') line += 1
      i += 1
    }
  }

  while (i < xhtml.length) {
    if (xhtml.startsWith('<!--', i)) {
      const end = xhtml.indexOf('-->', i + 4)
      advance(end >= 0 ? end + 3 : xhtml.length)
      continue
    }
    if (xhtml.startsWith('<![CDATA[', i)) {
      const end = xhtml.indexOf(']]>', i + 9)
      advance(end >= 0 ? end + 3 : xhtml.length)
      continue
    }
    if (xhtml[i] === '<') {
      const match = /^<(?:[A-Za-z_][\w.-]*:)?h([1-6])(?=[\s/>])/i.exec(xhtml.slice(i, i + 40))
      if (match) {
        lines.push(line)
      }
      // Skip to the closing `>` respecting quoted attribute values so `<` inside attributes can't confuse us.
      let end = i + 1
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
      advance(end)
      continue
    }
    if (xhtml[i] === '\n') line += 1
    i += 1
  }

  return lines
}

/** Scans spine chapters using `XmlCodec` and returns `h1`–`h6` headings in reading order. */
export function scanBookHeadings(
  pkg: EpubPackage,
  texts: ReadonlyMap<string, string>,
  codec: XmlCodec,
  options?: ScanHeadingsOptions,
): ScannedHeading[] {
  const allowedLevels = new Set(
    (options?.levels ?? [1, 2, 3, 4, 5, 6]).filter((lvl) => Number.isInteger(lvl) && lvl >= 1 && lvl <= 6),
  )
  const includeUntitled = options?.includeUntitledSpine === true
  const results: ScannedHeading[] = []

  for (const path of spineChapterPaths(pkg)) {
    const xhtml = texts.get(path)
    if (!xhtml) continue
    let doc: Document
    try {
      doc = codec.parse(xhtml)
    } catch {
      continue
    }

    const headingLines = findHeadingSourceLines(xhtml)
    let headingIndex = 0
    let matchedInChapter = 0
    walkElements(doc.documentElement, (el) => {
      const match = /^h([1-6])$/.exec(localTagName(el))
      if (!match) return
      const currentIndex = headingIndex
      headingIndex += 1
      const level = Number(match[1])
      const label = normalizeText(el.textContent)
      if (!label || !allowedLevels.has(level)) return
      matchedInChapter += 1
      const line = headingLines[currentIndex]
      results.push({
        key: `${path}#${currentIndex}`,
        path,
        level,
        label,
        id: findAnchorIdInside(el),
        headingIndex: currentIndex,
        ...(line !== undefined ? { line } : {}),
      })
    })

    if (includeUntitled && matchedInChapter === 0) {
      results.push({
        key: `${path}#untitled`,
        path,
        level: 0,
        label: fallbackChapterTitle(doc, path),
        id: '',
        headingIndex: -1,
      })
    }
  }

  return results
}

function buildNestedTree(items: Array<{ level: number; entry: TocEntry }>): TocEntry[] {
  const root: TocEntry[] = []
  const stack: Array<{ level: number; entry: TocEntry }> = []

  for (const item of items) {
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= item.level) {
      stack.pop()
    }
    const parent = stack[stack.length - 1]
    if (parent) parent.entry.children.push(item.entry)
    else root.push(item.entry)
    stack.push(item)
  }

  return root
}

/**
 * Generates or supplements a TOC tree from spine chapter headings.
 * Supports arbitrary selected heading levels (collapsing skipped levels cleanly), optional
 * non-colliding `id` injection into chapters, and non-destructive `append_missing` merging.
 */
export function generateTocFromHeadings(
  pkg: EpubPackage,
  texts: ReadonlyMap<string, string>,
  tocPath: string,
  codec: XmlCodec,
  options?: GenerateTocOptions,
): GenerateTocResult {
  const levels = (options?.levels ?? [1, 2, 3]).filter((lvl) => Number.isInteger(lvl) && lvl >= 1 && lvl <= 6)
  const minSelectedLevel = levels.length > 0 ? Math.min(...levels) : 1
  const includeUntitledSpine = options?.includeUntitledSpine === true
  const injectMissingIds = options?.injectMissingIds !== false
  const mode = options?.mode ?? 'replace'
  const existingEntries = options?.existingEntries ?? []
  const selectedSet =
    options?.selectedKeys === undefined
      ? null
      : options.selectedKeys instanceof Set
        ? options.selectedKeys
        : new Set(options.selectedKeys)
  const levelOverrides = options?.levelOverrides ?? {}

  const tocDir = dirname(tocPath)
  const existingKeys = new Set<string>()
  const existingFileRoots = new Set<string>()
  for (const { entry } of flattenToc(existingEntries)) {
    if (!entry.href) continue
    const key = normalizeTargetKey(tocDir, entry.href)
    if (key) existingKeys.add(key)
    const { path, fragment } = splitFragment(entry.href)
    if (path && !fragment) existingFileRoots.add(resolvePath(tocDir, path))
  }

  const scanned = scanBookHeadings(pkg, texts, codec, { levels, includeUntitledSpine })

  // Plan which headings need injected ids if they are active & not already present (in append_missing mode).
  const plannedIdsByKey = new Map<string, string>()
  const willInjectKeys = new Set<string>()
  const updatedChapters = new Map<string, string>()
  let injectedIdCount = 0

  const isAlreadyCovered = (item: ScannedHeading): boolean => {
    if (item.headingIndex < 0) return existingFileRoots.has(item.path) || existingKeys.has(item.path)
    if (item.id) return existingKeys.has(`${item.path}#${item.id}`)
    return existingFileRoots.has(item.path)
  }

  // Group chapters that may need ID injection for selected headings.
  const headingsByPath = new Map<string, ScannedHeading[]>()
  for (const item of scanned) {
    if (item.headingIndex < 0 || item.id) continue
    if (selectedSet && !selectedSet.has(item.key)) continue
    if (mode === 'append_missing' && isAlreadyCovered(item)) continue
    const list = headingsByPath.get(item.path) ?? []
    list.push(item)
    headingsByPath.set(item.path, list)
  }

  if (injectMissingIds && headingsByPath.size > 0) {
    // Only inject ids on chapters that actually have selected headings needing one, preserving
    // XML well-formedness and avoiding collisions with existing ids in that chapter.
    // See ADR 2026-11-20-toc-workbench-enhancements.
    for (const [chapterPath, items] of headingsByPath) {
      const xhtml = texts.get(chapterPath)
      if (!xhtml) continue
      let doc: Document
      try {
        doc = codec.parse(xhtml)
      } catch {
        continue
      }

      const usedIds = new Set<string>()
      const allHeadings: Element[] = []
      walkElements(doc.documentElement, (el) => {
        const id = el.getAttribute('id')?.trim()
        if (id) usedIds.add(id)
        const name = localTagName(el) === 'a' ? el.getAttribute('name')?.trim() : ''
        if (name) usedIds.add(name)
        if (/^h[1-6]$/.test(localTagName(el))) allHeadings.push(el)
      })

      let seq = 1
      let modified = false
      for (const item of items) {
        const headingEl = allHeadings[item.headingIndex]
        if (!headingEl) continue
        while (usedIds.has(`toc-${seq}`)) seq += 1
        const newId = `toc-${seq}`
        usedIds.add(newId)
        headingEl.setAttribute('id', newId)
        plannedIdsByKey.set(item.key, newId)
        willInjectKeys.add(item.key)
        injectedIdCount += 1
        modified = true
      }

      if (modified) {
        updatedChapters.set(chapterPath, codec.serialize(doc))
      }
    }
  }

  const candidates: GeneratedTocCandidate[] = scanned.map((item) => {
    const resolvedId = item.id || plannedIdsByKey.get(item.key) || ''
    const rel = relativePath(tocDir, item.path)
    const href = resolvedId ? `${rel}#${encodeURIComponent(resolvedId)}` : rel
    return {
      ...item,
      level: levelOverrides[item.key] ?? (item.level === 0 ? minSelectedLevel : item.level),
      id: resolvedId,
      href,
      willInjectId: willInjectKeys.has(item.key),
      alreadyInToc: isAlreadyCovered(item),
    }
  })

  const included = candidates.filter((candidate) => {
    if (selectedSet && !selectedSet.has(candidate.key)) return false
    if (mode === 'append_missing' && candidate.alreadyInToc) return false
    return true
  })

  const built = buildNestedTree(
    included.map((candidate) => ({
      level: candidate.level,
      entry: {
        label: candidate.label,
        href: candidate.href,
        rawHtml: '',
        children: [],
      },
    })),
  )

  if (mode === 'append_missing') {
    return {
      entries: [...cloneToc(existingEntries), ...built],
      addedCount: included.length,
      injectedIdCount,
      updatedChapters,
      candidates,
    }
  }

  return {
    entries: built,
    addedCount: included.length,
    injectedIdCount,
    updatedChapters,
    candidates,
  }
}

function findHeadingLabelInDoc(doc: Document, fragment: string): string {
  if (fragment) {
    let decoded = fragment
    try {
      decoded = decodeURIComponent(fragment)
    } catch {
      decoded = fragment
    }
    let found = ''
    walkElements(doc.documentElement, (el) => {
      if (found) return
      const id = el.getAttribute('id')?.trim()
      const name = localTagName(el) === 'a' ? el.getAttribute('name')?.trim() : ''
      if (id === decoded || name === decoded) {
        const text = normalizeText(el.textContent)
        if (text) found = text
      }
    })
    if (found) return found
  }

  let firstHeading = ''
  walkElements(doc.documentElement, (el) => {
    if (firstHeading) return
    if (/^h[1-6]$/.test(localTagName(el))) {
      const text = normalizeText(el.textContent)
      if (text) firstHeading = text
    }
  })
  return firstHeading
}

/**
 * Refreshes TOC entry labels from the corresponding chapter/anchor headings in the book.
 * Entries containing inline markup (such as MathML in `rawHtml`) are skipped by default so
 * math formulas are never stripped unintentionally.
 */
export function refreshTocLabelsFromHeadings(
  entries: TocEntry[],
  tocPath: string,
  texts: ReadonlyMap<string, string>,
  codec: XmlCodec,
  options?: RefreshTocLabelsOptions,
): RefreshTocLabelsResult {
  const tocDir = dirname(tocPath)
  const overwriteRich = options?.overwriteRichHtml === true
  const docCache = new Map<string, Document | null>()

  const getDoc = (path: string): Document | null => {
    if (docCache.has(path)) return docCache.get(path) ?? null
    const xhtml = texts.get(path)
    if (!xhtml) {
      docCache.set(path, null)
      return null
    }
    try {
      const doc = codec.parse(xhtml)
      docCache.set(path, doc)
      return doc
    } catch {
      docCache.set(path, null)
      return null
    }
  }

  let targetRefs: Set<TocEntry> | null = null
  const cloned = cloneToc(entries)
  if (options?.paths && options.paths.length > 0) {
    targetRefs = new Set<TocEntry>()
    for (const path of normalizeTocPaths(options.paths)) {
      const found = getTocEntry(cloned, path)
      if (found) targetRefs.add(found)
    }
  }

  let updatedCount = 0
  let skippedRichCount = 0

  const visit = (list: TocEntry[]): TocEntry[] =>
    list.map((entry) => {
      const nextChildren = visit(entry.children)
      const inScope = !targetRefs || targetRefs.has(entry)
      if (!inScope || !entry.href) {
        return { ...entry, children: nextChildren }
      }
      const hasRichMarkup = Boolean(entry.rawHtml && entry.rawHtml.includes('<'))
      if (hasRichMarkup && !overwriteRich) {
        skippedRichCount += 1
        return { ...entry, children: nextChildren }
      }

      const { path, fragment } = splitFragment(entry.href)
      if (!path) return { ...entry, children: nextChildren }
      const targetPath = resolvePath(tocDir, path)
      const doc = getDoc(targetPath)
      if (!doc) return { ...entry, children: nextChildren }
      const nextLabel = findHeadingLabelInDoc(doc, fragment)
      if (!nextLabel || nextLabel === entry.label) {
        return { ...entry, children: nextChildren }
      }
      updatedCount += 1
      return {
        ...entry,
        label: nextLabel,
        rawHtml: '',
        children: nextChildren,
      }
    })

  return {
    entries: visit(cloned),
    updatedCount,
    skippedRichCount,
  }
}
