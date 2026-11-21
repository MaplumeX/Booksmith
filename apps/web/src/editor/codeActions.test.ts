import { describe, expect, it } from 'vitest'
import {
  insertAnchorId,
  insertHorizontalRule,
  insertImageTag,
  insertLinkTag,
  wrapBlockTag,
  wrapInlineTag,
  wrapList,
} from './codeActions'

function apply(doc: string, res: ReturnType<typeof wrapInlineTag>) {
  return doc.slice(0, res.from) + res.insert + doc.slice(res.to)
}

describe('codeActions', () => {
  it('wraps and toggles inline tags cleanly', () => {
    const doc = '<p>Hello world</p>'
    const wrapped = wrapInlineTag(doc, 9, 14, 'strong')
    const afterWrap = apply(doc, wrapped)
    expect(afterWrap).toBe('<p>Hello <strong>world</strong></p>')

    // Re-running on inner selection unwraps it.
    const unwrapped = wrapInlineTag(afterWrap, wrapped.selection.anchor, wrapped.selection.head!, 'strong')
    expect(apply(afterWrap, unwrapped)).toBe(doc)
  })

  it('converts an existing block line or wraps plain text with wrapBlockTag', () => {
    const doc = '  <p class="lead">第一章</p>\n<p>正文</p>'
    const converted = wrapBlockTag(doc, 12, 12, 'h1')
    expect(apply(doc, converted)).toBe('  <h1 class="lead">第一章</h1>\n<p>正文</p>')

    const plain = '  未包裹的一行'
    const wrapped = wrapBlockTag(plain, 4, 4, 'p')
    expect(apply(plain, wrapped)).toBe('  <p>未包裹的一行</p>')
  })

  it('converts multi-line selections into ul/ol lists and strips outer <p>', () => {
    const doc = '  <p>第一项</p>\n  <p>第二项</p>'
    const res = wrapList(doc, 0, doc.length, 'ul')
    expect(apply(doc, res)).toBe('  <ul>\n    <li>第一项</li>\n    <li>第二项</li>\n  </ul>')
  })

  it('injects or updates id on current line opening tag, or inserts anchor/span', () => {
    const heading = '  <h2>引言</h2>'
    const injected = insertAnchorId(heading, 5, 5, 'sec-intro')!
    expect(apply(heading, injected)).toBe('  <h2 id="sec-intro">引言</h2>')

    const updated = insertAnchorId('  <h2 id="old">引言</h2>', 5, 5, 'sec-new')!
    expect(apply('  <h2 id="old">引言</h2>', updated)).toBe('  <h2 id="sec-new">引言</h2>')

    const span = insertAnchorId('plain text', 0, 5, 'mark1')!
    expect(apply('plain text', span)).toBe('<span id="mark1">plain</span> text')

    expect(insertAnchorId(heading, 5, 5, '123 bad')).toBeNull()
  })

  it('inserts links, images, and horizontal rules', () => {
    const link = insertLinkTag('<p>参考资料</p>', 3, 7, 'ch002.xhtml#ref')!
    expect(apply('<p>参考资料</p>', link)).toBe('<p><a href="ch002.xhtml#ref">参考资料</a></p>')

    const img = insertImageTag('<p></p>', 3, 3, '../images/fig1.png', '示意图')!
    expect(apply('<p></p>', img)).toBe('<p><img src="../images/fig1.png" alt="示意图" /></p>')

    const hr = insertHorizontalRule('<p>a</p>', 8, 8)
    expect(apply('<p>a</p>', hr)).toBe('<p>a</p><hr />')
  })
})
