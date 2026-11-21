import {
  browserXmlParser,
  getLinkedStylesheets,
  parsePackage,
  type AgentProposal,
  type AgentProposalFile,
  type EpubArchive,
  type EpubPackage,
  type XmlDocumentParser,
} from '@booksmith/core'
import { diffLines, spinePaths, type LineDiff } from '../diff/document'
import { detectEol, normalizeEol, type EolStyle } from '../editor/eol'
import { checkXmlWellFormed } from '../editor/wysiwygXhtml'
import { extensionOf, type LoadedBook } from './bookStore'

/**
 * Pure per-hunk diff, selective recomposition, XML validation, and read-only virtual book overlay
 * for in-canvas Agent proposal review.
 *
 * Keeps review state isolated from the live workspace so browsing, toggling hunks, or previewing
 * styles never mutates dirty state, drafts, or autosave timers.
 * See ADR 2026-11-21-in-canvas-agent-proposal-review.
 */

const encoder = new TextEncoder()

export interface ProposalHunk {
  id: string
  index: number
  beforeStart: number
  beforeCount: number
  afterStart: number
  afterCount: number
  beforeLines: string[]
  afterLines: string[]
  lines: LineDiff[]
  addedCount: number
  removedCount: number
}

export interface NumberedDiffLine {
  index: number
  beforeLine: number | null
  afterLine: number | null
  hunkId: string | null
  diff: LineDiff
}

export interface FileDiffModel {
  file: AgentProposalFile
  eol: EolStyle
  allLines: NumberedDiffLine[]
  hunks: ProposalHunk[]
  added: number
  removed: number
  isNoopText: boolean
}

export interface FileHunkSelectionSummary {
  total: number
  kept: number
}

export interface ComposedProposalPlan {
  selectedPaths: Set<string>
  composedTexts: Map<string, string>
  totalHunks: number
  keptHunks: number
  fileStates: Map<string, FileHunkSelectionSummary>
}

export interface XmlValidationFailure {
  path: string
  message: string
}

export interface VirtualReviewBook {
  archive: EpubArchive
  pkg: EpubPackage
  texts: Map<string, string>
}

function splitNormalizedLines(text: string): string[] {
  if (text.length === 0) return []
  return normalizeEol(text).split('\n')
}

export function isChapterPath(path: string): boolean {
  const ext = extensionOf(path)
  return ext === 'xhtml' || ext === 'html' || ext === 'htm'
}

export function isCssPath(path: string): boolean {
  return extensionOf(path) === 'css'
}

function isXmlLikePath(path: string): boolean {
  const ext = extensionOf(path)
  return ext === 'xhtml' || ext === 'html' || ext === 'htm' || ext === 'opf' || ext === 'ncx' || ext === 'xml' || ext === 'svg'
}

