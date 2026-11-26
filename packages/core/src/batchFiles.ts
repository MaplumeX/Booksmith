import { readNavToc, writeNavToc } from './nav'
import { readNcxToc, writeNcxToc } from './ncx'
import { removeManifestEntries, renameManifestEntries } from './opfEdit'
import { dirname, resolvePath } from './path'
import { collectReferences, rewriteReferences, type BookReference } from './references'
import { findCoverPaths } from './stylesheets'
import type { TocEntry } from './toc'
import type { EpubArchive, EpubPackage } from './types'
import { CONTAINER_PATH, parsePackage } from './unpack'
import type { XmlCodec } from './xml'

/**
 * Pure batch file-management primitives: protected-path checks, rule-based batch rename planning
 * & execution (including chained/swapped renames), batch delete with grouped external references
 * and risk flags, and non-contiguous spine reordering.
 * See ADR 2026-11-26-filetree-batch-operations.
 */

const encoder = new TextEncoder()

function basenameOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? path : path.slice(index + 1)
}

function splitName(filename: string): { stem: string; ext: string } {
  const dot = filename.lastIndexOf('.')
  if (dot <= 0) return { stem: filename, ext: '' }
  return { stem: filename.slice(0, dot), ext: filename.slice(dot) }
}

function lineOf(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1
  }
  return line
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Archive paths that must never be selected, renamed, or deleted in batch operations because
 * removing or moving them breaks EPUB container discovery.
 */
export function isProtectedArchivePath(path: string, pkg: Pick<EpubPackage, 'opfPath'>): boolean {
  return path === CONTAINER_PATH || path === 'mimetype' || path === pkg.opfPath
}

export type BatchRenameRule =
  | {
      mode: 'sequence'
      prefix: string
      start: number
      padWidth: number
      preserveExtension: boolean
    }
  | {
      mode: 'replace'
      find: string
      replace: string
      caseSensitive?: boolean
      preserveExtension: boolean
    }
  | {
      mode: 'affix'
      prefix: string
      suffix: string
      preserveExtension: boolean
    }

export type BatchRenameItemStatus = 'changed' | 'unchanged' | 'invalid' | 'conflict'

export interface BatchRenamePreviewItem {
  from: string
  to: string
  fromName: string
  toName: string
  status: BatchRenameItemStatus
  reason?: string
}

export interface BatchRenamePlan {
  items: BatchRenamePreviewItem[]
  renames: Map<string, string>
  changedCount: number
  unchangedCount: number
  errorCount: number
  canApply: boolean
}

function computeCandidateName(fromName: string, index: number, rule: BatchRenameRule): { name: string; stemEmpty: boolean } {
  const { stem, ext } = splitName(fromName)
  const target = rule.preserveExtension ? stem : fromName
  let nextTarget: string

  if (rule.mode === 'sequence') {
    const start = Number.isFinite(rule.start) ? Math.max(0, Math.floor(rule.start)) : 1
    const width = Number.isFinite(rule.padWidth) ? Math.max(1, Math.min(8, Math.floor(rule.padWidth))) : 3
    const seq = String(start + index).padStart(width, '0')
    nextTarget = `${rule.prefix}${seq}`
  } else if (rule.mode === 'replace') {
    if (!rule.find) {
      nextTarget = target
    } else {
      const pattern = new RegExp(escapeRegExp(rule.find), rule.caseSensitive === false ? 'gi' : 'g')
      nextTarget = target.replace(pattern, rule.replace)
    }
  } else {
    nextTarget = `${rule.prefix}${target}${rule.suffix}`
  }

  if (rule.preserveExtension) {
    return { name: `${nextTarget}${ext}`, stemEmpty: nextTarget.trim().length === 0 }
  }
  return { name: nextTarget, stemEmpty: nextTarget.trim().length === 0 }
}

/**
 * Computes a live preview and collision report for renaming `paths` according to `rule`.
 * Allows within-batch swaps (`a <-> b`) and chains (`b -> a, a -> x`) while flagging collisions
 * with non-moving existing files or duplicate targets inside the batch.
 */
