import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import {
  AGENT_READ_ONLY_TOOL_NAMES,
  AGENT_TOOL_NAMES,
  AgentWorkspace,
  createEmptyEpub,
  diffProposalSnapshots,
  isReadOnlyAgentTool,
  openEpub,
  probeImageDimensions,
} from '../src'
import type { XmlCodec } from '../src/xml'
import { readFixture } from './helpers'

function makeNodeCodec(): XmlCodec {
  return {
    parse: (xml) => new DOMParser().parseFromString(xml, 'application/xml') as unknown as Document,
    serialize: (node) => new XMLSerializer().serializeToString(node as never),
  }
}

function strictCheckXml(xml: string): string | null {
  const errors: string[] = []
  const parser = new DOMParser({
    onError: (level, message) => {
      if (level === 'error' || level === 'fatalError') errors.push(String(message))
    },
  })
  const doc = parser.parseFromString(xml, 'application/xml') as unknown as Document
  if (errors.length > 0) return errors[0]!
  if (!doc.documentElement) return 'XML document has no root element'
  return null
}

const codec = makeNodeCodec()
const FIXED_NOW = () => new Date('2026-11-20T10:00:00.000Z')

function openFixtureWorkspace(overlay?: { dirtyTexts?: Record<string, string>; deletedPaths?: string[] }) {
  const { archive } = openEpub(readFixture(), codec.parse)
  return AgentWorkspace.fromArchive(archive, { codec, checkXml: strictCheckXml, overlay, now: FIXED_NOW })
}

function openEmptyWorkspace() {
  const { archive } = openEpub(createEmptyEpub({ title: '测试书', author: '原作者' }), codec.parse)
  return AgentWorkspace.fromArchive(archive, { codec, checkXml: strictCheckXml, now: FIXED_NOW })
}

describe('AgentWorkspace read tools on real EPUB fixture', () => {
  it('lists files, reads line windows safely, and truncates huge chapters', () => {
    const ws = openFixtureWorkspace()
    const listed = ws.executeTool('list_files')
    expect(listed.ok).toBe(true)
    const data = listed.data as {
      title: string
      spine: string[]
      files: Array<{ path: string; isText: boolean; byteSize: number }>
    }
    expect(data.spine.length).toBeGreaterThanOrEqual(20)

    // Pick the largest text chapter (~174KB) and verify read_file paginates instead of dumping all bytes.
    const largest = data.files
      .filter((f) => f.isText)
      .sort((a, b) => b.byteSize - a.byteSize)[0]!
    expect(largest.byteSize).toBeGreaterThan(50_000)

    const page1 = ws.executeTool('read_file', { path: largest.path, startLine: 1, endLine: 400 })
    expect(page1.ok).toBe(true)
    const pageData = page1.data as { content: string; truncated: boolean; startLine: number; endLine: number }
    expect(pageData.startLine).toBe(1)
    expect(pageData.content.length).toBeLessThanOrEqual(24_500)
    expect(pageData.truncated).toBe(true)
  })

  it('searches book text with cap, runs lint_book, and reads metadata and toc', () => {
    const ws = openFixtureWorkspace()

    const searched = ws.executeTool('search_book', { query: '马克思', maxResults: 5 })
    expect(searched.ok).toBe(true)
    const sData = searched.data as { count: number; truncated: boolean; matches: Array<{ path: string; line: number }> }
    expect(sData.count).toBe(5)
    expect(sData.truncated).toBe(true)

    const linted = ws.executeTool('lint_book')
    expect(linted.ok).toBe(true)
    expect(Array.isArray((linted.data as { issues: unknown[] }).issues)).toBe(true)

    const meta = ws.executeTool('get_metadata')
    expect(meta.ok).toBe(true)
    expect((meta.data as { metadata: { title: string } }).metadata.title).toContain('马克思')

    const toc = ws.executeTool('get_toc')
    expect(toc.ok).toBe(true)
    const tocData = toc.data as { source: string; entries: unknown[] }
    expect(tocData.source).toBe('nav')
    expect(tocData.entries.length).toBeGreaterThan(0)
  })
  it('partitions read-only tools cleanly from write tools for ask approval mode', () => {
    expect(AGENT_READ_ONLY_TOOL_NAMES).toEqual([
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
    ])
    expect(AGENT_TOOL_NAMES).toHaveLength(27)
    for (const name of AGENT_READ_ONLY_TOOL_NAMES) {
      expect(AGENT_TOOL_NAMES).toContain(name)
      expect(isReadOnlyAgentTool(name)).toBe(true)
    }
    const writeTools = AGENT_TOOL_NAMES.filter((name) => !isReadOnlyAgentTool(name))
    expect(writeTools).toEqual([
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
    ])
  })
})