export function buildFileHunks(file: AgentProposalFile): FileDiffModel {
  const sourceSeed = file.beforeText ?? file.afterText ?? ''
  const eol = detectEol(sourceSeed)

  if (file.kind === 'create') {
    const afterLines = splitNormalizedLines(file.afterText ?? '')
    if (afterLines.length === 0) {
      return { file, eol, allLines: [], hunks: [], added: 0, removed: 0, isNoopText: true }
    }
    const hunkId = 'hunk-0'
    const diffEntries: LineDiff[] = afterLines.map((text) => ({ kind: 'added', text }))
    const allLines: NumberedDiffLine[] = diffEntries.map((diff, idx) => ({
      index: idx,
      beforeLine: null,
      afterLine: idx + 1,
      hunkId,
      diff,
    }))
    const hunk: ProposalHunk = {
      id: hunkId,
      index: 0,
      beforeStart: 1,
      beforeCount: 0,
      afterStart: 1,
      afterCount: afterLines.length,
      beforeLines: [],
      afterLines,
      lines: diffEntries,
      addedCount: afterLines.length,
      removedCount: 0,
    }
    return {
      file,
      eol,
      allLines,
      hunks: [hunk],
      added: afterLines.length,
      removed: 0,
      isNoopText: false,
    }
  }

  if (file.kind === 'delete') {
    const beforeLines = splitNormalizedLines(file.beforeText ?? '')
    if (beforeLines.length === 0) {
      return { file, eol, allLines: [], hunks: [], added: 0, removed: 0, isNoopText: true }
    }
    const hunkId = 'hunk-0'
    const diffEntries: LineDiff[] = beforeLines.map((text) => ({ kind: 'removed', text }))
    const allLines: NumberedDiffLine[] = diffEntries.map((diff, idx) => ({
      index: idx,
      beforeLine: idx + 1,
      afterLine: null,
      hunkId,
      diff,
    }))
    const hunk: ProposalHunk = {
      id: hunkId,
      index: 0,
      beforeStart: 1,
      beforeCount: beforeLines.length,
      afterStart: 1,
      afterCount: 0,
      beforeLines,
      afterLines: [],
      lines: diffEntries,
      addedCount: 0,
      removedCount: beforeLines.length,
    }
    return {
      file,
      eol,
      allLines,
      hunks: [hunk],
      added: 0,
      removed: beforeLines.length,
      isNoopText: false,
    }
  }

  const beforeNorm = normalizeEol(file.beforeText ?? '')
  const afterNorm = normalizeEol(file.afterText ?? '')
  if (beforeNorm === afterNorm) {
    const sameLines = beforeNorm.length === 0 ? [] : beforeNorm.split('\n')
    const allLines: NumberedDiffLine[] = sameLines.map((text, idx) => ({
      index: idx,
      beforeLine: idx + 1,
      afterLine: idx + 1,
      hunkId: null,
      diff: { kind: 'same', text },
    }))
    return { file, eol, allLines, hunks: [], added: 0, removed: 0, isNoopText: true }
  }

  const rawLines = diffLines(beforeNorm, afterNorm)
  const allLines: NumberedDiffLine[] = []
  const hunks: ProposalHunk[] = []

  let beforeCursor = 1
  let afterCursor = 1
  let totalAdded = 0
  let totalRemoved = 0
  let cursor = 0

  while (cursor < rawLines.length) {
    const line = rawLines[cursor]!
    if (line.kind === 'same') {
      allLines.push({
        index: allLines.length,
        beforeLine: beforeCursor,
        afterLine: afterCursor,
        hunkId: null,
        diff: line,
      })
      beforeCursor += 1
      afterCursor += 1
      cursor += 1
      continue
    }

    const hunkIndex = hunks.length
    const hunkId = `hunk-${hunkIndex}`
    const beforeStart = beforeCursor
    const afterStart = afterCursor
    const beforeLines: string[] = []
    const afterLines: string[] = []
    const hunkDiffLines: LineDiff[] = []
    let addedCount = 0
    let removedCount = 0

    while (cursor < rawLines.length && rawLines[cursor]!.kind !== 'same') {
      const entry = rawLines[cursor]!
      hunkDiffLines.push(entry)
      if (entry.kind === 'removed') {
        allLines.push({
          index: allLines.length,
          beforeLine: beforeCursor,
          afterLine: null,
          hunkId,
          diff: entry,
        })
        beforeLines.push(entry.text)
        beforeCursor += 1
        removedCount += 1
      } else if (entry.kind === 'added') {
        allLines.push({
          index: allLines.length,
          beforeLine: null,
          afterLine: afterCursor,
          hunkId,
          diff: entry,
        })
        afterLines.push(entry.text)
        afterCursor += 1
        addedCount += 1
      } else if (entry.kind === 'changed') {
        const beforeTextLine = entry.segments
          .filter((seg) => seg.kind !== 'added')
          .map((seg) => seg.text)
          .join('')
        const afterTextLine = entry.segments
          .filter((seg) => seg.kind !== 'removed')
          .map((seg) => seg.text)
          .join('')
        allLines.push({
          index: allLines.length,
          beforeLine: beforeCursor,
          afterLine: afterCursor,
          hunkId,
          diff: entry,
        })
        beforeLines.push(beforeTextLine)
        afterLines.push(afterTextLine)
        beforeCursor += 1
        afterCursor += 1
        addedCount += 1
        removedCount += 1
      }
      cursor += 1
    }

    totalAdded += addedCount
    totalRemoved += removedCount
    hunks.push({
      id: hunkId,
      index: hunkIndex,
      beforeStart,
      beforeCount: beforeLines.length,
      afterStart,
      afterCount: afterLines.length,
      beforeLines,
      afterLines,
      lines: hunkDiffLines,
      addedCount,
      removedCount,
    })
  }

  return {
    file,
    eol,
    allLines,
    hunks,
    added: totalAdded,
    removed: totalRemoved,
    isNoopText: hunks.length === 0,
  }
}

export function composeFileFromHunks(
  model: FileDiffModel,
  skippedHunkIds: ReadonlySet<string> | undefined,
): string {
  if (!skippedHunkIds || skippedHunkIds.size === 0) {
    return model.file.afterText ?? ''
  }
  if (model.hunks.length === 0) {
    return model.file.afterText ?? model.file.beforeText ?? ''
  }

  const allSkipped = model.hunks.every((hunk) => skippedHunkIds.has(hunk.id))
  if (allSkipped) {
    return model.file.beforeText ?? ''
  }

  const hunkById = new Map(model.hunks.map((hunk) => [hunk.id, hunk]))
  const outLines: string[] = []
  const emittedHunks = new Set<string>()

  for (const row of model.allLines) {
    if (row.hunkId === null) {
      if (row.diff.kind === 'same') outLines.push(row.diff.text)
      continue
    }
    if (emittedHunks.has(row.hunkId)) continue
    emittedHunks.add(row.hunkId)
    const hunk = hunkById.get(row.hunkId)
    if (!hunk) continue
    if (skippedHunkIds.has(hunk.id)) {
      outLines.push(...hunk.beforeLines)
    } else {
      outLines.push(...hunk.afterLines)
    }
  }

  return outLines.join(model.eol)
}

