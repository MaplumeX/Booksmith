import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import {
  addSpineDocument,
  createEmptyEpub,
  duplicateChapterInBook,
  isTextEntry,
  lintBook,
  mergeChaptersInBook,
  openEpub,
  parsePackage,
} from '../src'
import type { EpubArchive, EpubPackage } from '../src/types'
import type { XmlCodec } from '../src/xml'

const codec: XmlCodec = {
  parse: (xml) => new DOMParser().parseFromString(xml, 'application/xml') as unknown as Document,
  serialize: (node) => new XMLSerializer().serializeToString(node as never),
}

const decoder = new TextDecoder('utf-8')
const encoder = new TextEncoder()

function buildTwoChapterBook(): { files: Map<string, string>; pkg: EpubPackage; archive: EpubArchive } {
  const { archive, pkg } = openEpub(createEmptyEpub({ title: '合并测试' }), codec.parse)
  const files = new Map<string, string>()
  for (const [path, bytes] of archive.entries) {
    if (isTextEntry(path)) files.set(path, decoder.decode(bytes))
  }

  const ch2Path = 'EPUB/text/ch002.xhtml'
  const ch2Xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>第二章</title>
  <link rel="stylesheet" href="../styles/extra.css" />
</head>
<body>
<section>
  <h1 id="ch2-title">第二章</h1>
  <p>第二章正文，回到 <a href="ch001.xhtml">第一章</a></p>
</section>
</body>
</html>
`
  const extraCss = 'body { color: #222; }\n'
  let opf = files.get(pkg.opfPath)!
  opf = addSpineDocument(opf, { id: 'ch002', href: 'text/ch002.xhtml', mediaType: 'application/xhtml+xml' }, codec)
  opf = opf.replace('</manifest>', '<item id="extra_css" href="styles/extra.css" media-type="text/css"/></manifest>')
  files.set(pkg.opfPath, opf)
  files.set(ch2Path, ch2Xml)
  files.set('EPUB/styles/extra.css', extraCss)

  archive.entries.set(pkg.opfPath, encoder.encode(opf))
  archive.entries.set(ch2Path, encoder.encode(ch2Xml))
  archive.entries.set('EPUB/styles/extra.css', encoder.encode(extraCss))
  archive.order.push(ch2Path, 'EPUB/styles/extra.css')

  const navPath = pkg.navPath!
  files.set(
    navPath,
    files
      .get(navPath)!
      .replace(
        '<li><a href="text/ch001.xhtml">第一章</a></li>',
        '<li><a href="text/ch001.xhtml">第一章</a></li><li><a href="text/ch002.xhtml">第二章</a></li><li><a href="text/ch002.xhtml#ch2-title">第二章标题</a></li>',
      ),
  )

  return {
    files,
    pkg: parsePackage(opf, pkg.opfPath, codec.parse),
    archive,
  }
}

describe('mergeChaptersInBook', () => {
  it('merges chapters, imports missing stylesheets, rewrites bare & fragment TOC links, and passes lint', () => {
    const { files, pkg, archive } = buildTwoChapterBook()

    const result = mergeChaptersInBook({
      files,
      pkg,
      archive,
      paths: ['EPUB/text/ch001.xhtml', 'EPUB/text/ch002.xhtml'],
      codec,
    })

    expect(result.primaryPath).toBe('EPUB/text/ch001.xhtml')
    expect(result.removedPaths).toEqual(['EPUB/text/ch002.xhtml'])
    expect(result.pkg.spine).toEqual(['ch001'])
    expect(result.files.has('EPUB/text/ch002.xhtml')).toBe(false)

    const merged = result.files.get('EPUB/text/ch001.xhtml')!
    expect(merged).toContain('从这里开始写。')
    expect(merged).toContain('第二章正文')
    expect(merged).toContain('href="../styles/extra.css"')

    const nav = result.files.get(result.pkg.navPath!)!
    expect(nav).not.toContain('ch002.xhtml')
    expect(nav).toContain('text/ch001.xhtml#ch2-title')
    expect(nav).toContain('text/ch001.xhtml#merged_ch002')

    expect(lintBook(result.files, result.pkg, result.archive, codec)).toEqual([])
  })

  it('rejects merging fewer than two chapters', () => {
    const { files, pkg, archive } = buildTwoChapterBook()
    expect(() =>
      mergeChaptersInBook({ files, pkg, archive, paths: ['EPUB/text/ch001.xhtml'], codec }),
    ).toThrow(/至少需要/)
  })
})

describe('duplicateChapterInBook', () => {
  it('clones chapter content and inserts it right after the source chapter in spine', () => {
    const { files, pkg, archive } = buildTwoChapterBook()
    const result = duplicateChapterInBook({
      files,
      pkg,
      archive,
      path: 'EPUB/text/ch001.xhtml',
      codec,
    })

    expect(result.createdPath).toBe('EPUB/text/ch001_copy.xhtml')
    expect(result.pkg.spine).toEqual(['ch001', 'ch001_copy', 'ch002'])
    expect(result.files.get('EPUB/text/ch001_copy.xhtml')).toBe(files.get('EPUB/text/ch001.xhtml'))
  })
})
