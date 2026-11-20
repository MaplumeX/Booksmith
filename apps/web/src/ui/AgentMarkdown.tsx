import { Check, Copy } from 'lucide-react'
import { Fragment, useState, type ReactNode } from 'react'

export type MarkdownBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { type: 'code'; lang: string; code: string; unclosed?: boolean }
  | { type: 'blockquote'; lines: string[] }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; start: number; items: string[] }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'hr' }
  | { type: 'paragraph'; text: string }

export type InlineToken =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: InlineToken[] }
  | { type: 'em'; children: InlineToken[] }
  | { type: 'del'; children: InlineToken[] }
  | { type: 'link'; label: string; href: string }

/**
 * Only allows http(s) URLs in rendered assistant Markdown links to prevent javascript:/data: XSS.
 * See ADR 2026-11-20-agent-sidebar-chat-ui.
 */
export function sanitizeHref(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href
    }
    return null
  } catch {
    return null
  }
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) => cell.trim())
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.includes('-')) return false
  const cells = splitTableRow(trimmed)
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? ''
  const trimmed = line.trim()
  if (!trimmed) return true
  if (/^```/.test(trimmed)) return true
  if (/^#{1,6}\s+/.test(trimmed)) return true
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) return true
  if (/^>\s?/.test(trimmed)) return true
  if (/^[-*+]\s+/.test(line.trimStart())) return true
  if (/^\d+\.\s+/.test(line.trimStart())) return true
  if (trimmed.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1] ?? '')) {
    return true
  }
  return false
}

export function parseMarkdownBlocks(source: string): MarkdownBlock[] {
  const normalized = source.replace(/\r\n?/g, '\n')
  if (!normalized.trim()) return []

  const lines = normalized.split('\n')
  const blocks: MarkdownBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()

    if (!trimmed) {
      i += 1
      continue
    }

    // Fenced code block (gracefully handles streaming unclosed blocks)
    const fenceMatch = /^```([^\s`]*)\s*$/.exec(trimmed)
    if (fenceMatch) {
      const lang = fenceMatch[1] ?? ''
      const codeLines: string[] = []
      i += 1
      let closed = false
      while (i < lines.length) {
        if (/^```\s*$/.test((lines[i] ?? '').trim())) {
          closed = true
          i += 1
          break
        }
        codeLines.push(lines[i] ?? '')
        i += 1
      }
      blocks.push({
        type: 'code',
        lang,
        code: codeLines.join('\n'),
        ...(closed ? {} : { unclosed: true }),
      })
      continue
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: 'hr' })
      i += 1
      continue
    }

    // Heading (# .. ###### clamped to h1..h4)
    const headingMatch = /^(#{1,6})\s+(.+?)\s*#*$/.exec(trimmed)
    if (headingMatch) {
      const rawLevel = headingMatch[1]!.length
      const level = (rawLevel > 4 ? 4 : rawLevel) as 1 | 2 | 3 | 4
      blocks.push({ type: 'heading', level, text: headingMatch[2]! })
      i += 1
      continue
    }

    // Blockquote
    if (/^>\s?/.test(trimmed)) {
      const quoteLines: string[] = []
      while (i < lines.length && /^>\s?/.test((lines[i] ?? '').trim())) {
        quoteLines.push((lines[i] ?? '').trim().replace(/^>\s?/, ''))
        i += 1
      }
      blocks.push({ type: 'blockquote', lines: quoteLines })
      continue
    }

    // GFM pipe table
    if (trimmed.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1] ?? '')) {
      const headers = splitTableRow(trimmed)
      i += 2
      const rows: string[][] = []
      while (i < lines.length) {
        const rowLine = (lines[i] ?? '').trim()
        if (!rowLine || !rowLine.includes('|')) break
        rows.push(splitTableRow(rowLine))
        i += 1
      }
      blocks.push({ type: 'table', headers, rows })
      continue
    }

    // Unordered list
    if (/^[-*+]\s+/.test(line.trimStart())) {
      const items: string[] = []
      while (i < lines.length) {
        const cur = lines[i] ?? ''
        const ulMatch = /^\s*[-*+]\s+(.*)$/.exec(cur)
        if (ulMatch) {
          items.push(ulMatch[1] ?? '')
          i += 1
        } else if (cur.trim() && /^\s{2,}/.test(cur) && items.length > 0 && !isBlockStart(lines, i)) {
          items[items.length - 1] = `${items[items.length - 1]}\n${cur.trim()}`
          i += 1
        } else {
          break
        }
      }
      blocks.push({ type: 'ul', items })
      continue
    }

    // Ordered list
    const olFirst = /^\s*(\d+)\.\s+(.*)$/.exec(line)
    if (olFirst) {
      const start = Number.parseInt(olFirst[1]!, 10) || 1
      const items: string[] = []
      while (i < lines.length) {
        const cur = lines[i] ?? ''
        const olMatch = /^\s*\d+\.\s+(.*)$/.exec(cur)
        if (olMatch) {
          items.push(olMatch[1] ?? '')
          i += 1
        } else if (cur.trim() && /^\s{2,}/.test(cur) && items.length > 0 && !isBlockStart(lines, i)) {
          items[items.length - 1] = `${items[items.length - 1]}\n${cur.trim()}`
          i += 1
        } else {
          break
        }
      }
      blocks.push({ type: 'ol', start, items })
      continue
    }

    // Paragraph (consumes consecutive non-block lines)
    const paraLines: string[] = [line]
    i += 1
    while (i < lines.length && !isBlockStart(lines, i)) {
      paraLines.push(lines[i] ?? '')
      i += 1
    }
    blocks.push({ type: 'paragraph', text: paraLines.join('\n') })
  }

  return blocks
}