describe('AgentWorkspace overlay & pure text edits', () => {
  it('sees unsaved browser dirtyTexts and diffs proposals only against post-overlay baseline', () => {
    const ws = openFixtureWorkspace({
      dirtyTexts: {
        'OEBPS/Text/chapter001.xhtml': '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body><p>未保存的草稿内容</p></body></html>',
      },
    })

    const found = ws.executeTool('search_book', { query: '未保存的草稿内容' })
    expect(found.ok).toBe(true)
    expect((found.data as { count: number }).count).toBe(1)

    // No Agent edits yet -> proposal is null (does not include user's own unsaved edit).
    expect(ws.buildProposal('p0')).toBeNull()

    const edited = ws.executeTool('edit_file', {
      path: 'OEBPS/Text/chapter001.xhtml',
      oldText: '未保存的草稿内容',
      newText: '校对后的草稿内容',
    })
    expect(edited.ok).toBe(true)

    const proposal = ws.buildProposal('p1')!
    expect(proposal).not.toBeNull()
    expect(proposal.isStructural).toBe(false)
    expect(proposal.validationIssues).toEqual([])
    expect(proposal.files).toHaveLength(1)
    expect(proposal.files[0]!.kind).toBe('update')
    expect(proposal.files[0]!.beforeText).toContain('未保存的草稿内容')
    expect(proposal.files[0]!.afterText).toContain('校对后的草稿内容')
  })

  it('rejects ambiguous edit_file matches unless replaceAll is true, and rolls back invalid XML', () => {
    const ws = openEmptyWorkspace()
    const path = 'EPUB/text/ch001.xhtml'
    const original = ws.getText(path)!

    // Duplicate target -> rejected without replaceAll
    const wrote = ws.executeTool('write_file', {
      path,
      content: original.replace('<p>从这里开始写。</p>', '<p>重复词</p><p>重复词</p>'),
    })
    expect(wrote.ok).toBe(true)

    const ambiguous = ws.executeTool('edit_file', { path, oldText: '重复词', newText: '新词' })
    expect(ambiguous.ok).toBe(false)
    expect(ambiguous.error).toContain('matched 2 times')

    const replaceAll = ws.executeTool('edit_file', {
      path,
      oldText: '重复词',
      newText: '新词',
      replaceAll: true,
    })
    expect(replaceAll.ok).toBe(true)
    expect(ws.getText(path)).toContain('<p>新词</p><p>新词</p>')

    // Malformed XML -> rejected and does not corrupt working text
    const badXml = ws.executeTool('edit_file', {
      path,
      oldText: '<p>新词</p><p>新词</p>',
      newText: '<p>坏标签</div>',
    })
    expect(badXml.ok).toBe(false)
    expect(badXml.error).toContain('XML')
    expect(ws.getText(path)).toContain('<p>新词</p><p>新词</p>')

    // Protected files cannot be modified
    const protectedRes = ws.executeTool('write_file', { path: 'META-INF/container.xml', content: '<x/>' })
    expect(protectedRes.ok).toBe(false)
  })
})