export function buildComposedProposalPlan(
  proposal: AgentProposal,
  modelsByPath: ReadonlyMap<string, FileDiffModel>,
  skippedByPath: Readonly<Record<string, ReadonlySet<string>>>,
): ComposedProposalPlan {
  const selectedPaths = new Set<string>()
  const composedTexts = new Map<string, string>()
  const fileStates = new Map<string, FileHunkSelectionSummary>()
  let totalHunks = 0
  let keptHunks = 0

  for (const file of proposal.files) {
    const model = modelsByPath.get(file.path) ?? buildFileHunks(file)
    const fileTotal = model.hunks.length
    totalHunks += fileTotal

    if (proposal.isStructural) {
      keptHunks += fileTotal
      fileStates.set(file.path, { total: fileTotal, kept: fileTotal })
      selectedPaths.add(file.path)
      continue
    }

    const skipped = skippedByPath[file.path]
    const fileKept = model.hunks.reduce((acc, hunk) => acc + (skipped?.has(hunk.id) ? 0 : 1), 0)
    keptHunks += fileKept
    fileStates.set(file.path, { total: fileTotal, kept: fileKept })

    if (fileTotal === 0) {
      // No-op text files need not block or mutate anything.
      continue
    }

    if (fileKept === 0) continue

    selectedPaths.add(file.path)
    if (fileKept < fileTotal) {
      composedTexts.set(file.path, composeFileFromHunks(model, skipped))
    }
  }

  return { selectedPaths, composedTexts, totalHunks, keptHunks, fileStates }
}

/**
 * Validates that selectively skipped hunks on XML/XHTML files still produce well-formed markup
 * before allowing browser workspace application. See ADR 2026-11-21-in-canvas-agent-proposal-review.
 */