const INLINE_PATTERN_SOURCE =
  '(`[^`\\n]+`)|(\\[([^\\]\\n]+)\\]\\(((?:[^()\\s]|\\([^()\\s]*\\))+)\\))|(\\*\\*([^*\\n]+(?:\\*(?!\\*)[^*\\n]*)*)\\*\\*)|(~~([^~\\n]+)~~)|(\\*(?!\\s)([^*\\n]+?)(?<!\\s)\\*)'

export function parseInlineTokens(text: string, depth = 0): InlineToken[] {
  if (depth > 4) return [{ type: 'text', text }]
  const tokens: InlineToken[] = []
  const pattern = new RegExp(INLINE_PATTERN_SOURCE, 'g')
  let lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', text: text.slice(lastIndex, match.index) })
    }

    if (match[1]) {
      tokens.push({ type: 'code', text: match[1].slice(1, -1) })
    } else if (match[2] && match[3] && match[4]) {
      const safe = sanitizeHref(match[4])
      if (safe) {
        tokens.push({ type: 'link', label: match[3], href: safe })
      } else {
        tokens.push({ type: 'text', text: match[3] })
      }
    } else if (match[5] && match[6]) {
      tokens.push({ type: 'strong', children: parseInlineTokens(match[6], depth + 1) })
    } else if (match[7] && match[8]) {
      tokens.push({ type: 'del', children: parseInlineTokens(match[8], depth + 1) })
    } else if (match[9] && match[10]) {
      tokens.push({ type: 'em', children: parseInlineTokens(match[10], depth + 1) })
    }

    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    tokens.push({ type: 'text', text: text.slice(lastIndex) })
  }

  return tokens
}

