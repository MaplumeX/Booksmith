import { mergeChaptersInBook } from './chapterMerge'
import {
  splitChapterAtMarkersInBook,
  splitChapterByHeadingLevelInBook,
  splitChapterInBook,
} from './chapterSplit'
import { lintBook } from './lint'
import { readNavToc, writeNavToc } from './nav'
import { readNcxToc, writeNcxToc } from './ncx'
import { addSpineDocument, removeManifestEntry, renameManifestEntry, reorderSpine } from './opfEdit'
import {
  readOpfMeta,
  touchOpfModified,
  writeOpfMeta,
  writeOpfMetadata,
  type MetadataDraft,
  type OpfMetaRow,
} from './opfWrite'
import { dirname, relativePath, resolvePath, splitFragment } from './path'
import { collectReferences, rewriteReferences } from './references'
import { searchBook, type SearchFile } from './search'
import {
  createBlankStylesheet,
  deleteUnusedResourcesInBook,
  findUnusedResources,
  updateChaptersStylesheets,
  type UnusedResourceCategory,
} from './stylesheets'
import { isTextEntry } from './text'
import {
  countTocEntries,
  findBrokenAnchors,
  getTocEntry,
  indentTocEntries,
  indentTocEntry,
  insertTocEntry,
  moveTocEntries,
  moveTocEntry,
  moveTocSubtree,
  outdentTocEntries,
  outdentTocEntry,
  rebaseTocHrefs,
  removeBrokenTocEntries,
  removeTocEntries,
  removeTocEntry,
  updateTocEntry,
  type TocEntry,
  type TocInsertPosition,
  type TocPath,
} from './toc'
import { generateTocFromHeadings, refreshTocLabelsFromHeadings, scanBookHeadings } from './tocGenerate'
import { initializeBookToc } from './tocInit'
import type { EpubArchive, EpubIssue, EpubPackage } from './types'
import { parsePackage, readOpfPath } from './unpack'
import { validateStructure } from './validate'
import type { XmlCodec } from './xml'

/**
 * Framework-agnostic EPUB tool primitives and sandboxed working copy for the built-in Agent.
 * Kept pure inside `@booksmith/core` so both the server runner and any future MCP server
 * share identical EPUB mutation and validation rules. See ADR 2026-11-20-builtin-epub-agent.
 */

export type AgentToolName =
  | 'list_files'
  | 'read_file'
  | 'search_book'
  | 'lint_book'
  | 'get_metadata'
  | 'get_toc'
  | 'scan_headings'
  | 'edit_file'
  | 'write_file'
  | 'update_metadata'
  | 'update_toc'
  | 'generate_toc'
  | 'edit_toc'
  | 'create_chapter'
  | 'rename_file'
  | 'delete_file'
  | 'split_chapter'
  | 'merge_chapters'
  | 'link_stylesheets'
  | 'create_stylesheet'
  | 'cleanup_unused_resources'

export const AGENT_READ_ONLY_TOOL_NAMES: readonly AgentToolName[] = [
  'list_files',
  'read_file',
  'search_book',
  'lint_book',
  'get_metadata',
  'get_toc',
  'scan_headings',
] as const

const READ_ONLY_TOOL_SET = new Set<string>(AGENT_READ_ONLY_TOOL_NAMES)

/** Single source of truth for `ask` (read-only) mode tool filtering.
 * See ADR 2026-11-20-agent-modes-and-multimodel. */
export function isReadOnlyAgentTool(name: AgentToolName): boolean {
  return READ_ONLY_TOOL_SET.has(name)
}

export const AGENT_TOOL_NAMES: readonly AgentToolName[] = [
  ...AGENT_READ_ONLY_TOOL_NAMES,
  'edit_file',
  'write_file',
  'update_metadata',
  'update_toc',
  'generate_toc',
  'edit_toc',
  'create_chapter',
  'rename_file',
  'delete_file',
  'split_chapter',
  'merge_chapters',
  'link_stylesheets',
  'create_stylesheet',
  'cleanup_unused_resources',
] as const

export interface AgentWorkspaceOverlay {
  dirtyTexts?: Record<string, string>
  deletedPaths?: string[]
}

export interface AgentWorkspaceOptions {
  codec: XmlCodec
  overlay?: AgentWorkspaceOverlay
  /** Optional strict XML well-formedness checker returning an error message or null when valid. */
  checkXml?: (xml: string) => string | null
  /** Optional clock override for deterministic `dcterms:modified` timestamps in tests. */
  now?: () => Date
}

export interface AgentProposalFile {
  path: string
  previousPath?: string
  kind: 'create' | 'update' | 'rename' | 'delete'
  beforeText?: string
  afterText?: string
  referencesAffected?: Array<{ from: string; line: number }>
}

export interface AgentProposal {
  id: string
  /** Structural proposals (create/rename/delete/OPF/TOC) must apply atomically to keep EPUB valid.
   * See ADR 2026-11-20-builtin-epub-agent. */
  isStructural: boolean
  validationIssues: EpubIssue[]
  files: AgentProposalFile[]
}

export interface AgentToolResult {
  ok: boolean
  data?: unknown
  error?: string
}

const XML_EXTENSIONS = new Set(['xhtml', 'xml', 'opf', 'ncx', 'svg'])
const DEFAULT_READ_LINES = 200
const MAX_READ_LINES = 400
const MAX_READ_CHARS = 24_000
const DEFAULT_SEARCH_RESULTS = 40
const MAX_SEARCH_RESULTS = 100

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8')

function extensionOf(path: string): string {
  const index = path.lastIndexOf('.')
  return index < 0 ? '' : path.slice(index + 1).toLowerCase()
}

function basenameOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? path : path.slice(index + 1)
}

function lineOf(text: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === '\n') line += 1
  }
  return line
}

function isProtectedPath(path: string): boolean {
  return path === 'mimetype' || path.startsWith('META-INF/')
}