export function validateComposedProposal(
  proposal: AgentProposal,
  plan: ComposedProposalPlan,
  parseXml: XmlDocumentParser = browserXmlParser,
): XmlValidationFailure[] {
  if (proposal.isStructural) return []

  const failures: XmlValidationFailure[] = []
  for (const [path, text] of plan.composedTexts) {
    if (!isXmlLikePath(path)) continue
    if (isChapterPath(path)) {
      const check = checkXmlWellFormed(text, parseXml)
      if (!check.ok) {
        failures.push({
          path,
          message: `部分跳过改动导致 ${path} 的 XHTML 结构不再闭合（${check.message}），请恢复关联变更块或切换到源码视图核对。`,
        })
      }
      continue
    }
    try {
      const doc = parseXml(text)
      const root = doc.documentElement
      const errors = doc.getElementsByTagName('parsererror')
      if (!root || root.nodeName === 'parsererror' || errors.length > 0) {
        const detail = errors[0]?.textContent?.trim().split('\n')[0]
        failures.push({
          path,
          message: detail
            ? `部分跳过改动导致 ${path} 的 XML 语法不闭合：${detail}`
            : `部分跳过改动导致 ${path} 的 XML 语法不闭合，请恢复关联变更块。`,
        })
      }
    } catch (error) {
      failures.push({
        path,
        message: `部分跳过改动导致 ${path} 解析失败：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  return failures
}

export function buildVirtualReviewBook(args: {
  book: LoadedBook
  texts: ReadonlyMap<string, string>
  proposal: AgentProposal
  modelsByPath?: ReadonlyMap<string, FileDiffModel>
  skippedByPath?: Readonly<Record<string, ReadonlySet<string>>>
  readOnly?: boolean
  cssOverride?: { path: string; mode: 'before' | 'after' } | null
  parseXml?: XmlDocumentParser
}): VirtualReviewBook {
  const {
    book,
    texts,
    proposal,
    modelsByPath,
    skippedByPath = {},
    readOnly = false,
    cssOverride = null,
    parseXml = browserXmlParser,
  } = args

  const nextEntries = new Map(book.archive.entries)
  let nextOrder = [...book.archive.order]
  const nextTexts = new Map(texts)

  for (const file of proposal.files) {
    if (file.kind === 'rename' && file.previousPath) {
      const existing = nextEntries.get(file.previousPath)
      nextEntries.delete(file.previousPath)
      nextTexts.delete(file.previousPath)
      const finalText = file.afterText
      if (finalText !== undefined) {
        nextEntries.set(file.path, encoder.encode(finalText))
        nextTexts.set(file.path, finalText)
      } else if (existing) {
        nextEntries.set(file.path, existing)
      }
      nextOrder = nextOrder.map((p) => (p === file.previousPath ? file.path : p))
      if (!nextOrder.includes(file.path)) nextOrder.push(file.path)
      continue
    }

    if (file.kind === 'delete') {
      nextEntries.delete(file.path)
      nextTexts.delete(file.path)
      nextOrder = nextOrder.filter((p) => p !== file.path)
      continue
    }

    let nextText = file.afterText
    if (!readOnly && !proposal.isStructural && file.kind === 'update') {
      const model = modelsByPath?.get(file.path) ?? buildFileHunks(file)
      nextText = composeFileFromHunks(model, skippedByPath[file.path])
    }
    if (cssOverride && cssOverride.path === file.path && cssOverride.mode === 'before') {
      nextText = file.beforeText ?? ''
    }

    if (nextText !== undefined) {
      nextEntries.set(file.path, encoder.encode(nextText))
      nextTexts.set(file.path, nextText)
      if (!nextOrder.includes(file.path)) nextOrder.push(file.path)
    }
  }

  let nextPkg = book.pkg
  const opfChanged = proposal.files.some((f) => f.path === book.pkg.opfPath)
  if (opfChanged) {
    const opfXml = nextTexts.get(book.pkg.opfPath)
    if (opfXml) {
      try {
        nextPkg = parsePackage(opfXml, book.pkg.opfPath, parseXml)
      } catch {
        nextPkg = book.pkg
      }
    }
  }

  return {
    archive: { order: nextOrder, entries: nextEntries },
    pkg: nextPkg,
    texts: nextTexts,
  }
}

export function findReferencingChaptersForCss(
  cssPath: string,
  pkg: EpubPackage,
  texts: ReadonlyMap<string, string>,
): string[] {
  const chapters = spinePaths(pkg)
  const matches: string[] = []
  for (const chapterPath of chapters) {
    const xhtml = texts.get(chapterPath)
    if (!xhtml) continue
    const linked = getLinkedStylesheets(xhtml, chapterPath)
    if (linked.includes(cssPath)) {
      matches.push(chapterPath)
    }
  }
  return matches
}

export function summarizeStructuralProposal(proposal: AgentProposal, pkg: EpubPackage): string[] {
  let createdChapters = 0
  let createdOther = 0
  let renamed = 0
  let deleted = 0
  let touchedOpf = false
  let touchedToc = false
  let updatedChapters = 0
  let updatedCss = 0

  for (const file of proposal.files) {
    if (file.path === pkg.opfPath) {
      touchedOpf = true
      continue
    }
    if (file.path === pkg.navPath || file.path === pkg.ncxPath) {
      touchedToc = true
      continue
    }
    if (file.kind === 'create') {
      if (isChapterPath(file.path)) createdChapters += 1
      else createdOther += 1
    } else if (file.kind === 'rename') {
      renamed += 1
    } else if (file.kind === 'delete') {
      deleted += 1
    } else if (file.kind === 'update') {
      if (isChapterPath(file.path)) updatedChapters += 1
      else if (isCssPath(file.path)) updatedCss += 1
    }
  }

  const parts: string[] = []
  if (createdChapters > 0) parts.push(`新增 ${createdChapters} 章`)
  if (createdOther > 0) parts.push(`新增 ${createdOther} 个资源文件`)
  if (renamed > 0) parts.push(`重命名 ${renamed} 项`)
  if (deleted > 0) parts.push(`删除 ${deleted} 项`)
  if (updatedChapters > 0) parts.push(`更新 ${updatedChapters} 章正文`)
  if (updatedCss > 0) parts.push(`更新 ${updatedCss} 份样式表`)
  if (touchedToc && touchedOpf) parts.push('同步目录与 OPF')
  else if (touchedToc) parts.push('同步目录')
  else if (touchedOpf) parts.push('同步 OPF 清单/元数据')

  return parts
}

export function detectProposalStaleness(
  proposal: AgentProposal,
  currentTexts: ReadonlyMap<string, string>,
): string[] {
  const drifted: string[] = []
  for (const file of proposal.files) {
    if (file.kind === 'create') {
      if (currentTexts.has(file.path)) drifted.push(file.path)
      continue
    }
    const targetPath = file.kind === 'rename' && file.previousPath ? file.previousPath : file.path
    const current = currentTexts.get(targetPath)
    if (file.beforeText !== undefined) {
      if (current === undefined || normalizeEol(current) !== normalizeEol(file.beforeText)) {
        drifted.push(file.path)
      }
    }
  }
  return drifted
}
