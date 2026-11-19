import { describe, expect, it } from 'vitest'
import { openEpub, unzipArchive, zipArchive } from '../src'
import { firstEntryCompression, firstEntryName, nodeXmlParser, readFixture } from './helpers'

const original = readFixture()

describe('archive round trip', () => {
  it('keeps every entry byte-identical and in the same order', () => {
    const { archive } = openEpub(original, nodeXmlParser)
    const repacked = zipArchive(archive)
    const again = unzipArchive(repacked)

    expect(again.order).toEqual(archive.order)
    for (const [path, bytes] of archive.entries) {
      expect(again.entries.get(path), path).toEqual(bytes)
    }
  })

  it('writes mimetype first and uncompressed', () => {
    const { archive } = openEpub(original, nodeXmlParser)
    const repacked = zipArchive(archive)
    expect(firstEntryName(repacked)).toBe('mimetype')
    expect(firstEntryCompression(repacked)).toBe(0)
  })

  it('changes only the edited entry', () => {
    const { archive } = openEpub(original, nodeXmlParser)
    const chapterPath = 'EPUB/text/ch003.xhtml'
    const edited = new TextDecoder().decode(archive.entries.get(chapterPath))
    const changed = new Map(archive.entries)
    changed.set(chapterPath, new TextEncoder().encode(`${edited}\n<!-- edited -->`))

    const repacked = unzipArchive(zipArchive({ order: archive.order, entries: changed }))

    for (const [path, bytes] of archive.entries) {
      const after = repacked.entries.get(path)
      if (path === chapterPath) {
        expect(after).not.toEqual(bytes)
      } else {
        expect(after, path).toEqual(bytes)
      }
    }
  })

  it('rejects a tampered mimetype', () => {
    const { archive } = openEpub(original, nodeXmlParser)
    const broken = new Map(archive.entries)
    broken.set('mimetype', new TextEncoder().encode('text/plain'))
    expect(() => openEpub(zipArchive({ order: archive.order, entries: broken }), nodeXmlParser)).toThrow(
      /mimetype/,
    )
  })
})
