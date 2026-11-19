import { describe, expect, it } from 'vitest'
import { planReplace } from './replacePlan'

function book(files: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(files))
}

describe('planReplace', () => {
  it('replaces a literal across every file that has it', () => {
    const files = book({
      'EPUB/text/ch001.xhtml': '<p>马克思</p>',
      'EPUB/text/ch002.xhtml': '<p>马克思与恩格斯</p><p>马克思</p>',
      'EPUB/text/ch003.xhtml': '<p>无关</p>',
    })
    const plan = planReplace(files, { query: '马克思', replacement: '马克斯' })

    expect(plan.total).toBe(3)
    expect(plan.files.map((file) => file.path)).toEqual(['EPUB/text/ch001.xhtml', 'EPUB/text/ch002.xhtml'])
    expect(plan.files[1]?.text).toBe('<p>马克斯与恩格斯</p><p>马克斯</p>')
    expect(plan.files[1]?.count).toBe(2)
  })

  it('expands capture groups in regex mode', () => {
    const files = book({ 'EPUB/text/ch001.xhtml': '<h1>第一章</h1><h1>第二章</h1>' })
    const plan = planReplace(files, {
      query: '第([一二三四五六七八九十]+)章',
      replacement: '§$1',
      regex: true,
    })

    expect(plan.files[0]?.text).toBe('<h1>§一</h1><h1>§二</h1>')
    expect(plan.total).toBe(2)
  })

  it('supports $& for the whole match', () => {
    const files = book({ 'a.xhtml': 'ab' })
    const plan = planReplace(files, { query: 'b', replacement: '[$&]' })
    expect(plan.files[0]?.text).toBe('a[b]')
  })

  it('is case-insensitive unless asked otherwise', () => {
    const files = book({ 'a.xhtml': 'Marx marx MARX' })
    expect(planReplace(files, { query: 'marx', replacement: 'M' }).total).toBe(3)
    expect(planReplace(files, { query: 'marx', replacement: 'M', caseSensitive: true }).total).toBe(1)
  })

  it('treats regex characters as literals when regex is off', () => {
    const files = book({ 'a.xhtml': '<p>a.b</p><p>axb</p>' })
    const plan = planReplace(files, { query: 'a.b', replacement: 'X' })
    expect(plan.files[0]?.text).toBe('<p>X</p><p>axb</p>')
  })

  it('allows deleting with an empty replacement', () => {
    const files = book({ 'a.xhtml': 'a-b-c' })
    expect(planReplace(files, { query: '-', replacement: '' }).files[0]?.text).toBe('abc')
  })

  it('returns an empty plan for no query or an invalid pattern', () => {
    const files = book({ 'a.xhtml': 'abc' })
    expect(planReplace(files, { query: '', replacement: 'x' })).toEqual({ total: 0, files: [] })
    expect(planReplace(files, { query: '(', replacement: 'x', regex: true })).toEqual({ total: 0, files: [] })
  })

  it('leaves files without a match out of the plan', () => {
    const files = book({ 'a.xhtml': 'abc', 'b.xhtml': 'nothing' })
    expect(planReplace(files, { query: 'zzz', replacement: 'x' })).toEqual({ total: 0, files: [] })
  })

  it('does not mutate the source map', () => {
    const files = book({ 'a.xhtml': 'abc' })
    planReplace(files, { query: 'a', replacement: 'z' })
    expect(files.get('a.xhtml')).toBe('abc')
  })
})
