import { describe, expect, it } from 'vitest'
import type { XmlDocumentParser } from '@booksmith/core'
import {
  checkXmlWellFormed,
  extractBodyRange,
  extractTopLevelIslands,
  replaceBodyInXhtml,
  serializeEditableBody,
  type EditableAttrLike,
  type EditableNodeLike,
} from './wysiwygXhtml'

function el(
  tagName: string,
  attrs: Record<string, string> = {},
  children: EditableNodeLike[] = [],
): EditableNodeLike {
  const entries: EditableAttrLike[] = Object.entries(attrs).map(([name, value]) => ({ name, value }))
  const map = new Map(Object.entries(attrs))
  return {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    attributes: entries,
    childNodes: children,
    getAttribute: (name) => map.get(name) ?? null,
    hasAttribute: (name) => map.has(name),
  }
}

function txt(value: string): EditableNodeLike {
  return { nodeType: 3, nodeValue: value, childNodes: [] }
}

function comment(value: string): EditableNodeLike {
  return { nodeType: 8, nodeValue: value, childNodes: [] }
}

const SAMPLE_XHTML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <link rel="stylesheet" type="text/css" href="../styles/stylesheet1.css" />
  <title>ch010.xhtml</title>
</head>
<body epub:type="bodymatter">
<section id="第五章-推导" epub:type="chapter">
<h1>第五章</h1>
<p>公式 <math display="inline" xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mn>4000</mn><msub><mi>C</mi><mn>1</mn></msub></mrow><annotation encoding="application/x-tex">4000C_1</annotation></semantics></math> 成立。</p>
<p><img src="../media/fig1.png" alt="图一" /></p>
</section>
</body>
</html>`

describe('wysiwygXhtml', () => {
  it('validates well-formedness and rejects missing body or parsererror', () => {
    const okParser: XmlDocumentParser = () =>
      ({
        documentElement: { nodeName: 'html' },
        getElementsByTagName: () => [],
      }) as unknown as Document

    expect(checkXmlWellFormed(SAMPLE_XHTML, okParser)).toEqual({ ok: true })
    expect(checkXmlWellFormed('<html><head/></html>', okParser).ok).toBe(false)

    const errorParser: XmlDocumentParser = () =>
      ({
        documentElement: { nodeName: 'html' },
        getElementsByTagName: (tag: string) =>
          tag === 'parsererror' ? [{ textContent: 'Opening and ending tag mismatch: p line 12' }] : [],
      }) as unknown as Document

    const failed = checkXmlWellFormed(SAMPLE_XHTML, errorParser)
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.message).toContain('Opening and ending tag mismatch')

    const throwingParser: XmlDocumentParser = () => {
      throw new Error('unclosed tag')
    }
    expect(checkXmlWellFormed(SAMPLE_XHTML, throwingParser).ok).toBe(false)
  })

  it('extracts body range while preserving prolog, head, and body attributes', () => {
    const range = extractBodyRange(SAMPLE_XHTML)
    expect(range).not.toBeNull()
    expect(range?.openTag).toBe('<body epub:type="bodymatter">')
    expect(range?.innerXml).toContain('<section id="第五章-推导" epub:type="chapter">')
  })

  it('extracts top-level protection islands and skips comments, CDATA, and nested islands', () => {
    const inner = `
      <!-- <math><mi>ignored</mi></math> -->
      <p><![CDATA[<svg></svg>]]></p>
      <p>A <math display="inline" xmlns="http://www.w3.org/1998/Math/MathML"><mrow><mi>x</mi><mo>></mo><mn>0</mn></mrow></math></p>
      <svg viewBox="0 0 10 10"><svg width="4" height="4"/></svg>
      <audio controls="controls" />
    `
    const islands = extractTopLevelIslands(inner)
    expect(islands).toEqual([
      '<math display="inline" xmlns="http://www.w3.org/1998/Math/MathML"><mrow><mi>x</mi><mo>></mo><mn>0</mn></mrow></math>',
      '<svg viewBox="0 0 10 10"><svg width="4" height="4"/></svg>',
      '<audio controls="controls" />',
    ])
  })

  it('serializes edited body cleanly, restoring images, islands, namespaces, and stripping editor artifacts', () => {
    const range = extractBodyRange(SAMPLE_XHTML)!
    const islands = extractTopLevelIslands(range.innerXml)

    const bodyDom = el('body', { contenteditable: 'true', spellcheck: 'false' }, [
      el('section', { id: '第五章-推导', 'epub:type': 'chapter' }, [
        el('h1', {}, [txt('第五章（修订）')]),
        el('p', {}, [
          txt('公式 & 推导 '),
          el(
            'math',
            {
              'data-booksmith-island': '0',
              contenteditable: 'false',
              tabindex: '0',
              'data-booksmith-tabindex': 'true',
              'data-booksmith-selected': 'true',
            },
            [txt('mutated-should-be-ignored')],
          ),
          txt(' 已校对。'),
        ]),
        el('p', {}, [
          el('img', {
            src: 'blob:http://127.0.0.1:5173/abc-123',
            alt: '图一（修订）',
            'data-booksmith-src': '../media/fig1.png',
          }),
          el('img', {
            alt: '原图注（缺失图片：../media/missing.png）',
            'data-booksmith-src': '../media/missing.png',
            'data-booksmith-orig-alt': '原图注',
            'data-missing': 'true',
          }),
          el('img', {
            alt: '（缺失图片：../media/no-alt.png）',
            'data-booksmith-src': '../media/no-alt.png',
            'data-booksmith-no-alt': 'true',
            'data-missing': 'true',
          }),
          el('img', { src: 'blob:http://127.0.0.1:5173/orphan-blob', alt: 'orphan' }),
        ]),
        el('p', {}, [txt('空行测试'), el('br'), txt('下一行')]),
        el('p', {}, []),
        el('span', { 'data-booksmith-ui': 'true' }, [txt('should-drop')]),
        comment('保留注释'),
      ]),
    ])

    const serializedBody = serializeEditableBody(bodyDom, SAMPLE_XHTML, islands)
    const nextXhtml = replaceBodyInXhtml(SAMPLE_XHTML, serializedBody)

    // Prolog & head stay byte-for-byte intact.
    expect(nextXhtml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>')).toBe(true)
    expect(nextXhtml).toContain('<link rel="stylesheet" type="text/css" href="../styles/stylesheet1.css" />')
    expect(nextXhtml).toContain('<body epub:type="bodymatter">')
    expect(nextXhtml).toContain('<section id="第五章-推导" epub:type="chapter">')
    expect(nextXhtml).toContain('<h1>第五章（修订）</h1>')
    expect(nextXhtml).toContain('<p>公式 &amp; 推导 <math display="inline" xmlns="http://www.w3.org/1998/Math/MathML">')
    expect(nextXhtml).toContain('<annotation encoding="application/x-tex">4000C_1</annotation>')
    expect(nextXhtml).toContain('<img src="../media/fig1.png" alt="图一（修订）" />')
    expect(nextXhtml).toContain('<img src="../media/missing.png" alt="原图注" />')
    expect(nextXhtml).toContain('<img src="../media/no-alt.png" />')
    expect(nextXhtml).toContain('<img alt="orphan" />')
    expect(nextXhtml).toContain('<br />')
    expect(nextXhtml).toContain('<p></p>')
    expect(nextXhtml).toContain('<!--保留注释-->')

    expect(nextXhtml).not.toContain('blob:')
    expect(nextXhtml).not.toContain('contenteditable')
    expect(nextXhtml).not.toContain('data-booksmith-')
    expect(nextXhtml).not.toContain('data-missing')
    expect(nextXhtml).not.toContain('tabindex')
    expect(nextXhtml).not.toContain('mutated-should-be-ignored')
    expect(nextXhtml).not.toContain('should-drop')
  })
})
