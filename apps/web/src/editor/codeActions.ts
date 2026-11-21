/**
 * Pure CodeMirror single-transaction XHTML editing primitives (wrap block/inline, list conversion,
 * anchor ID injection, link/image/hr/text insertion). Every action returns a single change spec so
 * one Cmd/Ctrl+Z reverts the entire edit cleanly.
 * See ADR 2026-11-21-code-productivity-and-command-palette.
 */

export type CodeBlockTag = 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'blockquote'
export type CodeInlineTag = 'strong' | 'em' | 'code' | 'sup' | 'sub'
export type CodeListTag = 'ul' | 'ol'

export interface CodeEditResult {
  from: number
  to: number
  insert: string
  selection: { anchor: number; head?: number }
}

const CONVERTIBLE_BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div'])

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Toggles or wraps `[from, to]` in an inline XHTML tag (`<strong>`, `<em>`, `<code>`, `<sup>`, `<sub>`). */
export function wrapInlineTag(doc: string, from: number, to: number, tag: CodeInlineTag): CodeEditResult {
  const open = `<${tag}>`
  const close = `</${tag}>`
  const selected = doc.slice(from, to)

  // Case 1: Selection itself includes `<tag>...</tag>` -> unwrap.
  const selfPattern = new RegExp(`^<${tag}>([\\s\\S]*)</${tag}>$`, 'i')
  const selfMatch = selfPattern.exec(selected)
  if (selfMatch && selfMatch[1] !== undefined) {
    const inner = selfMatch[1]
    return {
      from,
      to,
      insert: inner,
      selection: { anchor: from, head: from + inner.length },
    }
  }

  // Case 2: Selection is immediately flanked by `<tag>` and `</tag>` -> unwrap.
  if (
    from >= open.length &&
    doc.slice(from - open.length, from).toLowerCase() === open &&
    doc.slice(to, to + close.length).toLowerCase() === close
  ) {
    return {
      from: from - open.length,
      to: to + close.length,
      insert: selected,
      selection: { anchor: from - open.length, head: from - open.length + selected.length },
    }
  }

  if (from === to) {
    const insert = `${open}${close}`
    return {
      from,
      to,
      insert,
      selection: { anchor: from + open.length },
    }
  }

  const insert = `${open}${selected}${close}`
  return {
    from,
    to,
    insert,
    selection: { anchor: from + open.length, head: from + open.length + selected.length },
  }
}

/** Wraps selection or converts the current block line to `p` / `h1`–`h4` / `blockquote`. */
export function wrapBlockTag(doc: string, from: number, to: number, tag: CodeBlockTag): CodeEditResult {
  if (from !== to) {
    const selected = doc.slice(from, to)
    if (tag !== 'blockquote') {
      const existing = /^<([a-z][a-z0-9]*)(\s[^>]*)?>([\s\S]*)<\/\1>$/i.exec(selected.trim())
      if (existing?.[1] && CONVERTIBLE_BLOCKS.has(existing[1].toLowerCase())) {
        const attrs = existing[2] ?? ''
        const inner = existing[3] ?? ''
        const insert = `<${tag}${attrs}>${inner}</${tag}>`
        return { from, to, insert, selection: { anchor: from, head: from + insert.length } }
      }
    }
    const insert =
      tag === 'blockquote' && selected.includes('\n')
        ? `<blockquote>\n${selected}\n</blockquote>`
        : `<${tag}>${selected}</${tag}>`
    return {
      from,
      to,
      insert,
      selection: { anchor: from, head: from + insert.length },
    }
  }

  // Collapsed cursor: operate on the current line.
  const lineStart = doc.lastIndexOf('\n', from - 1) + 1
  const nextNewline = doc.indexOf('\n', from)
  const lineEnd = nextNewline < 0 ? doc.length : nextNewline
  const line = doc.slice(lineStart, lineEnd)
  const indentMatch = /^([ \t]*)/.exec(line)
  const indent = indentMatch?.[1] ?? ''
  const trimmed = line.trim()

  if (!trimmed) {
    const insert = `<${tag}></${tag}>`
    return {
      from,
      to,
      insert,
      selection: { anchor: from + tag.length + 2 },
    }
  }

  if (tag !== 'blockquote') {
    const existing = /^<([a-z][a-z0-9]*)(\s[^>]*)?>([\s\S]*)<\/\1>$/i.exec(trimmed)
    if (existing?.[1] && CONVERTIBLE_BLOCKS.has(existing[1].toLowerCase())) {
      const attrs = existing[2] ?? ''
      const inner = existing[3] ?? ''
      const insert = `${indent}<${tag}${attrs}>${inner}</${tag}>`
      return {
        from: lineStart,
        to: lineEnd,
        insert,
        selection: { anchor: lineStart + insert.length },
      }
    }
  }

  const insert = `${indent}<${tag}>${trimmed}</${tag}>`
  return {
    from: lineStart,
    to: lineEnd,
    insert,
    selection: { anchor: lineStart + insert.length },
  }
}

