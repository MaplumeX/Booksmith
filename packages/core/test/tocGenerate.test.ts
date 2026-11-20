import { readFileSync } from 'node:fs'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import {
  findBrokenAnchors,
  flattenToc,
  generateTocFromHeadings,
  listDocumentAnchors,
  openEpub,
  parsePackage,
  readNavToc,
  refreshTocLabelsFromHeadings,
  scanBookHeadings,
  type TocEntry,
} from '../src'
import type { XmlCodec } from '../src/xml'

const codec: XmlCodec = {
  parse: (xml) => new DOMParser().parseFromString(xml, 'application/xml') as unknown as Document,
  serialize: (node) => new XMLSerializer().serializeToString(node as never),
}

function sampleBook() {
  const opfXml = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:sample</dc:identifier>
    <dc:title>样书</dc:title>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch3" href="text/ch3.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="ch3"/>
  </spine>
</package>`

  const ch1 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>第一章</title></head>
<body>
  <h1 id="toc-1">第一章 总论</h1>
  <h2>第一节 背景</h2>
  <h4 id="deep">细分条目</h4>
</body>
</html>`

  const ch2 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>插图页</title></head>
<body>
  <p id="fig-1">纯插图无标题</p>
</body>
</html>`

  const ch3 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>第二章</title></head>
<body>
  <h2>第二章 进阶</h2>
  <h3>2.1 方法</h3>
  <h4>2.1.1 细节</h4>
</body>
</html>`

  const pkg = parsePackage(opfXml, 'EPUB/content.opf', codec.parse)
  const texts = new Map<string, string>([
    ['EPUB/content.opf', opfXml],
    ['EPUB/nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol/></nav></body></html>'],
    ['EPUB/text/ch1.xhtml', ch1],
    ['EPUB/text/ch2.xhtml', ch2],
    ['EPUB/text/ch3.xhtml', ch3],
  ])
  return { pkg, texts }
}

