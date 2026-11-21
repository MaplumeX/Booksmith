import { detectDominantEol } from './chapterSplit'
import { removeManifestEntry } from './opfEdit'
import { addManifestItem } from './opfWrite'
import { dirname, relativePath, resolvePath, splitFragment } from './path'
import { collectReferences } from './references'
import type { EpubArchive, EpubPackage } from './types'
import { parsePackage } from './unpack'
import type { XmlCodec } from './xml'

/**
 * Stylesheet creation, chapter `<link rel="stylesheet">` management, and unused resource cleanup.
 * See ADR 2026-11-21-chapter-structure-and-resource-tools.
 */

const encoder = new TextEncoder()
const LINK_TAG_PATTERN = /[ \t]*<link\b[^>]*\/?>(?:[ \t]*\r?\n)?/gi
const IMAGE_TYPE = /^image\//i
const FONT_TYPE = /^(?:font\/|application\/(?:font|vnd\.ms-opentype|x-font))/i
const CSS_TYPE = /^text\/css$/i

export type UnusedResourceCategory = 'image' | 'font' | 'stylesheet'

export interface UnusedResource {
  path: string
  href: string
  mediaType: string
  category: UnusedResourceCategory
  byteSize: number
}

function isStylesheetLinkTag(tag: string): boolean {
  return /\brel\s*=\s*(?:"[^"]*\bstylesheet\b[^"]*"|'[^']*\bstylesheet\b[^']*')/i.test(tag)
}

function extractLinkHref(tag: string): string | null {
  const match = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag)
  const raw = (match?.[1] ?? match?.[2] ?? '').trim()
  return raw || null
}

function findHeadBounds(xhtml: string): { openEnd: number; closeStart: number } | null {
  const openMatch = /<head(?:\s[^>]*)?>/i.exec(xhtml)
  if (!openMatch || openMatch.index === undefined) return null
  const openEnd = openMatch.index + openMatch[0].length
  const closeStart = xhtml.toLowerCase().indexOf('</head>', openEnd)
  if (closeStart < 0) return null
  return { openEnd, closeStart }
}

/** Lists all `.css` stylesheets registered in the book manifest or archive. */
export function listBookStylesheets(pkg: EpubPackage, archive: EpubArchive): string[] {
  const paths = new Set<string>()
  for (const item of pkg.manifest) {
    if (CSS_TYPE.test(item.mediaType) || item.path.toLowerCase().endsWith('.css')) {
      if (archive.entries.has(item.path)) paths.add(item.path)
    }
  }
  for (const path of archive.order) {
    if (path.toLowerCase().endsWith('.css') && archive.entries.has(path)) {
      paths.add(path)
    }
  }
  return Array.from(paths).sort((a, b) => a.localeCompare(b, 'en'))
}

/** Returns resolved archive paths of all local `<link rel="stylesheet">` entries inside `<head>`. */
export function getLinkedStylesheets(xhtml: string, chapterPath: string): string[] {
  const head = findHeadBounds(xhtml)
  if (!head) return []
  const headInner = xhtml.slice(head.openEnd, head.closeStart).replace(/<!--[\s\S]*?-->/g, '')
  const baseDir = dirname(chapterPath)
  const out: string[] = []

  for (const match of headInner.matchAll(/<link\b[^>]*\/?>/gi)) {
    const tag = match[0]
    if (!isStylesheetLinkTag(tag)) continue
    const rawHref = extractLinkHref(tag)
    if (!rawHref || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rawHref) || rawHref.startsWith('//')) continue
    try {
      const resolved = resolvePath(baseDir, splitFragment(rawHref).path)
      if (!out.includes(resolved)) out.push(resolved)
    } catch {
      // Ignore malformed hrefs.
    }
  }
  return out
}

/**
 * Updates `<link rel="stylesheet">` tags in a chapter's `<head>` to match `desiredCssPaths`.
 * Preserves existing linked tags verbatim, leaves unrelated `<head>` nodes untouched, and returns
 * the original string verbatim when no links need to be added or removed.
 */
