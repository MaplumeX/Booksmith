import { describe, expect, it } from 'vitest'
import { openEpub, validateStructure } from '../src'
import { nodeXmlParser, readFixture } from './helpers'

const bytes = readFixture()
const { archive, pkg } = openEpub(bytes, nodeXmlParser)

describe('real book structure', () => {
  it('unpacks 55 entries with mimetype first', () => {
    expect(archive.order).toHaveLength(55)
    expect(archive.order[0]).toBe('mimetype')
  })

  it('reads the package document', () => {
    expect(pkg.opfPath).toBe('EPUB/content.opf')
    expect(pkg.version).toBe('3.0')
    expect(pkg.manifest).toHaveLength(51)
    expect(pkg.spine).toHaveLength(28)
    expect(pkg.spine).toContain('nav')
  })

  it('discovers both navigation documents', () => {
    expect(pkg.navPath).toBe('EPUB/nav.xhtml')
    expect(pkg.ncxPath).toBe('EPUB/toc.ncx')
  })

  it('extracts metadata', () => {
    expect(pkg.metadata.title).toBe('马克思经济学与数理分析')
    expect(pkg.metadata.language).toBe('zh-CN')
    expect(pkg.metadata.creators).toEqual(['藤森赖明', '李帮喜'])
    expect(pkg.metadata.identifier).toMatch(/^urn:uuid:/)
  })

  it('resolves manifest hrefs to archive paths', () => {
    const chapter = pkg.manifest.find((item) => item.href === 'text/ch010.xhtml')
    expect(chapter?.path).toBe('EPUB/text/ch010.xhtml')
    expect(archive.entries.has('EPUB/text/ch010.xhtml')).toBe(true)
  })

  it('counts inline MathML in the heaviest chapter', () => {
    const text = new TextDecoder().decode(archive.entries.get('EPUB/text/ch010.xhtml'))
    expect((text.match(/<math/g) ?? []).length).toBe(328)
  })

  it('passes structural validation', () => {
    expect(validateStructure(archive, pkg)).toEqual([])
  })
})
