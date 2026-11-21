import {
  browserXmlParser,
  getLinkedStylesheets,
  parsePackage,
  type AgentProposal,
  type AgentProposalDelta,
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
 * Pure per-hunk diff, 3-state Cursor-style decision engine (`pending | accepted | rejected`),
 * content-fingerprint reconciliation across live streaming updates, XML validation, and read-only
 * virtual book overlay for in-canvas Agent proposal review.
 *
 * Keeps review state isolated from the live workspace so browsing, accepting/rejecting hunks,
 * or previewing styles never mutates dirty state, drafts, or autosave timers.
 * See ADR 2026-11-21-in-canvas-agent-proposal-review, ADR 2026-11-22-live-streaming-agent-review.
 */

const encoder = new TextEncoder()

/** Maximum intervening unchanged lines absorbed when pairing unbalanced open/close chapter tags.
 * Exceeding this cap keeps chapter-wide wrappers granular while `validateComposedProposal` guards XML.
 * See ADR 2026-11-22-contiguous-quote-and-structural-revision-preview. */
const MAX_STRUCTURAL_COALESCE_GAP = 40

const HTML_VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

const BODY_BOUNDARY_RE = /<\/?body(?:\s[^<>]*?)?>/i

interface FragmentTagBalance {
  unmatchedOpens: string[]
  unmatchedCloses: string[]
}

function analyzeFragmentTagBalance(fragment: string): FragmentTagBalance {
  const unmatchedOpens: string[] = []
  const unmatchedCloses: string[] = []
  const tokenRe =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE\b[^>]*>|<\/?([a-zA-Z][\w:-]*)(?:\s[^<>]*?)?(\/?)>/gi
  for (const match of fragment.matchAll(tokenRe)) {
    const full = match[0]!
    const rawName = match[1]
    if (!rawName) continue
    const name = rawName.toLowerCase()
    const selfClosing = match[2] === '/' || HTML_VOID_TAGS.has(name)
    if (full.startsWith('</')) {
      if (unmatchedOpens.length > 0 && unmatchedOpens[unmatchedOpens.length - 1] === name) {
        unmatchedOpens.pop()
      } else {
        unmatchedCloses.push(name)
      }
    } else if (!selfClosing) {
      unmatchedOpens.push(name)
    }
  }
  return { unmatchedOpens, unmatchedCloses }
}

/**
 * Coalesces paired unbalanced open/close XHTML tag hunks (e.g. wrapping or unwrapping
 * `<blockquote>...</blockquote>` across unchanged `<p>` lines) into a single atomic hunk
 * so per-hunk reject cannot break XML well-formedness and book-page revision preview sees
 * balanced before/after structure. See ADR 2026-11-22-contiguous-quote-and-structural-revision-preview.
 */
function coalesceStructuralChapterHunks(
  allLines: NumberedDiffLine[],
  rawHunks: ProposalHunk[],
): ProposalHunk[] {
  if (rawHunks.length < 2) return rawHunks

  const ranges = new Map<string, { start: number; end: number }>()
  for (let i = 0; i < allLines.length; i += 1) {
    const hunkId = allLines[i]!.hunkId
    if (!hunkId) continue
    const existing = ranges.get(hunkId)
    if (existing) existing.end = i
    else ranges.set(hunkId, { start: i, end: i })
  }

  const groups: Array<{ startRow: number; endRow: number; firstHunk: ProposalHunk }> = []
  let hIdx = 0
  let didCoalesce = false

  while (hIdx < rawHunks.length) {
    const startHunk = rawHunks[hIdx]!
    const startRange = ranges.get(startHunk.id)
    if (!startRange) {
      hIdx += 1
      continue
    }

    const beforeBal = analyzeFragmentTagBalance(startHunk.beforeLines.join('\n'))
    const afterBal = analyzeFragmentTagBalance(startHunk.afterLines.join('\n'))
    const hasUnmatchedClose = beforeBal.unmatchedCloses.length > 0 || afterBal.unmatchedCloses.length > 0
    const needsForwardClose =
      !hasUnmatchedClose && (beforeBal.unmatchedOpens.length > 0 || afterBal.unmatchedOpens.length > 0)

    let coalescedEndIdx: number | null = null

    if (needsForwardClose) {
      const beforeAcc = [...startHunk.beforeLines]
      const afterAcc = [...startHunk.afterLines]
      let sameGap = 0
      let prevEndRow = startRange.end

      for (let scanIdx = hIdx + 1; scanIdx < rawHunks.length; scanIdx += 1) {
        const nextHunk = rawHunks[scanIdx]!
        const nextRange = ranges.get(nextHunk.id)
        if (!nextRange) break

        let crossedBody = false
        for (let rowIdx = prevEndRow + 1; rowIdx < nextRange.start; rowIdx += 1) {
          const row = allLines[rowIdx]!
          if (row.diff.kind === 'same') {
            if (BODY_BOUNDARY_RE.test(row.diff.text)) {
              crossedBody = true
              break
            }
            sameGap += 1
            if (sameGap > MAX_STRUCTURAL_COALESCE_GAP) break
            beforeAcc.push(row.diff.text)
            afterAcc.push(row.diff.text)
          }
        }
        if (crossedBody || sameGap > MAX_STRUCTURAL_COALESCE_GAP) break

        beforeAcc.push(...nextHunk.beforeLines)
        afterAcc.push(...nextHunk.afterLines)
        prevEndRow = nextRange.end

        const mergedBeforeBal = analyzeFragmentTagBalance(beforeAcc.join('\n'))
        const mergedAfterBal = analyzeFragmentTagBalance(afterAcc.join('\n'))
        if (mergedBeforeBal.unmatchedCloses.length > 0 || mergedAfterBal.unmatchedCloses.length > 0) {
          break
        }
        if (mergedBeforeBal.unmatchedOpens.length === 0 && mergedAfterBal.unmatchedOpens.length === 0) {
          coalescedEndIdx = scanIdx
          break
        }
      }
    }

    if (coalescedEndIdx !== null) {
      const endRange = ranges.get(rawHunks[coalescedEndIdx]!.id)!
      groups.push({ startRow: startRange.start, endRow: endRange.end, firstHunk: startHunk })
      didCoalesce = true
      hIdx = coalescedEndIdx + 1
    } else {
      groups.push({ startRow: startRange.start, endRow: startRange.end, firstHunk: startHunk })
      hIdx += 1
    }
  }

  if (!didCoalesce) return rawHunks

  const sigCounts = new Map<string, number>()
  const nextHunks: ProposalHunk[] = []

  for (let gIdx = 0; gIdx < groups.length; gIdx += 1) {
    const { startRow, endRow, firstHunk } = groups[gIdx]!
    const hunkId = `hunk-${gIdx}`
    const beforeLines: string[] = []
    const afterLines: string[] = []
    const lines: LineDiff[] = []
    let addedCount = 0
    let removedCount = 0
    let beforeStart: number | null = null
    let afterStart: number | null = null

    for (let rowIdx = startRow; rowIdx <= endRow; rowIdx += 1) {
      const row = allLines[rowIdx]!
      row.hunkId = hunkId
      lines.push(row.diff)
      if (beforeStart === null && row.beforeLine !== null) beforeStart = row.beforeLine
      if (afterStart === null && row.afterLine !== null) afterStart = row.afterLine

      if (row.diff.kind === 'same') {
        beforeLines.push(row.diff.text)
        afterLines.push(row.diff.text)
      } else if (row.diff.kind === 'removed') {
        beforeLines.push(row.diff.text)
        removedCount += 1
      } else if (row.diff.kind === 'added') {
        afterLines.push(row.diff.text)
        addedCount += 1
      } else if (row.diff.kind === 'changed') {
        beforeLines.push(
          row.diff.segments
            .filter((seg) => seg.kind !== 'added')
            .map((seg) => seg.text)
            .join(''),
        )
        afterLines.push(
          row.diff.segments
            .filter((seg) => seg.kind !== 'removed')
            .map((seg) => seg.text)
            .join(''),
        )
        addedCount += 1
        removedCount += 1
      }
    }

    nextHunks.push({
      id: hunkId,
      index: gIdx,
      fingerprint: makeHunkFingerprint(beforeLines, afterLines, sigCounts),
      beforeStart: beforeStart ?? firstHunk.beforeStart,
      beforeCount: beforeLines.length,
      afterStart: afterStart ?? firstHunk.afterStart,
      afterCount: afterLines.length,
      beforeLines,
      afterLines,
      lines,
      addedCount,
      removedCount,
    })
  }

  return nextHunks
}

export type HunkDecision = 'pending' | 'accepted' | 'rejected'
export type FileHunkDecisions = Readonly<Record<string, HunkDecision>>
export type ProposalHunkDecisions = Readonly<Record<string, FileHunkDecisions>>
export type LegacySkippedSet = ReadonlySet<string>

export interface ProposalHunk {
  id: string
  index: number
  /** Stable content + per-file occurrence fingerprint so user decisions survive live re-edits.
   * See ADR 2026-11-22-live-streaming-agent-review. */
  fingerprint: string
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
  accepted: number
  rejected: number
  pending: number
}

export interface ComposedProposalPlan {
  selectedPaths: Set<string>
  composedTexts: Map<string, string>
  totalHunks: number
  keptHunks: number
  acceptedHunks: number
  rejectedHunks: number
  pendingHunks: number
  fileStates: Map<string, FileHunkSelectionSummary>
}

export function getHunkDecision(
  decisions: FileHunkDecisions | LegacySkippedSet | undefined,
  hunkId: string,
): HunkDecision {
  if (!decisions) return 'pending'
  if (decisions instanceof Set) return decisions.has(hunkId) ? 'rejected' : 'pending'
  return (decisions as FileHunkDecisions)[hunkId] ?? 'pending'
}

function makeHunkFingerprint(
  beforeLines: readonly string[],
  afterLines: readonly string[],
  counts: Map<string, number>,
): string {
  const sig = `${beforeLines.join('\n')}\u0000${afterLines.join('\n')}`
  const occ = counts.get(sig) ?? 0
  counts.set(sig, occ + 1)
  return `${occ}:${sig}`
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
      fingerprint: makeHunkFingerprint([], afterLines, new Map()),
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
      fingerprint: makeHunkFingerprint(beforeLines, [], new Map()),
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
  const sigCounts = new Map<string, number>()

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
      fingerprint: makeHunkFingerprint(beforeLines, afterLines, sigCounts),
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

  const finalHunks = isChapterPath(file.path) ? coalesceStructuralChapterHunks(allLines, hunks) : hunks

  return {
    file,
    eol,
    allLines,
    hunks: finalHunks,
    added: totalAdded,
    removed: totalRemoved,
    isNoopText: finalHunks.length === 0,
  }
}

/**
 * Merges a streaming `AgentProposalDelta` into the current live proposal in-place by path order.
 * Returns null when all changes have been reverted back to baseline.
 * See ADR 2026-11-22-live-streaming-agent-review.
 */
export function applyProposalDelta(
  current: AgentProposal | null,
  delta: AgentProposalDelta,
): AgentProposal | null {
  const removed = new Set(delta.removedPaths)
  const changedByPath = new Map(delta.changedFiles.map((file) => [file.path, file]))
  const nextFiles: AgentProposalFile[] = []
  const seen = new Set<string>()

  for (const existing of current?.files ?? []) {
    if (removed.has(existing.path)) continue
    const updated = changedByPath.get(existing.path)
    nextFiles.push(updated ?? existing)
    seen.add(existing.path)
  }
  for (const file of delta.changedFiles) {
    if (removed.has(file.path) || seen.has(file.path)) continue
    nextFiles.push(file)
    seen.add(file.path)
  }

  if (nextFiles.length === 0) return null
  return {
    id: delta.proposalId || current?.id || 'live',
    isStructural: delta.isStructural,
    validationIssues: current?.validationIssues ?? [],
    files: nextFiles,
  }
}

/**
 * Reconciles user per-hunk decisions across live edits to the same file by matching content
 * fingerprints, so earlier accept/reject choices never drift when new hunks are inserted above.
 * See ADR 2026-11-22-live-streaming-agent-review.
 */
export function reconcileHunkDecisions(
  prevModel: FileDiffModel | undefined,
  nextModel: FileDiffModel,
  prevDecisions: FileHunkDecisions | undefined,
): FileHunkDecisions {
  if (!prevModel || !prevDecisions) return {}
  const byFingerprint = new Map<string, HunkDecision>()
  for (const hunk of prevModel.hunks) {
    const decision = prevDecisions[hunk.id]
    if (decision === 'accepted' || decision === 'rejected') {
      byFingerprint.set(hunk.fingerprint, decision)
    }
  }
  if (byFingerprint.size === 0) return {}

  const next: Record<string, HunkDecision> = {}
  for (const hunk of nextModel.hunks) {
    const matched = byFingerprint.get(hunk.fingerprint)
    if (matched) next[hunk.id] = matched
  }
  return next
}

export function reconcileProposalDecisions(
  prevProposal: AgentProposal | null,
  nextProposal: AgentProposal | null,
  prevByPath: ProposalHunkDecisions,
): ProposalHunkDecisions {
  if (!nextProposal) return {}
  const prevFiles = new Map((prevProposal?.files ?? []).map((file) => [file.path, file]))
  const nextByPath: Record<string, FileHunkDecisions> = {}

  for (const file of nextProposal.files) {
    const prevDec = prevByPath[file.path]
    if (!prevDec || Object.keys(prevDec).length === 0) continue
    const prevFile = prevFiles.get(file.path)
    if (!prevFile) continue
    if (
      prevFile.kind === file.kind &&
      prevFile.beforeText === file.beforeText &&
      prevFile.afterText === file.afterText
    ) {
      nextByPath[file.path] = prevDec
      continue
    }
    const reconciled = reconcileHunkDecisions(buildFileHunks(prevFile), buildFileHunks(file), prevDec)
    if (Object.keys(reconciled).length > 0) {
      nextByPath[file.path] = reconciled
    }
  }
  return nextByPath
}

/** Finds the newest introduced/modified hunk index when a file updates live during streaming. */
export function findNewestChangedHunkIndex(
  prevModel: FileDiffModel | null | undefined,
  nextModel: FileDiffModel,
): number {
  if (nextModel.hunks.length === 0) return -1
  if (!prevModel || prevModel.hunks.length === 0) return 0
  const prevFingerprints = new Set(prevModel.hunks.map((h) => h.fingerprint))
  for (let i = nextModel.hunks.length - 1; i >= 0; i -= 1) {
    if (!prevFingerprints.has(nextModel.hunks[i]!.fingerprint)) return i
  }
  return 0
}

export function composeFileFromHunks(
  model: FileDiffModel,
  decisions: FileHunkDecisions | LegacySkippedSet | undefined,
): string {
  if (!decisions) {
    return model.file.afterText ?? ''
  }
  if (model.hunks.length === 0) {
    return model.file.afterText ?? model.file.beforeText ?? ''
  }

  let rejectedCount = 0
  for (const hunk of model.hunks) {
    if (getHunkDecision(decisions, hunk.id) === 'rejected') rejectedCount += 1
  }
  if (rejectedCount === 0) {
    return model.file.afterText ?? ''
  }
  if (rejectedCount === model.hunks.length) {
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
    if (getHunkDecision(decisions, hunk.id) === 'rejected') {
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
  decisionsByPath: Readonly<Record<string, FileHunkDecisions | LegacySkippedSet>>,
): ComposedProposalPlan {
  const selectedPaths = new Set<string>()
  const composedTexts = new Map<string, string>()
  const fileStates = new Map<string, FileHunkSelectionSummary>()
  let totalHunks = 0
  let keptHunks = 0
  let acceptedHunks = 0
  let rejectedHunks = 0
  let pendingHunks = 0

  for (const file of proposal.files) {
    const model = modelsByPath.get(file.path) ?? buildFileHunks(file)
    const fileTotal = model.hunks.length
    totalHunks += fileTotal

    if (proposal.isStructural) {
      keptHunks += fileTotal
      pendingHunks += fileTotal
      fileStates.set(file.path, {
        total: fileTotal,
        kept: fileTotal,
        accepted: 0,
        rejected: 0,
        pending: fileTotal,
      })
      selectedPaths.add(file.path)
      continue
    }

    const decisions = decisionsByPath[file.path]
    let fileAccepted = 0
    let fileRejected = 0
    let filePending = 0
    for (const hunk of model.hunks) {
      const dec = getHunkDecision(decisions, hunk.id)
      if (dec === 'accepted') fileAccepted += 1
      else if (dec === 'rejected') fileRejected += 1
      else filePending += 1
    }
    const fileKept = fileTotal - fileRejected
    keptHunks += fileKept
    acceptedHunks += fileAccepted
    rejectedHunks += fileRejected
    pendingHunks += filePending
    fileStates.set(file.path, {
      total: fileTotal,
      kept: fileKept,
      accepted: fileAccepted,
      rejected: fileRejected,
      pending: filePending,
    })

    if (fileTotal === 0) {
      // No-op text files need not block or mutate anything.
      continue
    }

    if (fileKept === 0) continue

    selectedPaths.add(file.path)
    if (fileRejected > 0) {
      composedTexts.set(file.path, composeFileFromHunks(model, decisions))
    }
  }

  return {
    selectedPaths,
    composedTexts,
    totalHunks,
    keptHunks,
    acceptedHunks,
    rejectedHunks,
    pendingHunks,
    fileStates,
  }
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
  skippedByPath?: Readonly<Record<string, FileHunkDecisions | LegacySkippedSet>>
  decisionsByPath?: ProposalHunkDecisions
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
    decisionsByPath,
    readOnly = false,
    cssOverride = null,
    parseXml = browserXmlParser,
  } = args
  const activeDecisions = decisionsByPath ?? skippedByPath

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
      nextText = composeFileFromHunks(model, activeDecisions[file.path])
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
