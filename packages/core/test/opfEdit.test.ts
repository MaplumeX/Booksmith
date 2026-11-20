import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import { createEmptyEpub, openEpub, parsePackage } from '../src'
import {
  addSpineDocument,
  removeManifestEntry,
  renameManifestEntry,
  reorderSpine,
  setManifestMediaType,
} from '../src/opfEdit'
import type { XmlCodec } from '../src/xml'

const codec: XmlCodec = {
  parse: (xml) => new DOMParser().parseFromString(xml, 'application/xml') as unknown as Document,
  serialize: (node) => new XMLSerializer().serializeToString(node as never),
}

const decoder = new TextDecoder('utf-8')

/** The empty-book package: one chapter (`EPUB/text/ch001.xhtml`), nav and stylesheet. */
function emptyBookOpf(): { opf: string; baseDir: string } {
  const { archive, pkg } = openEpub(createEmptyEpub({ title: '结构测试' }), codec.parse)
  return { opf: decoder.decode(archive.entries.get(pkg.opfPath)), baseDir: 'EPUB' }
}

const chapter = (id: string, href: string) => ({ id, href, mediaType: 'application/xhtml+xml' })

describe('addSpineDocument', () => {
  it('adds a manifest item and appends it to the spine', () => {
    const { opf } = emptyBookOpf()
    const next = addSpineDocument(opf, chapter('ch002', 'text/ch002.xhtml'), codec)
    const pkg = parsePackage(next, 'EPUB/content.opf', codec.parse)

    expect(pkg.manifest.map((item) => item.path)).toContain('EPUB/text/ch002.xhtml')
    expect(pkg.spine).toEqual(['ch001', 'ch002'])
  })

  it('disambiguates a duplicate id and still appends that item', () => {
    const { opf } = emptyBookOpf()
    const next = addSpineDocument(opf, chapter('ch001', 'text/ch002.xhtml'), codec)
    const pkg = parsePackage(next, 'EPUB/content.opf', codec.parse)

    expect(pkg.spine).toHaveLength(2)
    expect(pkg.spine[1]).toBe('ch001_1')
  })

  it('leaves the table of contents untouched', () => {
    const { opf } = emptyBookOpf()
    const next = addSpineDocument(opf, chapter('ch002', 'text/ch002.xhtml'), codec)
    expect(next).not.toContain('ch002.xhtml</a>')
  })
})

describe('renameManifestEntry', () => {
  it('rewrites the href and keeps the spine idref', () => {
    const { opf, baseDir } = emptyBookOpf()
    const next = renameManifestEntry(opf, 'EPUB/text/ch001.xhtml', 'text/ch001-intro.xhtml', baseDir, codec)
    const pkg = parsePackage(next, 'EPUB/content.opf', codec.parse)

    expect(pkg.manifest.some((item) => item.path === 'EPUB/text/ch001-intro.xhtml')).toBe(true)
    expect(pkg.manifest.some((item) => item.path === 'EPUB/text/ch001.xhtml')).toBe(false)
    expect(pkg.spine).toEqual(['ch001'])
  })

  it('only touches the entry whose path matches', () => {
    const { opf, baseDir } = emptyBookOpf()
    const withNeighbour = addSpineDocument(opf, chapter('ch0010', 'text/ch0010.xhtml'), codec)
    const next = renameManifestEntry(
      withNeighbour,
      'EPUB/text/ch001.xhtml',
      'text/ch001-renamed.xhtml',
      baseDir,
      codec,
    )
    const pkg = parsePackage(next, 'EPUB/content.opf', codec.parse)

    expect(pkg.manifest.map((item) => item.path).sort()).toEqual([
      'EPUB/nav.xhtml',
      'EPUB/styles/stylesheet1.css',
      'EPUB/text/ch001-renamed.xhtml',
      'EPUB/text/ch0010.xhtml',
    ])
  })

  it('throws when no entry matches', () => {
    const { opf, baseDir } = emptyBookOpf()
    expect(() => renameManifestEntry(opf, 'EPUB/text/missing.xhtml', 'text/x.xhtml', baseDir, codec)).toThrow(
      /no entry/,
    )
  })
})

