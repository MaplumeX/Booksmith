import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import { createEmptyEpub, isTextEntry, openEpub, parsePackage } from '../src'
import { addManifestItem } from '../src/opfWrite'
import { lintBook } from '../src/lint'
import type { EpubArchive, EpubPackage } from '../src/types'
import type { XmlCodec } from '../src/xml'

const codec: XmlCodec = {
  parse: (xml) => new DOMParser().parseFromString(xml, 'application/xml') as unknown as Document,
  serialize: (node) => new XMLSerializer().serializeToString(node as never),
}

const decoder = new TextDecoder()
const encoder = new TextEncoder()

interface Fixture {
  files: Map<string, string>
  pkg: EpubPackage
  archive: EpubArchive
}

function open(): Fixture {
  const { archive, pkg } = openEpub(createEmptyEpub({ title: '检查测试' }), codec.parse)
  return { files: decode(archive), pkg, archive }
}

function decode(archive: EpubArchive): Map<string, string> {
  const files = new Map<string, string>()
  for (const [path, bytes] of archive.entries) {
    if (isTextEntry(path)) files.set(path, decoder.decode(bytes))
  }
  return files
}

/** Re-reads the OPF after a test edit, the way the editor does after a structural change. */
function reparse(fixture: Fixture): void {
  fixture.pkg = parsePackage(fixture.files.get(fixture.pkg.opfPath) ?? '', fixture.pkg.opfPath, codec.parse)
}

const codes = (issues: ReturnType<typeof lintBook>): string[] => issues.map((issue) => issue.code)

describe('lintBook', () => {
  it('reports nothing for a fresh book', () => {
    const { files, pkg, archive } = open()
    expect(lintBook(files, pkg, archive, codec)).toEqual([])
  })

  it('reports a reference to a file the archive does not contain', () => {
    const fixture = open()
    const chapter = 'EPUB/text/ch001.xhtml'
    fixture.files.set(
      chapter,
      (fixture.files.get(chapter) ?? '').replace('<p>从这里开始写。</p>', '<p>图</p><img src="../images/missing.png"/>'),
    )

    const issues = lintBook(fixture.files, fixture.pkg, fixture.archive, codec)
    expect(codes(issues)).toEqual(['broken-reference'])
    expect(issues[0]?.path).toBe(chapter)
    expect(issues[0]?.line).toBeGreaterThan(1)
  })

  it('reports a manifest resource nothing points at', () => {
    const fixture = open()
    const opfPath = fixture.pkg.opfPath
    fixture.files.set(
      opfPath,
      addManifestItem(
        fixture.files.get(opfPath) ?? '',
        { id: 'lonely', href: 'media/lonely.png', mediaType: 'image/png' },
        codec,
      ),
    )
    fixture.archive.entries.set('EPUB/media/lonely.png', encoder.encode('not really a png'))
    reparse(fixture)
    expect(fixture.pkg.manifest.map((item) => item.path)).toContain('EPUB/media/lonely.png')
    expect([...fixture.archive.entries.keys()]).toContain('EPUB/media/lonely.png')

    const issues = lintBook(fixture.files, fixture.pkg, fixture.archive, codec)
    expect(codes(issues)).toEqual(['unused-resource'])
    expect(issues[0]?.path).toBe('EPUB/media/lonely.png')
  })

  it('does not warn about a resource that a chapter references', () => {
    const fixture = open()
    const opfPath = fixture.pkg.opfPath
    fixture.files.set(
      opfPath,
      addManifestItem(
        fixture.files.get(opfPath) ?? '',
        { id: 'used', href: 'media/used.png', mediaType: 'image/png' },
        codec,
      ),
    )
    fixture.archive.entries.set('EPUB/media/used.png', encoder.encode('not really a png'))
    const chapter = 'EPUB/text/ch001.xhtml'
    fixture.files.set(
      chapter,
      (fixture.files.get(chapter) ?? '').replace('</body>', '<img src="../media/used.png"/></body>'),
    )
    reparse(fixture)

    expect(lintBook(fixture.files, fixture.pkg, fixture.archive, codec)).toEqual([])
  })

  it('reports an empty reading order', () => {
    const fixture = open()
    const opfPath = fixture.pkg.opfPath
    fixture.files.set(opfPath, (fixture.files.get(opfPath) ?? '').replace('<itemref idref="ch001"/>', ''))
    reparse(fixture)

    expect(codes(lintBook(fixture.files, fixture.pkg, fixture.archive, codec))).toEqual(['empty-spine'])
  })

  it('reports a toc entry whose fragment is gone', () => {
    const fixture = open()
    const navPath = fixture.pkg.navPath ?? 'EPUB/nav.xhtml'
    fixture.files.set(
      navPath,
      (fixture.files.get(navPath) ?? '').replace('text/ch001.xhtml', 'text/ch001.xhtml#nowhere'),
    )

    const issues = lintBook(fixture.files, fixture.pkg, fixture.archive, codec)
    expect(codes(issues)).toEqual(['broken-anchor'])
    expect(issues[0]?.path).toBe(navPath)
  })

  it('does not complain about a toc entry that keeps its anchor', () => {
    const fixture = open()
    const navPath = fixture.pkg.navPath ?? 'EPUB/nav.xhtml'
    fixture.files.set(
      navPath,
      (fixture.files.get(navPath) ?? '').replace('text/ch001.xhtml', 'text/ch001.xhtml#top'),
    )
    const chapter = 'EPUB/text/ch001.xhtml'
    fixture.files.set(chapter, (fixture.files.get(chapter) ?? '').replace('<h1>', '<h1 id="top">'))

    expect(lintBook(fixture.files, fixture.pkg, fixture.archive, codec)).toEqual([])
  })
})
