import type { AgentProposal, EpubArchive, EpubPackage, XmlDocumentParser } from '@booksmith/core'
import { describe, expect, it } from 'vitest'
import {
  applyProposalToBook,
  collectDirtyTexts,
  computeDeletedPaths,
  createUndoSnapshot,
  evaluateAutoApply,
  type WorkspaceSnapshot,
} from './agentProposal'
import { groupFiles, type LoadedBook } from './bookStore'

const encoder = new TextEncoder()

/** Minimal XML DOM stub for `parsePackage` so web state tests stay zero-dependency. */
const stubOpfParser: XmlDocumentParser = (xml) => {
  const parseAttrs = (raw: string): Record<string, string> => {
    const map: Record<string, string> = {}
    for (const m of raw.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) map[m[1]!] = m[2]!
    return map
  }
  const makeEl = (attrs: Record<string, string>, text = '') => ({
    getAttribute: (name: string) => attrs[name] ?? null,
    textContent: text,
    getElementsByTagNameNS: (_ns: string, tag: string) => findTag(tag),
  })
  const findTag = (tag: string) => {
    if (tag === 'package') {
      const m = /<package([^>]*)>/.exec(xml)
      return m ? [makeEl(parseAttrs(m[1]!))] : []
    }
    if (tag === 'spine') {
      const m = /<spine([^>]*)>/.exec(xml)
      return m ? [makeEl(parseAttrs(m[1]!))] : []
    }
    if (tag === 'item' || tag === 'itemref') {
      return [...xml.matchAll(new RegExp(`<${tag}([^>]*)/?>`, 'g'))].map((m) => makeEl(parseAttrs(m[1]!)))
    }
    return [...xml.matchAll(new RegExp(`<dc:${tag}[^>]*>([^<]*)</dc:${tag}>`, 'g'))].map((m) => makeEl({}, m[1]!))
  }
  return { getElementsByTagNameNS: (_ns: string, tag: string) => findTag(tag) } as unknown as Document
}

const OPF_V1 = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>测试书</dc:title><dc:language>zh-CN</dc:language><dc:identifier id="bookid">id1</dc:identifier></metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="styles/stylesheet1.css" media-type="text/css"/>
    <item id="ch001" href="text/ch001.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="ch001"/></spine>
</package>`

const OPF_V2 = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>测试书</dc:title><dc:language>zh-CN</dc:language><dc:identifier id="bookid">id1</dc:identifier></metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="styles/stylesheet1.css" media-type="text/css"/>
    <item id="ch001" href="text/intro.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch002" href="text/ch002.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="ch001"/><itemref idref="ch002"/></spine>
</package>`

function buildSnapshot(): WorkspaceSnapshot {
  const texts = new Map<string, string>([
    ['EPUB/content.opf', OPF_V1],
    ['EPUB/nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><body/></html>'],
    ['EPUB/styles/stylesheet1.css', 'body { line-height: 1.6; }'],
    ['EPUB/text/ch001.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>从这里开始写。</p></body></html>'],
  ])
  const entries = new Map<string, Uint8Array>()
  for (const [k, v] of texts) entries.set(k, encoder.encode(v))
  const archive: EpubArchive = { order: [...entries.keys()], entries }
  const pkg: EpubPackage = {
    version: '3.0',
    uniqueIdentifierId: 'bookid',
    opfPath: 'EPUB/content.opf',
    navPath: 'EPUB/nav.xhtml',
    metadata: {
      title: '测试书',
      language: 'zh-CN',
      identifier: 'id1',
      creators: [],
      publisher: '',
      date: '',
      description: '',
      subjects: [],
      rights: '',
    },
    manifest: [
      { id: 'nav', href: 'nav.xhtml', mediaType: 'application/xhtml+xml', properties: ['nav'], path: 'EPUB/nav.xhtml' },
      { id: 'css', href: 'styles/stylesheet1.css', mediaType: 'text/css', properties: [], path: 'EPUB/styles/stylesheet1.css' },
      { id: 'ch001', href: 'text/ch001.xhtml', mediaType: 'application/xhtml+xml', properties: [], path: 'EPUB/text/ch001.xhtml' },
    ],
    spine: ['ch001'],
  }
  const book: LoadedBook = {
    id: 'book-1',
    version: 1,
    archive,
    pkg,
    texts,
    groups: groupFiles(pkg, archive),
    serverPaths: new Set(entries.keys()),
  }
  return {
    book,
    texts,
    dirty: new Set(),
    tabs: ['EPUB/text/ch001.xhtml'],
    active: 'EPUB/text/ch001.xhtml',
  }
}

