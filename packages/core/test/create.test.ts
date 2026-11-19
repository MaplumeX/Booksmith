import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import { addManifestItem, createEmptyEpub, openEpub, validateStructure } from '../src'
import type { XmlCodec } from '../src/xml'

const codec: XmlCodec = {
  parse: (xml) => new DOMParser().parseFromString(xml, 'application/xml') as unknown as Document,
  serialize: (node) => new XMLSerializer().serializeToString(node as never),
}

describe('new book', () => {
  it('produces a package that passes structural validation', () => {
    const bytes = createEmptyEpub({ title: '测试书', author: '我', language: 'zh-CN' })
    const { archive, pkg } = openEpub(bytes, codec.parse)
    expect(archive.order[0]).toBe('mimetype')
    expect(pkg.version).toBe('3.0')
    expect(pkg.metadata.title).toBe('测试书')
    expect(pkg.metadata.creators).toEqual(['我'])
    expect(pkg.spine).toHaveLength(1)
    expect(pkg.navPath).toBe('EPUB/nav.xhtml')
    expect(validateStructure(archive, pkg)).toEqual([])
  })

  it('escapes the title', () => {
    const bytes = createEmptyEpub({ title: 'A & B <c>' })
    const { pkg } = openEpub(bytes, codec.parse)
    expect(pkg.metadata.title).toBe('A & B <c>')
  })
})

describe('manifest import', () => {
  it('adds an item and keeps existing ones', () => {
    const bytes = createEmptyEpub({ title: 'x' })
    const { pkg, archive } = openEpub(bytes, codec.parse)
    const opf = new TextDecoder().decode(archive.entries.get(pkg.opfPath))

    const updated = addManifestItem(
      opf,
      { id: 'img_cover', href: 'media/cover.jpg', mediaType: 'image/jpeg' },
      codec,
    )
    const doc = codec.parse(updated)
    const items = Array.from(doc.getElementsByTagName('item'))
    expect(items).toHaveLength(4)
    expect(items.some((item) => item.getAttribute('href') === 'media/cover.jpg')).toBe(true)
    expect(items.some((item) => item.getAttribute('properties') === 'nav')).toBe(true)
  })

  it('disambiguates duplicate ids', () => {
    const bytes = createEmptyEpub({ title: 'x' })
    const { pkg, archive } = openEpub(bytes, codec.parse)
    const opf = new TextDecoder().decode(archive.entries.get(pkg.opfPath))
    const once = addManifestItem(opf, { id: 'nav', href: 'a.png', mediaType: 'image/png' }, codec)
    const twice = addManifestItem(once, { id: 'nav', href: 'b.png', mediaType: 'image/png' }, codec)
    const ids = Array.from(codec.parse(twice).getElementsByTagName('item')).map((item) => item.getAttribute('id'))
    expect(new Set(ids).size).toBe(ids.length)
  })
})
