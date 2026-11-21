import type { AgentProposal, EpubArchive, EpubPackage, XmlDocumentParser } from '@booksmith/core'
import { describe, expect, it } from 'vitest'
import { groupFiles, type LoadedBook } from './bookStore'
import {
  buildComposedProposalPlan,
  buildFileHunks,
  buildVirtualReviewBook,
  composeFileFromHunks,
  detectProposalStaleness,
  findReferencingChaptersForCss,
  summarizeStructuralProposal,
  validateComposedProposal,
} from './proposalReview'

const encoder = new TextEncoder()

/** Strict balanced-tag stub XML parser for unit testing partial-hunk well-formedness checks. */
const strictXmlStub: XmlDocumentParser = (xml) => {
  const stack: string[] = []
  let broken: string | null = null
  const tagRe = /<\/?([a-zA-Z][\w:-]*)(?:\s[^<>]*?)?(\/?)>/g
  for (const match of xml.matchAll(tagRe)) {
    const full = match[0]!
    const name = match[1]!
    const selfClosing = match[2] === '/'
    if (full.startsWith('</')) {
      const top = stack.pop()
      if (top !== name) {
        broken = `mismatched closing tag </${name}>`
        break
      }
    } else if (!selfClosing) {
      stack.push(name)
    }
  }
  if (!broken && stack.length > 0) broken = `unclosed <${stack[stack.length - 1]}>`
  return {
    documentElement: { nodeName: broken ? 'parsererror' : 'html' },
    getElementsByTagName: (tag: string) =>
      tag === 'parsererror' && broken ? [{ textContent: broken }] : [],
  } as unknown as Document
}

