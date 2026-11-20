import {
  browserXmlParser,
  parsePackage,
  type AgentProposal,
  type EpubArchive,
  type XmlDocumentParser,
} from '@booksmith/core'
import { spinePaths } from '../diff/document'
import { groupFiles, type LoadedBook } from './bookStore'

/**
 * Pure browser-side proposal application & undo engine.
 * Structural proposals apply atomically as one batch; pure-text proposals allow per-file selection.
 * Applying writes only into the browser workspace so existing autosave, If-Match optimistic locks,
 * and per-file snapshots remain the single save path. See ADR 2026-11-20-builtin-epub-agent.
 */

const encoder = new TextEncoder()

export interface WorkspaceSnapshot {
  book: LoadedBook
  texts: Map<string, string>
  dirty: Set<string>
  tabs: string[]
  active: string | null
}

export interface ApplyProposalInput extends WorkspaceSnapshot {
  proposal: AgentProposal
  /** Only honored when `proposal.isStructural === false`. */
  selectedPaths?: Set<string>
  parseXml?: XmlDocumentParser
}

export interface ApplyProposalResult extends WorkspaceSnapshot {
  appliedCount: number
}

export function createUndoSnapshot(state: WorkspaceSnapshot): WorkspaceSnapshot {
  const entries = new Map(state.book.archive.entries)
  const archive: EpubArchive = { order: [...state.book.archive.order], entries }
  const texts = new Map(state.texts)
  return {
    book: {
      ...state.book,
      archive,
      texts,
      groups: state.book.groups.map((group) => ({ ...group, paths: [...group.paths] })),
      serverPaths: new Set(state.book.serverPaths),
    },
    texts,
    dirty: new Set(state.dirty),
    tabs: [...state.tabs],
    active: state.active,
  }
}

export function computeDeletedPaths(book: LoadedBook): string[] {
  const deleted: string[] = []
  for (const path of book.serverPaths) {
    if (!book.archive.entries.has(path)) deleted.push(path)
  }
  return deleted
}

export function collectDirtyTexts(
  texts: Map<string, string>,
  dirty: Set<string>,
  book: LoadedBook,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const path of dirty) {
    const text = texts.get(path)
    if (text !== undefined) out[path] = text
  }
  // Include any newly created unsaved text files even if not yet flagged in dirty.
  for (const [path, text] of texts) {
    if (!book.serverPaths.has(path)) out[path] = text
  }
  return out
}

export function applyProposalToBook(input: ApplyProposalInput): ApplyProposalResult {
  const { proposal, parseXml = browserXmlParser } = input
  if (proposal.validationIssues.length > 0) {
    throw new Error('提案未通过结构预检，无法应用')
  }

  const targetFiles = proposal.isStructural
    ? proposal.files
    : proposal.files.filter((file) => !input.selectedPaths || input.selectedPaths.has(file.path))

  if (targetFiles.length === 0) {
    return {
      book: input.book,
      texts: input.texts,
      dirty: input.dirty,
      tabs: input.tabs,
      active: input.active,
      appliedCount: 0,
    }
  }

  const nextEntries = new Map(input.book.archive.entries)
  let nextOrder = [...input.book.archive.order]
  const nextTexts = new Map(input.texts)
  const nextDirty = new Set(input.dirty)
  let nextTabs = [...input.tabs]
  let nextActive = input.active

  // 1. Apply renames first so subsequent updates or tab remaps see the destination path.
  for (const file of targetFiles) {
    if (file.kind !== 'rename' || !file.previousPath) continue
    const from = file.previousPath
    const to = file.path

    const existingBytes = nextEntries.get(from)
    nextEntries.delete(from)
    if (file.afterText !== undefined) {
      nextEntries.set(to, encoder.encode(file.afterText))
      nextTexts.set(to, file.afterText)
    } else if (existingBytes) {
      nextEntries.set(to, existingBytes)
      const movedText = nextTexts.get(from)
      if (movedText !== undefined) nextTexts.set(to, movedText)
    }
    nextTexts.delete(from)

    nextOrder = nextOrder.map((entry) => (entry === from ? to : entry))
    if (!nextOrder.includes(to)) nextOrder.push(to)

    nextDirty.delete(from)
    nextDirty.add(to)

    nextTabs = nextTabs.map((tab) => (tab === from ? to : tab))
    if (nextActive === from) nextActive = to
  }

  // 2. Apply deletions.
  for (const file of targetFiles) {
    if (file.kind !== 'delete') continue
    nextEntries.delete(file.path)
    nextOrder = nextOrder.filter((entry) => entry !== file.path)
    nextTexts.delete(file.path)
    nextDirty.delete(file.path)
    nextTabs = nextTabs.filter((tab) => tab !== file.path)
    if (nextActive === file.path) nextActive = null
  }

  // 3. Apply creates and text updates.
  for (const file of targetFiles) {
    if (file.kind !== 'create' && file.kind !== 'update') continue
    if (file.afterText === undefined) continue
    nextEntries.set(file.path, encoder.encode(file.afterText))
    if (!nextOrder.includes(file.path)) nextOrder.push(file.path)
    nextTexts.set(file.path, file.afterText)
    nextDirty.add(file.path)
  }

  const nextArchive: EpubArchive = { order: nextOrder, entries: nextEntries }
  const opfXml = nextTexts.get(input.book.pkg.opfPath) ?? ''
  const nextPkg = parsePackage(opfXml, input.book.pkg.opfPath, parseXml)
  const nextGroups = groupFiles(nextPkg, nextArchive)

  const nextBook: LoadedBook = {
    ...input.book,
    archive: nextArchive,
    pkg: nextPkg,
    texts: nextTexts,
    groups: nextGroups,
    serverPaths: input.book.serverPaths,
  }

  if (nextActive === null) {
    nextActive = nextTabs[0] ?? spinePaths(nextPkg)[0] ?? nextGroups[0]?.paths[0] ?? null
    if (nextActive && !nextTabs.includes(nextActive)) nextTabs = [nextActive]
  }

  // Deduplicate tabs in case a rename collided with an already-open tab.
  nextTabs = Array.from(new Set(nextTabs))

  return {
    book: nextBook,
    texts: nextTexts,
    dirty: nextDirty,
    tabs: nextTabs,
    active: nextActive,
    appliedCount: targetFiles.length,
  }
}
