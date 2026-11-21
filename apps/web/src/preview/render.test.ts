import { describe, expect, it, vi } from 'vitest'
import type { EpubArchive, EpubPackage } from '@booksmith/core'
import {
  adaptDocumentBodyInlineStyles,
  buildEditorStyleCss,
  buildPreviewThemeCss,
  buildReaderBaseCss,
  PreviewBlobCache,
  previewResourcesChanged,
  type PreviewResourceSnapshot,
} from './render'

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

  it('tracks remote asset keys so lazy HTTP images re-render only on replacement, rename, or deletion', () => {
    const pkg = makePkg()
    const archive: EpubArchive = { order: ['OEBPS/Images/cover.jpg'], entries: new Map() }
    const deps = new Map<string, PreviewResourceSnapshot>([
      ['OEBPS/Images/cover.jpg', { bytes: undefined, assetKey: 'remote:book-1:OEBPS/Images/cover.jpg:sha1', mime: 'image/jpeg' }],
    ])

    const sameRemote = () => ({
      kind: 'url' as const,
      url: 'http://localhost/api/books/book-1/entry?path=OEBPS%2FImages%2Fcover.jpg&sha=sha1',
      key: 'remote:book-1:OEBPS/Images/cover.jpg:sha1',
      mime: 'image/jpeg',
    })
    expect(previewResourcesChanged(deps, archive, pkg, sameRemote)).toBe(false)

    const updatedRemote = () => ({
      kind: 'url' as const,
      url: 'http://localhost/api/books/book-1/entry?path=OEBPS%2FImages%2Fcover.jpg&sha=sha2',
      key: 'remote:book-1:OEBPS/Images/cover.jpg:sha2',
      mime: 'image/jpeg',
    })
    expect(previewResourcesChanged(deps, archive, pkg, updatedRemote)).toBe(true)

    const localReplacement = () => ({
      kind: 'bytes' as const,
      bytes: new Uint8Array([7, 8, 9]),
      mime: 'image/jpeg',
    })
    expect(previewResourcesChanged(deps, archive, pkg, localReplacement)).toBe(true)

    const deletedRemote = () => null
    expect(previewResourcesChanged(deps, archive, pkg, deletedRemote)).toBe(true)
  })
})

describe('preview & editor theme CSS', () => {
  it('generates Soft Craft Studio colors for light and dark preview themes', () => {
    const light = buildPreviewThemeCss('light')
    expect(light).toContain('color-scheme: light')
    expect(light).toContain('background-color: #ffffff')
    expect(light).toContain('color: #202028')

    const dark = buildPreviewThemeCss('dark')
    expect(dark).toContain('color-scheme: dark')
    expect(dark).toContain('background-color: #1a1b24')
    expect(dark).toContain('color: #ececf2')
    expect(dark).toContain('color: #9c97f4')
  })

  it('aligns editable paper CSS with global light and dark tokens', () => {
    const light = buildEditorStyleCss('light')
    expect(light).toContain('color-scheme: light')
    expect(light).toContain('background: #ffffff')
    expect(light).toContain('color: #202028')

    const dark = buildEditorStyleCss('dark')
    expect(dark).toContain('color-scheme: dark')
    expect(dark).toContain('background: #1a1b24')
    expect(dark).toContain('color: #ececf2')
    expect(dark).toContain('hr.sigil_split_marker')
    expect(light).toContain('hr.sigil_split_marker')
  })

  it('builds zero-specificity reader baseline CSS for typography, blockquote, code, and tables', () => {
    const previewLight = buildReaderBaseCss('light', { mode: 'preview' })
    expect(previewLight).toContain(':where(blockquote)')
    expect(previewLight).toContain(':where(pre)')
    expect(previewLight).toContain(':where(table)')
    expect(previewLight).toContain('padding: 20px 24px')
    expect(previewLight).toContain('color: #464655')
    expect(previewLight).toContain('background-color: #f4f4f6')

    const previewDark = buildReaderBaseCss('dark', { mode: 'preview' })
    expect(previewDark).toContain('color: #b4b5c7')
    expect(previewDark).toContain('background-color: #222430')

    const editableDark = buildReaderBaseCss('dark', { mode: 'editable' })
    expect(editableDark).not.toContain('padding: 20px 24px')
  })

  it('adapts and restores inline styles while preserving original values for WYSIWYG round-trip', () => {
    function mockElement(attrs: Record<string, string>, tagName = 'BLOCKQUOTE') {
      const map = new Map(Object.entries(attrs))
      return {
        tagName,
        closest: () => null,
        hasAttribute: (k: string) => map.has(k),
        getAttribute: (k: string) => map.get(k) ?? null,
        setAttribute: (k: string, v: string) => map.set(k, v),
        removeAttribute: (k: string) => map.delete(k),
      }
    }

    const quote = mockElement({ style: 'color: #555; background: #f5f5f5;' })
    const svgRect = {
      tagName: 'RECT',
      closest: (sel: string) => (sel.includes('svg') ? {} : null),
      hasAttribute: () => true,
      getAttribute: () => 'fill: #000;',
      setAttribute: () => {
        throw new Error('should not modify SVG descendants')
      },
      removeAttribute: () => {},
    }
    const body = {
      ...mockElement({}, 'BODY'),
      querySelectorAll: () => [quote, svgRect],
    } as unknown as Element

    adaptDocumentBodyInlineStyles(body, 'dark', true)
    expect(quote.getAttribute('data-booksmith-orig-style')).toBe('color: #555; background: #f5f5f5;')
    expect(quote.getAttribute('style')).toContain('color: #b4b5c7')
    expect(quote.getAttribute('style')).toContain('background: #222430')

    adaptDocumentBodyInlineStyles(body, 'light', true)
    expect(quote.hasAttribute('data-booksmith-orig-style')).toBe(false)
    expect(quote.getAttribute('style')).toBe('color: #555; background: #f5f5f5;')
  })
})
