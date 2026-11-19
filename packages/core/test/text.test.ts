import { describe, expect, it } from 'vitest'
import { hasPageHistory, isTextEntry } from '../src/text'

describe('isTextEntry', () => {
  it('accepts every extension the editor can edit', () => {
    for (const path of [
      'EPUB/text/ch001.xhtml',
      'EPUB/text/index.html',
      'EPUB/styles/main.css',
      'EPUB/content.opf',
      'EPUB/toc.ncx',
      'META-INF/container.xml',
      'EPUB/media/cover.svg',
      'EPUB/scripts/app.js',
      'notes.txt',
    ]) {
      expect(isTextEntry(path), path).toBe(true)
    }
  })

  it('rejects binary entries and paths without an extension', () => {
    for (const path of ['mimetype', 'EPUB/media/cover.jpg', 'EPUB/media/font.woff2', 'EPUB/media/']) {
      expect(isTextEntry(path), path).toBe(false)
    }
  })

  it('is case insensitive on the extension', () => {
    expect(isTextEntry('EPUB/text/CH001.XHTML')).toBe(true)
  })
})

describe('hasPageHistory', () => {
  it('covers book content, including metadata and styles', () => {
    expect(hasPageHistory('EPUB/content.opf')).toBe(true)
    expect(hasPageHistory('EPUB/nav.xhtml')).toBe(true)
    expect(hasPageHistory('EPUB/styles/main.css')).toBe(true)
  })

  it('skips the zip container metadata even though it is xml', () => {
    expect(hasPageHistory('META-INF/container.xml')).toBe(false)
    expect(hasPageHistory('mimetype')).toBe(false)
    expect(hasPageHistory('EPUB/media/cover.png')).toBe(false)
  })
})