function isSafeFilename(name: string): boolean {
  return (
    name.length > 0 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('..') &&
    !/[\u0000-\u001f]/.test(name)
  )
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function isoModified(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function defaultCheckXml(xml: string, codec: XmlCodec): string | null {
  try {
    const doc = codec.parse(xml)
    const root = doc.documentElement
    if (!root) return 'XML document has no root element'
    if (root.tagName === 'parsererror' || doc.getElementsByTagName('parsererror').length > 0) {
      const errNode = root.tagName === 'parsererror' ? root : doc.getElementsByTagName('parsererror')[0]
      return errNode?.textContent?.trim() || 'XML parse error'
    }
    return null
  } catch (error) {
    return error instanceof Error ? error.message : 'XML parse error'
  }
}

function chapterSkeleton(title: string, language: string): string {
  const safeTitle = escapeXml(title || '新章节')
  const safeLang = escapeXml(language || 'zh-CN')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${safeLang}">
<head><meta charset="utf-8"/><title>${safeTitle}</title></head>
<body>
<section epub:type="chapter">
<h1>${safeTitle}</h1>
<p></p>
</section>
</body>
</html>
`
}

function pruneToc(entries: TocEntry[], tocPath: string, removed: string): { entries: TocEntry[]; changed: boolean } {
  let changed = false
  const kept: TocEntry[] = []
  for (const entry of entries) {
    const { path } = splitFragment(entry.href)
    if (path && resolvePath(dirname(tocPath), path) === removed) {
      changed = true
      continue
    }
    const children = pruneToc(entry.children, tocPath, removed)
    if (children.changed) changed = true
    kept.push(children.changed ? { ...entry, children: children.entries } : entry)
  }
  return { entries: kept, changed }
}

function parseTocPath(raw: unknown): TocPath | null {
  if (!Array.isArray(raw)) return null
  const out: number[] = []
  for (const seg of raw) {
    if (typeof seg !== 'number' || !Number.isInteger(seg) || seg < 0) return null
    out.push(seg)
  }
  return out
}

function parseTocPaths(raw: unknown): TocPath[] | null {
  if (!Array.isArray(raw)) return null
  const out: TocPath[] = []
  for (const item of raw) {
    const parsed = parseTocPath(item)
    if (!parsed || parsed.length === 0) return null
    out.push(parsed)
  }
  return out
}

function parseLevels(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out = raw.filter((lvl): lvl is number => typeof lvl === 'number' && Number.isInteger(lvl) && lvl >= 1 && lvl <= 6)
  return out.length > 0 ? out : undefined
}

function cloneEntries(source: EpubArchive): EpubArchive {
  const entries = new Map<string, Uint8Array>()
  for (const [path, bytes] of source.entries) entries.set(path, bytes)
  return { order: [...source.order], entries }
}

function normalizeTocInput(raw: unknown): TocEntry[] | null {
  if (!Array.isArray(raw)) return null
  const out: TocEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null
    const record = item as Record<string, unknown>
    if (typeof record.label !== 'string' || typeof record.href !== 'string') return null
    const children = record.children === undefined ? [] : normalizeTocInput(record.children)
    if (!children) return null
    out.push({
      label: record.label,
      href: record.href,
      ...(typeof record.rawHtml === 'string' ? { rawHtml: record.rawHtml } : {}),
      children,
    })
  }
  return out
}

export class AgentWorkspace {
  private readonly codec: XmlCodec
  private readonly checkXmlFn: (xml: string) => string | null
  private readonly nowFn: () => Date

  private archive: EpubArchive
  private pkg: EpubPackage
  private texts: Map<string, string>

  private readonly initialTexts: Map<string, string>
  private readonly initialPaths: Set<string>

  /** Maps a current path back to the initial path it originated from (for rename chains). */
  private readonly originByCurrent = new Map<string, string>()
  private readonly deletedRefs = new Map<string, Array<{ from: string; line: number }>>()
  private structuralTouched = false
  /** Tracks whether an unapplied prior proposal was seeded into the working copy so read-only follow-ups keep it intact.
   * See ADR 2026-11-21-agent-session-continuity. */
  private seededPendingProposal = false
  private mutatedSinceSeed = false

  private constructor(
    archive: EpubArchive,
    pkg: EpubPackage,
    texts: Map<string, string>,
    options: AgentWorkspaceOptions,
  ) {
    this.codec = options.codec
    this.checkXmlFn = options.checkXml ?? ((xml) => defaultCheckXml(xml, options.codec))
    this.nowFn = options.now ?? (() => new Date())
    this.archive = archive
    this.pkg = pkg
    this.texts = texts
    this.initialTexts = new Map(texts)
    this.initialPaths = new Set(archive.entries.keys())
    for (const path of archive.entries.keys()) this.originByCurrent.set(path, path)
  }

  /**
   * Builds a working sandbox from the last saved archive plus the browser's unsaved overlay.
   * Proposals diff strictly against this post-overlay baseline so the user's own unsaved edits
   * are never misattributed to the Agent. See ADR 2026-11-20-builtin-epub-agent.
   */
  static fromArchive(baseArchive: EpubArchive, options: AgentWorkspaceOptions): AgentWorkspace {
    const working = cloneEntries(baseArchive)
    const deleted = new Set(options.overlay?.deletedPaths ?? [])

    for (const path of deleted) {
      if (isProtectedPath(path)) continue
      working.entries.delete(path)
    }
    working.order = working.order.filter((path) => working.entries.has(path))

    for (const [path, text] of Object.entries(options.overlay?.dirtyTexts ?? {})) {
      if (isProtectedPath(path)) continue
      working.entries.set(path, encoder.encode(text))
      if (!working.order.includes(path)) working.order.push(path)
    }

    const opfPath = readOpfPath(working, options.codec.parse)
    const opfBytes = working.entries.get(opfPath)
    if (!opfBytes) throw new Error(`OPF file missing: ${opfPath}`)
    const pkg = parsePackage(decoder.decode(opfBytes), opfPath, options.codec.parse)

    const texts = new Map<string, string>()
    for (const [path, bytes] of working.entries) {
      if (isTextEntry(path)) texts.set(path, decoder.decode(bytes))
    }

    return new AgentWorkspace(working, pkg, texts, options)
  }

  getPackage(): EpubPackage {
    return this.pkg
  }

  getText(path: string): string | undefined {
    return this.texts.get(path)
  }

  hasSeededPendingProposal(): boolean {
    return this.seededPendingProposal
  }

  hasNewMutations(): boolean {
    return this.mutatedSinceSeed
  }

  /**
   * Checks whether every file touched by a prior pending proposal still matches the current
   * post-overlay editor baseline. Returns drifted paths; empty means safe to seed cumulatively.
   */
  detectPendingProposalDrift(proposal: AgentProposal): string[] {
    const drifted: string[] = []
    for (const file of proposal.files) {
      if (isProtectedPath(file.path)) continue
      if (file.kind === 'create') {
        if (this.archive.entries.has(file.path)) drifted.push(file.path)
        continue
      }
      if (file.kind === 'rename') {
        const source = file.previousPath
        if (!source || !this.archive.entries.has(source)) {
          drifted.push(source ?? file.path)
          continue
        }
        if (file.path !== source && this.archive.entries.has(file.path)) {
          drifted.push(file.path)
          continue
        }
        if (file.beforeText !== undefined && this.texts.get(source) !== file.beforeText) {
          drifted.push(source)
        }
        continue
      }
      if (file.kind === 'delete') {
        if (!this.archive.entries.has(file.path)) {
          drifted.push(file.path)
          continue
        }
        if (file.beforeText !== undefined && this.texts.get(file.path) !== file.beforeText) {
          drifted.push(file.path)
        }
        continue
      }
      // kind === 'update'
      if (!this.texts.has(file.path)) {
        drifted.push(file.path)
      } else if (file.beforeText !== undefined && this.texts.get(file.path) !== file.beforeText) {
        drifted.push(file.path)
      }
    }
    return drifted
  }

  /**
   * Overlays an unapplied pending proposal onto the working copy without altering `initialTexts`
   * or `initialPaths`, so subsequent writes yield a single cumulative diff against the real editor state.
   * See ADR 2026-11-21-agent-session-continuity.
   */
  seedPendingProposal(proposal: AgentProposal): { seeded: boolean; driftedPaths: string[] } {
    const driftedPaths = this.detectPendingProposalDrift(proposal)
    if (driftedPaths.length > 0) {
      return { seeded: false, driftedPaths }
    }

    const renames = proposal.files.filter((f) => f.kind === 'rename')
    const deletes = proposal.files.filter((f) => f.kind === 'delete')
    const creates = proposal.files.filter((f) => f.kind === 'create')
    const updates = proposal.files.filter((f) => f.kind === 'update')

    for (const file of renames) {
      const source = file.previousPath
      if (!source || isProtectedPath(source) || isProtectedPath(file.path)) continue
      const existingBytes = this.archive.entries.get(source)
      const origin = this.originByCurrent.get(source) ?? source
      this.archive.entries.delete(source)
      this.texts.delete(source)
      this.originByCurrent.delete(source)

      const orderIdx = this.archive.order.indexOf(source)
      if (orderIdx >= 0) this.archive.order[orderIdx] = file.path
      else if (!this.archive.order.includes(file.path)) this.archive.order.push(file.path)

      if (file.afterText !== undefined) {
        this.texts.set(file.path, file.afterText)
        this.archive.entries.set(file.path, encoder.encode(file.afterText))
      } else if (existingBytes) {
        this.archive.entries.set(file.path, existingBytes)
        if (isTextEntry(file.path)) this.texts.set(file.path, decoder.decode(existingBytes))
      }
      this.originByCurrent.set(file.path, origin)
    }

    for (const file of deletes) {
      if (isProtectedPath(file.path)) continue
      this.archive.entries.delete(file.path)
      this.archive.order = this.archive.order.filter((p) => p !== file.path)
      this.texts.delete(file.path)
      this.originByCurrent.delete(file.path)
      if (file.referencesAffected && file.referencesAffected.length > 0) {
        this.deletedRefs.set(file.path, file.referencesAffected)
      }
    }

    for (const file of creates) {
      if (isProtectedPath(file.path)) continue
      this.setTextEntry(file.path, file.afterText ?? '')
      this.originByCurrent.delete(file.path)
    }

    for (const file of updates) {
      if (isProtectedPath(file.path)) continue
      this.setTextEntry(file.path, file.afterText ?? '')
    }

    if (proposal.isStructural) {
      this.structuralTouched = true
    }

    this.refreshPackage()
    this.seededPendingProposal = true
    this.mutatedSinceSeed = false
    return { seeded: true, driftedPaths: [] }
  }

  private setTextEntry(path: string, content: string): void {
    this.texts.set(path, content)
    this.archive.entries.set(path, encoder.encode(content))
    if (!this.archive.order.includes(path)) this.archive.order.push(path)
  }

  private refreshPackage(): void {
    const opfXml = this.texts.get(this.pkg.opfPath)
    if (!opfXml) throw new Error(`OPF missing: ${this.pkg.opfPath}`)
    this.pkg = parsePackage(opfXml, this.pkg.opfPath, this.codec.parse)
  }

  private validateTextIfXml(path: string, content: string): string | null {
    if (!XML_EXTENSIONS.has(extensionOf(path))) return null
    try {
      return this.checkXmlFn(content)
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  private isStructuralFile(path: string): boolean {
    return path === this.pkg.opfPath || path === this.pkg.navPath || path === this.pkg.ncxPath || isProtectedPath(path)
  }

  private spinePaths(): string[] {
    return this.pkg.spine
      .map((id) => this.pkg.manifest.find((item) => item.id === id)?.path)
      .filter((path): path is string => typeof path === 'string')
  }

  private chapterDirectory(): string {
    const first = this.spinePaths()[0]
    return first ? dirname(first) : dirname(this.pkg.opfPath)
  }

  private nextChapterFilename(dir: string): string {
    const prefix = dir ? `${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/` : ''
    const pattern = new RegExp(`^${prefix}ch(\\d+)\\.xhtml$`)
    let max = 0
    for (const path of this.archive.entries.keys()) {
      const match = pattern.exec(path)
      if (match?.[1]) max = Math.max(max, Number(match[1]))
    }
    return `ch${String(max + 1).padStart(3, '0')}.xhtml`
  }

  private makeManifestId(filename: string): string {
    const stem = filename.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'chapter'
    return /^[a-zA-Z_]/.test(stem) ? stem : `ch_${stem}`
  }

  executeTool(name: AgentToolName, args: Record<string, unknown> = {}): AgentToolResult {
    const result = this.dispatchTool(name, args)
    if (result.ok && !isReadOnlyAgentTool(name)) {
      this.mutatedSinceSeed = true
    }
    return result
  }

  private dispatchTool(name: AgentToolName, args: Record<string, unknown>): AgentToolResult {
    switch (name) {
      case 'list_files':
        return this.toolListFiles()
      case 'read_file':
        return this.toolReadFile(args)
      case 'search_book':
        return this.toolSearchBook(args)
      case 'lint_book':
        return this.toolLintBook()
      case 'get_metadata':
        return this.toolGetMetadata()
      case 'get_toc':
        return this.toolGetToc()
      case 'scan_headings':
        return this.toolScanHeadings(args)
      case 'edit_file':
        return this.toolEditFile(args)
      case 'write_file':
        return this.toolWriteFile(args)
      case 'update_metadata':
        return this.toolUpdateMetadata(args)
      case 'update_toc':
        return this.toolUpdateToc(args)
      case 'generate_toc':
        return this.toolGenerateToc(args)
      case 'edit_toc':
        return this.toolEditToc(args)
      case 'create_chapter':
        return this.toolCreateChapter(args)
      case 'rename_file':
        return this.toolRenameFile(args)
      case 'delete_file':
        return this.toolDeleteFile(args)
      case 'split_chapter':
        return this.toolSplitChapter(args)
      case 'merge_chapters':
        return this.toolMergeChapters(args)
      case 'link_stylesheets':
        return this.toolLinkStylesheets(args)
      case 'create_stylesheet':
        return this.toolCreateStylesheet(args)
      case 'cleanup_unused_resources':
        return this.toolCleanupUnusedResources(args)
    }
  }

  private toolListFiles(): AgentToolResult {
    const mediaByPath = new Map(this.pkg.manifest.map((item) => [item.path, item.mediaType]))
    const spineSet = new Set(this.spinePaths())
    const files = this.archive.order
      .filter((path) => path !== 'mimetype' && !path.endsWith('/'))
      .map((path) => {
        const bytes = this.archive.entries.get(path)
        const text = this.texts.get(path)
        return {
          path,
          mediaType: mediaByPath.get(path) ?? '',
          inSpine: spineSet.has(path),
          isText: text !== undefined,
          lineCount: text !== undefined ? text.split('\n').length : undefined,
          byteSize: bytes?.byteLength ?? 0,
        }
      })

    return {
      ok: true,
      data: {
        title: this.pkg.metadata.title,
        author: this.pkg.metadata.creators.join(', '),
        language: this.pkg.metadata.language,
        opfPath: this.pkg.opfPath,
        navPath: this.pkg.navPath ?? null,
        ncxPath: this.pkg.ncxPath ?? null,
        spine: this.spinePaths(),
        files,
      },
    }
  }

  private toolReadFile(args: Record<string, unknown>): AgentToolResult {
    const path = typeof args.path === 'string' ? args.path.trim() : ''
    if (!path) return { ok: false, error: 'path is required' }
    const text = this.texts.get(path)
    if (text === undefined) {
      return this.archive.entries.has(path)
        ? { ok: false, error: `${path} is a binary file and cannot be read as text` }
        : { ok: false, error: `file not found: ${path}` }
    }

    const lines = text.split('\n')
    const totalLines = lines.length
    const startLine = Math.max(1, Math.min(totalLines, Math.floor(Number(args.startLine ?? 1)) || 1))
    const requestedEnd =
      args.endLine !== undefined ? Math.floor(Number(args.endLine)) : startLine + DEFAULT_READ_LINES - 1
    const cappedEnd = Math.min(totalLines, Math.max(startLine, Math.min(requestedEnd, startLine + MAX_READ_LINES - 1)))

    const outLines: string[] = []
    let chars = 0
    let actualEnd = startLine - 1
    let truncatedByChars = false

    for (let lineNo = startLine; lineNo <= cappedEnd; lineNo += 1) {
      const formatted = `${lineNo}|${lines[lineNo - 1] ?? ''}`
      if (outLines.length > 0 && chars + formatted.length + 1 > MAX_READ_CHARS) {
        truncatedByChars = true
        break
      }
      outLines.push(formatted)
      chars += formatted.length + 1
      actualEnd = lineNo
    }

    return {
      ok: true,
      data: {
        path,
        totalLines,
        startLine,
        endLine: actualEnd,
        truncated: actualEnd < totalLines || truncatedByChars,
        content: outLines.join('\n'),
      },
    }
  }

  private toolSearchBook(args: Record<string, unknown>): AgentToolResult {
    const query = typeof args.query === 'string' ? args.query : ''
    if (!query) return { ok: false, error: 'query is required' }

    const regex = args.regex === true
    const caseSensitive = args.caseSensitive === true
    const pathFilter = typeof args.pathFilter === 'string' ? args.pathFilter.trim() : ''
    const maxResults = Math.max(
      1,
      Math.min(MAX_SEARCH_RESULTS, Math.floor(Number(args.maxResults ?? DEFAULT_SEARCH_RESULTS)) || DEFAULT_SEARCH_RESULTS),
    )

    const files: SearchFile[] = []
    for (const [path, text] of this.texts) {
      if (isProtectedPath(path)) continue
      if (pathFilter && !path.includes(pathFilter)) continue
      files.push({ path, text })
    }

    const result = searchBook(files, query, { regex, caseSensitive, maxResults })
    return {
      ok: true,
      data: {
        query,
        count: result.matches.length,
        truncated: result.truncated,
        matches: result.matches.map((match) => ({
          path: match.path,
          line: match.line,
          column: match.column,
          preview: match.preview,
        })),
      },
    }
  }

  private toolLintBook(): AgentToolResult {
    const issues = lintBook(this.texts, this.pkg, this.archive, this.codec)
    return { ok: true, data: { count: issues.length, issues } }
  }

  private toolGetMetadata(): AgentToolResult {
    const opfXml = this.texts.get(this.pkg.opfPath) ?? ''
    const meta = opfXml ? readOpfMeta(opfXml, this.codec) : []
    return {
      ok: true,
      data: {
        opfPath: this.pkg.opfPath,
        metadata: this.pkg.metadata,
        meta,
      },
    }
  }

  private toolGetToc(): AgentToolResult {
    if (this.pkg.navPath) {
      const navXml = this.texts.get(this.pkg.navPath) ?? ''
      const entries = navXml ? readNavToc(navXml, this.codec) : []
      return {
        ok: true,
        data: {
          source: 'nav',
          tocPath: this.pkg.navPath,
          entries,
          brokenAnchors: findBrokenAnchors(entries, this.pkg.navPath, this.texts),
        },
      }
    }
    if (this.pkg.ncxPath) {
      const ncxXml = this.texts.get(this.pkg.ncxPath) ?? ''
      const entries = ncxXml ? readNcxToc(ncxXml, this.codec) : []
      return {
        ok: true,
        data: {
          source: 'ncx',
          tocPath: this.pkg.ncxPath,
          entries,
          brokenAnchors: findBrokenAnchors(entries, this.pkg.ncxPath, this.texts),
        },
      }
    }
    return { ok: true, data: { source: 'none', tocPath: null, entries: [], brokenAnchors: [] } }
  }

  private toolEditFile(args: Record<string, unknown>): AgentToolResult {
    const path = typeof args.path === 'string' ? args.path.trim() : ''
    const oldText = typeof args.oldText === 'string' ? args.oldText : ''
    const newText = typeof args.newText === 'string' ? args.newText : ''
    const replaceAll = args.replaceAll === true

    if (!path) return { ok: false, error: 'path is required' }
    if (isProtectedPath(path)) return { ok: false, error: `cannot edit protected archive metadata: ${path}` }
    if (!oldText) return { ok: false, error: 'oldText must be a non-empty string' }

    const current = this.texts.get(path)
    if (current === undefined) return { ok: false, error: `text file not found: ${path}` }

    const occurrences = current.split(oldText).length - 1
    if (occurrences === 0) {
      return { ok: false, error: `oldText not found in ${path}; read the file first to match exact text` }
    }
    if (occurrences > 1 && !replaceAll) {
      return {
        ok: false,
        error: `oldText matched ${occurrences} times in ${path}; include more surrounding context or pass replaceAll: true`,
      }
    }

    const updated = replaceAll ? current.split(oldText).join(newText) : current.replace(oldText, newText)
    const xmlError = this.validateTextIfXml(path, updated)
    if (xmlError) {
      return { ok: false, error: `edit rejected — resulting XML in ${path} is invalid: ${xmlError}` }
    }

    this.setTextEntry(path, updated)
    if (this.isStructuralFile(path)) {
      this.structuralTouched = true
      if (path === this.pkg.opfPath) {
        try {
          this.refreshPackage()
        } catch (error) {
          this.setTextEntry(path, current)
          return {
            ok: false,
            error: `edit rejected — OPF could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
          }
        }
      }
    }

    return {
      ok: true,
      data: {
        path,
        replacements: replaceAll ? occurrences : 1,
        lineCount: updated.split('\n').length,
      },
    }
  }

  private toolWriteFile(args: Record<string, unknown>): AgentToolResult {
    const path = typeof args.path === 'string' ? args.path.trim() : ''
    const content = typeof args.content === 'string' ? args.content : null

    if (!path) return { ok: false, error: 'path is required' }
    if (content === null) return { ok: false, error: 'content is required' }
    if (isProtectedPath(path)) return { ok: false, error: `cannot modify protected archive metadata: ${path}` }

    const previous = this.texts.get(path)
    if (previous === undefined) {
      return {
        ok: false,
        error: `file ${path} does not exist as a text entry; use create_chapter to add a new XHTML chapter`,
      }
    }

    const xmlError = this.validateTextIfXml(path, content)
    if (xmlError) {
      return { ok: false, error: `write rejected — XML in ${path} is invalid: ${xmlError}` }
    }

    this.setTextEntry(path, content)
    if (this.isStructuralFile(path)) {
      this.structuralTouched = true
      if (path === this.pkg.opfPath) {
        try {
          this.refreshPackage()
        } catch (error) {
          this.setTextEntry(path, previous)
          return {
            ok: false,
            error: `write rejected — OPF could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
          }
        }
      }
    }

    return { ok: true, data: { path, lineCount: content.split('\n').length } }
  }

  private toolUpdateMetadata(args: Record<string, unknown>): AgentToolResult {
    const opfPath = this.pkg.opfPath
    const currentOpf = this.texts.get(opfPath)
    if (!currentOpf) return { ok: false, error: `OPF file missing: ${opfPath}` }

    const rawMeta = args.metadata && typeof args.metadata === 'object' ? (args.metadata as Partial<MetadataDraft>) : null
    const rawMetaRows = Array.isArray(args.meta) ? (args.meta as OpfMetaRow[]) : null
    if (!rawMeta && !rawMetaRows) {
      return { ok: false, error: 'provide metadata and/or meta rows to update' }
    }

    let nextOpf = currentOpf
    if (rawMeta) {
      const merged: MetadataDraft = {
        title: typeof rawMeta.title === 'string' ? rawMeta.title : this.pkg.metadata.title,
        creators: Array.isArray(rawMeta.creators)
          ? rawMeta.creators.filter((v): v is string => typeof v === 'string')
          : this.pkg.metadata.creators,
        language: typeof rawMeta.language === 'string' ? rawMeta.language : this.pkg.metadata.language,
        identifier: typeof rawMeta.identifier === 'string' ? rawMeta.identifier : this.pkg.metadata.identifier,
        publisher: typeof rawMeta.publisher === 'string' ? rawMeta.publisher : this.pkg.metadata.publisher,
        date: typeof rawMeta.date === 'string' ? rawMeta.date : this.pkg.metadata.date,
        description: typeof rawMeta.description === 'string' ? rawMeta.description : this.pkg.metadata.description,
        subjects: Array.isArray(rawMeta.subjects)
          ? rawMeta.subjects.filter((v): v is string => typeof v === 'string')
          : this.pkg.metadata.subjects,
        rights: typeof rawMeta.rights === 'string' ? rawMeta.rights : this.pkg.metadata.rights,
      }
      nextOpf = writeOpfMetadata(nextOpf, merged, this.codec)
    }

    if (rawMetaRows) {
      const sanitized = rawMetaRows
        .filter((row): row is OpfMetaRow => Boolean(row && typeof row.property === 'string'))
        .map((row) => ({
          property: row.property,
          refines: typeof row.refines === 'string' ? row.refines : '',
          value: typeof row.value === 'string' ? row.value : '',
        }))
      nextOpf = writeOpfMeta(nextOpf, sanitized, this.codec)
    }

    nextOpf = touchOpfModified(nextOpf, isoModified(this.nowFn()), this.codec)
    const xmlError = this.validateTextIfXml(opfPath, nextOpf)
    if (xmlError) return { ok: false, error: `OPF update produced invalid XML: ${xmlError}` }

    this.setTextEntry(opfPath, nextOpf)
    this.structuralTouched = true
    this.refreshPackage()

    return { ok: true, data: { opfPath, metadata: this.pkg.metadata } }
  }

  private toolUpdateToc(args: Record<string, unknown>): AgentToolResult {
    const entries = normalizeTocInput(args.entries)
    if (!entries) return { ok: false, error: 'entries must be an array of { label, href, children? }' }

    const { navPath, ncxPath } = this.pkg
    if (!navPath && !ncxPath) return { ok: false, error: 'book has neither nav.xhtml nor toc.ncx' }

    const primaryTocPath = navPath ?? ncxPath!
    const updatedFiles: string[] = []

    if (navPath) {
      const navXml = this.texts.get(navPath)
      if (!navXml) return { ok: false, error: `nav file missing: ${navPath}` }
      const nextNav = writeNavToc(navXml, entries, this.codec)
      const err = this.validateTextIfXml(navPath, nextNav)
      if (err) return { ok: false, error: `updated nav XML is invalid: ${err}` }
      this.setTextEntry(navPath, nextNav)
      updatedFiles.push(navPath)
    }

    if (ncxPath) {
      const ncxXml = this.texts.get(ncxPath)
      if (ncxXml) {
        const rebased = rebaseTocHrefs(entries, primaryTocPath, ncxPath)
        const nextNcx = writeNcxToc(ncxXml, rebased, this.codec)
        const err = this.validateTextIfXml(ncxPath, nextNcx)
        if (err) return { ok: false, error: `updated ncx XML is invalid: ${err}` }
        this.setTextEntry(ncxPath, nextNcx)
        updatedFiles.push(ncxPath)
      }
    }

    this.structuralTouched = true
    const brokenAnchors = findBrokenAnchors(entries, primaryTocPath, this.texts)
    return { ok: true, data: { updatedFiles, brokenAnchors } }
  }

  private readCurrentToc(): { tocPath: string; entries: TocEntry[] } | null {
    if (this.pkg.navPath) {
      const navXml = this.texts.get(this.pkg.navPath)
      if (!navXml) return null
      return { tocPath: this.pkg.navPath, entries: readNavToc(navXml, this.codec) }
    }
    if (this.pkg.ncxPath) {
      const ncxXml = this.texts.get(this.pkg.ncxPath)
      if (!ncxXml) return null
      return { tocPath: this.pkg.ncxPath, entries: readNcxToc(ncxXml, this.codec) }
    }
    return null
  }

  private writeTocTree(entries: TocEntry[]): { ok: true; updatedFiles: string[]; primaryTocPath: string } | { ok: false; error: string } {
    const { navPath, ncxPath } = this.pkg
    const primaryTocPath = navPath ?? ncxPath
    if (!primaryTocPath) return { ok: false, error: 'book has neither nav.xhtml nor toc.ncx' }

    const updatedFiles: string[] = []
    if (navPath) {
      const navXml = this.texts.get(navPath)
      if (!navXml) return { ok: false, error: `nav file missing: ${navPath}` }
      const nextNav = writeNavToc(navXml, entries, this.codec)
      const err = this.validateTextIfXml(navPath, nextNav)
      if (err) return { ok: false, error: `updated nav XML is invalid: ${err}` }
      this.setTextEntry(navPath, nextNav)
      updatedFiles.push(navPath)
    }
    if (ncxPath) {
      const ncxXml = this.texts.get(ncxPath)
      if (ncxXml) {
        const rebased = rebaseTocHrefs(entries, primaryTocPath, ncxPath)
        const nextNcx = writeNcxToc(ncxXml, rebased, this.codec)
        const err = this.validateTextIfXml(ncxPath, nextNcx)
        if (err) return { ok: false, error: `updated ncx XML is invalid: ${err}` }
        this.setTextEntry(ncxPath, nextNcx)
        updatedFiles.push(ncxPath)
      }
    }
    this.structuralTouched = true
    return { ok: true, updatedFiles, primaryTocPath }
  }

  private toolScanHeadings(args: Record<string, unknown>): AgentToolResult {
    const levels = parseLevels(args.levels)
    const includeUntitledSpine = args.includeUntitledSpine === true
    const all = scanBookHeadings(this.pkg, this.texts, this.codec, { levels, includeUntitledSpine })
    const truncated = all.length > 500
    const headings = truncated ? all.slice(0, 500) : all
    return {
      ok: true,
      data: {
        count: all.length,
        truncated,
        headings,
      },
    }
  }

  private toolGenerateToc(args: Record<string, unknown>): AgentToolResult {
    const levels = parseLevels(args.levels) ?? [1, 2, 3]
    const mode = args.mode === 'append_missing' ? 'append_missing' : 'replace'
    const injectMissingIds = args.injectMissingIds !== false
    const includeUntitledSpine = args.includeUntitledSpine === true

    const updatedFiles: string[] = []
    if (!this.pkg.navPath && !this.pkg.ncxPath) {
      const init = initializeBookToc(this.pkg, this.texts, this.codec)
      const tocErr = this.validateTextIfXml(init.tocPath, init.tocContent)
      if (tocErr) return { ok: false, error: `initialized TOC XML is invalid: ${tocErr}` }
      const opfErr = this.validateTextIfXml(this.pkg.opfPath, init.opfXml)
      if (opfErr) return { ok: false, error: `updated OPF XML is invalid: ${opfErr}` }
      this.setTextEntry(init.tocPath, init.tocContent)
      this.setTextEntry(this.pkg.opfPath, touchOpfModified(init.opfXml, isoModified(this.nowFn()), this.codec))
      this.structuralTouched = true
      this.refreshPackage()
      updatedFiles.push(init.tocPath, this.pkg.opfPath)
    }

    const current = this.readCurrentToc()
    if (!current) return { ok: false, error: 'failed to read TOC document after initialization' }

    const generated = generateTocFromHeadings(this.pkg, this.texts, current.tocPath, this.codec, {
      levels,
      mode,
      injectMissingIds,
      includeUntitledSpine,
      existingEntries: current.entries,
    })

    for (const [chapterPath, chapterXml] of generated.updatedChapters) {
      const err = this.validateTextIfXml(chapterPath, chapterXml)
      if (err) return { ok: false, error: `chapter ${chapterPath} became invalid XML after id injection: ${err}` }
    }
    for (const [chapterPath, chapterXml] of generated.updatedChapters) {
      this.setTextEntry(chapterPath, chapterXml)
      updatedFiles.push(chapterPath)
    }

    const written = this.writeTocTree(generated.entries)
    if (!written.ok) return written
    for (const file of written.updatedFiles) {
      if (!updatedFiles.includes(file)) updatedFiles.push(file)
    }

    const brokenAnchors = findBrokenAnchors(generated.entries, written.primaryTocPath, this.texts)
    return {
      ok: true,
      data: {
        tocPath: written.primaryTocPath,
        mode,
        addedCount: generated.addedCount,
        totalCount: countTocEntries(generated.entries),
        injectedIdCount: generated.injectedIdCount,
        updatedChapters: [...generated.updatedChapters.keys()],
        updatedFiles,
        brokenAnchors,
      },
    }
  }

  private toolEditToc(args: Record<string, unknown>): AgentToolResult {
    const action = typeof args.action === 'string' ? args.action : ''
    const current = this.readCurrentToc()
    if (!current) return { ok: false, error: 'book has neither nav.xhtml nor toc.ncx' }

    let next: TocEntry[] = current.entries
    let meta: Record<string, unknown> = {}

    switch (action) {
      case 'insert': {
        const label = typeof args.label === 'string' ? args.label.trim() : ''
        const href = typeof args.href === 'string' ? args.href.trim() : ''
        if (!label || !href) return { ok: false, error: 'insert requires non-empty label and href' }
        const path = args.path === undefined ? [] : parseTocPath(args.path)
        if (!path) return { ok: false, error: 'path must be an array of non-negative integers' }
        const position: TocInsertPosition =
          args.position === 'before' || args.position === 'inside' ? args.position : 'after'
        next = insertTocEntry(current.entries, path, { label, href, rawHtml: '', children: [] }, position)
        break
      }
      case 'update': {
        const path = parseTocPath(args.path)
        if (!path || path.length === 0) return { ok: false, error: 'update requires a non-empty path' }
        if (!getTocEntry(current.entries, path)) return { ok: false, error: `toc entry not found at [${path.join(',')}]` }
        const nextLabel = typeof args.label === 'string' ? args.label.trim() : undefined
        const nextHref = typeof args.href === 'string' ? args.href.trim() : undefined
        if (!nextLabel && !nextHref) return { ok: false, error: 'update requires label and/or href' }
        next = updateTocEntry(current.entries, path, (entry) => ({
          ...entry,
          ...(nextLabel ? { label: nextLabel, rawHtml: '' } : {}),
          ...(nextHref ? { href: nextHref } : {}),
        }))
        break
      }
      case 'move': {
        const delta = args.delta === -1 || args.delta === 1 ? args.delta : null
        if (!delta) return { ok: false, error: 'move requires delta (-1 or 1)' }
        const paths = args.paths !== undefined ? parseTocPaths(args.paths) : null
        if (paths) {
          next = moveTocEntries(current.entries, paths, delta)
        } else {
          const path = parseTocPath(args.path)
          if (!path || path.length === 0) return { ok: false, error: 'move requires path or paths' }
          next = moveTocEntry(current.entries, path, delta)
        }
        break
      }
      case 'move_subtree': {
        const fromPath = parseTocPath(args.path)
        const toPath = parseTocPath(args.toPath)
        const position: TocInsertPosition =
          args.position === 'before' || args.position === 'inside' ? args.position : 'after'
        if (!fromPath || fromPath.length === 0 || !toPath || toPath.length === 0) {
          return { ok: false, error: 'move_subtree requires non-empty path and toPath' }
        }
        next = moveTocSubtree(current.entries, fromPath, toPath, position)
        break
      }
      case 'indent': {
        const paths = args.paths !== undefined ? parseTocPaths(args.paths) : null
        if (paths) {
          next = indentTocEntries(current.entries, paths)
        } else {
          const path = parseTocPath(args.path)
          if (!path || path.length === 0) return { ok: false, error: 'indent requires path or paths' }
          next = indentTocEntry(current.entries, path)
        }
        break
      }
      case 'outdent': {
        const paths = args.paths !== undefined ? parseTocPaths(args.paths) : null
        if (paths) {
          next = outdentTocEntries(current.entries, paths)
        } else {
          const path = parseTocPath(args.path)
          if (!path || path.length === 0) return { ok: false, error: 'outdent requires path or paths' }
          next = outdentTocEntry(current.entries, path)
        }
        break
      }
      case 'remove': {
        const keepChildren = args.keepChildren === true
        const paths = args.paths !== undefined ? parseTocPaths(args.paths) : null
        if (paths) {
          next = removeTocEntries(current.entries, paths, { keepChildren })
        } else {
          const path = parseTocPath(args.path)
          if (!path || path.length === 0) return { ok: false, error: 'remove requires path or paths' }
          next = removeTocEntry(current.entries, path, { keepChildren })
        }
        break
      }
      case 'refresh_labels': {
        const paths = args.paths !== undefined ? parseTocPaths(args.paths) : undefined
        if (args.paths !== undefined && !paths) return { ok: false, error: 'paths must be an array of valid paths' }
        const refreshed = refreshTocLabelsFromHeadings(current.entries, current.tocPath, this.texts, this.codec, {
          paths: paths ?? undefined,
          overwriteRichHtml: args.overwriteRichHtml === true,
        })
        next = refreshed.entries
        meta = { updatedCount: refreshed.updatedCount, skippedRichCount: refreshed.skippedRichCount }
        break
      }
      case 'clean_broken': {
        const cleaned = removeBrokenTocEntries(current.entries, current.tocPath, this.texts)
        next = cleaned.entries
        meta = { removedCount: cleaned.removedCount }
        break
      }
      default:
        return {
          ok: false,
          error:
            'action must be one of insert, update, move, move_subtree, indent, outdent, remove, refresh_labels, clean_broken',
        }
    }

    const written = this.writeTocTree(next)
    if (!written.ok) return written
    const brokenAnchors = findBrokenAnchors(next, written.primaryTocPath, this.texts)
    return {
      ok: true,
      data: {
        action,
        totalCount: countTocEntries(next),
        updatedFiles: written.updatedFiles,
        brokenAnchors,
        ...meta,
      },
    }
  }

  private toolCreateChapter(args: Record<string, unknown>): AgentToolResult {
    const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : '新章节'
    const dir = this.chapterDirectory()
    const rawFilename =
      typeof args.filename === 'string' && args.filename.trim()
        ? args.filename.trim()
        : this.nextChapterFilename(dir)

    if (!isSafeFilename(rawFilename)) {
      return { ok: false, error: `invalid filename: ${rawFilename}` }
    }
    const filename = /\.(xhtml|html)$/i.test(rawFilename) ? rawFilename : `${rawFilename}.xhtml`
    const targetPath = dir ? `${dir}/${filename}` : filename

    if (this.archive.entries.has(targetPath)) {
      return { ok: false, error: `file already exists: ${targetPath}` }
    }

    const content =
      typeof args.content === 'string' && args.content.trim().length > 0
        ? args.content
        : chapterSkeleton(title, this.pkg.metadata.language || 'zh-CN')

    const xmlError = this.validateTextIfXml(targetPath, content)
    if (xmlError) {
      return { ok: false, error: `chapter content is not well-formed XML: ${xmlError}` }
    }

    const opfPath = this.pkg.opfPath
    const opfXml = this.texts.get(opfPath)
    if (!opfXml) return { ok: false, error: `OPF file missing: ${opfPath}` }

    const baseDir = dirname(opfPath)
    let nextOpf = addSpineDocument(
      opfXml,
      {
        id: this.makeManifestId(filename),
        href: relativePath(baseDir, targetPath),
        mediaType: 'application/xhtml+xml',
      },
      this.codec,
    )

    const insertAfter = typeof args.insertAfter === 'string' ? args.insertAfter.trim() : ''
    if (insertAfter) {
      const currentSpine = this.spinePaths()
      const idx = currentSpine.indexOf(insertAfter)
      if (idx >= 0) {
        const reordered = [...currentSpine.slice(0, idx + 1), targetPath, ...currentSpine.slice(idx + 1)]
        nextOpf = reorderSpine(nextOpf, reordered, baseDir, this.codec)
      }
    }

    nextOpf = touchOpfModified(nextOpf, isoModified(this.nowFn()), this.codec)

    this.setTextEntry(targetPath, content)
    this.setTextEntry(opfPath, nextOpf)
    this.structuralTouched = true
    this.refreshPackage()

    if (args.addToToc === true) {
      const { navPath, ncxPath } = this.pkg
      if (navPath) {
        const navXml = this.texts.get(navPath)
        if (navXml) {
          const entries = readNavToc(navXml, this.codec)
          entries.push({ label: title, href: relativePath(dirname(navPath), targetPath), children: [] })
          this.setTextEntry(navPath, writeNavToc(navXml, entries, this.codec))
          if (ncxPath) {
            const ncxXml = this.texts.get(ncxPath)
            if (ncxXml) {
              this.setTextEntry(ncxPath, writeNcxToc(ncxXml, rebaseTocHrefs(entries, navPath, ncxPath), this.codec))
            }
          }
        }
      } else if (ncxPath) {
        const ncxXml = this.texts.get(ncxPath)
        if (ncxXml) {
          const entries = readNcxToc(ncxXml, this.codec)
          entries.push({ label: title, href: relativePath(dirname(ncxPath), targetPath), children: [] })
          this.setTextEntry(ncxPath, writeNcxToc(ncxXml, entries, this.codec))
        }
      }
    }

    return { ok: true, data: { path: targetPath, title, addedToToc: args.addToToc === true } }
  }

  private toolRenameFile(args: Record<string, unknown>): AgentToolResult {
    const path = typeof args.path === 'string' ? args.path.trim() : ''
    const newFilename = typeof args.newFilename === 'string' ? args.newFilename.trim() : ''

    if (!path) return { ok: false, error: 'path is required' }
    if (!isSafeFilename(newFilename)) return { ok: false, error: `invalid newFilename: ${newFilename}` }
    if (isProtectedPath(path) || path === this.pkg.opfPath) {
      return { ok: false, error: `cannot rename protected or package file: ${path}` }
    }
    if (!this.archive.entries.has(path)) {
      return { ok: false, error: `file not found: ${path}` }
    }

    const dir = dirname(path)
    const target = dir ? `${dir}/${newFilename}` : newFilename
    if (target === path) return { ok: true, data: { previousPath: path, path: target, referencesRewritten: 0 } }
    if (this.archive.entries.has(target)) {
      return { ok: false, error: `target path already exists: ${target}` }
    }

    const opfPath = this.pkg.opfPath
    const opfXml = this.texts.get(opfPath)
    if (!opfXml) return { ok: false, error: `OPF file missing: ${opfPath}` }

    const baseDir = dirname(opfPath)
    let nextOpf: string
    try {
      nextOpf = renameManifestEntry(opfXml, path, relativePath(baseDir, target), baseDir, this.codec)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'failed to rename manifest entry' }
    }
    nextOpf = touchOpfModified(nextOpf, isoModified(this.nowFn()), this.codec)

    const filesForRewrite = new Map(this.texts)
    filesForRewrite.set(opfPath, nextOpf)
    // Renaming without rewriting href/src leaves every chapter and TOC pointing at a dead path.
    // See ADR 2026-11-19-file-structure-editing.
    const rewritten = rewriteReferences(filesForRewrite, new Map([[path, target]]))

    const bytes = this.archive.entries.get(path)!
    this.archive.entries.delete(path)
    this.archive.entries.set(target, bytes)
    this.archive.order = this.archive.order.map((entry) => (entry === path ? target : entry))

    const movedText = rewritten.files.get(path)
    rewritten.files.delete(path)
    if (movedText !== undefined) rewritten.files.set(target, movedText)

    this.texts = rewritten.files
    for (const [textPath, textValue] of this.texts) {
      this.archive.entries.set(textPath, encoder.encode(textValue))
    }

    const origin = this.originByCurrent.get(path)
    this.originByCurrent.delete(path)
    if (origin !== undefined) this.originByCurrent.set(target, origin)

    this.structuralTouched = true
    this.refreshPackage()

    return {
      ok: true,
      data: {
        previousPath: path,
        path: target,
        referencesRewritten: rewritten.touched.length,
      },
    }
  }

  private toolDeleteFile(args: Record<string, unknown>): AgentToolResult {
    const path = typeof args.path === 'string' ? args.path.trim() : ''
    if (!path) return { ok: false, error: 'path is required' }
    if (isProtectedPath(path) || path === this.pkg.opfPath) {
      return { ok: false, error: `cannot delete protected or package file: ${path}` }
    }
    if (path === this.pkg.navPath) {
      return { ok: false, error: `cannot delete the EPUB navigation document (${path})` }
    }
    if (!this.archive.entries.has(path)) {
      return { ok: false, error: `file not found: ${path}` }
    }

    const opfPath = this.pkg.opfPath
    const opfXml = this.texts.get(opfPath)
    if (!opfXml) return { ok: false, error: `OPF file missing: ${opfPath}` }

    const ignored = new Set([path, opfPath, this.pkg.navPath, this.pkg.ncxPath].filter(Boolean) as string[])
    const affected = collectReferences(this.texts)
      .filter((reference) => reference.targetPath === path && !ignored.has(reference.from))
      .map((reference) => ({
        from: reference.from,
        line: lineOf(this.texts.get(reference.from) ?? '', reference.offset),
      }))

    let nextOpf: string
    try {
      nextOpf = removeManifestEntry(opfXml, path, dirname(opfPath), this.codec)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'failed to remove manifest entry' }
    }
    nextOpf = touchOpfModified(nextOpf, isoModified(this.nowFn()), this.codec)
    this.setTextEntry(opfPath, nextOpf)

    if (this.pkg.navPath) {
      const navXml = this.texts.get(this.pkg.navPath)
      if (navXml) {
        try {
          const pruned = pruneToc(readNavToc(navXml, this.codec), this.pkg.navPath, path)
          if (pruned.changed) this.setTextEntry(this.pkg.navPath, writeNavToc(navXml, pruned.entries, this.codec))
        } catch {
          // Leave unreadable nav untouched; lint/validation reports it.
        }
      }
    }

    if (this.pkg.ncxPath) {
      const ncxXml = this.texts.get(this.pkg.ncxPath)
      if (ncxXml) {
        try {
          const pruned = pruneToc(readNcxToc(ncxXml, this.codec), this.pkg.ncxPath, path)
          if (pruned.changed) this.setTextEntry(this.pkg.ncxPath, writeNcxToc(ncxXml, pruned.entries, this.codec))
        } catch {
          // Leave unreadable ncx untouched.
        }
      }
    }

    this.archive.entries.delete(path)
    this.archive.order = this.archive.order.filter((entry) => entry !== path)
    this.texts.delete(path)

    const origin = this.originByCurrent.get(path)
    this.originByCurrent.delete(path)
    if (origin !== undefined && this.initialPaths.has(origin)) {
      this.deletedRefs.set(origin, affected)
    }

    this.structuralTouched = true
    this.refreshPackage()

    return {
      ok: true,
      data: {
        deletedPath: path,
        brokenReferencesCreated: affected,
      },
    }
  }

  private applyWorkspaceResult(nextFiles: Map<string, string>, nextArchive: EpubArchive, nextPkg: EpubPackage): void {
    const opfPath = nextPkg.opfPath
    const opfXml = nextFiles.get(opfPath)
    if (opfXml) {
      const touchedOpf = touchOpfModified(opfXml, isoModified(this.nowFn()), this.codec)
      nextFiles.set(opfPath, touchedOpf)
      nextArchive.entries.set(opfPath, encoder.encode(touchedOpf))
      nextPkg = parsePackage(touchedOpf, opfPath, this.codec.parse)
    }
    this.texts = nextFiles
    this.archive = nextArchive
    this.pkg = nextPkg
    this.structuralTouched = true
  }

  private toolSplitChapter(args: Record<string, unknown>): AgentToolResult {
    const path = typeof args.path === 'string' ? args.path.trim() : ''
    if (!path) return { ok: false, error: 'path is required' }
    const text = this.texts.get(path)
    if (text === undefined) return { ok: false, error: `chapter not found: ${path}` }

    try {
      let result
      if (args.byMarkers === true) {
        result = splitChapterAtMarkersInBook({
          files: this.texts,
          pkg: this.pkg,
          archive: this.archive,
          path,
          codec: this.codec,
        })
      } else if (typeof args.headingLevel === 'number') {
        result = splitChapterByHeadingLevelInBook({
          files: this.texts,
          pkg: this.pkg,
          archive: this.archive,
          path,
          level: Math.floor(args.headingLevel),
          codec: this.codec,
        })
      } else {
        let offset = -1
        if (typeof args.beforeText === 'string' && args.beforeText.length > 0) {
          const first = text.indexOf(args.beforeText)
          if (first < 0) return { ok: false, error: `beforeText not found in ${path}` }
          if (text.indexOf(args.beforeText, first + 1) >= 0) {
            return { ok: false, error: `beforeText matched multiple times in ${path}; provide more context` }
          }
          offset = first
        } else if (typeof args.line === 'number' && Number.isInteger(args.line) && args.line >= 1) {
          const lines = text.split('\n')
          if (args.line > lines.length) {
            return { ok: false, error: `line ${args.line} exceeds file length (${lines.length})` }
          }
          let acc = 0
          for (let i = 0; i < args.line - 1; i += 1) acc += (lines[i]?.length ?? 0) + 1
          offset = acc
        } else {
          return { ok: false, error: 'provide one of: line, beforeText, byMarkers: true, or headingLevel (1-6)' }
        }
        result = splitChapterInBook({
          files: this.texts,
          pkg: this.pkg,
          archive: this.archive,
          path,
          offset,
          codec: this.codec,
        })
      }

      this.applyWorkspaceResult(result.files, result.archive, result.pkg)
      return {
        ok: true,
        data: {
          sourcePath: result.sourcePath,
          createdPaths: result.createdPaths,
          referencesRewritten: result.referencesRewritten,
        },
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private toolMergeChapters(args: Record<string, unknown>): AgentToolResult {
    const rawPaths = Array.isArray(args.paths)
      ? args.paths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map((p) => p.trim())
      : []
    if (rawPaths.length < 2) {
      return { ok: false, error: 'paths must contain at least 2 chapter paths' }
    }
    for (const p of rawPaths) {
      if (isProtectedPath(p) || p === this.pkg.opfPath || p === this.pkg.navPath) {
        return { ok: false, error: `cannot merge protected or navigation file: ${p}` }
      }
    }

    try {
      const result = mergeChaptersInBook({
        files: this.texts,
        pkg: this.pkg,
        archive: this.archive,
        paths: rawPaths,
        codec: this.codec,
      })
      for (const removed of result.removedPaths) {
        this.originByCurrent.delete(removed)
      }
      this.applyWorkspaceResult(result.files, result.archive, result.pkg)
      return {
        ok: true,
        data: {
          primaryPath: result.primaryPath,
          removedPaths: result.removedPaths,
          referencesRewritten: result.referencesRewritten,
        },
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private toolLinkStylesheets(args: Record<string, unknown>): AgentToolResult {
    const chapterPaths = Array.isArray(args.chapterPaths)
      ? args.chapterPaths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map((p) => p.trim())
      : []
    if (chapterPaths.length === 0) return { ok: false, error: 'chapterPaths must be a non-empty array' }

    const toArray = (v: unknown) =>
      Array.isArray(v)
        ? v.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map((p) => p.trim())
        : undefined
    const set = toArray(args.set)
    const add = toArray(args.add)
    const remove = toArray(args.remove)
    if (!set && !add && !remove) {
      return { ok: false, error: 'provide set, add, or remove stylesheet paths' }
    }

    for (const cssPath of [...(set ?? []), ...(add ?? [])]) {
      if (!this.archive.entries.has(cssPath)) {
        return { ok: false, error: `stylesheet not found in archive: ${cssPath}` }
      }
    }
    for (const chPath of chapterPaths) {
      if (!this.texts.has(chPath)) {
        return { ok: false, error: `chapter not found: ${chPath}` }
      }
    }

    const updated = updateChaptersStylesheets(this.texts, chapterPaths, { set, add, remove })
    for (const changed of updated.changedPaths) {
      const nextText = updated.files.get(changed)
      if (nextText !== undefined) this.setTextEntry(changed, nextText)
    }

    return {
      ok: true,
      data: {
        changedPaths: updated.changedPaths,
        chapterCount: chapterPaths.length,
      },
    }
  }

  private toolCreateStylesheet(args: Record<string, unknown>): AgentToolResult {
    const filename = typeof args.filename === 'string' ? args.filename.trim() : undefined
    const content = typeof args.content === 'string' ? args.content : undefined
    const linkToChapters = Array.isArray(args.linkToChapters)
      ? args.linkToChapters.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map((p) => p.trim())
      : []

    try {
      const created = createBlankStylesheet({
        files: this.texts,
        pkg: this.pkg,
        archive: this.archive,
        filename,
        content,
        codec: this.codec,
      })
      let nextFiles = created.files
      let linkedChapters: string[] = []
      if (linkToChapters.length > 0) {
        const linked = updateChaptersStylesheets(nextFiles, linkToChapters, { add: [created.createdPath] })
        nextFiles = linked.files
        linkedChapters = linked.changedPaths
        for (const ch of linkedChapters) {
          const val = nextFiles.get(ch)
          if (val !== undefined) created.archive.entries.set(ch, encoder.encode(val))
        }
      }
      this.applyWorkspaceResult(nextFiles, created.archive, created.pkg)
      return {
        ok: true,
        data: {
          path: created.createdPath,
          linkedChapters,
        },
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private toolCleanupUnusedResources(args: Record<string, unknown>): AgentToolResult {
    const unused = findUnusedResources(this.texts, this.pkg, this.archive)
    if (args.dryRun === true) {
      return { ok: true, data: { unused, removedPaths: [] } }
    }

    const unusedSet = new Set(unused.map((item) => item.path))
    let targets: string[]
    if (Array.isArray(args.paths) && args.paths.length > 0) {
      const requested = args.paths
        .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        .map((p) => p.trim())
      const notUnused = requested.filter((p) => !unusedSet.has(p))
      if (notUnused.length > 0) {
        return {
          ok: false,
          error: `refused to delete referenced or protected resource(s): ${notUnused.join(', ')}`,
        }
      }
      targets = requested
    } else {
      const allowedCategories = new Set<UnusedResourceCategory>(
        Array.isArray(args.categories) && args.categories.length > 0
          ? args.categories.filter(
              (c): c is UnusedResourceCategory => c === 'image' || c === 'font' || c === 'stylesheet',
            )
          : ['image', 'font', 'stylesheet'],
      )
      targets = unused.filter((item) => allowedCategories.has(item.category)).map((item) => item.path)
    }

    if (targets.length === 0) {
      return { ok: true, data: { removedPaths: [], remainingUnusedCount: unused.length } }
    }

    const cleaned = deleteUnusedResourcesInBook({
      files: this.texts,
      pkg: this.pkg,
      archive: this.archive,
      paths: targets,
      codec: this.codec,
    })
    for (const removed of cleaned.removedPaths) {
      this.originByCurrent.delete(removed)
    }
    this.applyWorkspaceResult(cleaned.files, cleaned.archive, cleaned.pkg)
    const remaining = findUnusedResources(this.texts, this.pkg, this.archive)
    return {
      ok: true,
      data: {
        removedPaths: cleaned.removedPaths,
        remainingUnusedCount: remaining.length,
      },
    }
  }

  /**
   * Compiles the net changes accumulated during a turn into a reviewable proposal.
   * Returns null when the Agent made no net changes (or made no new writes after seeding a pending proposal).
   */
  buildProposal(id: string): AgentProposal | null {
    if (this.seededPendingProposal && !this.mutatedSinceSeed) {
      return null
    }
    const files: AgentProposalFile[] = []
    const survivingOrigins = new Set<string>()

    for (const currentPath of this.archive.order) {
      if (isProtectedPath(currentPath)) continue
      const origin = this.originByCurrent.get(currentPath)
      const afterText = this.texts.get(currentPath)

      if (origin === undefined) {
        // Newly created during this turn.
        files.push({
          path: currentPath,
          kind: 'create',
          ...(afterText !== undefined ? { afterText } : {}),
        })
        continue
      }

      survivingOrigins.add(origin)
      const beforeText = this.initialTexts.get(origin)

      if (origin !== currentPath) {
        files.push({
          path: currentPath,
          previousPath: origin,
          kind: 'rename',
          ...(beforeText !== undefined ? { beforeText } : {}),
          ...(afterText !== undefined ? { afterText } : {}),
        })
      } else if (beforeText !== afterText && afterText !== undefined) {
        files.push({
          path: currentPath,
          kind: 'update',
          beforeText: beforeText ?? '',
          afterText,
        })
      }
    }

    for (const initialPath of this.initialPaths) {
      if (isProtectedPath(initialPath)) continue
      if (survivingOrigins.has(initialPath)) continue
      const beforeText = this.initialTexts.get(initialPath)
      const refs = this.deletedRefs.get(initialPath)
      files.push({
        path: initialPath,
        kind: 'delete',
        ...(beforeText !== undefined ? { beforeText } : {}),
        ...(refs && refs.length > 0 ? { referencesAffected: refs } : {}),
      })
    }

    if (files.length === 0) return null

    const validationIssues = validateStructure(this.archive, this.pkg)
    for (const file of files) {
      if (file.kind === 'delete' || file.afterText === undefined) continue
      const xmlError = this.validateTextIfXml(file.path, file.afterText)
      if (xmlError) {
        validationIssues.push({
          code: 'invalid-xml',
          message: `${basenameOf(file.path)} XML 语法错误：${xmlError}`,
          path: file.path,
        })
      }
    }

    const isStructural =
      this.structuralTouched ||
      files.some((file) => file.kind !== 'update' || this.isStructuralFile(file.path))

    return {
      id,
      isStructural,
      validationIssues,
      files,
    }
  }
}