export function planBatchRename(
  paths: readonly string[],
  rule: BatchRenameRule,
  existingPaths: ReadonlySet<string>,
  protectedPaths?: ReadonlySet<string>,
): BatchRenamePlan {
  const uniquePaths = Array.from(new Set(paths))
  const drafts = uniquePaths.map((from, index) => {
    const fromName = basenameOf(from)
    const dir = dirname(from)
    if (protectedPaths?.has(from)) {
      return {
        from,
        to: from,
        fromName,
        toName: fromName,
        invalidReason: '受保护的容器文件无法重命名',
      }
    }
    const { name: toName, stemEmpty } = computeCandidateName(fromName, index, rule)
    let invalidReason: string | undefined
    if (!toName || !toName.trim()) {
      invalidReason = '文件名不能为空'
    } else if (toName.includes('/') || toName.includes('\\') || toName.includes('\0')) {
      invalidReason = '文件名不能包含路径分隔符'
    } else if (toName === '.' || toName === '..') {
      invalidReason = '文件名不合法'
    } else if (rule.preserveExtension && stemEmpty) {
      invalidReason = '主文件名不能为空'
    }
    const to = dir ? `${dir}/${toName}` : toName
    return { from, to, fromName, toName, invalidReason }
  })

  // Track which paths are vacating their slots so chains (b -> a, a -> x) and swaps (a <-> b) validate cleanly.
  // See ADR 2026-11-26-filetree-batch-operations.
  const movingSources = new Set<string>()
  const targetCounts = new Map<string, number>()

  for (const draft of drafts) {
    if (draft.invalidReason) continue
    targetCounts.set(draft.to, (targetCounts.get(draft.to) ?? 0) + 1)
    if (draft.to !== draft.from) {
      movingSources.add(draft.from)
    }
  }

  const items: BatchRenamePreviewItem[] = []
  const renames = new Map<string, string>()
  let changedCount = 0
  let unchangedCount = 0
  let errorCount = 0

  for (const draft of drafts) {
    if (draft.invalidReason) {
      items.push({
        from: draft.from,
        to: draft.to,
        fromName: draft.fromName,
        toName: draft.toName,
        status: 'invalid',
        reason: draft.invalidReason,
      })
      errorCount += 1
      continue
    }

    const dupCount = targetCounts.get(draft.to) ?? 0
    if (dupCount > 1) {
      items.push({
        from: draft.from,
        to: draft.to,
        fromName: draft.fromName,
        toName: draft.toName,
        status: 'conflict',
        reason: '与同批其他目标文件名重名',
      })
      errorCount += 1
      continue
    }

    if (draft.to !== draft.from && existingPaths.has(draft.to) && !movingSources.has(draft.to)) {
      items.push({
        from: draft.from,
        to: draft.to,
        fromName: draft.fromName,
        toName: draft.toName,
        status: 'conflict',
        reason: '该目录下已存在同名文件',
      })
      errorCount += 1
      continue
    }

    if (draft.to === draft.from) {
      items.push({
        from: draft.from,
        to: draft.to,
        fromName: draft.fromName,
        toName: draft.toName,
        status: 'unchanged',
      })
      unchangedCount += 1
      continue
    }

    items.push({
      from: draft.from,
      to: draft.to,
      fromName: draft.fromName,
      toName: draft.toName,
      status: 'changed',
    })
    renames.set(draft.from, draft.to)
    changedCount += 1
  }

  return {
    items,
    renames,
    changedCount,
    unchangedCount,
    errorCount,
    canApply: errorCount === 0 && changedCount > 0,
  }
}

export interface RenameFilesInBookResult {
  files: Map<string, string>
  archive: EpubArchive
  pkg: EpubPackage
  renames: Map<string, string>
  touchedReferences: BookReference[]
}

/**
 * Atomically renames one or more files in the book, updating OPF manifest hrefs in a single DOM
 * pass and rewriting all text/CSS/TOC references in a single text pass so swaps and chains work
 * without double-rewriting or reformatting prose.
 */
