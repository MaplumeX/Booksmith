import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import {
  addManifestItem,
  createBlankStylesheet,
  createEmptyEpub,
  deleteUnusedResourcesInBook,
  findUnusedResources,
  getLinkedStylesheets,
  isTextEntry,
  listBookStylesheets,
  openEpub,
  parsePackage,
  setChapterStylesheets,
  updateChaptersStylesheets,
} from '../src'
import type { EpubArchive, EpubPackage } from '../src/types'
import type { XmlCodec } from '../src/xml'

const codec: XmlCodec = {
  parse: (xml) => new DOMParser().parseFromString(xml, 'application/xml') as unknown as Document,
  serialize: (node) => new XMLSerializer().serializeToString(node as never),
}

const decoder = new TextDecoder('utf-8')
const encoder = new TextEncoder()

function openBook(): { files: Map<string, string>; pkg: EpubPackage; archive: EpubArchive } {
  const { archive, pkg } = openEpub(createEmptyEpub({ title: '样式表测试' }), codec.parse)
  const files = new Map<string, string>()
  for (const [path, bytes] of archive.entries) {
    if (isTextEntry(path)) files.set(path, decoder.decode(bytes))
  }
  return { files, pkg, archive }
}

describe('stylesheets management', () => {
  it('lists stylesheets, creates a blank CSS without entering spine, and toggles chapter links', () => {
    const book = openBook()
    expect(listBookStylesheets(book.pkg, book.archive)).toEqual(['EPUB/styles/stylesheet1.css'])

    const created = createBlankStylesheet({
      files: book.files,
      pkg: book.pkg,
      archive: book.archive,
      filename: 'chapter-theme',
      codec,
    })
    expect(created.createdPath).toBe('EPUB/styles/chapter-theme.css')
    expect(created.pkg.spine).toEqual(['ch001'])
    expect(listBookStylesheets(created.pkg, created.archive)).toEqual([
      'EPUB/styles/chapter-theme.css',
      'EPUB/styles/stylesheet1.css',
    ])

    const chPath = 'EPUB/text/ch001.xhtml'
    const original = created.files.get(chPath)!
    expect(getLinkedStylesheets(original, chPath)).toEqual(['EPUB/styles/stylesheet1.css'])

    // No-op when desired set matches current links.
    expect(setChapterStylesheets(original, chPath, ['EPUB/styles/stylesheet1.css'])).toBe(original)

    // Add second stylesheet and remove the first.
    const updated = setChapterStylesheets(original, chPath, ['EPUB/styles/chapter-theme.css'])
    expect(getLinkedStylesheets(updated, chPath)).toEqual(['EPUB/styles/chapter-theme.css'])
    expect(updated).not.toContain('stylesheet1.css')
    expect(updated).toContain('<title>')
  })

  it('supports delta add/remove across multiple chapters via updateChaptersStylesheets', () => {
    const book = openBook()
    const ch1 = 'EPUB/text/ch001.xhtml'
    const ch2 = 'EPUB/text/ch002.xhtml'
    book.files.set(ch2, book.files.get(ch1)!)

    const res = updateChaptersStylesheets(book.files, [ch1, ch2], {
      add: ['EPUB/styles/extra.css'],
    })
    expect(res.changedPaths).toEqual([ch1, ch2])
    expect(getLinkedStylesheets(res.files.get(ch1)!, ch1)).toEqual([
      'EPUB/styles/stylesheet1.css',
      'EPUB/styles/extra.css',
    ])
  })
})

describe('findUnusedResources & deleteUnusedResourcesInBook', () => {
  it('detects unused images, fonts, and unlinked CSS while protecting cover-image and epub2 cover', () => {
    const book = openBook()
    let opf = book.files.get(book.pkg.opfPath)!
    opf = addManifestItem(
      opf,
      { id: 'unused_img', href: 'images/orphan.png', mediaType: 'image/png' },
      codec,
    )
    opf = addManifestItem(
      opf,
      { id: 'cover_img', href: 'images/cover.jpg', mediaType: 'image/jpeg', properties: ['cover-image'] },
      codec,
    )
    opf = addManifestItem(
      opf,
      { id: 'legacy_cover', href: 'images/legacy.jpg', mediaType: 'image/jpeg' },
      codec,
    )
    opf = opf.replace('</metadata>', '<meta name="cover" content="legacy_cover"/></metadata>')
    opf = addManifestItem(
      opf,
      { id: 'unused_css', href: 'styles/unused.css', mediaType: 'text/css' },
      codec,
    )
    opf = addManifestItem(
      opf,
      { id: 'unused_font', href: 'fonts/unused.woff2', mediaType: 'font/woff2' },
      codec,
    )

    book.files.set(book.pkg.opfPath, opf)
    book.files.set('EPUB/styles/unused.css', 'p { color: red; }')
    book.archive.entries.set('EPUB/images/orphan.png', new Uint8Array([1, 2, 3, 4]))
    book.archive.entries.set('EPUB/images/cover.jpg', new Uint8Array([1, 2]))
    book.archive.entries.set('EPUB/images/legacy.jpg', new Uint8Array([1, 2]))
    book.archive.entries.set('EPUB/styles/unused.css', encoder.encode('p { color: red; }'))
    book.archive.entries.set('EPUB/fonts/unused.woff2', new Uint8Array([1, 2, 3]))
    book.pkg = parsePackage(opf, book.pkg.opfPath, codec.parse)

    const unused = findUnusedResources(book.files, book.pkg, book.archive)
    expect(unused.map((item) => `${item.category}:${item.path}`).sort()).toEqual([
      'font:EPUB/fonts/unused.woff2',
      'image:EPUB/images/orphan.png',
      'stylesheet:EPUB/styles/unused.css',
    ])

    const cleaned = deleteUnusedResourcesInBook({
      files: book.files,
      pkg: book.pkg,
      archive: book.archive,
      paths: ['EPUB/images/orphan.png', 'EPUB/styles/unused.css'],
      codec,
    })
    expect(cleaned.removedPaths).toEqual(['EPUB/images/orphan.png', 'EPUB/styles/unused.css'])
    expect(cleaned.archive.entries.has('EPUB/images/orphan.png')).toBe(false)
    expect(cleaned.files.has('EPUB/styles/unused.css')).toBe(false)
    expect(cleaned.pkg.manifest.some((i) => i.path === 'EPUB/images/orphan.png')).toBe(false)
    expect(cleaned.archive.entries.has('EPUB/images/cover.jpg')).toBe(true)
  })
})
