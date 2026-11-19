import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { InvalidEpubError, unpackEpub, zipArchive } from '../src'

const encoder = new TextEncoder()

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
})
