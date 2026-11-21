import { describe, expect, it } from 'vitest'
import { relativePath, resolvePath } from '../src/path'
import {
  collectBrokenReferences,
  collectDocumentIds,
  collectReferences,
  rewriteAnchorReferences,
  rewriteReferences,
} from '../src/references'

function book(files: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(files))
}

describe('relativePath', () => {
  it('walks up from the referencing directory', () => {
    expect(relativePath('EPUB/text', 'EPUB/images/fig.png')).toBe('../images/fig.png')
  })

  it('walks down from a shared parent', () => {
    expect(relativePath('EPUB', 'EPUB/text/ch001.xhtml')).toBe('text/ch001.xhtml')
  })

  it('uses a bare name inside the same directory', () => {
    expect(relativePath('EPUB/text', 'EPUB/text/ch002.xhtml')).toBe('ch002.xhtml')
  })

  it('handles the archive root', () => {
    expect(relativePath('', 'EPUB/text/a.xhtml')).toBe('EPUB/text/a.xhtml')
    expect(relativePath('EPUB', 'mimetype')).toBe('../mimetype')
  })

  it('round-trips through resolvePath', () => {
    for (const [fromDir, target] of [
      ['EPUB/text', 'EPUB/images/fig.png'],
      ['EPUB', 'EPUB/text/ch001.xhtml'],
      ['EPUB/a/b', 'EPUB/c.png'],
    ] as const) {
      expect(resolvePath(fromDir, relativePath(fromDir, target))).toBe(target)
    }
  })
})

describe('collectReferences', () => {
  it('resolves attribute values against the referring file', () => {
    const files = book({
      'EPUB/text/ch001.xhtml':
        '<link href="../styles/s.css"/><img src="../images/fig.png"/><a href="ch002.xhtml#sec2">x</a>',
    })
    expect(collectReferences(files).map((ref) => ref.targetPath)).toEqual([
      'EPUB/styles/s.css',
      'EPUB/images/fig.png',
      'EPUB/text/ch002.xhtml',
    ])
    expect(collectReferences(files)[2]?.fragment).toBe('sec2')
  })

  it('resolves CSS url() against the stylesheet directory', () => {
    const files = book({ 'EPUB/styles/s.css': '@font-face { src: url(../fonts/a.woff2); }' })
    expect(collectReferences(files)).toMatchObject([
      { from: 'EPUB/styles/s.css', raw: '../fonts/a.woff2', targetPath: 'EPUB/fonts/a.woff2', fragment: '' },
    ])
  })

  it('treats a bare fragment as a reference to its own file', () => {
    const files = book({ 'EPUB/text/ch001.xhtml': '<a href="#note1">note</a>' })
    expect(collectReferences(files)[0]?.targetPath).toBe('EPUB/text/ch001.xhtml')
  })

  it('ignores external URLs, data URIs and empty values', () => {
    const files = book({
      'EPUB/text/ch001.xhtml':
        '<a href="https://example.com/x">a</a><img src="data:image/png;base64,AA"/><a href="">b</a><a href="//cdn/x">c</a>',
    })
    expect(collectReferences(files)).toEqual([])
  })

  it('ignores a value with a malformed percent escape', () => {
    const files = book({ 'EPUB/text/ch001.xhtml': '<img src="../images/100%.png"/>' })
    expect(collectReferences(files)).toEqual([])
  })
})

describe('rewriteReferences', () => {
  const files = book({
    'EPUB/text/ch001.xhtml':
      '<link href="../styles/s.css"/><img src="../images/fig.png"/><img src=\'../images/other.png\'/>',
    'EPUB/text/ch002.xhtml': '<img src="fig.png"/>',
    'EPUB/styles/s.css': 'body { background: url("../images/fig.png"); }',
  })

  it('rewrites only references to the renamed path', () => {
    const { files: next, touched } = rewriteReferences(files, new Map([['EPUB/images/fig.png', 'EPUB/media/fig.png']]))

    expect(next.get('EPUB/text/ch001.xhtml')).toBe(
      '<link href="../styles/s.css"/><img src="../media/fig.png"/><img src=\'../images/other.png\'/>',
    )
    expect(next.get('EPUB/styles/s.css')).toBe('body { background: url("../media/fig.png"); }')
    expect(touched.map((ref) => ref.from)).toEqual(['EPUB/text/ch001.xhtml', 'EPUB/styles/s.css'])
  })

  it('does not touch a longer name that merely starts with the old one', () => {
    const withNeighbour = book({
      'EPUB/text/ch001.xhtml': '<img src="../images/fig.png"/><img src="../images/fig.png.bak"/>',
    })
    const { files: next } = rewriteReferences(
      withNeighbour,
      new Map([['EPUB/images/fig.png', 'EPUB/images/renamed.png']]),
    )
    expect(next.get('EPUB/text/ch001.xhtml')).toBe(
      '<img src="../images/renamed.png"/><img src="../images/fig.png.bak"/>',
    )
  })

  it('keeps the fragment on the renamed reference', () => {
    const withAnchor = book({ 'EPUB/text/ch001.xhtml': '<a href="ch002.xhtml#sec2">x</a>' })
    const { files: next } = rewriteReferences(
      withAnchor,
      new Map([['EPUB/text/ch002.xhtml', 'EPUB/text/ch002-intro.xhtml']]),
    )
    expect(next.get('EPUB/text/ch001.xhtml')).toBe('<a href="ch002-intro.xhtml#sec2">x</a>')
  })

  it('recomputes the relative form when the target moves to another directory', () => {
    const moving = book({ 'EPUB/text/ch001.xhtml': '<img src="../images/fig.png"/>' })
    const { files: next } = rewriteReferences(
      moving,
      new Map([['EPUB/images/fig.png', 'EPUB/text/media/fig.png']]),
    )
    expect(next.get('EPUB/text/ch001.xhtml')).toBe('<img src="media/fig.png"/>')
  })

  it('leaves the source map untouched', () => {
    rewriteReferences(files, new Map([['EPUB/images/fig.png', 'EPUB/media/fig.png']]))
    expect(files.get('EPUB/text/ch002.xhtml')).toBe('<img src="fig.png"/>')
  })

  it('returns the same content when nothing matches', () => {
    const { files: next, touched } = rewriteReferences(files, new Map([['EPUB/nothing.png', 'EPUB/x.png']]))
    expect(touched).toEqual([])
    expect([...next].map(([path, text]) => [path, text])).toEqual([...files])
  })
})