export function renameFilesInBook(args: {
  files: Map<string, string>
  pkg: EpubPackage
  archive: EpubArchive
  renames: ReadonlyMap<string, string>
  codec: XmlCodec
}): RenameFilesInBookResult {
  const { files, pkg, archive, codec } = args
  const effective = new Map<string, string>()

  for (const [from, to] of args.renames) {
    if (from === to) continue
    if (!archive.entries.has(from)) {
      throw new Error(`找不到要重命名的文件：${from}`)
    }
    if (isProtectedArchivePath(from, pkg) || isProtectedArchivePath(to, pkg)) {
      throw new Error(`受保护的容器文件无法重命名：${from}`)
    }
    if (!to || to.includes('\\') || to.includes('\0') || to.endsWith('/')) {
      throw new Error(`目标路径不合法：${to}`)
    }
    effective.set(from, to)
  }

  if (effective.size === 0) {
    return {
      files: new Map(files),
      archive,
      pkg,
      renames: effective,
      touchedReferences: [],
    }
  }

  const seenTargets = new Set<string>()
  for (const [from, to] of effective) {
    if (seenTargets.has(to)) {
      throw new Error(`目标文件名冲突：${to}`)
    }
    seenTargets.add(to)
    if (archive.entries.has(to) && !effective.has(to)) {
      throw new Error(`目标路径已存在文件：${to}`)
    }
    if (dirname(from) !== dirname(to)) {
      throw new Error(`批量重命名不支持跨目录移动：${from} -> ${to}`)
    }
  }

  const opfPath = pkg.opfPath
  const opfDir = dirname(opfPath)
  const manifestPaths = new Set(pkg.manifest.map((item) => item.path))
  const manifestRenames = new Map<string, string>()
  for (const [from, to] of effective) {
    if (manifestPaths.has(from)) manifestRenames.set(from, to)
  }

  // Skip OPF in text-level reference rewriting so manifest hrefs updated via DOM are never double-rewritten on chains.
  // See ADR 2026-11-26-filetree-batch-operations.
  const rewritten = rewriteReferences(files, effective, { skipPaths: new Set([opfPath]) })

  const nextOpf =
    manifestRenames.size > 0
      ? renameManifestEntries(files.get(opfPath) ?? '', manifestRenames, opfDir, codec)
      : (files.get(opfPath) ?? '')

  // Remap text & binary maps into fresh containers so swaps (a <-> b) and chains never clobber keys.
  const nextFiles = new Map<string, string>()
  for (const [path, text] of rewritten.files) {
    const dest = effective.get(path) ?? path
    nextFiles.set(dest, text)
  }
  nextFiles.set(opfPath, nextOpf)

  const nextEntries = new Map<string, Uint8Array>()
  for (const [path, bytes] of archive.entries) {
    const dest = effective.get(path) ?? path
    nextEntries.set(dest, bytes)
  }
  for (const [path, text] of nextFiles) {
    if (nextEntries.has(path)) {
      nextEntries.set(path, encoder.encode(text))
    }
  }

  const nextOrder = archive.order.map((path) => effective.get(path) ?? path)
  const nextArchive: EpubArchive = { order: nextOrder, entries: nextEntries }
  const nextPkg = parsePackage(nextOpf, opfPath, codec.parse)

  return {
    files: nextFiles,
    archive: nextArchive,
    pkg: nextPkg,
    renames: effective,
    touchedReferences: rewritten.touched,
  }
}

export interface BatchDeleteReference {
  from: string
  line: number
  raw: string
}

export interface BatchDeleteReferenceGroup {
  targetPath: string
  references: BatchDeleteReference[]
}

export interface BatchDeleteInspection {
  paths: string[]
  referenceGroups: BatchDeleteReferenceGroup[]
  totalReferences: number
  includesNav: boolean
  includesNcx: boolean
  coverPaths: string[]
  emptiesAllChapters: boolean
}

/**
 * Inspects external references and structural risks before deleting one or more files.
 * Mutual references between files inside the same deletion batch are excluded.
 */
