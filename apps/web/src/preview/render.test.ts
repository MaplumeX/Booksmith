import { describe, expect, it, vi } from 'vitest'
import type { EpubArchive, EpubPackage } from '@booksmith/core'
import { PreviewBlobCache, previewResourcesChanged, type PreviewResourceSnapshot } from './render'

function makePkg(manifest: Array<{ id: string; path: string; mediaType: string }> = []): EpubPackage {
  return {
    opfPath: 'OEBPS/content.opf',
    version: '3.0',
    uniqueIdentifierId: 'uid',
    metadata: {
      title: 'Test',
      language: 'zh-CN',
      identifier: 'id-1',
      creators: [],
      publisher: '',
      date: '',
      description: '',
      subjects: [],
      rights: '',
    },
    manifest: manifest.map((item) => ({ ...item, href: item.path, properties: [] })),
    spine: [],
  }
}

describe('PreviewBlobCache', () => {
  it('reuses blob URLs when bytes reference and mime are unchanged and revokes replaced ones on flush', () => {
    let seq = 0
    const revoked: string[] = []
    const createSpy = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:mock-${++seq}`)
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
      revoked.push(url)
    })

    try {
      const cache = new PreviewBlobCache()
      const imgV1 = new Uint8Array([1, 2, 3])
      const imgV2 = new Uint8Array([4, 5, 6])

      const first = cache.urlFor('OEBPS/Images/cover.png', imgV1, 'image/png')
      const repeated = cache.urlFor('OEBPS/Images/cover.png', imgV1, 'image/png')
      expect(first).toBe('blob:mock-1')
      expect(repeated).toBe(first)
      expect(createSpy).toHaveBeenCalledTimes(1)

      const updated = cache.urlFor('OEBPS/Images/cover.png', imgV2, 'image/png')
      expect(updated).toBe('blob:mock-2')
      // Old URL stays alive until the caller finishes patching the DOM and flushes.
      expect(revoked).toEqual([])

      cache.flushObsolete()
      expect(revoked).toEqual(['blob:mock-1'])

      cache.dispose()
      expect(revoked).toEqual(['blob:mock-1', 'blob:mock-2'])
    } finally {
      createSpy.mockRestore()
      revokeSpy.mockRestore()
    }
  })

  it('evicts entries removed from the archive during flushObsolete', () => {
    let seq = 0
    const revoked: string[] = []
    const createSpy = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:mock-${++seq}`)
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
      revoked.push(url)
    })

    try {
      const cache = new PreviewBlobCache()
      const bytes = new Uint8Array([9])
      cache.urlFor('OEBPS/Images/old.png', bytes, 'image/png')

      const archive: EpubArchive = { order: [], entries: new Map() }
      cache.flushObsolete(archive)
      expect(revoked).toEqual(['blob:mock-1'])
    } finally {
      createSpy.mockRestore()
      revokeSpy.mockRestore()
    }
  })
})

describe('previewResourcesChanged', () => {
  it('ignores edits to unrelated archive entries such as the chapter XHTML itself on save', () => {
    const cssBytes = new Uint8Array([10, 20])
    const imgBytes = new Uint8Array([30, 40])
    const deps = new Map<string, PreviewResourceSnapshot>([
      ['OEBPS/Styles/style.css', { bytes: cssBytes, mime: 'text/css' }],
      ['OEBPS/Images/fig.png', { bytes: imgBytes, mime: 'image/png' }],
    ])

    const pkg = makePkg()
    const savedArchive: EpubArchive = {
      order: ['OEBPS/Text/ch001.xhtml', 'OEBPS/Styles/style.css', 'OEBPS/Images/fig.png'],
      entries: new Map([
        ['OEBPS/Text/ch001.xhtml', new Uint8Array([99, 98, 97])],
        ['OEBPS/Styles/style.css', cssBytes],
        ['OEBPS/Images/fig.png', imgBytes],
      ]),
    }

    expect(previewResourcesChanged(deps, savedArchive, pkg)).toBe(false)
  })

  it('detects when a referenced stylesheet or image changes or a missing asset appears', () => {
    const cssV1 = new Uint8Array([10, 20])
    const cssV2 = new Uint8Array([10, 21])
    const pkg = makePkg()

    const deps = new Map<string, PreviewResourceSnapshot>([
      ['OEBPS/Styles/style.css', { bytes: cssV1, mime: 'text/css' }],
      ['OEBPS/Images/missing.png', { bytes: undefined, mime: 'image/png' }],
    ])

    const cssUpdated: EpubArchive = {
      order: ['OEBPS/Styles/style.css'],
      entries: new Map([['OEBPS/Styles/style.css', cssV2]]),
    }
    expect(previewResourcesChanged(deps, cssUpdated, pkg)).toBe(true)

    const missingAdded: EpubArchive = {
      order: ['OEBPS/Styles/style.css', 'OEBPS/Images/missing.png'],
      entries: new Map([
        ['OEBPS/Styles/style.css', cssV1],
        ['OEBPS/Images/missing.png', new Uint8Array([1])],
      ]),
    }
    expect(previewResourcesChanged(deps, missingAdded, pkg)).toBe(true)
  })
})