describe('listDocumentAnchors', () => {
  it('lists ids and anchor names in document order', () => {
    const xhtml = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
      <h1 id="intro">引言</h1>
      <p><a name="note1">注1</a></p>
      <h2 id="intro">重复不收录</h2>
    </body></html>`
    expect(listDocumentAnchors(xhtml, codec)).toEqual([
      { id: 'intro', tag: 'h1', label: '引言' },
      { id: 'note1', tag: 'a', label: '注1' },
    ])
  })
})

describe('scanBookHeadings & generateTocFromHeadings', () => {
  it('filters selected levels and collapses skipped levels cleanly (e.g. h2 + h4)', () => {
    const { pkg, texts } = sampleBook()
    const scanned = scanBookHeadings(pkg, texts, codec, { levels: [2, 4] })
    expect(scanned.map((h) => [h.level, h.label])).toEqual([
      [2, '第一节 背景'],
      [4, '细分条目'],
      [2, '第二章 进阶'],
      [4, '2.1.1 细节'],
    ])

    const generated = generateTocFromHeadings(pkg, texts, 'EPUB/nav.xhtml', codec, {
      levels: [2, 4],
      injectMissingIds: true,
      mode: 'replace',
    })
    expect(generated.entries.map((e) => e.label)).toEqual(['第一节 背景', '第二章 进阶'])
    expect(generated.entries[0]?.children.map((e) => e.label)).toEqual(['细分条目'])
    expect(generated.entries[1]?.children.map((e) => e.label)).toEqual(['2.1.1 细节'])
  })

  it('injects non-colliding ids into missing-id headings and keeps all anchors valid', () => {
    const { pkg, texts } = sampleBook()
    const generated = generateTocFromHeadings(pkg, texts, 'EPUB/nav.xhtml', codec, {
      levels: [1, 2, 3],
      injectMissingIds: true,
      mode: 'replace',
    })
    // ch1 already has id="toc-1", so the injected h2 id must skip toc-1 -> toc-2.
    expect(generated.injectedIdCount).toBe(3)
    expect(generated.updatedChapters.size).toBe(2)
    expect(generated.entries[0]?.href).toBe('text/ch1.xhtml#toc-1')
    expect(generated.entries[0]?.children[0]?.href).toBe('text/ch1.xhtml#toc-2')

    const mergedFiles = new Map(texts)
    for (const [path, content] of generated.updatedChapters) mergedFiles.set(path, content)
    expect(findBrokenAnchors(generated.entries, 'EPUB/nav.xhtml', mergedFiles)).toEqual([])
  })

  it('does not modify chapter files when injectMissingIds is false', () => {
    const { pkg, texts } = sampleBook()
    const generated = generateTocFromHeadings(pkg, texts, 'EPUB/nav.xhtml', codec, {
      levels: [1, 2],
      injectMissingIds: false,
      mode: 'replace',
    })
    expect(generated.injectedIdCount).toBe(0)
    expect(generated.updatedChapters.size).toBe(0)
    expect(generated.entries[0]?.children[0]?.href).toBe('text/ch1.xhtml')
  })

  it('includes untitled spine chapters when requested', () => {
    const { pkg, texts } = sampleBook()
    const generated = generateTocFromHeadings(pkg, texts, 'EPUB/nav.xhtml', codec, {
      levels: [1, 2],
      includeUntitledSpine: true,
      injectMissingIds: false,
      mode: 'replace',
    })
    expect(generated.entries.map((e) => e.label)).toEqual(['第一章 总论', '插图页'])
    expect(generated.entries[1]?.href).toBe('text/ch2.xhtml')
  })

  it('append_missing keeps existing manual labels, MathML rawHtml, and custom hierarchy untouched', () => {
    const { pkg, texts } = sampleBook()
    const existing: TocEntry[] = [
      {
        label: '自定义第一章',
        href: 'text/ch1.xhtml#toc-1',
        rawHtml: '自定义<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math>',
        children: [],
      },
    ]
    const generated = generateTocFromHeadings(pkg, texts, 'EPUB/nav.xhtml', codec, {
      levels: [1, 2],
      injectMissingIds: true,
      mode: 'append_missing',
      existingEntries: existing,
    })
    expect(generated.entries[0]?.label).toBe('自定义第一章')
    expect(generated.entries[0]?.rawHtml).toContain('<math')
    expect(generated.entries.slice(1).map((e) => e.label)).toEqual(['第一节 背景', '第二章 进阶'])
  })
})

describe('refreshTocLabelsFromHeadings', () => {
  it('updates plain headings from chapter content while skipping MathML entries by default', () => {
    const { texts } = sampleBook()
    const current: TocEntry[] = [
      { label: '旧标题', href: 'text/ch1.xhtml#toc-1', rawHtml: '', children: [] },
      {
        label: '公式标题',
        href: 'text/ch1.xhtml#deep',
        rawHtml: '公式 <math xmlns="http://www.w3.org/1998/Math/MathML"><mi>a</mi></math>',
        children: [],
      },
    ]
    const refreshed = refreshTocLabelsFromHeadings(current, 'EPUB/nav.xhtml', texts, codec)
    expect(refreshed.updatedCount).toBe(1)
    expect(refreshed.skippedRichCount).toBe(1)
    expect(refreshed.entries[0]?.label).toBe('第一章 总论')
    expect(refreshed.entries[1]?.label).toBe('公式标题')
    expect(refreshed.entries[1]?.rawHtml).toContain('<math')
  })

  it('round-trips cleanly on the real MathML fixture book', () => {
    const bytes = new Uint8Array(readFileSync(new URL('../../../fixtures/马克思经济学与数理分析.epub', import.meta.url)))
    const { archive, pkg } = openEpub(bytes, codec.parse)
    const decoder = new TextDecoder('utf-8')
    const texts = new Map<string, string>()
    for (const [path, data] of archive.entries) {
      if (/\.(xhtml|html|opf|ncx|xml)$/i.test(path)) texts.set(path, decoder.decode(data))
    }
    const navXml = texts.get(pkg.navPath!)!
    const existing = readNavToc(navXml, codec)
    const generated = generateTocFromHeadings(pkg, texts, pkg.navPath!, codec, {
      levels: [1, 2, 3],
      injectMissingIds: true,
      mode: 'append_missing',
      existingEntries: existing,
    })
    // Existing MathML entries are preserved verbatim in append_missing mode.
    const mathEntries = flattenToc(generated.entries).filter(({ entry }) => entry.rawHtml?.includes('<math'))
    expect(mathEntries.length).toBeGreaterThan(0)
    // Any chapter updated with injected ids still parses cleanly as XML.
    for (const [, updatedXml] of generated.updatedChapters) {
      expect(() => codec.parse(updatedXml)).not.toThrow()
    }
  })
})