export function inspectBatchDelete(args: {
  files: ReadonlyMap<string, string>
  pkg: EpubPackage
  paths: readonly string[]
}): BatchDeleteInspection {
  const { files, pkg } = args
  const validPaths = Array.from(new Set(args.paths)).filter((path) => !isProtectedArchivePath(path, pkg))
  const targetSet = new Set(validPaths)

  const byTarget = new Map<string, BatchDeleteReference[]>()
  for (const path of validPaths) byTarget.set(path, [])

  const filesMap = files instanceof Map ? files : new Map(files)
  for (const reference of collectReferences(filesMap)) {
    if (reference.from === pkg.opfPath) continue
    if (!targetSet.has(reference.targetPath)) continue
    // Ignore references originating from another file being deleted in the same batch.
    if (targetSet.has(reference.from)) continue
    const list = byTarget.get(reference.targetPath)
    if (!list) continue
    list.push({
      from: reference.from,
      line: lineOf(filesMap.get(reference.from) ?? '', reference.offset),
      raw: reference.raw,
    })
  }

  const referenceGroups: BatchDeleteReferenceGroup[] = []
  let totalReferences = 0
  for (const path of validPaths) {
    const references = byTarget.get(path) ?? []
    if (references.length > 0) {
      referenceGroups.push({ targetPath: path, references })
      totalReferences += references.length
    }
  }

  const coverSet = findCoverPaths(filesMap, pkg)
  const coverPaths = validPaths.filter((path) => coverSet.has(path))
  const spineFiles = pkg.spine
    .map((id) => pkg.manifest.find((item) => item.id === id)?.path)
    .filter((path): path is string => typeof path === 'string')

  return {
    paths: validPaths,
    referenceGroups,
    totalReferences,
    includesNav: Boolean(pkg.navPath && targetSet.has(pkg.navPath)),
    includesNcx: Boolean(pkg.ncxPath && targetSet.has(pkg.ncxPath)),
    coverPaths,
    emptiesAllChapters: spineFiles.length > 0 && spineFiles.every((path) => targetSet.has(path)),
  }
}

function pruneTocTargets(
  entries: TocEntry[],
  tocPath: string,
  removedSet: ReadonlySet<string>,
): { entries: TocEntry[]; changed: boolean } {
  let changed = false
  const kept: TocEntry[] = []
  for (const entry of entries) {
    const href = entry.href.split('#')[0] ?? ''
    if (href && removedSet.has(resolvePath(dirname(tocPath), href))) {
      changed = true
      continue
    }
    const children = pruneTocTargets(entry.children, tocPath, removedSet)
    if (children.changed) changed = true
    kept.push(children.changed ? { ...entry, children: children.entries } : entry)
  }
  return { entries: kept, changed }
}

export interface DeleteFilesInBookResult {
  files: Map<string, string>
  archive: EpubArchive
  pkg: EpubPackage
  removedPaths: string[]
}

/**
 * Atomically deletes one or more unprotected files from OPF manifest/spine, prunes dangling TOC
 * entries in surviving nav/ncx documents, and removes archive entries.
 */