function renderInline(tokens: InlineToken[], keyPrefix: string): ReactNode[] {
  return tokens.map((token, idx) => {
    const key = `${keyPrefix}-${idx}`
    switch (token.type) {
      case 'text': {
        const parts = token.text.split('\n')
        if (parts.length === 1) return <Fragment key={key}>{token.text}</Fragment>
        return (
          <Fragment key={key}>
            {parts.map((part, pIdx) => (
              <Fragment key={`${key}-l-${pIdx}`}>
                {pIdx > 0 ? <br /> : null}
                {part}
              </Fragment>
            ))}
          </Fragment>
        )
      }
      case 'code':
        return (
          <code key={key} className="agent-md-code">
            {token.text}
          </code>
        )
      case 'strong':
        return <strong key={key}>{renderInline(token.children, key)}</strong>
      case 'em':
        return <em key={key}>{renderInline(token.children, key)}</em>
      case 'del':
        return <del key={key}>{renderInline(token.children, key)}</del>
      case 'link':
        return (
          <a key={key} href={token.href} target="_blank" rel="noopener noreferrer" className="agent-md-link">
            {token.label}
          </a>
        )
    }
  })
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="agent-md-pre-wrap">
      <div className="agent-md-pre-head">
        <span className="agent-md-pre-lang">{lang || 'text'}</span>
        <button
          type="button"
          className="agent-md-copy-btn"
          aria-label={copied ? '已复制代码' : '复制代码'}
          onClick={handleCopy}
        >
          {copied ? (
            <>
              <Check size={11} strokeWidth={2} aria-hidden="true" />
              <span>已复制</span>
            </>
          ) : (
            <>
              <Copy size={11} strokeWidth={1.75} aria-hidden="true" />
              <span>复制</span>
            </>
          )}
        </button>
      </div>
      <pre className="agent-md-pre">
        <code>{code}</code>
      </pre>
    </div>
  )
}

export function AgentMarkdown({ content }: { content: string }) {
  const blocks = parseMarkdownBlocks(content)
  if (blocks.length === 0) return null

  return (
    <div className="agent-md">
      {blocks.map((block, index) => {
        const key = `b-${index}`
        switch (block.type) {
          case 'heading': {
            const inner = renderInline(parseInlineTokens(block.text), key)
            if (block.level === 1) return <h3 key={key} className="agent-md-h1">{inner}</h3>
            if (block.level === 2) return <h4 key={key} className="agent-md-h2">{inner}</h4>
            if (block.level === 3) return <h5 key={key} className="agent-md-h3">{inner}</h5>
            return <h6 key={key} className="agent-md-h4">{inner}</h6>
          }
          case 'code':
            return <CodeBlock key={key} lang={block.lang} code={block.code} />
          case 'blockquote':
            return (
              <blockquote key={key} className="agent-md-quote">
                {block.lines.map((line, lIdx) => (
                  <p key={`${key}-q-${lIdx}`}>{renderInline(parseInlineTokens(line), `${key}-q-${lIdx}`)}</p>
                ))}
              </blockquote>
            )
          case 'ul':
            return (
              <ul key={key} className="agent-md-list">
                {block.items.map((item, iIdx) => (
                  <li key={`${key}-li-${iIdx}`}>{renderInline(parseInlineTokens(item), `${key}-li-${iIdx}`)}</li>
                ))}
              </ul>
            )
          case 'ol':
            return (
              <ol key={key} start={block.start} className="agent-md-list">
                {block.items.map((item, iIdx) => (
                  <li key={`${key}-li-${iIdx}`}>{renderInline(parseInlineTokens(item), `${key}-li-${iIdx}`)}</li>
                ))}
              </ol>
            )
          case 'table':
            return (
              <div key={key} className="agent-md-table-wrap">
                <table className="agent-md-table">
                  <thead>
                    <tr>
                      {block.headers.map((header, hIdx) => (
                        <th key={`${key}-h-${hIdx}`}>
                          {renderInline(parseInlineTokens(header), `${key}-h-${hIdx}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rIdx) => (
                      <tr key={`${key}-r-${rIdx}`}>
                        {block.headers.map((_, cIdx) => (
                          <td key={`${key}-c-${rIdx}-${cIdx}`}>
                            {renderInline(parseInlineTokens(row[cIdx] ?? ''), `${key}-c-${rIdx}-${cIdx}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          case 'hr':
            return <hr key={key} className="agent-md-hr" />
          case 'paragraph':
            return (
              <p key={key} className="agent-md-p">
                {renderInline(parseInlineTokens(block.text), key)}
              </p>
            )
        }
      })}
    </div>
  )
}