function makeBook(): { book: LoadedBook; texts: Map<string, string> } {
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>书稿</dc:title><dc:language>zh-CN</dc:language><dc:identifier id="id">b1</dc:identifier></metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="styles/main.css" media-type="text/css"/>
    <item id="ch1" href="text/ch001.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="ch1"/></spine>
</package>`

  const ch1 = [
    '<html xmlns="http://www.w3.org/1999/xhtml">',
    '<head><link rel="stylesheet" href="../styles/main.css" /></head>',
    '<body>',
    '<p>第一段错字甲。</p>',
    '<p>第二段保持不变。</p>',
    '<p>第三段错字乙。</p>',
    '</body>',
    '</html>',
  ].join('\n')

  const texts = new Map<string, string>([
    ['EPUB/content.opf', opf],
    ['EPUB/nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><body><nav/></body></html>'],
    ['EPUB/styles/main.css', 'p { line-height: 1.6; }'],
    ['EPUB/text/ch001.xhtml', ch1],
  ])
  const entries = new Map<string, Uint8Array>()
  for (const [k, v] of texts) entries.set(k, encoder.encode(v))
  const archive: EpubArchive = { order: [...entries.keys()], entries }
  const pkg: EpubPackage = {
    version: '3.0',
    uniqueIdentifierId: 'id',
    opfPath: 'EPUB/content.opf',
    navPath: 'EPUB/nav.xhtml',
    metadata: {
      title: '书稿',
      language: 'zh-CN',
      identifier: 'b1',
      creators: [],
      publisher: '',
      date: '',
      description: '',
      subjects: [],
      rights: '',
    },
    manifest: [
      { id: 'nav', href: 'nav.xhtml', mediaType: 'application/xhtml+xml', properties: ['nav'], path: 'EPUB/nav.xhtml' },
      { id: 'css', href: 'styles/main.css', mediaType: 'text/css', properties: [], path: 'EPUB/styles/main.css' },
      { id: 'ch1', href: 'text/ch001.xhtml', mediaType: 'application/xhtml+xml', properties: [], path: 'EPUB/text/ch001.xhtml' },
    ],
    spine: ['ch1'],
  }
  const book: LoadedBook = {
    id: 'b1',
    version: 1,
    archive,
    pkg,
    texts,
    groups: groupFiles(pkg, archive),
    serverPaths: new Set(entries.keys()),
    entryMeta: new Map(),
    entryOrigins: new Map(),
    serverEntries: new Map(),
    localBinaries: new Map(),
  }
  return { book, texts }
}

describe('proposalReview engine', () => {
  it('splits multiple changes into independent hunks and recomposes partial skips with CRLF preservation', () => {
    const before = ['<body>', '<p>甲错字</p>', '<p>未变</p>', '<p>乙错字</p>', '</body>'].join('\r\n')
    const after = ['<body>', '<p>甲正字</p>', '<p>未变</p>', '<p>乙正字</p>', '</body>'].join('\r\n')
    const model = buildFileHunks({
      path: 'EPUB/text/ch001.xhtml',
      kind: 'update',
      beforeText: before,
      afterText: after,
    })

    expect(model.hunks).toHaveLength(2)
    expect(model.hunks[0]!.beforeStart).toBe(2)
    expect(model.hunks[1]!.beforeStart).toBe(4)

    const onlyFirst = composeFileFromHunks(model, new Set([model.hunks[1]!.id]))
    expect(onlyFirst).toBe(['<body>', '<p>甲正字</p>', '<p>未变</p>', '<p>乙错字</p>', '</body>'].join('\r\n'))

    const noneKept = composeFileFromHunks(model, new Set([model.hunks[0]!.id, model.hunks[1]!.id]))
    expect(noneKept).toBe(before)
  })

  it('blocks partial-hunk composition that splits a multi-line XML element', () => {
    const before = [
      '<html xmlns="http://www.w3.org/1999/xhtml"><body>',
      '<p>正文内容</p>',
      '</body></html>',
    ].join('\n')
    const after = [
      '<html xmlns="http://www.w3.org/1999/xhtml"><body>',
      '<blockquote>',
      '<p>正文内容</p>',
      '</blockquote>',
      '</body></html>',
    ].join('\n')

    const proposal: AgentProposal = {
      id: 'p-xml',
      isStructural: false,
      validationIssues: [],
      files: [{ path: 'EPUB/text/ch001.xhtml', kind: 'update', beforeText: before, afterText: after }],
    }
    const model = buildFileHunks(proposal.files[0]!)
    expect(model.hunks).toHaveLength(2)

    const plan = buildComposedProposalPlan(proposal, new Map([[model.file.path, model]]), {
      [model.file.path]: new Set([model.hunks[1]!.id]),
    })
    const failures = validateComposedProposal(proposal, plan, strictXmlStub)
    expect(failures).toHaveLength(1)
    expect(failures[0]!.path).toBe('EPUB/text/ch001.xhtml')
    expect(failures[0]!.message).toContain('XHTML 结构不再闭合')
  })

  it('builds a read-only virtual overlay book with CSS toggle and finds referencing chapters', () => {
    const { book, texts } = makeBook()
    const proposal: AgentProposal = {
      id: 'p-css',
      isStructural: false,
      validationIssues: [],
      files: [
        {
          path: 'EPUB/styles/main.css',
          kind: 'update',
          beforeText: 'p { line-height: 1.6; }',
          afterText: 'p { line-height: 1.85; color: #333; }',
        },
      ],
    }

    const refs = findReferencingChaptersForCss('EPUB/styles/main.css', book.pkg, texts)
    expect(refs).toEqual(['EPUB/text/ch001.xhtml'])

    const virtualAfter = buildVirtualReviewBook({ book, texts, proposal })
    expect(virtualAfter.texts.get('EPUB/styles/main.css')).toContain('1.85')
    // Live book remains untouched.
    expect(texts.get('EPUB/styles/main.css')).toBe('p { line-height: 1.6; }')

    const virtualBeforeCss = buildVirtualReviewBook({
      book,
      texts,
      proposal,
      cssOverride: { path: 'EPUB/styles/main.css', mode: 'before' },
    })
    expect(virtualBeforeCss.texts.get('EPUB/styles/main.css')).toBe('p { line-height: 1.6; }')
  })

  it('summarizes structural proposals and detects stale baselines', () => {
    const { book, texts } = makeBook()
    const proposal: AgentProposal = {
      id: 'p-struct',
      isStructural: true,
      validationIssues: [],
      files: [
        { path: 'EPUB/text/ch002.xhtml', kind: 'create', afterText: '<html/>' },
        { path: 'EPUB/nav.xhtml', kind: 'update', beforeText: 'old-nav', afterText: 'new-nav' },
        { path: 'EPUB/content.opf', kind: 'update', beforeText: texts.get('EPUB/content.opf'), afterText: '<package/>' },
      ],
    }

    expect(summarizeStructuralProposal(proposal, book.pkg)).toEqual(['新增 1 章', '同步目录与 OPF'])
    expect(detectProposalStaleness(proposal, texts)).toEqual(['EPUB/nav.xhtml'])
  })
})