export function deleteFilesInBook(args: {
  files: Map<string, string>
  pkg: EpubPackage
  archive: EpubArchive
  paths: readonly string[]
  codec: XmlCodec
}): DeleteFilesInBookResult {
  const { files, pkg, archive, codec } = args
  const removedPaths = Array.from(new Set(args.paths)).filter(
    (path) => archive.entries.has(path) && !isProtectedArchivePath(path, pkg),
  )

  if (removedPaths.length === 0) {
    return { files: new Map(files), archive, pkg, removedPaths: [] }
  }

  const removedSet = new Set(removedPaths)
  const opfPath = pkg.opfPath
  const nextFiles = new Map(files)
  const nextOpf = removeManifestEntries(nextFiles.get(opfPath) ?? '', removedSet, dirname(opfPath), codec)
  nextFiles.set(opfPath, nextOpf)

  if (pkg.navPath && !removedSet.has(pkg.navPath)) {
    const navXml = nextFiles.get(pkg.navPath)
    if (navXml) {
      try {
        const pruned = pruneTocTargets(readNavToc(navXml, codec), pkg.navPath, removedSet)
        if (pruned.changed) nextFiles.set(pkg.navPath, writeNavToc(navXml, pruned.entries, codec))
      } catch {
        // Leave unreadable nav untouched; the structure check panel reports it.
      }
    }
  }

  if (pkg.ncxPath && !removedSet.has(pkg.ncxPath)) {
    const ncxXml = nextFiles.get(pkg.ncxPath)
    if (ncxXml) {
      try {
        const pruned = pruneTocTargets(readNcxToc(ncxXml, codec), pkg.ncxPath, removedSet)
        if (pruned.changed) nextFiles.set(pkg.ncxPath, writeNcxToc(ncxXml, pruned.entries, codec))
      } catch {
        // Same as above.
      }
    }
  }

  const nextEntries = new Map(archive.entries)
  for (const path of removedPaths) {
    nextFiles.delete(path)
    nextEntries.delete(path)
  }

  nextEntries.set(opfPath, encoder.encode(nextOpf))
  if (pkg.navPath && !removedSet.has(pkg.navPath) && nextFiles.has(pkg.navPath)) {
    nextEntries.set(pkg.navPath, encoder.encode(nextFiles.get(pkg.navPath)!))
  }
  if (pkg.ncxPath && !removedSet.has(pkg.ncxPath) && nextFiles.has(pkg.ncxPath)) {
    nextEntries.set(pkg.ncxPath, encoder.encode(nextFiles.get(pkg.ncxPath)!))
  }

  const nextOrder = archive.order.filter((path) => !removedSet.has(path))
  const nextArchive: EpubArchive = { order: nextOrder, entries: nextEntries }
  const nextPkg = parsePackage(nextOpf, opfPath, codec.parse)

  return {
    files: nextFiles,
    archive: nextArchive,
    pkg: nextPkg,
    removedPaths,
  }
}

export interface BatchSpineMoveCapability {
  canMoveUp: boolean
  canMoveDown: boolean
}

/**
 * Checks whether a selection of chapters can shift up or down by one slot while preserving
 * relative spacing between non-contiguous items.
 */
export function getBatchSpineMoveCapability(
  spineOrder: readonly string[],
  selectedPaths: ReadonlySet<string>,
): BatchSpineMoveCapability {
  if (spineOrder.length < 2 || selectedPaths.size === 0) {
    return { canMoveUp: false, canMoveDown: false }
  }
  const spineSet = new Set(spineOrder)
  let selectedCountInSpine = 0
  for (const path of selectedPaths) {
    if (!spineSet.has(path)) return { canMoveUp: false, canMoveDown: false }
    selectedCountInSpine += 1
  }
  if (selectedCountInSpine === 0 || selectedCountInSpine >= spineOrder.length) {
    return { canMoveUp: false, canMoveDown: false }
  }
  return {
    canMoveUp: !selectedPaths.has(spineOrder[0]!),
    canMoveDown: !selectedPaths.has(spineOrder[spineOrder.length - 1]!),
  }
}

/**
 * Shifts every selected chapter by 1 slot in `delta` direction while keeping relative spacing
 * intact. Returns `null` when the boundary item is already at the edge or any selected path is
 * outside the spine.
 */
export function computeBatchSpineMove(
  spineOrder: readonly string[],
  selectedPaths: ReadonlySet<string>,
  delta: -1 | 1,
): string[] | null {
  const capability = getBatchSpineMoveCapability(spineOrder, selectedPaths)
  if ((delta === -1 && !capability.canMoveUp) || (delta === 1 && !capability.canMoveDown)) {
    return null
  }

  const next = [...spineOrder]
  if (delta === -1) {
    for (let i = 1; i < next.length; i += 1) {
      if (selectedPaths.has(next[i]!) && !selectedPaths.has(next[i - 1]!)) {
        const tmp = next[i - 1]!
        next[i - 1] = next[i]!
        next[i] = tmp
      }
    }
  } else {
    for (let i = next.length - 2; i >= 0; i -= 1) {
      if (selectedPaths.has(next[i]!) && !selectedPaths.has(next[i + 1]!)) {
        const tmp = next[i + 1]!
        next[i + 1] = next[i]!
        next[i] = tmp
      }
    }
  }

  return next
}
