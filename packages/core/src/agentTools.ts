import { mergeChaptersInBook } from './chapterMerge'
import {
  splitChapterAtMarkersInBook,
  splitChapterByHeadingLevelInBook,
  splitChapterInBook,
} from './chapterSplit'
import { formatCss, formatXhtml } from './formatCode'
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
import { buildSearchPattern, searchBook, type SearchFile } from './search'
import {
  createBlankStylesheet,
  deleteUnusedResourcesInBook,
  findUnusedResources,
  getLinkedStylesheets,
  listBookStylesheets,
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
import {
  generateTocFromHeadings,
  listDocumentAnchors,
  refreshTocLabelsFromHeadings,
  scanBookHeadings,
} from './tocGenerate'
import { initializeBookToc } from './tocInit'
import type { EpubArchive, EpubIssue, EpubPackage } from './types'
import { parsePackage, readOpfPath } from './unpack'
import { validateStructure } from './validate'
import type { XmlCodec } from './xml'

/**
 * Framework-agnostic EPUB tool primitives and sandboxed working copy for the built-in Agent.
 * Kept pure inside `@booksmith/core` so both the server runner and any future MCP server
 * share identical EPUB mutation and validation rules. See ADR 2026-11-20-builtin-epub-agent
 * and ADR 2026-11-22-agent-book-editing-toolkit.
 */

export type AgentToolName =
  | 'list_files'
  | 'read_file'
  | 'search_book'
  | 'lint_book'
  | 'get_metadata'
  | 'get_toc'
  | 'scan_headings'
  | 'list_anchors'
  | 'find_references'
  | 'inspect_image'
  | 'edit_file'
  | 'replace_in_book'
  | 'write_file'
  | 'format_file'
  | 'update_metadata'
  | 'update_toc'
  | 'generate_toc'
  | 'edit_toc'
  | 'create_chapter'
  | 'rename_file'
  | 'delete_file'
  | 'reorder_spine'
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
  'list_anchors',
  'find_references',
  'inspect_image',
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
  'replace_in_book',
  'write_file',
  'format_file',
  'update_metadata',
  'update_toc',
  'generate_toc',
  'edit_toc',
  'create_chapter',
  'rename_file',
  'delete_file',
  'reorder_spine',
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
  /**
   * Optional true byte sizes for archive entries (especially binary assets whose bytes were
   * omitted to avoid detoasting in Postgres). Keeps `list_files` and `cleanup_unused_resources`
   * reporting accurate resource sizes.
   */
  entrySizes?: ReadonlyMap<string, number>
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

/**
 * Incremental proposal delta emitted after each successful write tool in `review` mode so
 * large chapters are not re-serialized on every step.
 * See ADR 2026-11-22-live-streaming-agent-review.
 */
export interface AgentProposalDelta {
  proposalId: string
  isStructural: boolean
  changedFiles: AgentProposalFile[]
  removedPaths: string[]
  focusPath: string | null
}

export interface AgentToolResult {
  ok: boolean
  data?: unknown
  error?: string
}

const XML_EXTENSIONS = new Set(['xhtml', 'xml', 'opf', 'ncx', 'svg'])
const HTML_EXTENSIONS = new Set(['xhtml', 'html', 'htm'])
const FORMATTABLE_XML_EXTENSIONS = new Set(['xhtml', 'html', 'htm', 'xml', 'opf', 'ncx'])
const DEFAULT_READ_LINES = 200
const MAX_READ_LINES = 400
const MAX_READ_CHARS = 24_000
const DEFAULT_SEARCH_RESULTS = 40
const MAX_SEARCH_RESULTS = 100
const DEFAULT_REPLACE_MAX_FILES = 200
const MAX_REPLACE_MAX_FILES = 500
const MAX_EDIT_TOC_INLINE_ENTRIES = 150

const IMAGE_EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

/**
 * Zero-dependency image header probe for PNG, JPEG, GIF, and WebP.
 * Returns pixel `{ width, height }` or null when unrecognized/truncated.
 */
export function probeImageDimensions(bytes: Uint8Array, mediaType?: string): { width: number; height: number } | null {
  if (!bytes || bytes.byteLength < 10) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  // PNG: 89 50 4E 47 0D 0A 1A 0A + IHDR
  if (
    bytes.byteLength >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a &&
    bytes[12] === 0x49 &&
    bytes[13] === 0x48 &&
    bytes[14] === 0x44 &&
    bytes[15] === 0x52
  ) {
    const width = view.getUint32(16, false)
    const height = view.getUint32(20, false)
    return width > 0 && height > 0 ? { width, height } : null
  }

  // GIF: GIF87a / GIF89a
  if (
    bytes.byteLength >= 10 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    const width = view.getUint16(6, true)
    const height = view.getUint16(8, true)
    return width > 0 && height > 0 ? { width, height } : null
  }

  // WebP: RIFF....WEBP
  if (
    bytes.byteLength >= 30 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!)
    if (chunk === 'VP8X' && bytes.byteLength >= 30) {
      const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16))
      const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16))
      return width > 0 && height > 0 ? { width, height } : null
    }
    if (chunk === 'VP8L' && bytes.byteLength >= 25 && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true)
      const width = (bits & 0x3fff) + 1
      const height = ((bits >> 14) & 0x3fff) + 1
      return width > 0 && height > 0 ? { width, height } : null
    }
    if (chunk === 'VP8 ' && bytes.byteLength >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      const width = view.getUint16(26, true) & 0x3fff
      const height = view.getUint16(28, true) & 0x3fff
      return width > 0 && height > 0 ? { width, height } : null
    }
  }

  // JPEG: FF D8
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 3 < bytes.byteLength) {
      if (bytes[offset] !== 0xff) {
        offset += 1
        continue
      }
      while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1
      if (offset >= bytes.byteLength) break
      const marker = bytes[offset]!
      offset += 1
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        continue
      }
      if (offset + 1 >= bytes.byteLength) break
      const length = view.getUint16(offset, false)
      if (length < 2 || offset + length > bytes.byteLength) break
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      if (isSof && offset + 6 < bytes.byteLength) {
        const height = view.getUint16(offset + 3, false)
        const width = view.getUint16(offset + 5, false)
        return width > 0 && height > 0 ? { width, height } : null
      }
      offset += length
    }
  }

  void mediaType
  return null
}

function decodeXmlEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z]+));/g, (full, dec?: string, hex?: string, named?: string) => {
    if (dec) {
      const code = Number.parseInt(dec, 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : full
    }
    if (hex) {
      const code = Number.parseInt(hex, 16)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : full
    }
    switch (named) {
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      case 'nbsp':
        return ' '
      case 'mdash':
        return '—'
      case 'ndash':
        return '–'
      case 'hellip':
        return '…'
      case 'ldquo':
        return '“'
      case 'rdquo':
        return '”'
      case 'lsquo':
        return '‘'
      case 'rsquo':
        return '’'
      default:
        return full
    }
  })
}

const READABLE_BLOCK_TAGS = new Set([
  'p',
  'div',
  'li',
  'blockquote',
  'pre',
  'tr',
  'dt',
  'dd',
  'figcaption',
  'caption',
  'section',
  'article',
  'aside',
  'header',
  'footer',
  'hr',
  'br',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
])

const SKIPPED_SUBTREE_TAGS = new Set(['head', 'style', 'script'])

interface ReadableBlock {
  line: number
  text: string
}

/**
 * Extracts readable plain-text blocks from XHTML while preserving each block's 1-based source
 * line number, heading level tags, and inline math/image markers for low-token proofreading.
 */
