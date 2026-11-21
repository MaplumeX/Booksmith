import type { AgentProposal, EpubArchive, EpubPackage, XmlDocumentParser } from '@booksmith/core'
import { describe, expect, it } from 'vitest'
import { groupFiles, type LoadedBook } from './bookStore'
import {
  applyProposalDelta,
  buildComposedProposalPlan,
  buildFileHunks,
  buildVirtualReviewBook,
  composeFileFromHunks,
  detectProposalStaleness,
  findNewestChangedHunkIndex,
  findReferencingChaptersForCss,
  reconcileHunkDecisions,
  reconcileProposalDecisions,
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

  it('coalesces paired cross-line blockquote wrappers into one atomic hunk with accurate stats and lossless reject', () => {
    const before = [
      '<html xmlns="http://www.w3.org/1999/xhtml"><body>',
      '<p>第一段引文</p>',
      '<p>第二段引文</p>',
      '</body></html>',
    ].join('\n')
    const after = [
      '<html xmlns="http://www.w3.org/1999/xhtml"><body>',
      '<blockquote>',
      '<p>第一段引文</p>',
      '<p>第二段引文</p>',
      '</blockquote>',
      '</body></html>',
    ].join('\n')

    const model = buildFileHunks({
      path: 'EPUB/text/ch001.xhtml',
      kind: 'update',
      beforeText: before,
      afterText: after,
    })
    expect(model.hunks).toHaveLength(1)
    expect(model.hunks[0]!.addedCount).toBe(2)
    expect(model.hunks[0]!.removedCount).toBe(0)
    expect(model.hunks[0]!.beforeLines).toEqual(['<p>第一段引文</p>', '<p>第二段引文</p>'])
    expect(model.hunks[0]!.afterLines).toEqual(['<blockquote>', '<p>第一段引文</p>', '<p>第二段引文</p>', '</blockquote>'])
    expect(composeFileFromHunks(model, { 'hunk-0': 'rejected' })).toBe(before)
    expect(composeFileFromHunks(model, { 'hunk-0': 'accepted' })).toBe(after)

    // Unwrapping blockquote also coalesces into one atomic hunk.
    const unwrapModel = buildFileHunks({
      path: 'EPUB/text/ch001.xhtml',
      kind: 'update',
      beforeText: after,
      afterText: before,
    })
    expect(unwrapModel.hunks).toHaveLength(1)
    expect(unwrapModel.hunks[0]!.removedCount).toBe(2)
    expect(unwrapModel.hunks[0]!.addedCount).toBe(0)
    expect(composeFileFromHunks(unwrapModel, { 'hunk-0': 'rejected' })).toBe(after)

    // Merging two consecutive blockquotes keeps the seam as one self-balanced hunk without over-merging.
    const mergeBefore = [
      '<html><body>',
      '<blockquote>',
      '<p>段1</p>',
      '</blockquote>',
      '<blockquote>',
      '<p>段2</p>',
      '</blockquote>',
      '<p>后续编辑前</p>',
      '</body></html>',
    ].join('\n')
    const mergeAfter = [
      '<html><body>',
      '<blockquote>',
      '<p>段1</p>',
      '<p>段2</p>',
      '</blockquote>',
      '<p>后续编辑后</p>',
      '</body></html>',
    ].join('\n')
    const mergeModel = buildFileHunks({
      path: 'EPUB/text/ch001.xhtml',
      kind: 'update',
      beforeText: mergeBefore,
      afterText: mergeAfter,
    })
    expect(mergeModel.hunks).toHaveLength(2)
    expect(mergeModel.hunks[0]!.beforeLines).toEqual(['</blockquote>', '<blockquote>'])
    expect(mergeModel.hunks[0]!.afterLines).toEqual([])
    expect(composeFileFromHunks(mergeModel, { 'hunk-0': 'rejected' })).toContain('</blockquote>\n<blockquote>')
  })

  it('keeps chapter-wide wrappers beyond the 40-line guard split and blocks partial XML breakage', () => {
    const middleParagraphs = Array.from({ length: 42 }, (_, idx) => `<p>第 ${idx + 1} 段正文</p>`)
    const before = [
      '<html xmlns="http://www.w3.org/1999/xhtml"><body>',
      ...middleParagraphs,
      '</body></html>',
    ].join('\n')
    const after = [
      '<html xmlns="http://www.w3.org/1999/xhtml"><body>',
      '<section>',
      ...middleParagraphs,
      '</section>',
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

  it('merges incremental streaming deltas and drops reverted files cleanly', () => {
    const p1 = applyProposalDelta(null, {
      proposalId: 'live-1',
      isStructural: false,
      changedFiles: [
        { path: 'EPUB/text/ch001.xhtml', kind: 'update', beforeText: '<p>原1</p>', afterText: '<p>改1</p>' },
      ],
      removedPaths: [],
      focusPath: 'EPUB/text/ch001.xhtml',
    })!
    expect(p1.files).toHaveLength(1)
    expect(p1.id).toBe('live-1')

    const p2 = applyProposalDelta(p1, {
      proposalId: 'live-1',
      isStructural: false,
      changedFiles: [
        { path: 'EPUB/text/ch002.xhtml', kind: 'update', beforeText: '<p>原2</p>', afterText: '<p>改2</p>' },
      ],
      removedPaths: [],
      focusPath: 'EPUB/text/ch002.xhtml',
    })!
    expect(p2.files.map((f) => f.path)).toEqual(['EPUB/text/ch001.xhtml', 'EPUB/text/ch002.xhtml'])

    // Updating ch001 in place preserves path ordering; removing ch002 drops it cleanly.
    const p3 = applyProposalDelta(p2, {
      proposalId: 'live-1',
      isStructural: false,
      changedFiles: [
        { path: 'EPUB/text/ch001.xhtml', kind: 'update', beforeText: '<p>原1</p>', afterText: '<p>改1b</p>' },
      ],
      removedPaths: ['EPUB/text/ch002.xhtml'],
      focusPath: 'EPUB/text/ch001.xhtml',
    })!
    expect(p3.files.map((f) => f.path)).toEqual(['EPUB/text/ch001.xhtml'])
    expect(p3.files[0]!.afterText).toBe('<p>改1b</p>')

    // Removing the last file yields null.
    const empty = applyProposalDelta(p3, {
      proposalId: 'live-1',
      isStructural: false,
      changedFiles: [],
      removedPaths: ['EPUB/text/ch001.xhtml'],
      focusPath: null,
    })
    expect(empty).toBeNull()
  })

  it('tracks 3-state decisions and reconciles accepted/rejected choices by fingerprint across live re-edits', () => {
    const before = [
      '<body>',
      '<p>第一段原文</p>',
      '<p>中间段落</p>',
      '<p>第三段错字</p>',
      '<p>重复错字</p>',
      '<p>尾段</p>',
      '<p>重复错字</p>',
      '</body>',
    ].join('\n')
    const afterStep1 = [
      '<body>',
      '<p>第一段原文</p>',
      '<p>中间段落</p>',
      '<p>第三段正字</p>',
      '<p>重复正字</p>',
      '<p>尾段</p>',
      '<p>重复正字</p>',
      '</body>',
    ].join('\n')
    const afterStep2 = [
      '<body>',
      '<p>第一段新增修改</p>',
      '<p>中间段落</p>',
      '<p>第三段正字</p>',
      '<p>重复正字</p>',
      '<p>尾段</p>',
      '<p>重复正字</p>',
      '</body>',
    ].join('\n')

    const model1 = buildFileHunks({ path: 'ch1.xhtml', kind: 'update', beforeText: before, afterText: afterStep1 })
    // model1 has 2 hunks: hunk-0 (lines 4-5 combined) and hunk-1 (line 7)
    expect(model1.hunks).toHaveLength(2)
    expect(model1.hunks[0]!.fingerprint).not.toBe(model1.hunks[1]!.fingerprint)

    // User accepts hunk-0 and rejects hunk-1 during streaming
    const decisions1 = { 'hunk-0': 'accepted' as const, 'hunk-1': 'rejected' as const }
    const composed1 = composeFileFromHunks(model1, decisions1)
    expect(composed1).toContain('<p>第三段正字</p>')
    expect(composed1).toContain('<p>尾段</p>\n<p>重复错字</p>')

    // Step 2 inserts a brand-new edit at line 2 -> shifts old hunk-0/hunk-1 to hunk-1/hunk-2!
    const model2 = buildFileHunks({ path: 'ch1.xhtml', kind: 'update', beforeText: before, afterText: afterStep2 })
    expect(model2.hunks).toHaveLength(3)

    const reconciled = reconcileHunkDecisions(model1, model2, decisions1)
    // Newly inserted top hunk starts as pending (absent), while prior decisions shift cleanly by fingerprint.
    expect(reconciled['hunk-0']).toBeUndefined()
    expect(reconciled['hunk-1']).toBe('accepted')
    expect(reconciled['hunk-2']).toBe('rejected')

    // Newest changed hunk locator points to index 0 (the newly introduced top edit).
    expect(findNewestChangedHunkIndex(model1, model2)).toBe(0)

    const proposal2: AgentProposal = {
      id: 'p-3state',
      isStructural: false,
      validationIssues: [],
      files: [model2.file],
    }
    const plan = buildComposedProposalPlan(proposal2, new Map([[model2.file.path, model2]]), {
      [model2.file.path]: reconciled,
    })
    expect(plan.totalHunks).toBe(3)
    expect(plan.pendingHunks).toBe(1)
    expect(plan.acceptedHunks).toBe(1)
    expect(plan.rejectedHunks).toBe(1)
    expect(plan.keptHunks).toBe(2)

    const proposal1: AgentProposal = {
      id: 'p-3state',
      isStructural: false,
      validationIssues: [],
      files: [model1.file],
    }
    const fullReconciled = reconcileProposalDecisions(proposal1, proposal2, {
      'ch1.xhtml': decisions1,
    })
    expect(fullReconciled['ch1.xhtml']).toEqual(reconciled)
  })
})
