import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import { initializeBookToc, parsePackage, readNavToc, readNcxToc, writeNavToc, writeNcxToc } from '../src'
import type { XmlCodec } from '../src/xml'

const codec: XmlCodec = {
  parse: (xml) => new DOMParser().parseFromString(xml, 'application/xml') as unknown as Document,
  serialize: (node) => new XMLSerializer().serializeToString(node as never),
}

function makeOpf(version: '3.0' | '2.0'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${version}" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:test</dc:identifier>
    <dc:title>测试书稿</dc:title>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
  </spine>
</package>`
}

describe('initializeBookToc', () => {
  it('creates nav.xhtml with properties="nav" for an EPUB 3 package lacking TOC', () => {
    const opfXml = makeOpf('3.0')
    const pkg = parsePackage(opfXml, 'EPUB/content.opf', codec.parse)
    expect(pkg.navPath).toBeUndefined()
    expect(pkg.ncxPath).toBeUndefined()

    const texts = new Map<string, string>([
      ['EPUB/content.opf', opfXml],
      ['EPUB/text/ch1.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>一</h1></body></html>'],
    ])
    const init = initializeBookToc(pkg, texts, codec)
    expect(init.created).toBe(true)
    expect(init.kind).toBe('nav')
    expect(init.tocPath).toBe('EPUB/nav.xhtml')

    const nextPkg = parsePackage(init.opfXml, 'EPUB/content.opf', codec.parse)
    expect(nextPkg.navPath).toBe('EPUB/nav.xhtml')
    expect(readNavToc(init.tocContent, codec)).toEqual([])

    const written = writeNavToc(init.tocContent, [{ label: '第一章', href: 'text/ch1.xhtml', children: [] }], codec)
    expect(readNavToc(written, codec)[0]?.label).toBe('第一章')
  })

  it('creates toc.ncx and sets spine@toc for an EPUB 2 package lacking TOC', () => {
    const opfXml = makeOpf('2.0')
    const pkg = parsePackage(opfXml, 'OEBPS/content.opf', codec.parse)
    const texts = new Map<string, string>([['OEBPS/content.opf', opfXml]])

    const init = initializeBookToc(pkg, texts, codec)
    expect(init.created).toBe(true)
    expect(init.kind).toBe('ncx')
    expect(init.tocPath).toBe('OEBPS/toc.ncx')

    const nextPkg = parsePackage(init.opfXml, 'OEBPS/content.opf', codec.parse)
    expect(nextPkg.ncxPath).toBe('OEBPS/toc.ncx')
    expect(readNcxToc(init.tocContent, codec)).toEqual([])

    const written = writeNcxToc(init.tocContent, [{ label: '第一章', href: 'text/ch1.xhtml', children: [] }], codec)
    expect(readNcxToc(written, codec)[0]?.label).toBe('第一章')
  })

  it('avoids filename collisions if an unregistered nav.xhtml already exists', () => {
    const opfXml = makeOpf('3.0')
    const pkg = parsePackage(opfXml, 'EPUB/content.opf', codec.parse)
    const texts = new Map<string, string>([
      ['EPUB/content.opf', opfXml],
      ['EPUB/nav.xhtml', '<html/>'],
    ])
    const init = initializeBookToc(pkg, texts, codec)
    expect(init.tocPath).toBe('EPUB/nav-1.xhtml')
  })
})