/** Converts selected lines (or current line) into a `<ul>` or `<ol>` list. */
export function wrapList(doc: string, from: number, to: number, listTag: CodeListTag): CodeEditResult {
  const lineStart = doc.lastIndexOf('\n', Math.max(0, from - 1)) + 1
  const endLookup = to > from && doc[to - 1] === '\n' ? to - 1 : to
  const nextNewline = doc.indexOf('\n', endLookup)
  const lineEnd = nextNewline < 0 ? doc.length : nextNewline

  const block = doc.slice(lineStart, lineEnd)
  const indentMatch = /^([ \t]*)/.exec(block)
  const indent = indentMatch?.[1] ?? ''
  const rawLines = block.split('\n').map((line) => line.trim()).filter(Boolean)

  if (rawLines.length === 0) {
    const insert = `${indent}<${listTag}>\n${indent}  <li></li>\n${indent}</${listTag}>`
    const caret = lineStart + `${indent}<${listTag}>\n${indent}  <li>`.length
    return { from: lineStart, to: lineEnd, insert, selection: { anchor: caret } }
  }

  const items = rawLines.map((line) => {
    const stripped = line.replace(/^<(?:p|li)(?:\s[^>]*)?>([\s\S]*)<\/(?:p|li)>$/i, '$1').trim()
    return `${indent}  <li>${stripped}</li>`
  })
  const insert = `${indent}<${listTag}>\n${items.join('\n')}\n${indent}</${listTag}>`
  return {
    from: lineStart,
    to: lineEnd,
    insert,
    selection: { anchor: lineStart, head: lineStart + insert.length },
  }
}

/**
 * Injects or updates `id="..."` on the current line's opening element tag when possible;
 * otherwise inserts an `<a id="..."></a>` anchor at the cursor or wraps the selection in `<span id="...">`.
 */
export function insertAnchorId(doc: string, from: number, to: number, rawId: string): CodeEditResult | null {
  const id = rawId.trim()
  if (!id || !/^[A-Za-z_][\w:.-]*$/.test(id)) return null

  if (from === to) {
    const lineStart = doc.lastIndexOf('\n', from - 1) + 1
    const nextNewline = doc.indexOf('\n', from)
    const lineEnd = nextNewline < 0 ? doc.length : nextNewline
    const line = doc.slice(lineStart, lineEnd)
    const openMatch = /^([ \t]*<([A-Za-z_][\w:.-]*))([^>]*?)(\/?>)/.exec(line)

    if (openMatch && openMatch[1] && openMatch[2] && openMatch[4]) {
      const prefix = openMatch[1]
      const attrs = openMatch[3] ?? ''
      const closing = openMatch[4]
      const existingId = /\s+id\s*=\s*(?:"[^"]*"|'[^']*')/i.exec(attrs)
      const nextAttrs = existingId
        ? attrs.replace(/\s+id\s*=\s*(?:"[^"]*"|'[^']*')/i, ` id="${escapeAttr(id)}"`)
        : ` id="${escapeAttr(id)}"${attrs}`
      const replacedTag = `${prefix}${nextAttrs}${closing}`
      const tagEnd = lineStart + openMatch[0].length
      return {
        from: lineStart,
        to: tagEnd,
        insert: replacedTag,
        selection: { anchor: lineStart + replacedTag.length },
      }
    }

    const insert = `<a id="${escapeAttr(id)}"></a>`
    return { from, to, insert, selection: { anchor: from + insert.length } }
  }

  const selected = doc.slice(from, to)
  const insert = `<span id="${escapeAttr(id)}">${selected}</span>`
  return { from, to, insert, selection: { anchor: from, head: from + insert.length } }
}

export function insertLinkTag(doc: string, from: number, to: number, href: string, label?: string): CodeEditResult | null {
  const trimmedHref = href.trim()
  if (!trimmedHref) return null
  const selected = doc.slice(from, to)
  const inner = selected || escapeText(label?.trim() || trimmedHref)
  const insert = `<a href="${escapeAttr(trimmedHref)}">${inner}</a>`
  return {
    from,
    to,
    insert,
    selection: { anchor: from + insert.length },
  }
}

export function insertImageTag(_doc: string, from: number, to: number, relativeSrc: string, alt: string): CodeEditResult | null {
  const src = relativeSrc.trim()
  if (!src) return null
  const insert = `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt.trim())}" />`
  return {
    from,
    to,
    insert,
    selection: { anchor: from + insert.length },
  }
}

export function insertHorizontalRule(_doc: string, from: number, to: number): CodeEditResult {
  const insert = '<hr />'
  return {
    from,
    to,
    insert,
    selection: { anchor: from + insert.length },
  }
}

export function insertRawText(_doc: string, from: number, to: number, text: string): CodeEditResult {
  return {
    from,
    to,
    insert: text,
    selection: { anchor: from + text.length },
  }
}
