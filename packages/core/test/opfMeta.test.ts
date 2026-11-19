import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import { readOpfMeta, touchOpfModified, writeOpfMeta } from '../src/opfWrite'
import type { XmlCodec } from '../src/xml'

const codec: XmlCodec = {
  parse: (xml) => new DOMParser().parseFromString(xml, 'application/xml') as unknown as Document,
  serialize: (node) => new XMLSerializer().serializeToString(node as never),
}

const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:1</dc:identifier>
    <dc:title>书</dc:title>
    <dc:creator id="creator">某人</dc:creator>
    <meta property="dcterms:modified">2026-11-19T00:00:00Z</meta>
    <meta property="role" refines="#creator">aut</meta>
    <meta name="cover" content="cover-image"/>
  </metadata>
  <manifest/>
  <spine/>
</package>
`

describe('readOpfMeta', () => {
  it('reads property, legacy name and refines rows', () => {
    expect(readOpfMeta(OPF, codec)).toEqual([
      { property: 'dcterms:modified', refines: '', value: '2026-11-19T00:00:00Z' },
      { property: 'role', refines: '#creator', value: 'aut' },
      { property: 'cover', refines: '', value: 'cover-image' },
    ])
  })
})

describe('writeOpfMeta', () => {
  it('updates a value without touching the other rows', () => {
    const rows = readOpfMeta(OPF, codec).map((row) =>
      row.property === 'role' ? { ...row, value: 'edt' } : row,
    )
    const next = writeOpfMeta(OPF, rows, codec)

    expect(readOpfMeta(next, codec)).toEqual([
      { property: 'dcterms:modified', refines: '', value: '2026-11-19T00:00:00Z' },
      { property: 'role', refines: '#creator', value: 'edt' },
      { property: 'cover', refines: '', value: 'cover-image' },
    ])
  })

  it('adds a row as an EPUB 3 property', () => {
    const rows = [...readOpfMeta(OPF, codec), { property: 'ibooks:specified-fonts', refines: '', value: 'true' }]
    const next = writeOpfMeta(OPF, rows, codec)
    const doc = codec.parse(next)

    const added = Array.from(doc.getElementsByTagName('meta')).find(
      (element) => element.getAttribute('property') === 'ibooks:specified-fonts',
    )
    expect(added?.textContent).toBe('true')
  })

  it('adds a legacy row as name + content', () => {
    const rows = [...readOpfMeta(OPF, codec), { property: 'fixed-layout', refines: '', value: 'true' }]
    const doc = codec.parse(writeOpfMeta(OPF, rows, codec))
    const added = Array.from(doc.getElementsByTagName('meta')).find(
      (element) => element.getAttribute('name') === 'fixed-layout',
    )
    expect(added?.getAttribute('content')).toBe('true')
  })

  it('drops rows the user removed', () => {
    const rows = readOpfMeta(OPF, codec).filter((row) => row.property !== 'role')
    expect(readOpfMeta(writeOpfMeta(OPF, rows, codec), codec).map((row) => row.property)).toEqual([
      'dcterms:modified',
      'cover',
    ])
  })

  it('ignores rows with an empty property', () => {
    const rows = [...readOpfMeta(OPF, codec), { property: '  ', refines: '', value: 'x' }]
    expect(readOpfMeta(writeOpfMeta(OPF, rows, codec), codec)).toHaveLength(3)
  })

  it('keeps the dc elements untouched', () => {
    const next = writeOpfMeta(OPF, readOpfMeta(OPF, codec), codec)
    expect(next).toContain('<dc:creator id="creator">某人</dc:creator>')
  })
})

describe('touchOpfModified', () => {
  it('rewrites the timestamp', () => {
    const next = touchOpfModified(OPF, '2026-11-20T10:00:00Z', codec)
    const row = readOpfMeta(next, codec).find((entry) => entry.property === 'dcterms:modified')
    expect(row?.value).toBe('2026-11-20T10:00:00Z')
  })

  it('returns the input unchanged when the timestamp already matches', () => {
    expect(touchOpfModified(OPF, '2026-11-19T00:00:00Z', codec)).toBe(OPF)
  })

  it('returns the input unchanged when the book has no dcterms:modified', () => {
    const without = OPF.replace('<meta property="dcterms:modified">2026-11-19T00:00:00Z</meta>', '')
    expect(touchOpfModified(without, '2026-11-20T10:00:00Z', codec)).toBe(without)
  })
})