describe('collectBrokenReferences', () => {
  it('reports references to paths the archive does not contain', () => {
    const files = book({
      'EPUB/text/ch001.xhtml': '<img src="../images/missing.png"/><img src="../images/here.png"/>',
    })
    const broken = collectBrokenReferences(
      files,
      new Set(['EPUB/text/ch001.xhtml', 'EPUB/images/here.png']),
    )
    expect(broken.map((ref) => ref.raw)).toEqual(['../images/missing.png'])
  })
})

describe('collectDocumentIds', () => {
  it('collects id and name attributes from start tags while ignoring comments and prose text', () => {
    const xhtml = `<body>
      <!-- <h2 id="commented">ignored</h2> -->
      <section id="sec1"><a name="fn1">note</a><p>text id="not-an-attr"</p></section>
      <p id='sec2'>more</p>
    </body>`
    expect([...collectDocumentIds(xhtml)].sort()).toEqual(['fn1', 'sec1', 'sec2'])
  })
})

describe('rewriteAnchorReferences', () => {
  it('rewrites external, TOC, and same-file fragment links when an anchor moves on split', () => {
    const files = book({
      'EPUB/nav.xhtml': '<a href="text/ch001.xhtml#keep">A</a><a href="text/ch001.xhtml#moved">B</a>',
      'EPUB/text/ch001.xhtml': '<a href="#moved">jump</a><a href="#keep">stay</a>',
      'EPUB/text/ch001_0001.xhtml': '<a href="#keep">back</a><a href="ch001.xhtml#moved">self</a>',
      'EPUB/text/ch002.xhtml': '<a href="ch001.xhtml#moved">ext</a>',
    })

    const anchorMoves = new Map([
      ['EPUB/text/ch001.xhtml', new Map([['moved', 'EPUB/text/ch001_0001.xhtml']])],
      ['EPUB/text/ch001_0001.xhtml', new Map([['keep', 'EPUB/text/ch001.xhtml']])],
    ])

    const { files: next, touched } = rewriteAnchorReferences(files, { anchorMoves })
    expect(next.get('EPUB/nav.xhtml')).toBe(
      '<a href="text/ch001.xhtml#keep">A</a><a href="text/ch001_0001.xhtml#moved">B</a>',
    )
    expect(next.get('EPUB/text/ch001.xhtml')).toBe('<a href="ch001_0001.xhtml#moved">jump</a><a href="#keep">stay</a>')
    expect(next.get('EPUB/text/ch001_0001.xhtml')).toBe('<a href="ch001.xhtml#keep">back</a><a href="#moved">self</a>')
    expect(next.get('EPUB/text/ch002.xhtml')).toBe('<a href="ch001_0001.xhtml#moved">ext</a>')
    expect(touched).toHaveLength(5)
  })

  it('rewrites whole-file links on merge and appends defaultFragment only for bare links', () => {
    const files = book({
      'EPUB/nav.xhtml': '<a href="text/ch002.xhtml">Ch2</a><a href="text/ch002.xhtml#sub">Sub</a>',
      'EPUB/text/ch001.xhtml': '<a href="ch002.xhtml">next</a><a href="ch002.xhtml#sub">sub</a>',
    })

    const wholeFileMoves = new Map([
      ['EPUB/text/ch002.xhtml', { path: 'EPUB/text/ch001.xhtml', defaultFragment: 'merge_ch002' }],
    ])

    const { files: next } = rewriteAnchorReferences(files, { wholeFileMoves })
    expect(next.get('EPUB/nav.xhtml')).toBe(
      '<a href="text/ch001.xhtml#merge_ch002">Ch2</a><a href="text/ch001.xhtml#sub">Sub</a>',
    )
    expect(next.get('EPUB/text/ch001.xhtml')).toBe('<a href="#merge_ch002">next</a><a href="#sub">sub</a>')
  })
})
