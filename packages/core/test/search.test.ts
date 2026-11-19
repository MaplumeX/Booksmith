import { readFileSync } from 'node:fs'
import { DOMParser } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import { groupMatches, searchBook, type SearchFile } from '../src/search'
import { openEpub } from '../src'

const bytes = new Uint8Array(readFileSync(new URL('../../../fixtures/马克思经济学与数理分析.epub', import.meta.url)))
const parse = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml') as unknown as Document
const { archive } = openEpub(bytes, parse)
const decoder = new TextDecoder('utf-8')
const files: SearchFile[] = [...archive.entries]
  .filter(([path]) => path.endsWith('.xhtml'))
  .map(([path, data]) => ({ path, text: decoder.decode(data) }))

describe('search across a real book', () => {
  it('finds every occurrence across many chapters', () => {
    const result = searchBook(files, '马克思')
    expect(result.truncated).toBe(false)
    expect(result.matches.length).toBeGreaterThanOrEqual(100)
    expect(new Set(result.matches.map((match) => match.path)).size).toBeGreaterThanOrEqual(20)
  })

  it('supports regular expressions over chapter headings', () => {
    const result = searchBook(files, '第[一二三四五六七八九十]+章', { regex: true })
    // The book has 16 numbered chapters; each heading also repeats in the nav and toc.
    expect(result.matches.length).toBeGreaterThanOrEqual(16)
    expect(new Set(result.matches.map((match) => match.path)).size).toBeGreaterThanOrEqual(16)
  })

  it('reports line and column for the first hit', () => {
    const result = searchBook([{ path: 'a.xhtml', text: 'first line\n第二行有马克思\n' }], '马克思')
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]).toMatchObject({ line: 2, column: 5 })
    expect(result.matches[0]?.preview).toContain('马克思')
  })

  it('groups matches per file in file order', () => {
    const result = searchBook(files, '置盐定理')
    const groups = groupMatches(result.matches)
    expect(groups.length).toBeGreaterThanOrEqual(3)
    expect(groups.reduce((sum, group) => sum + group.matches.length, 0)).toBe(result.matches.length)
  })

  it('respects case sensitivity', () => {
    const sample: SearchFile[] = [{ path: 'a.css', text: 'Body { color: red } body { margin: 0 }' }]
    expect(searchBook(sample, 'body').matches).toHaveLength(2)
    expect(searchBook(sample, 'body', { caseSensitive: true }).matches).toHaveLength(1)
  })

  it('escapes plain queries instead of treating them as regex', () => {
    const sample: SearchFile[] = [{ path: 'a.xhtml', text: 'price (net) is 3.50' }]
    expect(searchBook(sample, '(net)').matches).toHaveLength(1)
    expect(searchBook(sample, '3.50').matches).toHaveLength(1)
  })

  it('returns nothing for an empty or invalid query', () => {
    expect(searchBook(files, '').matches).toHaveLength(0)
    expect(searchBook(files, '([', { regex: true }).matches).toHaveLength(0)
  })

  it('stops at the result cap', () => {
    const result = searchBook(files, '马克思', { maxResults: 5 })
    expect(result.matches).toHaveLength(5)
    expect(result.truncated).toBe(true)
  })
})