describe('agentProposal application & undo', () => {
  it('supports per-file selection on pure text proposals and restores exact undo snapshot', () => {
    const initial = buildSnapshot()
    const undo = createUndoSnapshot(initial)

    const proposal: AgentProposal = {
      id: 'prop-text',
      isStructural: false,
      validationIssues: [],
      files: [
        {
          path: 'EPUB/text/ch001.xhtml',
          kind: 'update',
          beforeText: initial.texts.get('EPUB/text/ch001.xhtml'),
          afterText: '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>校对后的正文。</p></body></html>',
        },
        {
          path: 'EPUB/styles/stylesheet1.css',
          kind: 'update',
          beforeText: initial.texts.get('EPUB/styles/stylesheet1.css'),
          afterText: 'body { line-height: 1.75; }',
        },
      ],
    }

    const applied = applyProposalToBook({
      ...initial,
      proposal,
      selectedPaths: new Set(['EPUB/text/ch001.xhtml']),
      parseXml: stubOpfParser,
    })

    expect(applied.appliedCount).toBe(1)
    expect(applied.texts.get('EPUB/text/ch001.xhtml')).toContain('校对后的正文。')
    expect(applied.texts.get('EPUB/styles/stylesheet1.css')).toContain('line-height: 1.6;')
    expect(applied.dirty.has('EPUB/text/ch001.xhtml')).toBe(true)
    expect(applied.dirty.has('EPUB/styles/stylesheet1.css')).toBe(false)

    const dirtyPayload = collectDirtyTexts(applied.texts, applied.dirty, applied.book)
    expect(Object.keys(dirtyPayload)).toEqual(['EPUB/text/ch001.xhtml'])

    expect(undo.texts.get('EPUB/text/ch001.xhtml')).toContain('从这里开始写。')
    expect(undo.dirty.size).toBe(0)
  })

  it('applies structural proposals atomically (ignoring partial selection) and updates tabs & deletedPaths', () => {
    const initial = buildSnapshot()
    const proposal: AgentProposal = {
      id: 'prop-struct',
      isStructural: true,
      validationIssues: [],
      files: [
        {
          path: 'EPUB/text/intro.xhtml',
          previousPath: 'EPUB/text/ch001.xhtml',
          kind: 'rename',
          beforeText: initial.texts.get('EPUB/text/ch001.xhtml'),
          afterText: initial.texts.get('EPUB/text/ch001.xhtml'),
        },
        {
          path: 'EPUB/text/ch002.xhtml',
          kind: 'create',
          afterText: '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第二章</h1></body></html>',
        },
        {
          path: 'EPUB/content.opf',
          kind: 'update',
          beforeText: OPF_V1,
          afterText: OPF_V2,
        },
      ],
    }

    const applied = applyProposalToBook({
      ...initial,
      proposal,
      selectedPaths: new Set(['EPUB/text/ch002.xhtml']),
      parseXml: stubOpfParser,
    })

    expect(applied.appliedCount).toBe(3)
    expect(applied.tabs).toEqual(['EPUB/text/intro.xhtml'])
    expect(applied.active).toBe('EPUB/text/intro.xhtml')
    expect(applied.book.archive.entries.has('EPUB/text/ch001.xhtml')).toBe(false)
    expect(applied.book.archive.entries.has('EPUB/text/intro.xhtml')).toBe(true)
    expect(applied.book.archive.entries.has('EPUB/text/ch002.xhtml')).toBe(true)
    expect(applied.book.pkg.spine).toEqual(['ch001', 'ch002'])
    expect(computeDeletedPaths(applied.book)).toContain('EPUB/text/ch001.xhtml')
  })

  it('blocks applying proposals with validationIssues', () => {
    const initial = buildSnapshot()
    expect(() =>
      applyProposalToBook({
        ...initial,
        proposal: {
          id: 'bad',
          isStructural: false,
          validationIssues: [{ code: 'invalid-xml', message: 'broken' }],
          files: [{ path: 'EPUB/text/ch001.xhtml', kind: 'update', afterText: '<bad' }],
        },
        parseXml: stubOpfParser,
      }),
    ).toThrow('结构预检')
  })

  it('evaluates auto-apply eligibility cleanly across text, structural, preflight error, and broken-delete cases', () => {
    expect(
      evaluateAutoApply({
        id: 'p-text',
        isStructural: false,
        validationIssues: [],
        files: [{ path: 'EPUB/text/ch001.xhtml', kind: 'update', afterText: '<html/>' }],
      }),
    ).toEqual({ eligible: true })

    expect(
      evaluateAutoApply({
        id: 'p-create',
        isStructural: true,
        validationIssues: [],
        files: [{ path: 'EPUB/text/ch002.xhtml', kind: 'create', afterText: '<html/>' }],
      }),
    ).toEqual({ eligible: true })

    const preflightFail = evaluateAutoApply({
      id: 'p-err',
      isStructural: true,
      validationIssues: [{ code: 'missing-file', message: 'missing target' }],
      files: [{ path: 'EPUB/content.opf', kind: 'update', afterText: '<package/>' }],
    })
    expect(preflightFail.eligible).toBe(false)
    expect(preflightFail.reason).toContain('结构预检')

    const brokenDelete = evaluateAutoApply({
      id: 'p-del',
      isStructural: true,
      validationIssues: [],
      files: [
        {
          path: 'EPUB/text/extra.xhtml',
          kind: 'delete',
          referencesAffected: [{ from: 'EPUB/text/ch001.xhtml', line: 12 }],
        },
      ],
    })
    expect(brokenDelete.eligible).toBe(false)
    expect(brokenDelete.reason).toContain('外部引用失效')
  })
})