function extractReadableBlocks(xhtml: string): ReadableBlock[] {
  const blocks: ReadableBlock[] = []
  let line = 1
  let i = 0
  let currentLine: number | null = null
  let currentParts: string[] = []
  let pendingHeadingPrefix = ''

  const countNewlines = (start: number, end: number) => {
    for (let k = start; k < end; k += 1) {
      if (xhtml[k] === '\n') line += 1
    }
  }

  const flush = () => {
    const joined = currentParts.join('').replace(/\s+/g, ' ').trim()
    if (joined) {
      const text = pendingHeadingPrefix ? `${pendingHeadingPrefix}${joined}` : joined
      blocks.push({ line: currentLine ?? line, text })
    }
    currentParts = []
    currentLine = null
    pendingHeadingPrefix = ''
  }

  const appendToken = (token: string, tokenLine: number) => {
    if (!token) return
    if (currentLine === null) currentLine = tokenLine
    currentParts.push(token)
  }

  const skipUntilClosingTag = (tagLower: string, afterOpen: number): number => {
    const closePattern = new RegExp(`</(?:[A-Za-z_][\\w.-]*:)?${tagLower}\\s*>`, 'i')
    const match = closePattern.exec(xhtml.slice(afterOpen))
    return match ? afterOpen + match.index + match[0].length : xhtml.length
  }

  while (i < xhtml.length) {
    if (xhtml.startsWith('<!--', i)) {
      const end = xhtml.indexOf('-->', i + 4)
      const next = end >= 0 ? end + 3 : xhtml.length
      countNewlines(i, next)
      i = next
      continue
    }
    if (xhtml.startsWith('<![CDATA[', i)) {
      const end = xhtml.indexOf(']]>', i + 9)
      const next = end >= 0 ? end + 3 : xhtml.length
      const content = xhtml.slice(i + 9, end >= 0 ? end : xhtml.length)
      if (content.trim()) appendToken(content, line)
      countNewlines(i, next)
      i = next
      continue
    }
    if (xhtml.startsWith('<?', i)) {
      const end = xhtml.indexOf('?>', i + 2)
      const next = end >= 0 ? end + 2 : xhtml.length
      countNewlines(i, next)
      i = next
      continue
    }
    if (/^<!DOCTYPE\b/i.test(xhtml.slice(i, i + 12))) {
      const end = xhtml.indexOf('>', i + 9)
      const next = end >= 0 ? end + 1 : xhtml.length
      countNewlines(i, next)
      i = next
      continue
    }

    if (xhtml[i] === '<') {
      const tagStartLine = line
      // Find closing `>` respecting quoted attribute values
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
      const rawTag = xhtml.slice(i, end)
      const isClosing = rawTag.startsWith('</')
      const isSelfClosing = /\/\s*>$/.test(rawTag)
      const nameMatch = /^<\/?\s*(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)/.exec(rawTag)
      const tagLower = nameMatch?.[1]?.toLowerCase() ?? ''

      countNewlines(i, end)
      i = end

      if (!tagLower) continue

      if (!isClosing && !isSelfClosing && SKIPPED_SUBTREE_TAGS.has(tagLower)) {
        const closedEnd = skipUntilClosingTag(tagLower, i)
        countNewlines(i, closedEnd)
        i = closedEnd
        continue
      }

      if (!isClosing && tagLower === 'math') {
        if (!isSelfClosing) {
          const closedEnd = skipUntilClosingTag('math', i)
          countNewlines(i, closedEnd)
          i = closedEnd
        }
        appendToken('[公式]', tagStartLine)
        continue
      }

      if (!isClosing && tagLower === 'svg') {
        if (!isSelfClosing) {
          const closedEnd = skipUntilClosingTag('svg', i)
          countNewlines(i, closedEnd)
          i = closedEnd
        }
        appendToken('[SVG图像]', tagStartLine)
        continue
      }

      if (!isClosing && tagLower === 'img') {
        const altMatch = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(rawTag)
        const alt = decodeXmlEntities((altMatch?.[1] ?? altMatch?.[2] ?? '').trim())
        appendToken(alt ? `[图片: ${alt}]` : '[图片]', tagStartLine)
        continue
      }

      if (tagLower === 'td' || tagLower === 'th') {
        if (!isClosing && currentParts.length > 0) appendToken(' | ', tagStartLine)
        continue
      }

      if (READABLE_BLOCK_TAGS.has(tagLower)) {
        flush()
        if (!isClosing && /^h[1-6]$/.test(tagLower)) {
          pendingHeadingPrefix = `[${tagLower}] `
          currentLine = tagStartLine
        }
      }
      continue
    }

    const nextLt = xhtml.indexOf('<', i)
    const end = nextLt >= 0 ? nextLt : xhtml.length
    const rawText = xhtml.slice(i, end)
    if (rawText.trim().length > 0) {
      // Find exact line of first non-whitespace character in this text node
      let firstNonWsLine = line
      for (let k = 0; k < rawText.length; k += 1) {
        if (rawText[k] === '\n') firstNonWsLine += 1
        else if (!/\s/.test(rawText[k]!)) break
      }
      appendToken(decodeXmlEntities(rawText), firstNonWsLine)
    } else if (currentParts.length > 0 && rawText.length > 0) {
      currentParts.push(' ')
    }
    countNewlines(i, end)
    i = end
  }

  flush()
  return blocks
}

function countVisibleChars(xhtml: string): number {
  const stripped = xhtml
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, '')
  return decodeXmlEntities(stripped).replace(/\s+/g, '').length
}

interface AnnotatedTocEntry {
  path: number[]
  label: string
  href: string
  rawHtml?: string
  children: AnnotatedTocEntry[]
}

function findFirstTocPathByTarget(
  entries: readonly TocEntry[],
  tocDir: string,
  targetPath: string,
  prefix: number[] = [],
): TocPath | null {
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!
    const currentPath = [...prefix, i]
    const { path: hrefPath } = splitFragment(entry.href)
    if (hrefPath) {
      try {
        if (resolvePath(tocDir, hrefPath) === targetPath) return currentPath
      } catch {
        // Ignore malformed href
      }
    }
    const childMatch = findFirstTocPathByTarget(entry.children, tocDir, targetPath, currentPath)
    if (childMatch) return childMatch
  }
  return null
}

function annotateTocPaths(entries: readonly TocEntry[], prefix: number[] = []): AnnotatedTocEntry[] {
  return entries.map((entry, index) => {
    const path = [...prefix, index]
    return {
      path,
      label: entry.label,
      href: entry.href,
      ...(entry.rawHtml ? { rawHtml: entry.rawHtml } : {}),
      children: annotateTocPaths(entry.children, path),
    }
  })
}

function findAnchorSourceLines(xhtml: string): Map<string, number> {
  const map = new Map<string, number>()
  const attrPattern = /\b(?:id|name)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
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
    if (xhtml[i] !== '<') {
      if (xhtml[i] === '\n') line += 1
      i += 1
      continue
    }
    const nextChar = xhtml[i + 1]
    if (!nextChar || nextChar === '/' || nextChar === '?' || nextChar === '!') {
      const close = xhtml.indexOf('>', i + 1)
      advance(close >= 0 ? close + 1 : xhtml.length)
      continue
    }
    const tagLine = line
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
    const tagText = xhtml.slice(i, end)
    for (const match of tagText.matchAll(attrPattern)) {
      const val = (match[1] ?? match[2] ?? '').trim()
      if (val && !map.has(val)) map.set(val, tagLine)
    }
    advance(end)
  }

  return map
}

function extractImgAltNearOffset(text: string, offset: number): string | undefined {
  const tagStart = text.lastIndexOf('<', offset)
  const tagEnd = text.indexOf('>', offset)
  if (tagStart < 0 || tagEnd < 0 || tagEnd - tagStart > 2000) return undefined
  const tag = text.slice(tagStart, tagEnd + 1)
  if (!/^<img\b/i.test(tag)) return undefined
  const altMatch = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag)
  if (!altMatch) return ''
  return decodeXmlEntities((altMatch[1] ?? altMatch[2] ?? '').trim())
}

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

