import { describe, expect, it } from 'vitest'
import { parseInlineTokens, parseMarkdownBlocks, sanitizeHref } from './AgentMarkdown'

describe('AgentMarkdown parser', () => {
  it('parses headings, paragraphs, lists, quotes, tables, hr and fenced code blocks', () => {
    const md = [
      '## 校对摘要',
      '',
      '已定位以下问题：',
      '',
      '- 第 1 处：`ch001.xhtml` 引号不匹配',
      '- 第 2 处：**重复段落**',
      '',
      '1. 先备份',
      '2. 再应用提案',
      '',
      '> 建议开启结构检查确认无断链',
      '',
      '| 文件 | 问题 |',
      '| --- | --- |',
      '| ch001.xhtml | 标点 |',
      '',
      '---',
      '',
      '```xml',
      '<p>示例</p>',
      '```',
    ].join('\n')

    const blocks = parseMarkdownBlocks(md)
    expect(blocks.map((b) => b.type)).toEqual([
      'heading',
      'paragraph',
      'ul',
      'ol',
      'blockquote',
      'table',
      'hr',
      'code',
    ])
    expect(blocks[0]).toEqual({ type: 'heading', level: 2, text: '校对摘要' })
    expect(blocks[2]).toEqual({
      type: 'ul',
      items: ['第 1 处：`ch001.xhtml` 引号不匹配', '第 2 处：**重复段落**'],
    })
    expect(blocks[5]).toEqual({
      type: 'table',
      headers: ['文件', '问题'],
      rows: [['ch001.xhtml', '标点']],
    })
    expect(blocks[7]).toEqual({
      type: 'code',
      lang: 'xml',
      code: '<p>示例</p>',
    })
  })

  it('handles unclosed streaming fenced code blocks without dropping content', () => {
    const blocks = parseMarkdownBlocks('```html\n<section>\n  <h1>第一章</h1>')
    expect(blocks).toEqual([
      {
        type: 'code',
        lang: 'html',
        code: '<section>\n  <h1>第一章</h1>',
        unclosed: true,
      },
    ])
  })

  it('parses inline formatting and blocks unsafe link protocols', () => {
    const tokens = parseInlineTokens(
      '修改 **加粗与 `代码`**、*斜体*、~~删除~~、[文档](https://example.com/a) 和 [恶意](javascript:alert(1))',
    )
    expect(tokens).toEqual([
      { type: 'text', text: '修改 ' },
      {
        type: 'strong',
        children: [
          { type: 'text', text: '加粗与 ' },
          { type: 'code', text: '代码' },
        ],
      },
      { type: 'text', text: '、' },
      { type: 'em', children: [{ type: 'text', text: '斜体' }] },
      { type: 'text', text: '、' },
      { type: 'del', children: [{ type: 'text', text: '删除' }] },
      { type: 'text', text: '、' },
      { type: 'link', label: '文档', href: 'https://example.com/a' },
      { type: 'text', text: ' 和 ' },
      { type: 'text', text: '恶意' },
    ])
  })

  it('allows only http and https URLs in sanitizeHref', () => {
    expect(sanitizeHref('https://booksmith.dev/docs')).toBe('https://booksmith.dev/docs')
    expect(sanitizeHref('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787/')
    expect(sanitizeHref('javascript:alert(1)')).toBeNull()
    expect(sanitizeHref('data:text/html,hi')).toBeNull()
    expect(sanitizeHref('not a url')).toBeNull()
  })
})
