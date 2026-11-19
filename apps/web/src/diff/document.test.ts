import { describe, expect, it } from 'vitest'
import { diffChars, diffLines, sourceDocument, type LineDiff } from './document'

function kinds(diffs: LineDiff[]): string[] {
  return diffs.map((entry) => entry.kind)
}

function textsOf(diffs: LineDiff[]): string[] {
  return diffs.map((entry) =>
    entry.kind === 'changed'
      ? entry.segments
          .filter((segment) => segment.kind !== 'removed')
          .map((segment) => segment.text)
          .join('')
      : entry.text,
  )
}

describe('diffChars', () => {
  it('marks only the changed characters', () => {
    expect(diffChars('第5章 开端', '第5章 开端与终结')).toEqual([
      { kind: 'same', text: '第5章 开端' },
      { kind: 'added', text: '与终结' },
    ])
  })

  it('keeps the shared suffix after an insertion', () => {
    expect(diffChars('他说“好”', '他说“不好”')).toEqual([
      { kind: 'same', text: '他说“' },
      { kind: 'added', text: '不' },
      { kind: 'same', text: '好”' },
    ])
  })

  it('returns a single same segment for identical text', () => {
    expect(diffChars('不变', '不变')).toEqual([{ kind: 'same', text: '不变' }])
  })
})

describe('diffLines', () => {
  it('marks identical source as unchanged', () => {
    const text = '<p>一</p>\n<p>二</p>'
    expect(kinds(diffLines(text, text))).toEqual(['same', 'same'])
  })

  it('character-diffs a single edited line instead of red/green neighbours', () => {
    const diffs = diffLines('<p>这段话错了</p>\n<p>后记</p>', '<p>这段话对了</p>\n<p>后记</p>')
    expect(kinds(diffs)).toEqual(['changed', 'same'])
    const first = diffs[0]!
    if (first.kind !== 'changed') throw new Error('expected changed line')
    expect(first.segments).toEqual([
      { kind: 'same', text: '<p>这段话' },
      { kind: 'removed', text: '错' },
      { kind: 'added', text: '对' },
      { kind: 'same', text: '了</p>' },
    ])
  })

  it('reports an inserted line', () => {
    const diffs = diffLines('<p>一</p>\n<p>三</p>', '<p>一</p>\n<p>二</p>\n<p>三</p>')
    expect(kinds(diffs)).toEqual(['same', 'added', 'same'])
    expect(textsOf(diffs)).toEqual(['<p>一</p>', '<p>二</p>', '<p>三</p>'])
  })

  it('reports a deleted line', () => {
    const diffs = diffLines('<p>一</p>\n<p>二</p>\n<p>三</p>', '<p>一</p>\n<p>三</p>')
    expect(kinds(diffs)).toEqual(['same', 'removed', 'same'])
  })

  it('keeps multi-line replacements as separate removed and added lines', () => {
    const diffs = diffLines('<p>甲</p>\n<p>乙</p>', '<p>丙</p>\n<p>丁</p>')
    expect(kinds(diffs)).toEqual(['removed', 'removed', 'added', 'added'])
  })

  it('preserves order across an unrelated edit', () => {
    const diffs = diffLines('a\nb\nc', 'a\nB\nc')
    expect(kinds(diffs)).toEqual(['same', 'changed', 'same'])
    expect(textsOf(diffs)).toEqual(['a', 'B', 'c'])
  })

  it('surfaces a changed attribute, which the rendered diff could not show', () => {
    const diffs = diffLines('<p class="lead">正文</p>', '<p class="note">正文</p>')
    expect(kinds(diffs)).toEqual(['changed'])
    const first = diffs[0]!
    if (first.kind !== 'changed') throw new Error('expected changed line')
    const beforeText = first.segments
      .filter((segment) => segment.kind !== 'added')
      .map((segment) => segment.text)
      .join('')
    const afterText = first.segments
      .filter((segment) => segment.kind !== 'removed')
      .map((segment) => segment.text)
      .join('')
    expect(beforeText).toBe('<p class="lead">正文</p>')
    expect(afterText).toBe('<p class="note">正文</p>')
  })
})

describe('sourceDocument', () => {
  it('concatenates spine documents with a comment naming the source file', () => {
    const texts = new Map([
      ['EPUB/text/ch001.xhtml', '<p>一</p>'],
      ['EPUB/text/ch002.xhtml', '<p>二</p>'],
    ])
    expect(sourceDocument(['EPUB/text/ch001.xhtml', 'EPUB/text/ch002.xhtml'], texts)).toBe(
      '<!-- EPUB/text/ch001.xhtml -->\n<p>一</p>\n<!-- EPUB/text/ch002.xhtml -->\n<p>二</p>',
    )
  })

  it('skips spine entries that have no text', () => {
    expect(sourceDocument(['missing.xhtml'], new Map())).toBe('')
  })
})