describe('removeManifestEntry', () => {
  it('drops the item and its spine reference', () => {
    const { opf, baseDir } = emptyBookOpf()
    const next = removeManifestEntry(opf, 'EPUB/text/ch001.xhtml', baseDir, codec)
    const pkg = parsePackage(next, 'EPUB/content.opf', codec.parse)

    expect(pkg.spine).toEqual([])
    expect(pkg.manifest.some((item) => item.path === 'EPUB/text/ch001.xhtml')).toBe(false)
  })

  it('clears spine@toc when the NCX it names is removed', () => {
    const { opf, baseDir } = emptyBookOpf()
    const withNcx = opf
      .replace('</manifest>', '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest>')
      .replace('<spine>', '<spine toc="ncx">')
    const next = removeManifestEntry(withNcx, 'EPUB/toc.ncx', baseDir, codec)

    expect(next).not.toContain('toc="ncx"')
  })

  it('throws when no entry matches', () => {
    const { opf, baseDir } = emptyBookOpf()
    expect(() => removeManifestEntry(opf, 'EPUB/text/missing.xhtml', baseDir, codec)).toThrow(/no entry/)
  })
})

describe('reorderSpine', () => {
  it('follows the given path order', () => {
    const { opf, baseDir } = emptyBookOpf()
    const withTwo = addSpineDocument(opf, chapter('ch002', 'text/ch002.xhtml'), codec)
    const withThree = addSpineDocument(withTwo, chapter('ch003', 'text/ch003.xhtml'), codec)

    const next = reorderSpine(
      withThree,
      ['EPUB/text/ch003.xhtml', 'EPUB/text/ch001.xhtml', 'EPUB/text/ch002.xhtml'],
      baseDir,
      codec,
    )
    expect(parsePackage(next, 'EPUB/content.opf', codec.parse).spine).toEqual(['ch003', 'ch001', 'ch002'])
  })

  it('keeps unlisted entries in their original relative order at the end', () => {
    const { opf, baseDir } = emptyBookOpf()
    const withTwo = addSpineDocument(opf, chapter('ch002', 'text/ch002.xhtml'), codec)
    const withThree = addSpineDocument(withTwo, chapter('ch003', 'text/ch003.xhtml'), codec)

    const next = reorderSpine(withThree, ['EPUB/text/ch002.xhtml'], baseDir, codec)
    expect(parsePackage(next, 'EPUB/content.opf', codec.parse).spine).toEqual(['ch002', 'ch001', 'ch003'])
  })

  it('ignores paths that are not in the manifest', () => {
    const { opf, baseDir } = emptyBookOpf()
    const next = reorderSpine(opf, ['EPUB/text/nope.xhtml'], baseDir, codec)
    expect(parsePackage(next, 'EPUB/content.opf', codec.parse).spine).toEqual(['ch001'])
  })
})

describe('setManifestMediaType', () => {
  it('returns the original xml verbatim when media-type is already identical', () => {
    const { opf, baseDir } = emptyBookOpf()
    const next = setManifestMediaType(opf, 'EPUB/text/ch001.xhtml', 'application/xhtml+xml', baseDir, codec)
    expect(next).toBe(opf)
  })

  it('updates media-type when it differs from the manifest value', () => {
    const { opf, baseDir } = emptyBookOpf()
    const next = setManifestMediaType(opf, 'EPUB/styles/stylesheet1.css', 'text/plain', baseDir, codec)
    expect(next).not.toBe(opf)
    expect(parsePackage(next, 'EPUB/content.opf', codec.parse).manifest.find((i) => i.path === 'EPUB/styles/stylesheet1.css')?.mediaType).toBe('text/plain')
  })
})
