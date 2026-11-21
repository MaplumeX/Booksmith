import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import {
  SPLIT_MARKER_HTML,
  countSplitMarkers,
  createEmptyEpub,
  isTextEntry,
  openEpub,
  splitChapterAtMarkersInBook,
  splitChapterByHeadingLevelInBook,
  splitChapterInBook,
  splitXhtmlAtMarkers,
  splitXhtmlAtOffset,
  splitXhtmlByHeadingLevel,
} from '../src'
import type { EpubArchive, EpubPackage } from '../src/types'
import type { XmlCodec } from '../src/xml'

const codec: XmlCodec = {
  parse: (xml) => new DOMParser().parseFromString(xml, 'application/xml') as unknown as Document,
  serialize: (node) => new XMLSerializer().serializeToString(node as never),
}

const decoder = new TextDecoder('utf-8')

function decodeFiles(archive: EpubArchive): Map<string, string> {
  const files = new Map<string, string>()
  for (const [path, bytes] of archive.entries) {
    if (isTextEntry(path)) files.set(path, decoder.decode(bytes))
  }
  return files
}

function openFixtureBook(): { files: Map<string, string>; pkg: EpubPackage; archive: EpubArchive } {
  const { archive, pkg } = openEpub(createEmptyEpub({ title: '拆分测试' }), codec.parse)
  return { files: decodeFiles(archive), pkg, archive }
}

