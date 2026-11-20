import type { EpubArchive, EpubPackage } from '@booksmith/core'
import { describe, expect, it } from 'vitest'
import { groupFiles, REMOTE_BINARY_SENTINEL, resolveBookAsset, type LoadedBook } from './bookStore'
import { applySavedEntriesToBook, buildEntryDelta } from './entryDelta'

const encoder = new TextEncoder()

function makeBook(): LoadedBook {
  const texts = new Map<string, string>([
    ['EPUB/content.opf', '<package/>'],
    ['EPUB/text/ch001.xhtml', '<html/>'],
  ])
  const entries = new Map<string, Uint8Array>([
    ['mimetype', encoder.encode('application/epub+zip')],
    ['EPUB/content.opf', encoder.encode('<package/>')],
    ['EPUB/text/ch001.xhtml', encoder.encode('<html/>')],
    ['EPUB/images/fig1.jpg', REMOTE_BINARY_SENTINEL],
  ])
  const archive: EpubArchive = { order: [...entries.keys()], entries }
  const pkg: EpubPackage = {
    version: '3.0',
    uniqueIdentifierId: 'id',
    opfPath: 'EPUB/content.opf',
    metadata: {
      title: 'T',
      language: 'zh-CN',
      identifier: 'id',
      creators: [],
      publisher: '',
      date: '',
      description: '',
      subjects: [],
      rights: '',
    },
    manifest: [
      { id: 'ch1', href: 'text/ch001.xhtml', mediaType: 'application/xhtml+xml', properties: [], path: 'EPUB/text/ch001.xhtml' },
      { id: 'fig1', href: 'images/fig1.jpg', mediaType: 'image/jpeg', properties: [], path: 'EPUB/images/fig1.jpg' },
    ],
    spine: ['ch1'],
  }

  const serverEntries = new Map([
    ['mimetype', { path: 'mimetype', position: 0, isText: false, mediaType: 'text/plain', byteSize: 20, sha256: 'sha-mime' }],
    ['EPUB/content.opf', { path: 'EPUB/content.opf', position: 1, isText: true, mediaType: 'application/oebps-package+xml', byteSize: 10, sha256: 'sha-opf' }],
    ['EPUB/text/ch001.xhtml', { path: 'EPUB/text/ch001.xhtml', position: 2, isText: true, mediaType: 'application/xhtml+xml', byteSize: 7, sha256: 'sha-ch1' }],
    ['EPUB/images/fig1.jpg', { path: 'EPUB/images/fig1.jpg', position: 3, isText: false, mediaType: 'image/jpeg', byteSize: 50000, sha256: 'sha-fig1' }],
  ])

  return {
    id: 'book-1',
    version: 1,
    archive,
    pkg,
    texts,
    groups: groupFiles(pkg, archive),
    serverPaths: new Set(entries.keys()),
    entryMeta: new Map(
      [...serverEntries.values()].map((item) => [
        item.path,
        { path: item.path, isText: item.isText, mediaType: item.mediaType, byteSize: item.byteSize, sha256: item.sha256 },
      ]),
    ),
    entryOrigins: new Map([...serverEntries.keys()].map((path) => [path, path])),
    serverEntries,
    localBinaries: new Map(),
  }
}

describe('buildEntryDelta & applySavedEntriesToBook', () => {
  it('produces an empty delta when nothing changed', () => {
    const book = makeBook()
    const delta = buildEntryDelta({ book, texts: book.texts, dirty: new Set() })
    expect(delta.hasChanges).toBe(false)
    expect(delta.deletes).toEqual([])
    expect(delta.renames).toEqual([])
    expect(delta.textUpserts).toEqual({})
    expect(delta.binaryUpserts.size).toBe(0)
  })

  it('tracks text edits, zero-byte binary renames, deletions, and local binary replacements', () => {
    const book = makeBook()
    const texts = new Map(book.texts)
    texts.set('EPUB/text/ch001.xhtml', '<html>edited</html>')

    // Rename remote binary without uploading bytes
    book.archive.entries.delete('EPUB/images/fig1.jpg')
    book.archive.entries.set('EPUB/images/renamed.jpg', REMOTE_BINARY_SENTINEL)
    book.archive.order = book.archive.order.map((p) => (p === 'EPUB/images/fig1.jpg' ? 'EPUB/images/renamed.jpg' : p))
    book.entryOrigins.delete('EPUB/images/fig1.jpg')
    book.entryOrigins.set('EPUB/images/renamed.jpg', 'EPUB/images/fig1.jpg')
    book.entryMeta.set('EPUB/images/renamed.jpg', {
      path: 'EPUB/images/renamed.jpg',
      isText: false,
      mediaType: 'image/jpeg',
      byteSize: 50000,
      sha256: 'sha-fig1',
    })
    book.entryMeta.delete('EPUB/images/fig1.jpg')

    // Renamed remote binary still resolves to its original server path before save
    const resolved = resolveBookAsset(book, 'EPUB/images/renamed.jpg')
    expect(resolved?.kind).toBe('url')
    if (resolved?.kind === 'url') {
      expect(resolved.url).toContain('path=EPUB%2Fimages%2Ffig1.jpg')
      expect(resolved.url).toContain('sha=sha-fig1')
    }

    // Add a new local binary asset
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    book.archive.entries.set('EPUB/media/new.png', pngBytes)
    book.archive.order.push('EPUB/media/new.png')
    book.localBinaries.set('EPUB/media/new.png', { bytes: pngBytes, mediaType: 'image/png' })

    const delta = buildEntryDelta({
      book,
      texts,
      dirty: new Set(['EPUB/text/ch001.xhtml', 'EPUB/media/new.png']),
    })

    expect(delta.hasChanges).toBe(true)
    expect(delta.deletes).toEqual([])
    expect(delta.renames).toEqual([{ from: 'EPUB/images/fig1.jpg', to: 'EPUB/images/renamed.jpg' }])
    expect(delta.textUpserts).toEqual({ 'EPUB/text/ch001.xhtml': '<html>edited</html>' })
    expect([...delta.binaryUpserts.keys()]).toEqual(['EPUB/media/new.png'])

    // Reconcile after save: local binary bytes are released back to REMOTE_BINARY_SENTINEL
    const saved = applySavedEntriesToBook(
      book,
      2,
      [
        { path: 'mimetype', position: 0, isText: false, mediaType: 'text/plain', byteSize: 20, sha256: 'sha-mime' },
        { path: 'EPUB/content.opf', position: 1, isText: true, mediaType: 'application/oebps-package+xml', byteSize: 10, sha256: 'sha-opf' },
        { path: 'EPUB/text/ch001.xhtml', position: 2, isText: true, mediaType: 'application/xhtml+xml', byteSize: 19, sha256: 'sha-ch1-v2' },
        { path: 'EPUB/images/renamed.jpg', position: 3, isText: false, mediaType: 'image/jpeg', byteSize: 50000, sha256: 'sha-fig1' },
        { path: 'EPUB/media/new.png', position: 4, isText: false, mediaType: 'image/png', byteSize: 4, sha256: 'sha-new-png' },
      ],
      texts,
    )
    expect(saved.version).toBe(2)
    expect(saved.localBinaries.size).toBe(0)
    expect(saved.archive.entries.get('EPUB/media/new.png')).toBe(REMOTE_BINARY_SENTINEL)
    expect(saved.entryOrigins.get('EPUB/images/renamed.jpg')).toBe('EPUB/images/renamed.jpg')
    const afterAsset = resolveBookAsset(saved, 'EPUB/media/new.png')
    expect(afterAsset?.kind).toBe('url')
  })
})
