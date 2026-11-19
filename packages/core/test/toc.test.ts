import { readFileSync } from 'node:fs'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import { openEpub } from '../src'
import { readNavToc, writeNavToc } from '../src/nav'
import { readNcxToc, writeNcxToc } from '../src/ncx'
import { countTocEntries, findBrokenAnchors, flattenToc } from '../src/toc'
import { writeOpfMetadata, DC_NS, OPF_NS } from '../src/opfWrite'
import type { XmlCodec } from '../src/xml'

const codec: XmlCodec = {
  parse: (xml) => new DOMParser().parseFromString(xml, 'application/xml') as unknown as Document,
  serialize: (node) => new XMLSerializer().serializeToString(node as never),
}

const bytes = new Uint8Array(readFileSync(new URL('../../../fixtures/马克思经济学与数理分析.epub', import.meta.url)))
const { archive, pkg } = openEpub(bytes, codec.parse)
const decoder = new TextDecoder('utf-8')
const navXml = decoder.decode(archive.entries.get('EPUB/nav.xhtml'))
const ncxXml = decoder.decode(archive.entries.get('EPUB/toc.ncx'))
const opfXml = decoder.decode(archive.entries.get('EPUB/content.opf'))

describe('navigation document', () => {
  it('reads the nested toc tree', () => {
    const toc = readNavToc(navXml, codec)
    expect(countTocEntries(toc)).toBe(177)
    expect(toc[0]?.label).toBe('封面')
    const flat = flattenToc(toc)
    expect(Math.max(...flat.map(({ depth }) => depth))).toBe(2)
  })

  it('keeps inline MathML in a heading round trip', () => {
    const toc = readNavToc(navXml, codec)
    const withMath = toc.flatMap((entry) => flattenToc([entry])).find(({ entry }) => entry.rawHtml?.includes('<math'))
    expect(withMath).toBeDefined()

    const rebuilt = readNavToc(writeNavToc(navXml, toc, codec), codec)
    const rebuiltWithMath = flattenToc(rebuilt).find(({ entry }) => entry.rawHtml?.includes('<math'))
    expect(rebuiltWithMath?.entry.label).toContain('规定的递推公式')
  })

  it('renames one entry without touching the rest', () => {
    const toc = readNavToc(navXml, codec)
    const target = toc[3]
    expect(target).toBeDefined()
    if (!target) return
    target.label = '新的序言标题'
    target.rawHtml = ''

    const rebuilt = readNavToc(writeNavToc(navXml, toc, codec), codec)
    expect(countTocEntries(rebuilt)).toBe(177)
    expect(rebuilt[3]?.label).toBe('新的序言标题')
    expect(rebuilt[4]?.label).toBe(toc[4]?.label)
  })

  it('drops an entry when it is removed from the tree', () => {
    const toc = readNavToc(navXml, codec)
    toc.splice(3, 1)
    const rebuilt = readNavToc(writeNavToc(navXml, toc, codec), codec)
    expect(countTocEntries(rebuilt)).toBe(176)
  })

  it('detects broken anchors and accepts the real ones', () => {
    const files = new Map<string, string>()
    for (const [path, data] of archive.entries) {
      if (path.endsWith('.xhtml')) files.set(path, decoder.decode(data))
    }
    const toc = readNavToc(navXml, codec)
    expect(findBrokenAnchors(toc, 'EPUB/nav.xhtml', files)).toEqual([])

    const broken = readNavToc(navXml, codec)
    if (broken[0]) broken[0].href = 'text/ch999.xhtml'
    expect(findBrokenAnchors(broken, 'EPUB/nav.xhtml', files)).toHaveLength(1)
  })
})

describe('ncx mirror', () => {
  it('reads the real ncx', () => {
    const toc = readNcxToc(ncxXml, codec)
    expect(countTocEntries(toc)).toBeGreaterThan(100)
    expect(toc[0]?.label).toBe('马克思经济学与数理分析')
  })

  it('mirrors the nav tree into the ncx', () => {
    const toc = readNavToc(navXml, codec)
    const mirrored = readNcxToc(writeNcxToc(ncxXml, toc, codec), codec)
    expect(countTocEntries(mirrored)).toBe(177)
    expect(mirrored[1]?.href).toBe(toc[1]?.href)
  })
})

describe('opf metadata writer', () => {
  it('changes only the fields the form owns', () => {
    const before = {
      uniqueIdentifier: 'urn:uuid:716da389-d18c-486d-80e3-4555054fd727',
      subjects: ['政治经济学', '数理经济学', '马克思经济学'],
    }

    const updated = writeOpfMetadata(
      opfXml,
      {
        title: '新书名',
        creators: ['藤森赖明', '李帮喜'],
        language: 'zh-CN',
        identifier: before.uniqueIdentifier,
        publisher: '社会科学文献出版社',
        date: '2014-10',
        description: '新描述',
        subjects: before.subjects,
        rights: '社会科学文献出版社 2014；电子版仅供个人学习使用',
      },
      codec,
    )

    expect(updated).toContain('<dc:title id="epub-title-1">新书名</dc:title>')
    expect(updated).toContain('unique-identifier="epub-id-1"')
    expect(updated).toContain(before.uniqueIdentifier)
    expect(updated).toContain('refines="#epub-creator-1"')
    expect(updated).toContain('<dc:subject>政治经济学</dc:subject>')
    expect(updated).toContain('properties="mathml"')
  })

  it('adds and removes creators together with their refines metadata', () => {
    const base = {
      title: 'T',
      creators: ['A'],
      language: 'zh-CN',
      identifier: 'id',
      publisher: '',
      date: '',
      description: '',
      subjects: [],
      rights: '',
    }
    const single = codec.parse(writeOpfMetadata(opfXml, base, codec))
    const creators = Array.from(single.getElementsByTagNameNS(DC_NS, 'creator'))
    expect(creators).toHaveLength(1)
    expect(creators[0]?.textContent).toBe('A')
    const droppedRefines = Array.from(single.getElementsByTagNameNS(OPF_NS, 'meta')).filter(
      (meta) => meta.getAttribute('refines') === '#epub-creator-2',
    )
    expect(droppedRefines).toHaveLength(0)

    const three = codec.parse(writeOpfMetadata(opfXml, { ...base, creators: ['A', 'B', 'C'] }, codec))
    expect(three.getElementsByTagNameNS(DC_NS, 'creator')).toHaveLength(3)
  })
})