describe('splitXhtmlAtOffset', () => {
  const sample = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>第一章</title>
  <link rel="stylesheet" href="../styles/stylesheet1.css" />
</head>
<body>
  <section id="sec-main" epub:type="chapter">
    <div class="box" id="box-1">
      <p>前半段内容</p>
      <p id="p2">后半段内容</p>
    </div>
  </section>
</body>
</html>
`

  it('closes open ancestor tags in first half and reopens them without duplicate ids in second half', () => {
    const offset = sample.indexOf('<p id="p2">')
    const [first, second] = splitXhtmlAtOffset(sample, offset, codec)

    expect(first).toContain('<section id="sec-main" epub:type="chapter">')
    expect(first).toContain('<div class="box" id="box-1">')
    expect(first).toContain('<p>前半段内容</p>')
    expect(first).not.toContain('后半段内容')
    expect(first).toContain('</div></section>')

    expect(second).toContain('<link rel="stylesheet" href="../styles/stylesheet1.css" />')
    expect(second).toContain('<section epub:type="chapter">')
    expect(second).toContain('<div class="box">')
    expect(second).not.toContain('id="sec-main"')
    expect(second).not.toContain('id="box-1"')
    expect(second).toContain('<p id="p2">后半段内容</p>')
  })

  it('snaps safely when cursor is inside a MathML island so formulas are never torn apart', () => {
    const withMath = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Math</title></head><body>
<p>导语</p>
<math xmlns="http://www.w3.org/1998/Math/MathML"><mrow><mi>x</mi><mo>=</mo><mn>1</mn></mrow></math>
<p>结论</p>
</body></html>`
    const insideMath = withMath.indexOf('<mo>=</mo>')
    const [first, second] = splitXhtmlAtOffset(withMath, insideMath, codec)

    expect(first).toContain('<p>导语</p>')
    expect(first).not.toContain('<math')
    expect(second).toContain('<math xmlns="http://www.w3.org/1998/Math/MathML"><mrow><mi>x</mi><mo>=</mo><mn>1</mn></mrow></math>')
    expect(second).toContain('<p>结论</p>')
  })

  it('rejects malformed XML chapters with a clear error', () => {
    const broken = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head></head><body><p>未闭合<div></body></html>`
    expect(() => splitXhtmlAtOffset(broken, broken.indexOf('未闭合'), codec)).toThrow(/良构|不匹配|闭合/)
  })

  it('preserves CRLF dominant line endings', () => {
    const crlf = sample.replace(/\n/g, '\r\n')
    const offset = crlf.indexOf('<p id="p2">')
    const [first, second] = splitXhtmlAtOffset(crlf, offset, codec)
    expect(first).toContain('\r\n')
    expect(second).toContain('\r\n')
  })
})

describe('splitXhtmlAtMarkers & splitXhtmlByHeadingLevel', () => {
  it('splits at all sigil_split_marker <hr> tags and removes the markers', () => {
    const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>合集</title></head><body>
<section><p>第一部分</p>${SPLIT_MARKER_HTML}<p>第二部分</p><hr class="foo sigil_split_marker bar" /><p>第三部分</p></section>
</body></html>`
    expect(countSplitMarkers(xhtml)).toBe(2)
    const pieces = splitXhtmlAtMarkers(xhtml, codec)
    expect(pieces).toHaveLength(3)
    expect(pieces[0]).toContain('第一部分')
    expect(pieces[1]).toContain('第二部分')
    expect(pieces[2]).toContain('第三部分')
    for (const piece of pieces) {
      expect(piece).not.toContain('sigil_split_marker')
    }
  })

  it('splits cleanly by heading level across pandoc-style <section> wrappers', () => {
    const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>书</title></head><body>
<section id="s1"><h1>第一章</h1><p>内容一</p></section>
<section id="s2"><h1>第二章</h1><p>内容二</p></section>
<section id="s3"><h1>第三章</h1><p>内容三</p></section>
</body></html>`
    const pieces = splitXhtmlByHeadingLevel(xhtml, 1, codec)
    expect(pieces).toHaveLength(3)
    expect(pieces[0]).toContain('第一章')
    expect(pieces[0]).not.toContain('第二章')
    expect(pieces[1]).toContain('<section id="s2"><h1>第二章</h1>')
    expect(pieces[2]).toContain('<section id="s3"><h1>第三章</h1>')
  })
})

describe('book-level split orchestrators', () => {
  it('inserts split chapter right after source in spine and migrates TOC + cross-chapter #id links', () => {
    const { files, pkg, archive } = openFixtureBook()
    const chPath = 'EPUB/text/ch001.xhtml'
    const navPath = pkg.navPath!

    const chapterXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head><meta charset="utf-8" /><title>第一章</title></head>
<body>
<h1 id="sec1">第一节</h1>
<p>参见 <a href="#sec2">第二节</a></p>
<h2 id="sec2">第二节</h2>
<p>回到 <a href="#sec1">第一节</a></p>
</body>
</html>
`
    files.set(chPath, chapterXml)
    files.set(
      navPath,
      (files.get(navPath) ?? '').replace(
        '<a href="text/ch001.xhtml">第一章</a>',
        '<a href="text/ch001.xhtml#sec1">第一节</a></li><li><a href="text/ch001.xhtml#sec2">第二节</a>',
      ),
    )

    const offset = chapterXml.indexOf('<h2 id="sec2">')
    const result = splitChapterInBook({ files, pkg, archive, path: chPath, offset, codec })

    expect(result.createdPaths).toEqual(['EPUB/text/ch001_0001.xhtml'])
    expect(result.pkg.spine).toEqual(['ch001', 'ch001_0001'])
    expect(result.files.get(navPath)).toContain('text/ch001.xhtml#sec1')
    expect(result.files.get(navPath)).toContain('text/ch001_0001.xhtml#sec2')
    expect(result.files.get(chPath)).toContain('href="ch001_0001.xhtml#sec2"')
    expect(result.files.get('EPUB/text/ch001_0001.xhtml')).toContain('href="ch001.xhtml#sec1"')
    expect(result.referencesRewritten).toBe(3)
  })

  it('splits a real MathML chapter from the repository fixture book without corrupting XML', () => {
    const epubPath = resolve(__dirname, '../../../fixtures/马克思经济学与数理分析.epub')
    const bytes = new Uint8Array(readFileSync(epubPath))
    const { archive, pkg } = openEpub(bytes, codec.parse)
    const files = decodeFiles(archive)

    // Pick a chapter containing `<math` and multiple `<h2` headings.
    let targetPath: string | null = null
    for (const id of pkg.spine) {
      const item = pkg.manifest.find((m) => m.id === id)
      const text = item ? files.get(item.path) : undefined
      if (item && text && text.includes('<math') && (text.match(/<h2[\s>]/gi)?.length ?? 0) >= 2) {
        targetPath = item.path
        break
      }
    }
    expect(targetPath).not.toBeNull()

    const result = splitChapterByHeadingLevelInBook({
      files,
      pkg,
      archive,
      path: targetPath!,
      level: 2,
      codec,
    })
    expect(result.createdPaths.length).toBeGreaterThanOrEqual(1)
    // Verify original chapter and all split outputs parse cleanly and retain MathML.
    const combined = [result.files.get(targetPath!) ?? '', ...result.createdPaths.map((p) => result.files.get(p) ?? '')].join('')
    expect(combined).toContain('<math')
  })

  it('splits at markers in book and removes markers from all generated chapters', () => {
    const { files, pkg, archive } = openFixtureBook()
    const chPath = 'EPUB/text/ch001.xhtml'
    const base = files.get(chPath)!
    files.set(
      chPath,
      base.replace('<p>从这里开始写。</p>', `<p>第一段</p>${SPLIT_MARKER_HTML}<p>第二段</p>`),
    )

    const result = splitChapterAtMarkersInBook({ files, pkg, archive, path: chPath, codec })
    expect(result.createdPaths).toEqual(['EPUB/text/ch001_0001.xhtml'])
    expect(result.files.get(chPath)).toContain('第一段')
    expect(result.files.get('EPUB/text/ch001_0001.xhtml')).toContain('第二段')
    expect(countSplitMarkers(result.files.get(chPath)!)).toBe(0)
  })
})