function chapterSkeleton(title: string, language: string, stylesheetHrefs: string[] = []): string {
  const safeTitle = escapeXml(title || '新章节')
  const safeLang = escapeXml(language || 'zh-CN')
  const links = stylesheetHrefs
    .map((href) => `<link rel="stylesheet" type="text/css" href="${escapeXml(href)}"/>`)
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${safeLang}">
<head><meta charset="utf-8"/><title>${safeTitle}</title>${links}</head>
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
  private entrySizes: Map<string, number>

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
    this.entrySizes = new Map<string, number>()
    for (const [path, bytes] of archive.entries) {
      const providedSize = options.entrySizes?.get(path)
      if (bytes.byteLength > 0) {
        this.entrySizes.set(path, bytes.byteLength)
      } else if (typeof providedSize === 'number' && Number.isFinite(providedSize) && providedSize >= 0) {
        this.entrySizes.set(path, providedSize)
      } else {
        this.entrySizes.set(path, 0)
      }
    }
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

  getOriginPath(path: string): string {
    return this.originByCurrent.get(path) ?? path
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
        const encoded = encoder.encode(file.afterText)
        this.texts.set(file.path, file.afterText)
        this.archive.entries.set(file.path, encoded)
        this.entrySizes.delete(source)
        this.entrySizes.set(file.path, encoded.byteLength)
      } else if (existingBytes) {
        this.archive.entries.set(file.path, existingBytes)
        if (isTextEntry(file.path)) this.texts.set(file.path, decoder.decode(existingBytes))
        const prevSize = this.entrySizes.get(source) ?? existingBytes.byteLength
        this.entrySizes.delete(source)
        this.entrySizes.set(file.path, prevSize)
      }
      this.originByCurrent.set(file.path, origin)
    }

    for (const file of deletes) {
      if (isProtectedPath(file.path)) continue
      this.archive.entries.delete(file.path)
      this.archive.order = this.archive.order.filter((p) => p !== file.path)
      this.texts.delete(file.path)
      this.entrySizes.delete(file.path)
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
    const encoded = encoder.encode(content)
    this.texts.set(path, content)
    this.archive.entries.set(path, encoded)
    this.entrySizes.set(path, encoded.byteLength)
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
      case 'list_anchors':
        return this.toolListAnchors(args)
      case 'find_references':
        return this.toolFindReferences(args)
      case 'inspect_image':
        return this.toolInspectImage(args)
      case 'edit_file':
        return this.toolEditFile(args)
      case 'replace_in_book':
        return this.toolReplaceInBook(args)
      case 'write_file':
        return this.toolWriteFile(args)
      case 'format_file':
        return this.toolFormatFile(args)
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
      case 'reorder_spine':
        return this.toolReorderSpine(args)
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
        const isHtml = text !== undefined && HTML_EXTENSIONS.has(extensionOf(path))
        return {
          path,
          mediaType: mediaByPath.get(path) ?? '',
          inSpine: spineSet.has(path),
          isText: text !== undefined,
          lineCount: text !== undefined ? text.split('\n').length : undefined,
          ...(isHtml
            ? {
                charCount: countVisibleChars(text),
                stylesheets: getLinkedStylesheets(text, path),
              }
            : {}),
          byteSize: this.entrySizes.get(path) ?? bytes?.byteLength ?? 0,
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
        stylesheets: listBookStylesheets(this.pkg, this.archive),
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
      if (this.archive.entries.has(path)) {
        const ext = extensionOf(path)
        const hint = IMAGE_EXT_TO_MIME[ext]
          ? '; use inspect_image to inspect image metadata and content'
          : ''
        return { ok: false, error: `${path} is a binary file and cannot be read as text${hint}` }
      }
      return { ok: false, error: `file not found: ${path}` }
    }

    const view = args.view === 'text' ? 'text' : 'raw'
    const lines = text.split('\n')
    const totalLines = lines.length
    const startLine = Math.max(1, Math.min(totalLines, Math.floor(Number(args.startLine ?? 1)) || 1))
    const charBudget = Math.max(
      500,
      Math.min(MAX_READ_CHARS, Math.floor(Number(args.maxChars ?? MAX_READ_CHARS)) || MAX_READ_CHARS),
    )

    if (view === 'text') {
      const requestedEnd =
        args.endLine !== undefined
          ? Math.min(totalLines, Math.max(startLine, Math.floor(Number(args.endLine)) || totalLines))
          : totalLines
      const blocks = HTML_EXTENSIONS.has(extensionOf(path))
        ? extractReadableBlocks(text)
        : lines.map((lineText, idx) => ({ line: idx + 1, text: lineText.trim() })).filter((b) => b.text.length > 0)
      const inRange = blocks.filter((b) => b.line >= startLine && b.line <= requestedEnd)

      const outBlocks: string[] = []
      let chars = 0
      let lastBlockLine = startLine
      let truncatedByChars = false

      for (const block of inRange) {
        const formatted = `L${block.line}|${block.text}`
        if (outBlocks.length > 0 && chars + formatted.length + 1 > charBudget) {
          truncatedByChars = true
          break
        }
        if (outBlocks.length === 0 && formatted.length > charBudget) {
          outBlocks.push(`${formatted.slice(0, charBudget)}…`)
          lastBlockLine = block.line
          truncatedByChars = true
          break
        }
        outBlocks.push(formatted)
        chars += formatted.length + 1
        lastBlockLine = block.line
      }

      const lastSourceLineInBook = blocks.length > 0 ? blocks[blocks.length - 1]!.line : totalLines
      return {
        ok: true,
        data: {
          path,
          view: 'text',
          totalLines,
          totalBlocks: blocks.length,
          startLine,
          endLine: outBlocks.length > 0 ? lastBlockLine : startLine,
          truncated: truncatedByChars || requestedEnd < lastSourceLineInBook,
          content: outBlocks.join('\n'),
        },
      }
    }

    const charOffset = Math.max(0, Math.floor(Number(args.charOffset ?? 0)) || 0)
    if (charOffset > 0) {
      const rawLine = lines[startLine - 1] ?? ''
      if (charOffset >= rawLine.length) {
        return {
          ok: true,
          data: {
            path,
            view: 'raw',
            totalLines,
            startLine,
            endLine: startLine,
            charOffset,
            lineLength: rawLine.length,
            lineTruncated: false,
            truncated: startLine < totalLines,
            content: '',
          },
        }
      }
      const prefix = `${startLine}|`
      const sliceBudget = Math.max(200, charBudget - prefix.length)
      const slice = rawLine.slice(charOffset, charOffset + sliceBudget)
      const nextCharOffset = charOffset + slice.length
      const lineTruncated = nextCharOffset < rawLine.length
      return {
        ok: true,
        data: {
          path,
          view: 'raw',
          totalLines,
          startLine,
          endLine: startLine,
          charOffset,
          nextCharOffset: lineTruncated ? nextCharOffset : null,
          lineLength: rawLine.length,
          lineTruncated,
          truncated: lineTruncated || startLine < totalLines,
          ...(lineTruncated
            ? { hint: '该行超长，可继续传入 nextCharOffset 分片读取，或先调用 format_file 格式化后再编辑。' }
            : {}),
          content: `${prefix}${slice}`,
        },
      }
    }

    const requestedEnd =
      args.endLine !== undefined ? Math.floor(Number(args.endLine)) : startLine + DEFAULT_READ_LINES - 1
    const cappedEnd = Math.min(totalLines, Math.max(startLine, Math.min(requestedEnd, startLine + MAX_READ_LINES - 1)))

    const outLines: string[] = []
    let chars = 0
    let actualEnd = startLine - 1
    let truncatedByChars = false
    let lineTruncated = false
    let nextCharOffset: number | null = null
    let oversizedLineLength: number | undefined
    let nextLineOversized = false

    for (let lineNo = startLine; lineNo <= cappedEnd; lineNo += 1) {
      const rawLine = lines[lineNo - 1] ?? ''
      const prefix = `${lineNo}|`
      const formatted = `${prefix}${rawLine}`
      if (outLines.length === 0 && formatted.length > charBudget) {
        const sliceBudget = Math.max(200, charBudget - prefix.length)
        const slice = rawLine.slice(0, sliceBudget)
        outLines.push(`${prefix}${slice}`)
        actualEnd = lineNo
        truncatedByChars = true
        lineTruncated = true
        nextCharOffset = slice.length
        oversizedLineLength = rawLine.length
        break
      }
      if (outLines.length > 0 && chars + formatted.length + 1 > charBudget) {
        truncatedByChars = true
        if (formatted.length > charBudget) nextLineOversized = true
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
        view: 'raw',
        totalLines,
        startLine,
        endLine: actualEnd,
        truncated: actualEnd < totalLines || truncatedByChars,
        ...(lineTruncated
          ? {
              lineTruncated: true,
              nextCharOffset,
              lineLength: oversizedLineLength,
              hint: '该行超长（疑似单行压缩文件），可传入 charOffset 分片读取，或先调用 format_file 格式化后再编辑。',
            }
          : nextLineOversized
            ? {
                hint: `第 ${actualEnd + 1} 行超过单次读取上限（疑似单行压缩文件），建议先调用 format_file 格式化后再读取编辑，或传 startLine=${actualEnd + 1} 与 charOffset 分片读取。`,
              }
            : {}),
        content: outLines.join('\n'),
      },
    }
  }

  private toolSearchBook(args: Record<string, unknown>): AgentToolResult {
    const query = typeof args.query === 'string' ? args.query : ''
    if (!query) return { ok: false, error: 'query is required' }

    const regex = args.regex === true
    const caseSensitive = args.caseSensitive === true
    if (regex) {
      try {
        new RegExp(query, caseSensitive ? 'g' : 'gi')
      } catch (error) {
        return {
          ok: false,
          error: `invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }

    const scope =
      args.scope === 'spine' || args.scope === 'styles' || args.scope === 'metadata' ? args.scope : 'all'
    const pathFilter = typeof args.pathFilter === 'string' ? args.pathFilter.trim() : ''
    const maxResults = Math.max(
      1,
      Math.min(MAX_SEARCH_RESULTS, Math.floor(Number(args.maxResults ?? DEFAULT_SEARCH_RESULTS)) || DEFAULT_SEARCH_RESULTS),
    )
    const previewRadius =
      args.contextChars !== undefined
        ? Math.max(10, Math.min(200, Math.floor(Number(args.contextChars)) || 40))
        : undefined

    const spineSet = scope === 'spine' ? new Set(this.spinePaths()) : null
    const files: SearchFile[] = []
    for (const [path, text] of this.texts) {
      if (isProtectedPath(path)) continue
      if (scope === 'spine' && !spineSet!.has(path)) continue
      if (scope === 'styles' && extensionOf(path) !== 'css') continue
      if (scope === 'metadata' && !this.isStructuralFile(path)) continue
      if (pathFilter && !path.includes(pathFilter)) continue
      files.push({ path, text })
    }

    const result = searchBook(files, query, { regex, caseSensitive, maxResults, previewRadius })
    return {
      ok: true,
      data: {
        query,
        scope,
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
          totalCount: countTocEntries(entries),
          entries: annotateTocPaths(entries),
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
          totalCount: countTocEntries(entries),
          entries: annotateTocPaths(entries),
          brokenAnchors: findBrokenAnchors(entries, this.pkg.ncxPath, this.texts),
        },
      }
    }
    return { ok: true, data: { source: 'none', tocPath: null, totalCount: 0, entries: [], brokenAnchors: [] } }
  }

  private toolListAnchors(args: Record<string, unknown>): AgentToolResult {
    const path = typeof args.path === 'string' ? args.path.trim() : ''
    if (!path) return { ok: false, error: 'path is required' }
    const text = this.texts.get(path)
    if (text === undefined) {
      return this.archive.entries.has(path)
        ? { ok: false, error: `${path} is a binary file` }
        : { ok: false, error: `file not found: ${path}` }
    }

    const limit = Math.max(1, Math.min(500, Math.floor(Number(args.limit ?? 200)) || 200))
    const rawAnchors = listDocumentAnchors(text, this.codec)
    const lineMap = findAnchorSourceLines(text)
    const truncated = rawAnchors.length > limit
    const anchors = rawAnchors.slice(0, limit).map((anchor) => ({
      ...anchor,
      ...(lineMap.has(anchor.id) ? { line: lineMap.get(anchor.id) } : {}),
    }))

    return {
      ok: true,
      data: {
        path,
        count: rawAnchors.length,
        truncated,
        anchors,
      },
    }
  }

  private toolFindReferences(args: Record<string, unknown>): AgentToolResult {
    const targetPath = typeof args.targetPath === 'string' ? args.targetPath.trim() : ''
    const fromPath = typeof args.fromPath === 'string' ? args.fromPath.trim() : ''
    const includeOpf = args.includeOpf === true
    const maxResults = Math.max(1, Math.min(300, Math.floor(Number(args.maxResults ?? 100)) || 100))

    if (targetPath && !this.archive.entries.has(targetPath)) {
      return { ok: false, error: `targetPath not found in archive: ${targetPath}` }
    }
    if (fromPath && !this.texts.has(fromPath)) {
      return { ok: false, error: `fromPath not found as a text file: ${fromPath}` }
    }

    const allRefs = collectReferences(this.texts).filter((ref) => {
      if (!includeOpf && ref.from === this.pkg.opfPath) return false
      if (targetPath && ref.targetPath !== targetPath) return false
      if (fromPath && ref.from !== fromPath) return false
      return true
    })

    const truncated = allRefs.length > maxResults
    const references = allRefs.slice(0, maxResults).map((ref) => {
      const sourceText = this.texts.get(ref.from) ?? ''
      const line = lineOf(sourceText, ref.offset)
      const start = Math.max(0, ref.offset - 36)
      const end = Math.min(sourceText.length, ref.offset + ref.raw.length + 36)
      const preview = `${start > 0 ? '…' : ''}${sourceText.slice(start, end).replace(/\s+/g, ' ').trim()}${end < sourceText.length ? '…' : ''}`
      return {
        from: ref.from,
        line,
        raw: ref.raw,
        targetPath: ref.targetPath,
        fragment: ref.fragment,
        preview,
      }
    })

    return {
      ok: true,
      data: {
        ...(targetPath ? { targetPath } : {}),
        ...(fromPath ? { fromPath } : {}),
        count: allRefs.length,
        truncated,
        references,
      },
    }
  }

  private toolInspectImage(args: Record<string, unknown>): AgentToolResult {
    const path = typeof args.path === 'string' ? args.path.trim() : ''
    if (!path) return { ok: false, error: 'path is required' }
    if (!this.archive.entries.has(path)) {
      return { ok: false, error: `file not found: ${path}` }
    }

    const manifestItem = this.pkg.manifest.find((item) => item.path === path)
    const ext = extensionOf(path)
    const mediaType = manifestItem?.mediaType || IMAGE_EXT_TO_MIME[ext] || ''
    if (!mediaType.toLowerCase().startsWith('image/')) {
      return { ok: false, error: `${path} is not an image (mediaType: ${mediaType || 'unknown'})` }
    }

    const bytes = this.archive.entries.get(path)
    const byteSize = this.entrySizes.get(path) ?? bytes?.byteLength ?? 0
    const isSvg = mediaType.toLowerCase() === 'image/svg+xml' || ext === 'svg'

    const referencedBy = collectReferences(this.texts)
      .filter((ref) => ref.targetPath === path && ref.from !== this.pkg.opfPath)
      .slice(0, 50)
      .map((ref) => {
        const sourceText = this.texts.get(ref.from) ?? ''
        const alt = extractImgAltNearOffset(sourceText, ref.offset)
        return {
          from: ref.from,
          line: lineOf(sourceText, ref.offset),
          ...(alt !== undefined ? { alt } : {}),
        }
      })

    if (isSvg) {
      const svgRaw = this.texts.get(path) ?? (bytes && bytes.byteLength > 0 ? decoder.decode(bytes) : '')
      const truncated = svgRaw.length > MAX_READ_CHARS
      return {
        ok: true,
        data: {
          path,
          mediaType: 'image/svg+xml',
          byteSize,
          isSvg: true,
          truncated,
          svgContent: truncated ? `${svgRaw.slice(0, MAX_READ_CHARS)}\n...(已截断)` : svgRaw,
          referencedBy,
        },
      }
    }

    const dims = bytes && bytes.byteLength > 0 ? probeImageDimensions(bytes, mediaType) : null
    return {
      ok: true,
      data: {
        path,
        mediaType,
        byteSize,
        isSvg: false,
        ...(dims ? { width: dims.width, height: dims.height } : {}),
        referencedBy,
      },
    }
  }

  private toolEditFile(args: Record<string, unknown>): AgentToolResult {
    const path = typeof args.path === 'string' ? args.path.trim() : ''
    if (!path) return { ok: false, error: 'path is required' }
    if (isProtectedPath(path)) return { ok: false, error: `cannot edit protected archive metadata: ${path}` }

    const current = this.texts.get(path)
    if (current === undefined) return { ok: false, error: `text file not found: ${path}` }

    interface SingleEditSpec {
      oldText: string
      newText: string
      replaceAll: boolean
    }
    const specs: SingleEditSpec[] = []
    if (Array.isArray(args.edits) && args.edits.length > 0) {
      for (let i = 0; i < args.edits.length; i += 1) {
        const raw = args.edits[i]
        if (!raw || typeof raw !== 'object') {
          return { ok: false, error: `edits[${i}] must be an object with oldText and newText` }
        }
        const rec = raw as Record<string, unknown>
        const oldText = typeof rec.oldText === 'string' ? rec.oldText : ''
        const newText = typeof rec.newText === 'string' ? rec.newText : null
        if (!oldText) return { ok: false, error: `edits[${i}].oldText must be a non-empty string` }
        if (newText === null) return { ok: false, error: `edits[${i}].newText must be a string` }
        specs.push({ oldText, newText, replaceAll: rec.replaceAll === true })
      }
    } else {
      const oldText = typeof args.oldText === 'string' ? args.oldText : ''
      const newText = typeof args.newText === 'string' ? args.newText : ''
      if (!oldText) return { ok: false, error: 'oldText (or non-empty edits array) is required' }
      specs.push({ oldText, newText, replaceAll: args.replaceAll === true })
    }

    let updated = current
    let totalReplacements = 0
    const changedRanges: Array<{ editIndex: number; replacements: number; startLine: number; endLine: number }> = []
    const isBatch = Array.isArray(args.edits) && args.edits.length > 0

    for (let i = 0; i < specs.length; i += 1) {
      const spec = specs[i]!
      const label = isBatch ? `edits[${i}].oldText` : 'oldText'
      const occurrences = updated.split(spec.oldText).length - 1
      if (occurrences === 0) {
        return {
          ok: false,
          error: `${label} not found in ${path}; read the file first to match exact text`,
        }
      }
      if (occurrences > 1 && !spec.replaceAll) {
        return {
          ok: false,
          error: `${label} matched ${occurrences} times in ${path}; include more surrounding context or pass replaceAll: true`,
        }
      }

      const firstOffset = updated.indexOf(spec.oldText)
      const lastOffsetBefore = spec.replaceAll ? updated.lastIndexOf(spec.oldText) : firstOffset
      const startLine = lineOf(updated, firstOffset)
      const replacements = spec.replaceAll ? occurrences : 1
      updated = spec.replaceAll
        ? updated.split(spec.oldText).join(spec.newText)
        : updated.slice(0, firstOffset) + spec.newText + updated.slice(firstOffset + spec.oldText.length)
      const deltaPerMatch = spec.newText.length - spec.oldText.length
      const endOffsetAfter = lastOffsetBefore + deltaPerMatch * (replacements - 1) + spec.newText.length
      const endLine = lineOf(updated, Math.max(firstOffset, endOffsetAfter))

      totalReplacements += replacements
      changedRanges.push({ editIndex: i, replacements, startLine, endLine })
    }

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
        replacements: totalReplacements,
        editCount: specs.length,
        lineCount: updated.split('\n').length,
        changedRanges,
      },
    }
  }

  private toolReplaceInBook(args: Record<string, unknown>): AgentToolResult {
    const query = typeof args.query === 'string' ? args.query : ''
    if (!query) return { ok: false, error: 'query is required' }
    const replacement = typeof args.replacement === 'string' ? args.replacement : null
    if (replacement === null) return { ok: false, error: 'replacement must be a string' }

    const regex = args.regex === true
    const caseSensitive = args.caseSensitive !== false
    const dryRun = args.dryRun === true
    const scope =
      args.scope === 'styles' || args.scope === 'all' || args.scope === 'spine' ? args.scope : 'spine'
    const pathFilter = typeof args.pathFilter === 'string' ? args.pathFilter.trim() : ''
    const maxFiles = Math.max(
      1,
      Math.min(
        MAX_REPLACE_MAX_FILES,
        Math.floor(Number(args.maxFiles ?? DEFAULT_REPLACE_MAX_FILES)) || DEFAULT_REPLACE_MAX_FILES,
      ),
    )

    let pattern: RegExp
    try {
      const built = buildSearchPattern(query, { regex, caseSensitive })
      if (!built) {
        new RegExp(query, caseSensitive ? 'g' : 'gi')
        return { ok: false, error: 'invalid search pattern' }
      }
      pattern = built
    } catch (error) {
      return {
        ok: false,
        error: `invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
      }
    }

    let candidatePaths: string[]
    if (Array.isArray(args.paths) && args.paths.length > 0) {
      const requested = args.paths
        .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        .map((p) => p.trim())
      const unique = Array.from(new Set(requested))
      for (const p of unique) {
        if (isProtectedPath(p)) return { ok: false, error: `cannot modify protected archive metadata: ${p}` }
        if (!this.texts.has(p)) return { ok: false, error: `text file not found: ${p}` }
      }
      candidatePaths = unique
    } else {
      const spineSet = new Set(this.spinePaths())
      candidatePaths = this.archive.order.filter((p) => {
        if (isProtectedPath(p) || !this.texts.has(p)) return false
        if (scope === 'spine' && !spineSet.has(p)) return false
        if (scope === 'styles' && extensionOf(p) !== 'css') return false
        if (pathFilter && !p.includes(pathFilter)) return false
        return true
      })
    }

    const planned = new Map<string, string>()
    const fileReports: Array<{
      path: string
      replacements: number
      samples: Array<{ line: number; before: string; after: string }>
    }> = []
    let totalReplacements = 0
    let truncated = false

    for (const filePath of candidatePaths) {
      const original = this.texts.get(filePath)
      if (original === undefined) continue

      pattern.lastIndex = 0
      const samples: Array<{ line: number; before: string; after: string }> = []
      let count = 0

      // Use callback for literal mode so `$1`/`$&` in `replacement` is never interpreted as regex syntax.
      // For regex mode, expand standard JS replacement tokens using the real match & captures so lookarounds work.
      const expandRegexReplacement = (
        template: string,
        matched: string,
        captures: Array<string | undefined>,
        offset: number,
        whole: string,
        namedGroups?: Record<string, string | undefined>,
      ): string =>
        template.replace(/\$(?:\$|&|`|'|(\d{1,2})|<([^>]+)>)/g, (token, digits?: string, groupName?: string) => {
          if (token === '$$') return '$'
          if (token === '$&') return matched
          if (token === '$`') return whole.slice(0, offset)
          if (token === "$'") return whole.slice(offset + matched.length)
          if (groupName !== undefined) return namedGroups?.[groupName] ?? ''
          if (digits !== undefined) {
            const idx = Number.parseInt(digits, 10)
            if (idx >= 1 && idx <= captures.length) return captures[idx - 1] ?? ''
            if (digits.length === 2) {
              const first = Number.parseInt(digits[0]!, 10)
              if (first >= 1 && first <= captures.length) return (captures[first - 1] ?? '') + digits[1]!
            }
          }
          return token
        })

      const updated = regex
        ? original.replace(pattern, (...matchArgs) => {
            const matched = String(matchArgs[0] ?? '')
            const hasNamedGroups =
              typeof matchArgs[matchArgs.length - 1] === 'object' && matchArgs[matchArgs.length - 1] !== null
            const namedGroups = hasNamedGroups
              ? (matchArgs[matchArgs.length - 1] as Record<string, string | undefined>)
              : undefined
            const offset = Number(matchArgs[matchArgs.length - (hasNamedGroups ? 3 : 2)] ?? 0)
            const captures = matchArgs.slice(1, matchArgs.length - (hasNamedGroups ? 3 : 2)) as Array<
              string | undefined
            >
            const substituted = expandRegexReplacement(replacement, matched, captures, offset, original, namedGroups)
            count += 1
            if (samples.length < 3) {
              const ctxStart = Math.max(0, offset - 24)
              const ctxEnd = Math.min(original.length, offset + matched.length + 24)
              const beforeCtx = original.slice(ctxStart, ctxEnd).replace(/\s+/g, ' ').trim()
              const afterCtx = (
                original.slice(ctxStart, offset) +
                substituted +
                original.slice(offset + matched.length, ctxEnd)
              )
                .replace(/\s+/g, ' ')
                .trim()
              samples.push({ line: lineOf(original, offset), before: beforeCtx, after: afterCtx })
            }
            return substituted
          })
        : original.replace(pattern, (matched, offset: number) => {
            count += 1
            if (samples.length < 3) {
              const ctxStart = Math.max(0, offset - 24)
              const ctxEnd = Math.min(original.length, offset + matched.length + 24)
              const beforeCtx = original.slice(ctxStart, ctxEnd).replace(/\s+/g, ' ').trim()
              const afterCtx = (
                original.slice(ctxStart, offset) +
                replacement +
                original.slice(offset + matched.length, ctxEnd)
              )
                .replace(/\s+/g, ' ')
                .trim()
              samples.push({ line: lineOf(original, offset), before: beforeCtx, after: afterCtx })
            }
            return replacement
          })

      if (count === 0 || updated === original) continue

      if (planned.size >= maxFiles) {
        truncated = true
        break
      }

      const xmlError = this.validateTextIfXml(filePath, updated)
      if (xmlError) {
        return {
          ok: false,
          error: `replace_in_book rejected — resulting XML in ${filePath} is invalid: ${xmlError}`,
        }
      }

      planned.set(filePath, updated)
      totalReplacements += count
      fileReports.push({ path: filePath, replacements: count, samples })
    }

    if (!dryRun && planned.size > 0) {
      const nextOpf = planned.get(this.pkg.opfPath)
      if (nextOpf !== undefined) {
        try {
          parsePackage(nextOpf, this.pkg.opfPath, this.codec.parse)
        } catch (error) {
          return {
            ok: false,
            error: `replace_in_book rejected — OPF could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
          }
        }
      }

      for (const [filePath, nextContent] of planned) {
        this.setTextEntry(filePath, nextContent)
        if (this.isStructuralFile(filePath)) this.structuralTouched = true
      }
      if (nextOpf !== undefined) this.refreshPackage()
    }

    return {
      ok: true,
      data: {
        dryRun,
        scope: Array.isArray(args.paths) && args.paths.length > 0 ? 'paths' : scope,
        filesScanned: candidatePaths.length,
        filesChanged: planned.size,
        totalReplacements,
        truncated,
        files: fileReports,
      },
    }
  }

  private toolFormatFile(args: Record<string, unknown>): AgentToolResult {
    const rawPaths: string[] = []
    if (typeof args.path === 'string' && args.path.trim()) rawPaths.push(args.path.trim())
    if (Array.isArray(args.paths)) {
      for (const item of args.paths) {
        if (typeof item === 'string' && item.trim()) rawPaths.push(item.trim())
      }
    }
    const targets = Array.from(new Set(rawPaths))
    if (targets.length === 0) return { ok: false, error: 'path or paths is required' }

    const planned = new Map<string, string>()
    const results: Array<{ path: string; changed: boolean; beforeLines: number; afterLines: number }> = []

    for (const target of targets) {
      if (isProtectedPath(target)) {
        return { ok: false, error: `cannot format protected archive metadata: ${target}` }
      }
      const current = this.texts.get(target)
      if (current === undefined) {
        return { ok: false, error: `text file not found: ${target}` }
      }
      const ext = extensionOf(target)
      let formatted: string
      try {
        if (ext === 'css') {
          formatted = formatCss(current)
        } else if (FORMATTABLE_XML_EXTENSIONS.has(ext)) {
          formatted = formatXhtml(current, this.codec)
        } else {
          return {
            ok: false,
            error: `unsupported file type for formatting: ${target} (supports XHTML/XML/OPF/NCX/CSS)`,
          }
        }
      } catch (error) {
        return {
          ok: false,
          error: `failed to format ${target}: ${error instanceof Error ? error.message : String(error)}`,
        }
      }

      const xmlError = this.validateTextIfXml(target, formatted)
      if (xmlError) {
        return { ok: false, error: `format rejected — resulting XML in ${target} is invalid: ${xmlError}` }
      }

      const changed = formatted !== current
      if (changed) planned.set(target, formatted)
      results.push({
        path: target,
        changed,
        beforeLines: current.split('\n').length,
        afterLines: formatted.split('\n').length,
      })
    }

    const nextOpf = planned.get(this.pkg.opfPath)
    if (nextOpf !== undefined) {
      try {
        parsePackage(nextOpf, this.pkg.opfPath, this.codec.parse)
      } catch (error) {
        return {
          ok: false,
          error: `format rejected — OPF could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }

    for (const [target, formatted] of planned) {
      this.setTextEntry(target, formatted)
      if (this.isStructuralFile(target)) this.structuralTouched = true
    }
    if (nextOpf !== undefined) this.refreshPackage()

    return {
      ok: true,
      data: {
        formattedPaths: [...planned.keys()],
        unchangedPaths: results.filter((r) => !r.changed).map((r) => r.path),
        results,
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

  private applySingleTocAction(
    entries: TocEntry[],
    tocPath: string,
    spec: Record<string, unknown>,
  ): { ok: true; entries: TocEntry[]; action: string; meta: Record<string, unknown> } | { ok: false; error: string } {
    const action = typeof spec.action === 'string' ? spec.action : ''
    let next: TocEntry[] = entries
    let meta: Record<string, unknown> = {}

    switch (action) {
      case 'insert': {
        const label = typeof spec.label === 'string' ? spec.label.trim() : ''
        const href = typeof spec.href === 'string' ? spec.href.trim() : ''
        if (!label || !href) return { ok: false, error: 'insert requires non-empty label and href' }
        const path = spec.path === undefined ? [] : parseTocPath(spec.path)
        if (!path) return { ok: false, error: 'path must be an array of non-negative integers' }
        const position: TocInsertPosition =
          spec.position === 'before' || spec.position === 'inside' ? spec.position : 'after'
        next = insertTocEntry(entries, path, { label, href, rawHtml: '', children: [] }, position)
        break
      }
      case 'update': {
        const path = parseTocPath(spec.path)
        if (!path || path.length === 0) return { ok: false, error: 'update requires a non-empty path' }
        if (!getTocEntry(entries, path)) return { ok: false, error: `toc entry not found at [${path.join(',')}]` }
        const nextLabel = typeof spec.label === 'string' ? spec.label.trim() : undefined
        const nextHref = typeof spec.href === 'string' ? spec.href.trim() : undefined
        if (!nextLabel && !nextHref) return { ok: false, error: 'update requires label and/or href' }
        next = updateTocEntry(entries, path, (entry) => ({
          ...entry,
          ...(nextLabel ? { label: nextLabel, rawHtml: '' } : {}),
          ...(nextHref ? { href: nextHref } : {}),
        }))
        break
      }
      case 'move': {
        const delta = spec.delta === -1 || spec.delta === 1 ? spec.delta : null
        if (!delta) return { ok: false, error: 'move requires delta (-1 or 1)' }
        const paths = spec.paths !== undefined ? parseTocPaths(spec.paths) : null
        if (paths) {
          next = moveTocEntries(entries, paths, delta)
        } else {
          const path = parseTocPath(spec.path)
          if (!path || path.length === 0) return { ok: false, error: 'move requires path or paths' }
          next = moveTocEntry(entries, path, delta)
        }
        break
      }
      case 'move_subtree': {
        const fromPath = parseTocPath(spec.path)
        const toPath = parseTocPath(spec.toPath)
        const position: TocInsertPosition =
          spec.position === 'before' || spec.position === 'inside' ? spec.position : 'after'
        if (!fromPath || fromPath.length === 0 || !toPath || toPath.length === 0) {
          return { ok: false, error: 'move_subtree requires non-empty path and toPath' }
        }
        next = moveTocSubtree(entries, fromPath, toPath, position)
        break
      }
      case 'indent': {
        const paths = spec.paths !== undefined ? parseTocPaths(spec.paths) : null
        if (paths) {
          next = indentTocEntries(entries, paths)
        } else {
          const path = parseTocPath(spec.path)
          if (!path || path.length === 0) return { ok: false, error: 'indent requires path or paths' }
          next = indentTocEntry(entries, path)
        }
        break
      }
      case 'outdent': {
        const paths = spec.paths !== undefined ? parseTocPaths(spec.paths) : null
        if (paths) {
          next = outdentTocEntries(entries, paths)
        } else {
          const path = parseTocPath(spec.path)
          if (!path || path.length === 0) return { ok: false, error: 'outdent requires path or paths' }
          next = outdentTocEntry(entries, path)
        }
        break
      }
      case 'remove': {
        const keepChildren = spec.keepChildren === true
        const paths = spec.paths !== undefined ? parseTocPaths(spec.paths) : null
        if (paths) {
          next = removeTocEntries(entries, paths, { keepChildren })
        } else {
          const path = parseTocPath(spec.path)
          if (!path || path.length === 0) return { ok: false, error: 'remove requires path or paths' }
          next = removeTocEntry(entries, path, { keepChildren })
        }
        break
      }
      case 'refresh_labels': {
        const paths = spec.paths !== undefined ? parseTocPaths(spec.paths) : undefined
        if (spec.paths !== undefined && !paths) return { ok: false, error: 'paths must be an array of valid paths' }
        const refreshed = refreshTocLabelsFromHeadings(entries, tocPath, this.texts, this.codec, {
          paths: paths ?? undefined,
          overwriteRichHtml: spec.overwriteRichHtml === true,
        })
        next = refreshed.entries
        meta = { updatedCount: refreshed.updatedCount, skippedRichCount: refreshed.skippedRichCount }
        break
      }
      case 'clean_broken': {
        const cleaned = removeBrokenTocEntries(entries, tocPath, this.texts)
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

    return { ok: true, entries: next, action, meta }
  }

  private toolEditToc(args: Record<string, unknown>): AgentToolResult {
    const current = this.readCurrentToc()
    if (!current) return { ok: false, error: 'book has neither nav.xhtml nor toc.ncx' }

    const isBatch = Array.isArray(args.actions) && args.actions.length > 0
    const specs: Record<string, unknown>[] = isBatch
      ? (args.actions as unknown[]).map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>) : {}))
      : [args]

    if (specs.length > 50) {
      return { ok: false, error: 'actions batch cannot exceed 50 operations per call' }
    }

    let next = current.entries
    let lastMeta: Record<string, unknown> = {}
    const executedActions: string[] = []

    for (let i = 0; i < specs.length; i += 1) {
      const applied = this.applySingleTocAction(next, current.tocPath, specs[i]!)
      if (!applied.ok) {
        return {
          ok: false,
          error: isBatch ? `actions[${i}] failed: ${applied.error}` : applied.error,
        }
      }
      next = applied.entries
      lastMeta = applied.meta
      executedActions.push(applied.action)
    }

    const written = this.writeTocTree(next)
    if (!written.ok) return written
    const brokenAnchors = findBrokenAnchors(next, written.primaryTocPath, this.texts)
    const totalCount = countTocEntries(next)
    return {
      ok: true,
      data: {
        action: isBatch ? 'batch' : executedActions[0]!,
        ...(isBatch ? { actionCount: executedActions.length, actions: executedActions } : {}),
        totalCount,
        updatedFiles: written.updatedFiles,
        brokenAnchors,
        ...(totalCount <= MAX_EDIT_TOC_INLINE_ENTRIES
          ? { entries: annotateTocPaths(next) }
          : { entriesOmitted: true }),
        ...lastMeta,
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

    const insertAfter = typeof args.insertAfter === 'string' ? args.insertAfter.trim() : ''
    const currentSpine = this.spinePaths()
    let insertAfterIdx = -1
    if (insertAfter) {
      insertAfterIdx = currentSpine.indexOf(insertAfter)
      if (insertAfterIdx < 0) {
        return { ok: false, error: `insertAfter chapter not found in spine: ${insertAfter}` }
      }
    }

    let stylesheetPaths: string[] = []
    if (Array.isArray(args.stylesheets)) {
      const requested = args.stylesheets
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .map((s) => s.trim())
      for (const cssPath of requested) {
        if (!this.archive.entries.has(cssPath)) {
          return { ok: false, error: `stylesheet not found in archive: ${cssPath}` }
        }
      }
      stylesheetPaths = Array.from(new Set(requested))
    } else if (!(typeof args.content === 'string' && args.content.trim().length > 0)) {
      const templateChapterPath = insertAfter || currentSpine[0] || ''
      const templateText = templateChapterPath ? this.texts.get(templateChapterPath) : undefined
      if (templateText) {
        stylesheetPaths = getLinkedStylesheets(templateText, templateChapterPath).filter((cssPath) =>
          this.archive.entries.has(cssPath),
        )
      }
    }

    const targetDir = dirname(targetPath)
    const stylesheetHrefs = stylesheetPaths.map((cssPath) => relativePath(targetDir, cssPath))
    const content =
      typeof args.content === 'string' && args.content.trim().length > 0
        ? args.content
        : chapterSkeleton(title, this.pkg.metadata.language || 'zh-CN', stylesheetHrefs)

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

    if (insertAfterIdx >= 0) {
      const reordered = [...currentSpine.slice(0, insertAfterIdx + 1), targetPath, ...currentSpine.slice(insertAfterIdx + 1)]
      nextOpf = reorderSpine(nextOpf, reordered, baseDir, this.codec)
    }

    nextOpf = touchOpfModified(nextOpf, isoModified(this.nowFn()), this.codec)

    this.setTextEntry(targetPath, content)
    this.setTextEntry(opfPath, nextOpf)
    this.structuralTouched = true
    this.refreshPackage()

    if (args.addToToc === true) {
      const currentToc = this.readCurrentToc()
      if (currentToc) {
        const tocDir = dirname(currentToc.tocPath)
        const newEntry: TocEntry = {
          label: title,
          href: relativePath(tocDir, targetPath),
          rawHtml: '',
          children: [],
        }
        let nextEntries: TocEntry[]
        if (insertAfter) {
          const anchorPath = findFirstTocPathByTarget(currentToc.entries, tocDir, insertAfter)
          nextEntries = anchorPath
            ? insertTocEntry(currentToc.entries, anchorPath, newEntry, 'after')
            : [...currentToc.entries, newEntry]
        } else {
          nextEntries = [...currentToc.entries, newEntry]
        }
        this.writeTocTree(nextEntries)
      }
    }

    return {
      ok: true,
      data: {
        path: targetPath,
        title,
        addedToToc: args.addToToc === true,
        linkedStylesheets: stylesheetPaths,
      },
    }
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
    const prevSize = this.entrySizes.get(path) ?? bytes.byteLength
    this.archive.entries.delete(path)
    this.archive.entries.set(target, bytes)
    this.entrySizes.delete(path)
    this.entrySizes.set(target, prevSize)
    this.archive.order = this.archive.order.map((entry) => (entry === path ? target : entry))

    const movedText = rewritten.files.get(path)
    rewritten.files.delete(path)
    if (movedText !== undefined) rewritten.files.set(target, movedText)

    this.texts = rewritten.files
    for (const [textPath, textValue] of this.texts) {
      const encoded = encoder.encode(textValue)
      this.archive.entries.set(textPath, encoded)
      this.entrySizes.set(textPath, encoded.byteLength)
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
    this.entrySizes.delete(path)

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

  private toolReorderSpine(args: Record<string, unknown>): AgentToolResult {
    const rawPaths = Array.isArray(args.orderedPaths)
      ? args.orderedPaths
          .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
          .map((p) => p.trim())
      : []
    const uniquePaths = Array.from(new Set(rawPaths))
    if (uniquePaths.length === 0) {
      return { ok: false, error: 'orderedPaths must be a non-empty array of spine chapter paths' }
    }

    const currentSpine = this.spinePaths()
    const spineSet = new Set(currentSpine)
    const invalid = uniquePaths.filter((p) => !spineSet.has(p))
    if (invalid.length > 0) {
      return { ok: false, error: `path(s) not in spine: ${invalid.join(', ')}` }
    }

    const opfPath = this.pkg.opfPath
    const opfXml = this.texts.get(opfPath)
    if (!opfXml) return { ok: false, error: `OPF file missing: ${opfPath}` }

    const nextOpf = touchOpfModified(
      reorderSpine(opfXml, uniquePaths, dirname(opfPath), this.codec),
      isoModified(this.nowFn()),
      this.codec,
    )
    const xmlError = this.validateTextIfXml(opfPath, nextOpf)
    if (xmlError) return { ok: false, error: `OPF reorder produced invalid XML: ${xmlError}` }

    this.setTextEntry(opfPath, nextOpf)
    this.structuralTouched = true
    this.refreshPackage()

    return {
      ok: true,
      data: {
        opfPath,
        spine: this.spinePaths(),
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
    for (const key of Array.from(this.entrySizes.keys())) {
      if (!nextArchive.entries.has(key)) this.entrySizes.delete(key)
    }
    for (const [key, bytes] of nextArchive.entries) {
      if (bytes.byteLength > 0 || !this.entrySizes.has(key)) {
        this.entrySizes.set(key, bytes.byteLength)
      }
    }
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
    const unused = findUnusedResources(this.texts, this.pkg, this.archive, this.entrySizes)
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
    const remaining = findUnusedResources(this.texts, this.pkg, this.archive, this.entrySizes)
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
   * Pass `validate: false` during mid-turn live streaming to skip full-book `validateStructure`
   * until turn settlement; every write tool already validates XML on write.
   * See ADR 2026-11-22-live-streaming-agent-review.
   */
  buildProposal(id: string, options?: { validate?: boolean }): AgentProposal | null {
    if (this.seededPendingProposal && !this.mutatedSinceSeed) {
      return null
    }
    const shouldValidate = options?.validate !== false
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

    const validationIssues: EpubIssue[] = shouldValidate ? validateStructure(this.archive, this.pkg) : []
    if (shouldValidate) {
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

function proposalFilesEqual(a: AgentProposalFile, b: AgentProposalFile): boolean {
  if (
    a.path !== b.path ||
    a.kind !== b.kind ||
    a.previousPath !== b.previousPath ||
    a.beforeText !== b.beforeText ||
    a.afterText !== b.afterText
  ) {
    return false
  }
  const refsA = a.referencesAffected ?? []
  const refsB = b.referencesAffected ?? []
  if (refsA.length !== refsB.length) return false
  for (let i = 0; i < refsA.length; i += 1) {
    if (refsA[i]!.from !== refsB[i]!.from || refsA[i]!.line !== refsB[i]!.line) return false
  }
  return true
}

function focusPriority(path: string, opfPath?: string): number {
  if (opfPath && path === opfPath) return 4
  const ext = extensionOf(path)
  if (ext === 'xhtml' || ext === 'html' || ext === 'htm') return 0
  if (ext === 'css') return 1
  if (ext === 'ncx') return 3
  return 2
}

/**
 * Computes an incremental delta between two `AgentProposal` snapshots for real-time review streaming.
 * Returns null when neither file entries nor structural status changed.
 * See ADR 2026-11-22-live-streaming-agent-review.
 */
export function diffProposalSnapshots(
  prev: AgentProposal | null,
  next: AgentProposal | null,
  options: { proposalId?: string; hintPaths?: readonly string[]; opfPath?: string } = {},
): AgentProposalDelta | null {
  const proposalId = next?.id ?? prev?.id ?? options.proposalId ?? ''
  const prevByPath = new Map((prev?.files ?? []).map((file) => [file.path, file]))
  const nextByPath = new Map((next?.files ?? []).map((file) => [file.path, file]))

  const changedFiles: AgentProposalFile[] = []
  for (const file of next?.files ?? []) {
    const existing = prevByPath.get(file.path)
    if (!existing || !proposalFilesEqual(existing, file)) {
      changedFiles.push(file)
    }
  }

  const removedPaths: string[] = []
  for (const file of prev?.files ?? []) {
    if (!nextByPath.has(file.path)) {
      removedPaths.push(file.path)
    }
  }

  const nextStructural = next?.isStructural ?? false
  const prevStructural = prev?.isStructural ?? false
  if (changedFiles.length === 0 && removedPaths.length === 0 && nextStructural === prevStructural) {
    return null
  }

  let focusPath: string | null = null
  if (options.hintPaths && options.hintPaths.length > 0) {
    const validHints = options.hintPaths.filter((p) => nextByPath.has(p))
    if (validHints.length > 0) {
      validHints.sort((a, b) => focusPriority(a, options.opfPath) - focusPriority(b, options.opfPath))
      focusPath = validHints[0] ?? null
    }
  }
  if (!focusPath && changedFiles.length > 0) {
    const sorted = [...changedFiles].sort(
      (a, b) => focusPriority(a.path, options.opfPath) - focusPriority(b.path, options.opfPath),
    )
    focusPath = sorted[0]?.path ?? null
  }
  if (!focusPath && next && next.files.length > 0) {
    focusPath = next.files[0]?.path ?? null
  }

  return {
    proposalId,
    isStructural: nextStructural,
    changedFiles,
    removedPaths,
    focusPath,
  }
}