describe('AgentWorkspace structural tools (metadata, TOC, create, rename, delete)', () => {
  it('updates OPF metadata and syncs nav.xhtml + toc.ncx as structural proposals', () => {
    const ws = openFixtureWorkspace()

    const metaRes = ws.executeTool('update_metadata', {
      metadata: { title: '修订版书名', creators: ['新作者'] },
    })
    expect(metaRes.ok).toBe(true)

    const tocBefore = ws.executeTool('get_toc').data as { entries: Array<{ label: string; href: string; children: [] }> }
    const nextToc = [{ ...tocBefore.entries[0]!, label: '重命名首章' }, ...tocBefore.entries.slice(1)]
    const tocRes = ws.executeTool('update_toc', { entries: nextToc })
    expect(tocRes.ok).toBe(true)

    const proposal = ws.buildProposal('p-meta-toc')!
    expect(proposal.isStructural).toBe(true)
    expect(proposal.validationIssues).toEqual([])
    expect(proposal.files.some((f) => f.path === ws.getPackage().opfPath)).toBe(true)
    expect(proposal.files.some((f) => f.path === ws.getPackage().navPath)).toBe(true)
    if (ws.getPackage().ncxPath) {
      expect(proposal.files.some((f) => f.path === ws.getPackage().ncxPath)).toBe(true)
    }
  })

  it('creates a new chapter, adds it to spine and TOC, and passes validation', () => {
    const ws = openEmptyWorkspace()
    const created = ws.executeTool('create_chapter', {
      filename: 'epilogue.xhtml',
      title: '后记',
      addToToc: true,
    })
    expect(created.ok).toBe(true)
    expect((created.data as { path: string }).path).toBe('EPUB/text/epilogue.xhtml')

    const proposal = ws.buildProposal('p-create')!
    expect(proposal.isStructural).toBe(true)
    expect(proposal.validationIssues).toEqual([])
    expect(proposal.files.find((f) => f.path === 'EPUB/text/epilogue.xhtml')?.kind).toBe('create')
    expect(ws.getText('EPUB/nav.xhtml')).toContain('后记')
  })

  it('renames a chapter with cascading reference & manifest updates and collapses chained renames', () => {
    const ws = openFixtureWorkspace()
    const firstSpine = (ws.executeTool('list_files').data as { spine: string[] }).spine[1]!

    const rename1 = ws.executeTool('rename_file', { path: firstSpine, newFilename: 'temp-step.xhtml' })
    expect(rename1.ok).toBe(true)

    const midPath = (rename1.data as { path: string }).path
    const rename2 = ws.executeTool('rename_file', { path: midPath, newFilename: 'renamed-chapter.xhtml' })
    expect(rename2.ok).toBe(true)

    const finalPath = (rename2.data as { path: string }).path
    const proposal = ws.buildProposal('p-rename')!
    expect(proposal.isStructural).toBe(true)
    expect(proposal.validationIssues).toEqual([])

    const renamedEntry = proposal.files.find((f) => f.path === finalPath)
    expect(renamedEntry?.kind).toBe('rename')
    expect(renamedEntry?.previousPath).toBe(firstSpine)
    expect(proposal.files.some((f) => f.path === midPath)).toBe(false)
  })

  it('deletes a chapter, prunes TOC, reports broken references, and blocks deleting nav or OPF', () => {
    const ws = openEmptyWorkspace()
    const created = ws.executeTool('create_chapter', { filename: 'extra.xhtml', title: '附录', addToToc: true })
    expect(created.ok).toBe(true)
    const linked = ws.executeTool('edit_file', {
      path: 'EPUB/text/ch001.xhtml',
      oldText: '<p>从这里开始写。</p>',
      newText: '<p><a href="extra.xhtml">见附录</a></p>',
    })
    expect(linked.ok).toBe(true)

    const delExtra = ws.executeTool('delete_file', { path: 'EPUB/text/extra.xhtml' })
    expect(delExtra.ok).toBe(true)
    expect((delExtra.data as { brokenReferencesCreated: Array<{ from: string }> }).brokenReferencesCreated).toEqual([
      expect.objectContaining({ from: 'EPUB/text/ch001.xhtml' }),
    ])

    const ws2 = openEmptyWorkspace()
    const opfDelete = ws2.executeTool('delete_file', { path: ws2.getPackage().opfPath })
    expect(opfDelete.ok).toBe(false)
    const navDelete = ws2.executeTool('delete_file', { path: ws2.getPackage().navPath! })
    expect(navDelete.ok).toBe(false)

    // Delete an existing chapter from the real fixture
    const fixtureWs = openFixtureWorkspace()
    const spine = (fixtureWs.executeTool('list_files').data as { spine: string[] }).spine
    const target = spine[spine.length - 1]!
    const delRes = fixtureWs.executeTool('delete_file', { path: target })
    expect(delRes.ok).toBe(true)

    const proposal = fixtureWs.buildProposal('p-delete')!
    expect(proposal.isStructural).toBe(true)
    expect(proposal.validationIssues).toEqual([])
    expect(proposal.files.find((f) => f.path === target)?.kind).toBe('delete')
  })

  it('supports scan_headings, generate_toc, and incremental edit_toc while keeping MathML intact', () => {
    const ws = openEmptyWorkspace()
    const edited = ws.executeTool('edit_file', {
      path: 'EPUB/text/ch001.xhtml',
      oldText: '<p>从这里开始写。</p>',
      newText: '<h2>第一节</h2><p>正文</p><h3>子节</h3>',
    })
    expect(edited.ok).toBe(true)

    const scanned = ws.executeTool('scan_headings', { levels: [1, 2] })
    expect(scanned.ok).toBe(true)
    expect((scanned.data as { count: number }).count).toBe(2)

    const generated = ws.executeTool('generate_toc', {
      levels: [1, 2, 3],
      mode: 'replace',
      injectMissingIds: true,
    })
    expect(generated.ok).toBe(true)
    const genData = generated.data as { totalCount: number; injectedIdCount: number; brokenAnchors: unknown[] }
    expect(genData.totalCount).toBe(3)
    expect(genData.injectedIdCount).toBe(3)
    expect(genData.brokenAnchors).toEqual([])

    const inserted = ws.executeTool('edit_toc', {
      action: 'insert',
      path: [0],
      position: 'after',
      label: '补丁章节',
      href: 'text/ch001.xhtml',
    })
    expect(inserted.ok).toBe(true)
    expect((inserted.data as { totalCount: number }).totalCount).toBe(4)

    const updated = ws.executeTool('edit_toc', {
      action: 'update',
      path: [1],
      label: '补丁章节改名',
    })
    expect(updated.ok).toBe(true)

    const removed = ws.executeTool('edit_toc', {
      action: 'remove',
      path: [0],
      keepChildren: true,
    })
    expect(removed.ok).toBe(true)
    expect((removed.data as { totalCount: number }).totalCount).toBe(3)

    // Incremental edit_toc on the real fixture keeps untouched inline MathML intact.
    const fixtureWs = openFixtureWorkspace()
    const renameFirst = fixtureWs.executeTool('edit_toc', {
      action: 'update',
      path: [0],
      label: '封面（测试）',
    })
    expect(renameFirst.ok).toBe(true)
    const navAfter = fixtureWs.getText(fixtureWs.getPackage().navPath!)!
    expect(navAfter).toContain('<math')
    expect(fixtureWs.buildProposal('p-toc-inc')?.validationIssues).toEqual([])
  })

  it('supports split_chapter, merge_chapters, create_stylesheet, link_stylesheets, and cleanup_unused_resources', () => {
    const ws = openEmptyWorkspace()
    const ch1 = 'EPUB/text/ch001.xhtml'
    expect(
      ws.executeTool('edit_file', {
        path: ch1,
        oldText: '<p>从这里开始写。</p>',
        newText: '<p>第一部分</p>\n<h2 id="part2">第二部分</h2>\n<p>第二部分正文</p>',
      }).ok,
    ).toBe(true)

    // Split by headingLevel 2
    const splitRes = ws.executeTool('split_chapter', { path: ch1, headingLevel: 2 })
    expect(splitRes.ok).toBe(true)
    const created = (splitRes.data as { createdPaths: string[] }).createdPaths
    expect(created).toEqual(['EPUB/text/ch001_0001.xhtml'])

    // Create a stylesheet and link it to the newly split chapter
    const cssRes = ws.executeTool('create_stylesheet', {
      filename: 'custom.css',
      content: 'h2 { font-weight: 600; }\n',
      linkToChapters: created,
    })
    expect(cssRes.ok).toBe(true)
    const cssPath = (cssRes.data as { path: string }).path
    expect(cssPath).toBe('EPUB/styles/custom.css')
    expect(ws.getText(created[0]!)).toContain('../styles/custom.css')

    // Unlink stylesheet from split chapter so it becomes unused, then clean it up
    const unlinkRes = ws.executeTool('link_stylesheets', {
      chapterPaths: created,
      remove: [cssPath],
    })
    expect(unlinkRes.ok).toBe(true)
    expect(ws.getText(created[0]!)).not.toContain('custom.css')

    const dry = ws.executeTool('cleanup_unused_resources', { dryRun: true })
    expect(dry.ok).toBe(true)
    expect((dry.data as { unused: Array<{ path: string }> }).unused.map((u) => u.path)).toContain(cssPath)

    const cleaned = ws.executeTool('cleanup_unused_resources', { paths: [cssPath] })
    expect(cleaned.ok).toBe(true)
    expect((cleaned.data as { removedPaths: string[] }).removedPaths).toEqual([cssPath])

    // Merge split chapter back into ch001
    const merged = ws.executeTool('merge_chapters', { paths: [ch1, created[0]!] })
    expect(merged.ok).toBe(true)
    expect(ws.getText(ch1)).toContain('第二部分正文')
    expect(ws.getText(created[0]!)).toBeUndefined()

    const proposal = ws.buildProposal('p-struct')!
    expect(proposal.isStructural).toBe(true)
    expect(proposal.validationIssues).toEqual([])
  })

  it('seeds unapplied pending proposals cumulatively, preserves read-only follow-ups, and detects manual drift', () => {
    const ch1 = 'EPUB/text/ch001.xhtml'
    const baseArchive = openEpub(createEmptyEpub({ title: '续聊测试书', author: '原作者' }), codec.parse).archive

    // Turn 1: produces a pending proposal
    const ws1 = AgentWorkspace.fromArchive(baseArchive, { codec, checkXml: strictCheckXml, now: FIXED_NOW })
    expect(
      ws1.executeTool('edit_file', {
        path: ch1,
        oldText: '<p>从这里开始写。</p>',
        newText: '<p>第一处修订。</p>\n<p>第二段待定。</p>',
      }).ok,
    ).toBe(true)
    const pending1 = ws1.buildProposal('p-pending-1')!
    expect(pending1).not.toBeNull()

    // Turn 2a: pure Q&A on top of seeded pending proposal -> sees pending edits, produces null proposal
    const wsReadOnly = AgentWorkspace.fromArchive(baseArchive, { codec, checkXml: strictCheckXml, now: FIXED_NOW })
    expect(wsReadOnly.seedPendingProposal(pending1)).toEqual({ seeded: true, driftedPaths: [] })
    expect(wsReadOnly.hasSeededPendingProposal()).toBe(true)
    expect(wsReadOnly.hasNewMutations()).toBe(false)
    expect(wsReadOnly.getText(ch1)).toContain('第一处修订。')
    expect(wsReadOnly.executeTool('read_file', { path: ch1 }).ok).toBe(true)
    expect(wsReadOnly.buildProposal('p-noop')).toBeNull()

    // Turn 2b: follow-up edit on top of seeded pending proposal -> cumulative diff against real baseline
    const wsFollowUp = AgentWorkspace.fromArchive(baseArchive, { codec, checkXml: strictCheckXml, now: FIXED_NOW })
    expect(wsFollowUp.seedPendingProposal(pending1)).toEqual({ seeded: true, driftedPaths: [] })
    expect(
      wsFollowUp.executeTool('edit_file', {
        path: ch1,
        oldText: '<p>第二段待定。</p>',
        newText: '<p>第二段也已修订。</p>',
      }).ok,
    ).toBe(true)
    expect(wsFollowUp.hasNewMutations()).toBe(true)
    const cumulative = wsFollowUp.buildProposal('p-cumulative')!
    expect(cumulative).not.toBeNull()
    expect(cumulative.files).toHaveLength(1)
    expect(cumulative.files[0]!.beforeText).toContain('<p>从这里开始写。</p>')
    expect(cumulative.files[0]!.afterText).toContain('第一处修订。')
    expect(cumulative.files[0]!.afterText).toContain('第二段也已修订。')

    // Turn 2c: follow-up reverts pending edit completely back to baseline -> null proposal with hasNewMutations=true
    const wsRevert = AgentWorkspace.fromArchive(baseArchive, { codec, checkXml: strictCheckXml, now: FIXED_NOW })
    expect(wsRevert.seedPendingProposal(pending1)).toEqual({ seeded: true, driftedPaths: [] })
    expect(
      wsRevert.executeTool('edit_file', {
        path: ch1,
        oldText: '<p>第一处修订。</p>\n<p>第二段待定。</p>',
        newText: '<p>从这里开始写。</p>',
      }).ok,
    ).toBe(true)
    expect(wsRevert.hasNewMutations()).toBe(true)
    expect(wsRevert.buildProposal('p-reverted')).toBeNull()

    // Turn 2d: user manually edited ch1 -> detects drift and refuses to seed stale proposal
    const wsDrifted = AgentWorkspace.fromArchive(baseArchive, {
      codec,
      checkXml: strictCheckXml,
      now: FIXED_NOW,
      overlay: {
        dirtyTexts: {
          [ch1]: ws1.getText(ch1)!.replace('第一处修订。', '用户手改的内容。'),
        },
      },
    })
    const driftRes = wsDrifted.seedPendingProposal(pending1)
    expect(driftRes.seeded).toBe(false)
    expect(driftRes.driftedPaths).toEqual([ch1])
    expect(wsDrifted.hasSeededPendingProposal()).toBe(false)
    expect(wsDrifted.getText(ch1)).toContain('用户手改的内容。')
  })

  it('builds fast unvalidated snapshots and computes incremental deltas across edits, reverts, and hints', () => {
    const ws = openEmptyWorkspace()
    const ch1 = 'EPUB/text/ch001.xhtml'
    const opfPath = ws.getPackage().opfPath

    // Step 1: edit ch1
    expect(
      ws.executeTool('edit_file', {
        path: ch1,
        oldText: '<p>从这里开始写。</p>',
        newText: '<p>实时第一处。</p>',
      }).ok,
    ).toBe(true)

    const snap1 = ws.buildProposal('live-1', { validate: false })!
    expect(snap1).not.toBeNull()
    expect(snap1.validationIssues).toEqual([])
    const delta1 = diffProposalSnapshots(null, snap1, { hintPaths: [ch1], opfPath })!
    expect(delta1.proposalId).toBe('live-1')
    expect(delta1.isStructural).toBe(false)
    expect(delta1.changedFiles.map((f) => f.path)).toEqual([ch1])
    expect(delta1.removedPaths).toEqual([])
    expect(delta1.focusPath).toBe(ch1)

    // No-op diff against identical snapshot returns null
    expect(diffProposalSnapshots(snap1, snap1, { opfPath })).toBeNull()

    // Step 2: create a second chapter -> structural delta only sends newly changed files, focuses new chapter over OPF
    const created = ws.executeTool('create_chapter', { filename: 'ch002.xhtml', title: '第二章' })
    expect(created.ok).toBe(true)
    const ch2 = (created.data as { path: string }).path

    const snap2 = ws.buildProposal('live-1', { validate: false })!
    const delta2 = diffProposalSnapshots(snap1, snap2, { hintPaths: [opfPath, ch2], opfPath })!
    expect(delta2.isStructural).toBe(true)
    expect(delta2.changedFiles.map((f) => f.path)).toContain(ch2)
    expect(delta2.changedFiles.map((f) => f.path)).toContain(opfPath)
    // Untouched ch1 is not re-sent in delta2
    expect(delta2.changedFiles.map((f) => f.path)).not.toContain(ch1)
    expect(delta2.removedPaths).toEqual([])
    expect(delta2.focusPath).toBe(ch2)

    // Step 3: revert ch1 back to original -> appears in removedPaths
    expect(
      ws.executeTool('edit_file', {
        path: ch1,
        oldText: '<p>实时第一处。</p>',
        newText: '<p>从这里开始写。</p>',
      }).ok,
    ).toBe(true)
    const snap3 = ws.buildProposal('live-1', { validate: false })!
    const delta3 = diffProposalSnapshots(snap2, snap3, { opfPath })!
    expect(delta3.removedPaths).toEqual([ch1])
    expect(delta3.changedFiles).toEqual([])

    // Step 4: seeded pending proposal + edit on a new file -> hintPath keeps focus on newly touched file
    const baseArchive = openEpub(createEmptyEpub({ title: '焦点测试', author: '作者' }), codec.parse).archive
    const seedWs = AgentWorkspace.fromArchive(baseArchive, { codec, checkXml: strictCheckXml, now: FIXED_NOW })
    expect(seedWs.executeTool('create_chapter', { filename: 'ch002.xhtml', title: '第二章' }).ok).toBe(true)
    const seededProposal = seedWs.buildProposal('seed-1')!

    const wsFollow = AgentWorkspace.fromArchive(baseArchive, { codec, checkXml: strictCheckXml, now: FIXED_NOW })
    expect(wsFollow.seedPendingProposal(seededProposal).seeded).toBe(true)
    expect(
      wsFollow.executeTool('edit_file', {
        path: ch1,
        oldText: '<p>从这里开始写。</p>',
        newText: '<p>续聊改动第一章。</p>',
      }).ok,
    ).toBe(true)
    const snapFollow = wsFollow.buildProposal('live-2', { validate: false })!
    const deltaFollow = diffProposalSnapshots(null, snapFollow, { hintPaths: [ch1], opfPath })!
    expect(deltaFollow.focusPath).toBe(ch1)
    expect(deltaFollow.changedFiles.map((f) => f.path)).toContain(ch1)
    expect(deltaFollow.changedFiles.map((f) => f.path)).toContain('EPUB/text/ch002.xhtml')
  })
})