export function setChapterStylesheets(xhtml: string, chapterPath: string, desiredCssPaths: string[]): string {
  const head = findHeadBounds(xhtml)
  if (!head) return xhtml

  const desiredOrdered = Array.from(new Set(desiredCssPaths))
  const desiredSet = new Set(desiredOrdered)
  const currentLinked = getLinkedStylesheets(xhtml, chapterPath)
  const sameSet =
    currentLinked.length === desiredOrdered.length && currentLinked.every((path) => desiredSet.has(path))
  if (sameSet) return xhtml

  const eol = detectDominantEol(xhtml)
  const baseDir = dirname(chapterPath)
  const headInner = xhtml.slice(head.openEnd, head.closeStart)
  const keptPaths = new Set<string>()

  // Remove only stylesheet `<link>` tags not in `desiredSet` (skip matches inside HTML comments).
  const commentRanges: Array<[number, number]> = []
  for (const comment of headInner.matchAll(/<!--[\s\S]*?-->/g)) {
    if (comment.index !== undefined) commentRanges.push([comment.index, comment.index + comment[0].length])
  }
  const inComment = (pos: number) => commentRanges.some(([s, e]) => pos >= s && pos < e)

  let nextHeadInner = ''
  let cursor = 0
  for (const match of headInner.matchAll(LINK_TAG_PATTERN)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    if (inComment(start) || !isStylesheetLinkTag(match[0])) continue
    const rawHref = extractLinkHref(match[0])
    if (!rawHref || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rawHref) || rawHref.startsWith('//')) continue
    let resolved: string | null = null
    try {
      resolved = resolvePath(baseDir, splitFragment(rawHref).path)
    } catch {
      resolved = null
    }
    if (!resolved) continue

    if (desiredSet.has(resolved) && !keptPaths.has(resolved)) {
      keptPaths.add(resolved)
      continue
    }

    nextHeadInner += headInner.slice(cursor, start)
    cursor = end
  }
  nextHeadInner += headInner.slice(cursor)

  const missing = desiredOrdered.filter((cssPath) => !keptPaths.has(cssPath))
  if (missing.length > 0) {
    const additions = missing
      .map((cssPath) => `  <link rel="stylesheet" type="text/css" href="${relativePath(baseDir, cssPath)}" />`)
      .join(eol)
    const needsLead = nextHeadInner.length > 0 && !nextHeadInner.endsWith('\n')
    nextHeadInner = `${nextHeadInner}${needsLead ? eol : ''}${additions}${eol}`
  }

  return `${xhtml.slice(0, head.openEnd)}${nextHeadInner}${xhtml.slice(head.closeStart)}`
}

export interface UpdateChaptersStylesheetsOptions {
  /** Replace the full linked stylesheet list on every target chapter. */
  set?: string[]
  /** Add these stylesheets to every target chapter while preserving other linked styles. */
  add?: string[]
  /** Remove these stylesheets from every target chapter while preserving other linked styles. */
  remove?: string[]
}

export function updateChaptersStylesheets(
  files: Map<string, string>,
  chapterPaths: string[],
  options: UpdateChaptersStylesheetsOptions,
): { files: Map<string, string>; changedPaths: string[] } {
  const next = new Map(files)
  const changedPaths: string[] = []
  const removeSet = new Set(options.remove ?? [])

  for (const path of chapterPaths) {
    const current = files.get(path)
    if (current === undefined) continue
    let desired: string[]
    if (options.set !== undefined) {
      desired = options.set
    } else {
      const existing = getLinkedStylesheets(current, path)
      desired = existing.filter((css) => !removeSet.has(css))
      for (const css of options.add ?? []) {
        if (!desired.includes(css)) desired.push(css)
      }
    }
    const updated = setChapterStylesheets(current, path, desired)
    if (updated !== current) {
      next.set(path, updated)
      changedPaths.push(path)
    }
  }

  return { files: next, changedPaths }
}

export interface CreateStylesheetResult {
  files: Map<string, string>
  archive: EpubArchive
  pkg: EpubPackage
  createdPath: string
}

function defaultStylesDirectory(pkg: EpubPackage, archive: EpubArchive): string {
  const existing = listBookStylesheets(pkg, archive)[0]
  if (existing) return dirname(existing)
  const opfDir = dirname(pkg.opfPath)
  return opfDir ? `${opfDir}/styles` : 'styles'
}

function nextStylesheetFilename(dir: string, existing: ReadonlySet<string>): string {
  const prefix = dir ? `${dir}/` : ''
  let seq = 1
  while (true) {
    const name = `style${String(seq).padStart(3, '0')}.css`
    if (!existing.has(`${prefix}${name}`)) return name
    seq += 1
  }
}

export function createBlankStylesheet(args: {
  files: Map<string, string>
  pkg: EpubPackage
  archive: EpubArchive
  filename?: string
  content?: string
  codec: XmlCodec
}): CreateStylesheetResult {
  const { files, pkg, archive, codec } = args
  const dir = defaultStylesDirectory(pkg, archive)
  const occupied = new Set<string>(archive.entries.keys())
  for (const key of files.keys()) occupied.add(key)

  let name = args.filename?.trim() || nextStylesheetFilename(dir, occupied)
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error('样式表文件名不能包含路径分隔符。')
  }
  if (!name.toLowerCase().endsWith('.css')) name = `${name}.css`

  const createdPath = dir ? `${dir}/${name}` : name
  if (occupied.has(createdPath)) {
    throw new Error(`样式表已存在：${createdPath}`)
  }

  const opfDir = dirname(pkg.opfPath)
  const stem = name.replace(/\.css$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'style'
  const id = /^[a-zA-Z_]/.test(stem) ? stem : `css_${stem}`
  const cssContent = args.content ?? `/* ${name} */\n`

  const nextOpf = addManifestItem(
    files.get(pkg.opfPath) ?? '',
    { id, href: relativePath(opfDir, createdPath), mediaType: 'text/css' },
    codec,
  )

  const nextFiles = new Map(files)
  nextFiles.set(createdPath, cssContent)
  nextFiles.set(pkg.opfPath, nextOpf)

  const nextEntries = new Map(archive.entries)
  nextEntries.set(createdPath, encoder.encode(cssContent))
  nextEntries.set(pkg.opfPath, encoder.encode(nextOpf))

  const nextOrder = archive.order.includes(createdPath) ? [...archive.order] : [...archive.order, createdPath]
  const nextArchive: EpubArchive = { order: nextOrder, entries: nextEntries }
  const nextPkg = parsePackage(nextOpf, pkg.opfPath, codec.parse)

  return { files: nextFiles, archive: nextArchive, pkg: nextPkg, createdPath }
}

