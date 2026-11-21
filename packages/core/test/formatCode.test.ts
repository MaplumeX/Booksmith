import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import { formatCss, formatXhtml, isTextEntry, openEpub } from '../src'
import type { XmlCodec } from '../src/xml'

const codec: XmlCodec = {
  parse: (xml) => new DOMParser().parseFromString(xml, 'application/xml') as unknown as Document,
  serialize: (node) => new XMLSerializer().serializeToString(node as never),
}

const decoder = new TextDecoder('utf-8')

describe('formatXhtml', () => {
  it('indents minified XHTML cleanly while keeping inline spacing, comments, and declarations intact', () => {
    const messy =
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><meta charset="utf-8"/><title>Demo</title><link rel="stylesheet" href="../styles/a.css"/></head><body><!-- intro --><section epub:type="chapter"><h1>Hello <em>world</em>!</h1><p>中文<a href="#n1"><sup>1</sup></a>续写。</p></section></body></html>'

    const formatted = formatXhtml(messy, codec)
    expect(formatted).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE html>',
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">',
        '  <head>',
        '    <meta charset="utf-8"/>',
        '    <title>Demo</title>',
        '    <link rel="stylesheet" href="../styles/a.css"/>',
        '  </head>',
        '  <body>',
        '    <!-- intro -->',
        '    <section epub:type="chapter">',
        '      <h1>Hello <em>world</em>!</h1>',
        '      <p>中文<a href="#n1"><sup>1</sup></a>续写。</p>',
        '    </section>',
        '  </body>',
        '</html>',
        '',
      ].join('\n'),
    )
    // Idempotent on second pass.
    expect(formatXhtml(formatted, codec)).toBe(formatted)
  })

  it('preserves <pre>, <math>, <svg>, and <style> blocks byte-for-byte', () => {
    const mathBlock =
      '<math xmlns="http://www.w3.org/1998/Math/MathML"><mrow><mi>a</mi><mo>+</mo><mi>b</mi></mrow></math>'
    const preBlock = '<pre>  line 1\n    indented line 2\n</pre>'
    const input = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><style>body { color: red; }\n  p { margin: 0; }</style></head><body><div>${preBlock}<p>公式：${mathBlock} 结束</p></div></body></html>`

    const formatted = formatXhtml(input, codec)
    expect(formatted).toContain(preBlock)
    expect(formatted).toContain(mathBlock)
    expect(formatted).toContain('<style>body { color: red; }\n  p { margin: 0; }</style>')
    expect(formatted).toContain(`<p>公式：${mathBlock} 结束</p>`)
  })

  it('preserves CRLF dominant line endings and rejects malformed XML', () => {
    const crlf = '<?xml version="1.0"?>\r\n<html xmlns="http://www.w3.org/1999/xhtml">\r\n<body><p>hi</p></body></html>\r\n'
    const formatted = formatXhtml(crlf, codec)
    expect(formatted).toContain('\r\n')
    expect(formatted.replace(/\r\n/g, '')).not.toContain('\n')

    expect(() =>
      formatXhtml('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>broken</div></body></html>', codec),
    ).toThrow(/语法|不匹配|闭合/)
  })

  it('formats every chapter of the real MathML fixture book idempotently without losing MathML or prose', () => {
    const epubPath = resolve(__dirname, '../../../fixtures/马克思经济学与数理分析.epub')
    const { archive, pkg } = openEpub(new Uint8Array(readFileSync(epubPath)), codec.parse)

    let checked = 0
    for (const id of pkg.spine) {
      const item = pkg.manifest.find((m) => m.id === id)
      if (!item) continue
      const bytes = archive.entries.get(item.path)
      if (!bytes || !isTextEntry(item.path)) continue
      const original = decoder.decode(bytes)
      const once = formatXhtml(original, codec)
      const twice = formatXhtml(once, codec)
      expect(twice).toBe(once)

      // Strip all tags and collapse whitespace to verify prose content never changes.
      const proseOf = (s: string) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, '')
      expect(proseOf(once)).toBe(proseOf(original))
      expect((once.match(/<math\b/gi) ?? []).length).toBe((original.match(/<math\b/gi) ?? []).length)
      checked += 1
    }
    expect(checked).toBeGreaterThanOrEqual(20)
  })
})

describe('formatCss', () => {
  it('formats selectors, declarations, comments, url(data:...) and nested @media blocks idempotently', () => {
    const messy =
      '@charset "utf-8";/* base */body,html{margin:0;padding:0;background:url("data:image/svg+xml;utf8,<svg/>")}@media (max-width:600px){h1{font-size:1.2em;line-height:1.4}}'
    const formatted = formatCss(messy)
    expect(formatted).toBe(
      [
        '@charset "utf-8";',
        '',
        '/* base */',
        '',
        'body, html {',
        '  margin: 0;',
        '  padding: 0;',
        '  background: url("data:image/svg+xml;utf8,<svg/>");',
        '}',
        '',
        '@media (max-width:600px) {',
        '  h1 {',
        '    font-size: 1.2em;',
        '    line-height: 1.4;',
        '  }',
        '}',
        '',
      ].join('\n'),
    )
    expect(formatCss(formatted)).toBe(formatted)
  })
})