// Minimal valid 2x3 PNG header (8-byte signature + IHDR chunk) for dimension probe tests.
function makeSamplePng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width, false)
  view.setUint32(20, height, false)
  return bytes
}

describe('AgentWorkspace enhanced book-editing toolkit (batch, structure, ergonomics, proofreading & vision)', () => {
  it('supports atomic multi-edit in edit_file with changedRanges and full rollback on failure', () => {
    const ws = openEmptyWorkspace()
    const ch1 = 'EPUB/text/ch001.xhtml'
    expect(
      ws.executeTool('edit_file', {
        path: ch1,
        oldText: '<p>从这里开始写。</p>',
        newText: '<p>第一句旧词。</p>\n<p>第二句旧词。</p>',
      }).ok,
    ).toBe(true)

    // Atomic batch of 2 edits succeeds and returns changedRanges
    const batchOk = ws.executeTool('edit_file', {
      path: ch1,
      edits: [
        { oldText: '第一句旧词', newText: '第一句新词' },
        { oldText: '第二句旧词', newText: '第二句新词' },
      ],
    })
    expect(batchOk.ok).toBe(true)
    const okData = batchOk.data as {
      replacements: number
      editCount: number
      changedRanges: Array<{ editIndex: number; startLine: number; endLine: number }>
    }
    expect(okData.replacements).toBe(2)
    expect(okData.editCount).toBe(2)
    expect(okData.changedRanges).toHaveLength(2)
    expect(okData.changedRanges[0]!.startLine).toBeGreaterThanOrEqual(1)
    expect(ws.getText(ch1)).toContain('第一句新词')
    expect(ws.getText(ch1)).toContain('第二句新词')

    // If second edit fails, first edit must NOT be committed
    const batchFail = ws.executeTool('edit_file', {
      path: ch1,
      edits: [
        { oldText: '第一句新词', newText: '不该生效的词' },
        { oldText: '不存在的句子', newText: 'x' },
      ],
    })
    expect(batchFail.ok).toBe(false)
    expect(batchFail.error).toContain('edits[1].oldText')
    expect(ws.getText(ch1)).not.toContain('不该生效的词')
  })

  it('supports replace_in_book with dryRun, literal $ safety, regex lookarounds/captures, scope, and XML rollback', () => {
    const ws = openEmptyWorkspace()
    const ch1 = 'EPUB/text/ch001.xhtml'
    expect(ws.executeTool('create_chapter', { filename: 'ch002.xhtml', title: '第二章' }).ok).toBe(true)
    const ch2 = 'EPUB/text/ch002.xhtml'
    expect(
      ws.executeTool('edit_file', {
        path: ch1,
        oldText: '<p>从这里开始写。</p>',
        newText: '<p>术语A 和 价格 100 元。</p>',
      }).ok,
    ).toBe(true)
    expect(
      ws.executeTool('edit_file', {
        path: ch2,
        oldText: '<p></p>',
        newText: '<p>术语A 再次出现，价格 200 元。</p>',
      }).ok,
    ).toBe(true)

    // Invalid regex fails fast
    const badRe = ws.executeTool('replace_in_book', { query: '[unclosed', replacement: 'x', regex: true })
    expect(badRe.ok).toBe(false)
    expect(badRe.error).toContain('invalid regular expression')

    // Dry run reports counts & samples without mutating
    const dry = ws.executeTool('replace_in_book', {
      query: '术语A',
      replacement: '术语$1',
      dryRun: true,
    })
    expect(dry.ok).toBe(true)
    const dryData = dry.data as { dryRun: boolean; filesChanged: number; totalReplacements: number }
    expect(dryData.dryRun).toBe(true)
    expect(dryData.filesChanged).toBe(2)
    expect(dryData.totalReplacements).toBe(2)
    expect(ws.getText(ch1)).toContain('术语A')

    // Literal replace preserves literal `$1` without regex expansion
    const literalRes = ws.executeTool('replace_in_book', { query: '术语A', replacement: '术语$1' })
    expect(literalRes.ok).toBe(true)
    expect(ws.getText(ch1)).toContain('术语$1')
    expect(ws.getText(ch2)).toContain('术语$1')

    // Regex replace with lookbehind + capture group works accurately
    const regexRes = ws.executeTool('replace_in_book', {
      query: '(?<=价格 )(\\d+)(?= 元)',
      replacement: '<em>$1</em>',
      regex: true,
    })
    expect(regexRes.ok).toBe(true)
    expect(ws.getText(ch1)).toContain('价格 <em>100</em> 元')
    expect(ws.getText(ch2)).toContain('价格 <em>200</em> 元')

    // XML-breaking replacement rolls back atomically across all files
    const xmlBreak = ws.executeTool('replace_in_book', {
      query: '<em>',
      replacement: '<em><span>',
    })
    expect(xmlBreak.ok).toBe(false)
    expect(xmlBreak.error).toContain('XML')
    expect(ws.getText(ch1)).not.toContain('<span>')
    expect(ws.getText(ch2)).not.toContain('<span>')
  })

  it('supports format_file, reorder_spine, list_anchors, find_references, and scan_headings line numbers', () => {
    const ws = openEmptyWorkspace()
    const ch1 = 'EPUB/text/ch001.xhtml'
    expect(ws.executeTool('create_chapter', { filename: 'ch002.xhtml', title: '第二章' }).ok).toBe(true)
    const ch2 = 'EPUB/text/ch002.xhtml'

    // Write minified single-line XHTML into ch2 and format it via format_file
    const minified =
      '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二章</title></head><body><h1 id="sec2">第二章</h1><p><a name="fn1">注</a>见<a href="ch001.xhtml">第一章</a></p></body></html>'
    expect(ws.executeTool('write_file', { path: ch2, content: minified }).ok).toBe(true)
    expect(ws.getText(ch2)!.split('\n').length).toBe(1)

    const formatted = ws.executeTool('format_file', { paths: [ch2, 'EPUB/styles/stylesheet1.css'] })
    expect(formatted.ok).toBe(true)
    expect((formatted.data as { formattedPaths: string[] }).formattedPaths).toContain(ch2)
    expect(ws.getText(ch2)!.split('\n').length).toBeGreaterThan(5)

    // scan_headings returns accurate 1-based line numbers
    const headings = ws.executeTool('scan_headings')
    expect(headings.ok).toBe(true)
    const h2Entry = (headings.data as { headings: Array<{ path: string; label: string; line?: number }> }).headings.find(
      (h) => h.path === ch2,
    )!
    expect(h2Entry.label).toBe('第二章')
    expect(typeof h2Entry.line).toBe('number')
    expect(ws.getText(ch2)!.split('\n')[h2Entry.line! - 1]).toContain('第二章')

    // list_anchors returns ids and <a name> with line numbers
    const anchors = ws.executeTool('list_anchors', { path: ch2 })
    expect(anchors.ok).toBe(true)
    const anchorItems = (anchors.data as { anchors: Array<{ id: string; tag: string; line?: number }> }).anchors
    expect(anchorItems.map((a) => a.id)).toEqual(['sec2', 'fn1'])
    expect(anchorItems[0]!.line).toBe(h2Entry.line)

    // find_references supports reverse lookup & outgoing lookup
    const incoming = ws.executeTool('find_references', { targetPath: ch1 })
    expect(incoming.ok).toBe(true)
    expect((incoming.data as { references: Array<{ from: string }> }).references.some((r) => r.from === ch2)).toBe(true)

    const outgoing = ws.executeTool('find_references', { fromPath: ch2 })
    expect(outgoing.ok).toBe(true)
    expect(
      (outgoing.data as { references: Array<{ targetPath: string }> }).references.some((r) => r.targetPath === ch1),
    ).toBe(true)

    // reorder_spine reorders spine and rejects unknown paths
    const badReorder = ws.executeTool('reorder_spine', { orderedPaths: ['EPUB/text/missing.xhtml'] })
    expect(badReorder.ok).toBe(false)

    const reordered = ws.executeTool('reorder_spine', { orderedPaths: [ch2, ch1] })
    expect(reordered.ok).toBe(true)
    expect((reordered.data as { spine: string[] }).spine).toEqual([ch2, ch1])
    expect(ws.buildProposal('p-reorder')?.validationIssues).toEqual([])
  })

  it('annotates get_toc with path indices, supports batch edit_toc actions, and aligns create_chapter insertAfter + stylesheets', () => {
    const ws = openEmptyWorkspace()
    const ch1 = 'EPUB/text/ch001.xhtml'

    // Invalid insertAfter fails fast instead of silently appending
    expect(ws.executeTool('create_chapter', { title: '失败章', insertAfter: 'EPUB/text/nope.xhtml' }).ok).toBe(false)

    // Create ch003 at end, then insert ch002 after ch001 with addToToc: true -> inherits stylesheet & aligns TOC!
    expect(ws.executeTool('create_chapter', { filename: 'ch003.xhtml', title: '第三章', addToToc: true }).ok).toBe(true)
    const inserted = ws.executeTool('create_chapter', {
      filename: 'ch002.xhtml',
      title: '第二章',
      insertAfter: ch1,
      addToToc: true,
    })
    expect(inserted.ok).toBe(true)
    expect((inserted.data as { linkedStylesheets: string[] }).linkedStylesheets).toEqual(['EPUB/styles/stylesheet1.css'])
    expect(ws.getText('EPUB/text/ch002.xhtml')).toContain('../styles/stylesheet1.css')

    const toc = ws.executeTool('get_toc')
    expect(toc.ok).toBe(true)
    const tocEntries = (toc.data as { entries: Array<{ path: number[]; label: string }> }).entries
    expect(tocEntries.map((e) => [e.path, e.label])).toEqual([
      [[0], '第一章'],
      [[1], '第二章'],
      [[2], '第三章'],
    ])

    // Batch edit_toc executes sequentially and returns updated annotated entries
    const batchToc = ws.executeTool('edit_toc', {
      actions: [
        { action: 'update', path: [1], label: '第二章（修订）' },
        { action: 'indent', path: [2] },
      ],
    })
    expect(batchToc.ok).toBe(true)
    const batchData = batchToc.data as {
      action: string
      actionCount: number
      entries: Array<{ path: number[]; label: string; children: Array<{ path: number[]; label: string }> }>
    }
    expect(batchData.action).toBe('batch')
    expect(batchData.actionCount).toBe(2)
    expect(batchData.entries[1]!.label).toBe('第二章（修订）')
    expect(batchData.entries[1]!.children[0]!.path).toEqual([1, 0])
  })

  it('supports search_book scope/regex errors, read_file text view & giant single-line pagination, real entrySizes, and inspect_image', () => {
    const { archive } = openEpub(createEmptyEpub({ title: '图文测试书' }), codec.parse)
    // Add an unreferenced binary image (omitted bytes simulating Postgres listWorkspaceEntries) and a referenced PNG + SVG
    const pngBytes = makeSamplePng(320, 240)
    const svgText = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20"/></svg>'
    const encoder = new TextEncoder()
    archive.entries.set('EPUB/images/fig1.png', pngBytes)
    archive.order.push('EPUB/images/fig1.png')
    archive.entries.set('EPUB/images/icon.svg', encoder.encode(svgText))
    archive.order.push('EPUB/images/icon.svg')
    archive.entries.set('EPUB/images/unused.jpg', new Uint8Array(0))
    archive.order.push('EPUB/images/unused.jpg')

    const opf = new TextDecoder().decode(archive.entries.get('EPUB/content.opf')!)
    const nextOpf = opf.replace(
      '</manifest>',
      `  <item id="fig1" href="images/fig1.png" media-type="image/png"/>
    <item id="icon" href="images/icon.svg" media-type="image/svg+xml"/>
    <item id="unused" href="images/unused.jpg" media-type="image/jpeg"/>
  </manifest>`,
    )
    archive.entries.set('EPUB/content.opf', encoder.encode(nextOpf))

    const ws = AgentWorkspace.fromArchive(archive, {
      codec,
      checkXml: strictCheckXml,
      now: FIXED_NOW,
      entrySizes: new Map([['EPUB/images/unused.jpg', 98_765]]),
    })

    // list_files reports true binary entrySizes, stylesheets, and charCount
    const listed = ws.executeTool('list_files').data as {
      stylesheets: string[]
      files: Array<{ path: string; byteSize: number; charCount?: number; stylesheets?: string[] }>
    }
    expect(listed.stylesheets).toEqual(['EPUB/styles/stylesheet1.css'])
    expect(listed.files.find((f) => f.path === 'EPUB/images/unused.jpg')?.byteSize).toBe(98_765)
    const ch1Meta = listed.files.find((f) => f.path === 'EPUB/text/ch001.xhtml')!
    expect(ch1Meta.stylesheets).toEqual(['EPUB/styles/stylesheet1.css'])
    expect(ch1Meta.charCount).toBeGreaterThan(0)

    // cleanup_unused_resources dryRun uses real entrySizes
    const dryUnused = ws.executeTool('cleanup_unused_resources', { dryRun: true }).data as {
      unused: Array<{ path: string; byteSize: number }>
    }
    expect(dryUnused.unused.find((u) => u.path === 'EPUB/images/unused.jpg')?.byteSize).toBe(98_765)

    // search_book fails cleanly on invalid regex and filters by scope
    expect(ws.executeTool('search_book', { query: '(unclosed', regex: true }).ok).toBe(false)
    const styleSearch = ws.executeTool('search_book', { query: 'line-height', scope: 'styles' })
    expect(styleSearch.ok).toBe(true)
    expect((styleSearch.data as { count: number }).count).toBe(1)
    const spineSearch = ws.executeTool('search_book', { query: 'line-height', scope: 'spine' })
    expect((spineSearch.data as { count: number }).count).toBe(0)

    // Put math + img into ch001 and test read_file view: 'text' + inspect_image
    expect(
      ws.executeTool('edit_file', {
        path: 'EPUB/text/ch001.xhtml',
        oldText: '<p>从这里开始写。</p>',
        newText:
          '<p>公式 <math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math> 如图：</p>\n<p><img src="../images/fig1.png" alt="供需曲线图"/></p>',
      }).ok,
    ).toBe(true)

    const textView = ws.executeTool('read_file', { path: 'EPUB/text/ch001.xhtml', view: 'text' })
    expect(textView.ok).toBe(true)
    const textContent = (textView.data as { content: string }).content
    expect(textContent).toContain('[h1] 第一章')
    expect(textContent).toContain('[公式]')
    expect(textContent).toContain('[图片: 供需曲线图]')
    expect(textContent).toMatch(/^L\d+\|/m)

    // inspect_image probes PNG dimensions & referencedBy alt text, and returns SVG source
    expect(probeImageDimensions(pngBytes)).toEqual({ width: 320, height: 240 })
    const pngInfo = ws.executeTool('inspect_image', { path: 'EPUB/images/fig1.png' })
    expect(pngInfo.ok).toBe(true)
    expect(pngInfo.data).toMatchObject({
      path: 'EPUB/images/fig1.png',
      mediaType: 'image/png',
      width: 320,
      height: 240,
      isSvg: false,
      referencedBy: [expect.objectContaining({ from: 'EPUB/text/ch001.xhtml', alt: '供需曲线图' })],
    })

    const svgInfo = ws.executeTool('inspect_image', { path: 'EPUB/images/icon.svg' })
    expect(svgInfo.ok).toBe(true)
    expect((svgInfo.data as { isSvg: boolean; svgContent: string }).isSvg).toBe(true)
    expect((svgInfo.data as { svgContent: string }).svgContent).toContain('<rect')

    // Single-line giant minified chapter (> 24KB) is capped and paginated via charOffset
    const giantLine = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>长章</title></head><body><p>${'甲'.repeat(30_000)}</p></body></html>`
    expect(ws.executeTool('write_file', { path: 'EPUB/text/ch001.xhtml', content: giantLine }).ok).toBe(true)
    const chunk1 = ws.executeTool('read_file', { path: 'EPUB/text/ch001.xhtml', startLine: 1 })
    expect(chunk1.ok).toBe(true)
    const c1 = chunk1.data as { lineTruncated?: boolean; nextCharOffset?: number; content: string; hint?: string }
    expect(c1.lineTruncated).toBe(true)
    expect(c1.content.length).toBeLessThanOrEqual(24_000)
    expect(c1.hint).toContain('format_file')

    const chunk2 = ws.executeTool('read_file', {
      path: 'EPUB/text/ch001.xhtml',
      startLine: 1,
      charOffset: c1.nextCharOffset!,
    })
    expect(chunk2.ok).toBe(true)
    expect((chunk2.data as { lineTruncated?: boolean; content: string }).lineTruncated).toBe(false)
    expect((chunk2.data as { content: string }).content).toContain('</html>')
  })
})