/** Finds EPUB 2 `<meta name="cover" content="itemId"/>` cover manifest IDs so covers are never flagged unused. */
function epub2CoverItemIds(opfXml: string): Set<string> {
  const ids = new Set<string>()
  for (const match of opfXml.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0]
    if (!/\bname\s*=\s*(?:"cover"|'cover')/i.test(tag)) continue
    const contentMatch = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag)
    const id = (contentMatch?.[1] ?? contentMatch?.[2] ?? '').trim()
    if (id) ids.add(id)
  }
  return ids
}

/**
 * Lists unreferenced images, fonts, and unlinked CSS stylesheets.
 * Excludes OPF self-declarations, spine documents, EPUB 3 `cover-image`, and EPUB 2 `<meta name="cover">`
 * so book covers are never mistakenly offered for deletion.
 * See ADR 2026-11-21-chapter-structure-and-resource-tools.
 */
export function findUnusedResources(
  files: Map<string, string>,
  pkg: EpubPackage,
  archive: EpubArchive,
  entrySizes?: ReadonlyMap<string, number>,
): UnusedResource[] {
  const referenced = new Set(
    collectReferences(files)
      .filter((reference) => reference.from !== pkg.opfPath)
      .map((reference) => reference.targetPath),
  )

  const inSpine = new Set(
    pkg.spine
      .map((id) => pkg.manifest.find((item) => item.id === id)?.path)
      .filter((path): path is string => typeof path === 'string'),
  )
  const coverIds = epub2CoverItemIds(files.get(pkg.opfPath) ?? '')

  const out: UnusedResource[] = []
  for (const item of pkg.manifest) {
    if (!archive.entries.has(item.path)) continue
    if (inSpine.has(item.path) || referenced.has(item.path)) continue
    if (item.path === pkg.navPath || item.path === pkg.ncxPath) continue
    if (item.properties?.includes('cover-image') || coverIds.has(item.id)) continue

    let category: UnusedResourceCategory | null = null
    if (IMAGE_TYPE.test(item.mediaType)) category = 'image'
    else if (FONT_TYPE.test(item.mediaType)) category = 'font'
    else if (CSS_TYPE.test(item.mediaType)) category = 'stylesheet'
    if (!category) continue

    const byteSize = entrySizes?.get(item.path) ?? archive.entries.get(item.path)?.byteLength ?? 0
    out.push({
      path: item.path,
      href: item.href,
      mediaType: item.mediaType,
      category,
      byteSize,
    })
  }

  return out
}

export interface DeleteUnusedResourcesResult {
  files: Map<string, string>
  archive: EpubArchive
  pkg: EpubPackage
  removedPaths: string[]
}

export function deleteUnusedResourcesInBook(args: {
  files: Map<string, string>
  pkg: EpubPackage
  archive: EpubArchive
  paths: string[]
  codec: XmlCodec
}): DeleteUnusedResourcesResult {
  const { files, pkg, archive, codec } = args
  const targets = Array.from(new Set(args.paths)).filter((path) => archive.entries.has(path))
  if (targets.length === 0) {
    return { files: new Map(files), archive, pkg, removedPaths: [] }
  }

  const nextFiles = new Map(files)
  const nextEntries = new Map(archive.entries)
  let nextOrder = [...archive.order]
  const opfDir = dirname(pkg.opfPath)
  let nextOpf = nextFiles.get(pkg.opfPath) ?? ''

  for (const path of targets) {
    try {
      nextOpf = removeManifestEntry(nextOpf, path, opfDir, codec)
    } catch {
      // Entry wasn't registered in manifest; still delete from archive.
    }
    nextFiles.delete(path)
    nextEntries.delete(path)
    nextOrder = nextOrder.filter((entry) => entry !== path)
  }

  nextFiles.set(pkg.opfPath, nextOpf)
  nextEntries.set(pkg.opfPath, encoder.encode(nextOpf))

  const nextArchive: EpubArchive = { order: nextOrder, entries: nextEntries }
  const nextPkg = parsePackage(nextOpf, pkg.opfPath, codec.parse)

  return { files: nextFiles, archive: nextArchive, pkg: nextPkg, removedPaths: targets }
}
