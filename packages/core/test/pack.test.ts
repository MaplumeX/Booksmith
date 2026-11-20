import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { InvalidEpubError, unpackEpub, unzipArchive, zipArchive } from '../src'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function compressionMethods(zipBytes: Uint8Array): Map<string, number> {
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength)
  const methods = new Map<string, number>()
  for (let i = 0; i <= zipBytes.byteLength - 46; i += 1) {
    if (view.getUint32(i, true) !== 0x02014b50) continue
    const method = view.getUint16(i + 10, true)
    const nameLen = view.getUint16(i + 28, true)
    const name = decoder.decode(zipBytes.subarray(i + 46, i + 46 + nameLen))
    methods.set(name, method)
  }
  return methods
}

describe('pack guards', () => {
  it('refuses to pack an archive without mimetype', () => {
    const archive = { order: ['a.txt'], entries: new Map([['a.txt', encoder.encode('x')]]) }
    expect(() => zipArchive(archive)).toThrow(InvalidEpubError)
  })

  it('refuses a zip that is not an epub', () => {
    const notEpub = zipSync({ 'a.txt': encoder.encode('hello') })
    expect(() => unpackEpub(notEpub)).toThrow(/mimetype/)
  })

  it('refuses an epub whose mimetype is not the first entry', () => {
    const wrongOrder = zipSync({
      'a.txt': encoder.encode('hello'),
      mimetype: encoder.encode('application/epub+zip'),
      'META-INF/container.xml': encoder.encode('<container/>'),
    })
    expect(() => unpackEpub(wrongOrder)).toThrow(/first zip entry/)
  })

  it('rejects random bytes', () => {
    expect(() => unpackEpub(new Uint8Array([1, 2, 3, 4]))).toThrow(InvalidEpubError)
  })

  it('stores mimetype and pre-compressed media at level 0 while deflating text', () => {
    const fakeJpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
    const fakeWoff2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x02, 0x03])
    const text = encoder.encode('<html xmlns="http://www.w3.org/1999/xhtml"><p>hello world '.repeat(20) + '</html>')
    const archive = {
      order: ['mimetype', 'META-INF/container.xml', 'EPUB/ch1.xhtml', 'EPUB/cover.jpg', 'EPUB/font.woff2'],
      entries: new Map<string, Uint8Array>([
        ['mimetype', encoder.encode('application/epub+zip')],
        ['META-INF/container.xml', encoder.encode('<container/>')],
        ['EPUB/ch1.xhtml', text],
        ['EPUB/cover.jpg', fakeJpg],
        ['EPUB/font.woff2', fakeWoff2],
      ]),
    }

    const packed = zipArchive(archive)
    const methods = compressionMethods(packed)
    expect(methods.get('mimetype')).toBe(0)
    expect(methods.get('EPUB/cover.jpg')).toBe(0)
    expect(methods.get('EPUB/font.woff2')).toBe(0)
    expect(methods.get('EPUB/ch1.xhtml')).toBe(8)

    const unpacked = unzipArchive(packed)
    expect(unpacked.order).toEqual(archive.order)
    expect(unpacked.entries.get('EPUB/cover.jpg')).toEqual(fakeJpg)
    expect(unpacked.entries.get('EPUB/font.woff2')).toEqual(fakeWoff2)
    expect(unpacked.entries.get('EPUB/ch1.xhtml')).toEqual(text)
  })
})
