import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { Prec } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'
import type { ViewUpdate } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

export interface VerticalSpan {
  top: number
  bottom: number
}

/**
 * Splits a `.cm-line` block into its wrapped visual line boxes (contiguous, gap-free
 * vertical spans covering `[lineRect.top, lineRect.bottom]`). Single-row lines return
 * `[lineRect]` directly; wrapped lines cluster inline glyph rects into visual rows and
 * place row boundaries at the midpoints between adjacent glyph bands.
 */
export function visualLineBoxes(
  lineRect: VerticalSpan,
  glyphRects: readonly VerticalSpan[],
  defaultRowHeight: number,
): VerticalSpan[] {
  const lineHeight = lineRect.bottom - lineRect.top
  if (lineHeight <= 0) return []
  if (defaultRowHeight <= 0 || lineHeight <= defaultRowHeight * 1.5) {
    return [{ top: lineRect.top, bottom: lineRect.bottom }]
  }

  const maxGlyphHeight = defaultRowHeight * 1.5
  const valid = glyphRects
    .filter(
      (r) =>
        r.bottom > r.top &&
        r.bottom - r.top <= maxGlyphHeight &&
        r.bottom > lineRect.top &&
        r.top < lineRect.bottom,
    )
    .sort((a, b) => a.top - b.top)

  const bands: VerticalSpan[] = []
  for (const r of valid) {
    const last = bands[bands.length - 1]
    if (last) {
      const overlap = Math.min(last.bottom, r.bottom) - Math.max(last.top, r.top)
      const minHeight = Math.min(last.bottom - last.top, r.bottom - r.top)
      if (overlap > minHeight * 0.5) {
        last.top = Math.min(last.top, r.top)
        last.bottom = Math.max(last.bottom, r.bottom)
        continue
      }
    }
    bands.push({ top: r.top, bottom: r.bottom })
  }

  if (bands.length >= 2) {
    const boxes: VerticalSpan[] = []
    for (let i = 0; i < bands.length; i++) {
      const top = i === 0 ? lineRect.top : (bands[i - 1]!.bottom + bands[i]!.top) / 2
      const bottom = i === bands.length - 1 ? lineRect.bottom : (bands[i]!.bottom + bands[i + 1]!.top) / 2
      boxes.push({ top, bottom })
    }
    return boxes
  }

  const rows = Math.max(1, Math.round(lineHeight / defaultRowHeight))
  const step = lineHeight / rows
  return Array.from({ length: rows }, (_, i) => ({
    top: lineRect.top + i * step,
    bottom: i === rows - 1 ? lineRect.bottom : lineRect.top + (i + 1) * step,
  }))
}

/**
 * Snaps a selection rectangle to the exact visual line boxes whose midpoints it spans.
 * Using visual-line midpoints instead of loose edge overlap prevents CodeMirror's middle
 * `between` rectangle (whose raw top/bottom protrude into the start/end glyph half-leading)
 * from expanding onto the partially selected start/end rows, and stays idempotent on re-runs.
 */
export function snapMarkerToVisualLines(
  marker: VerticalSpan,
  visualLines: readonly VerticalSpan[],
): VerticalSpan | null {
  if (marker.bottom <= marker.top) return null
  let first: VerticalSpan | null = null
  let last: VerticalSpan | null = null
  for (const line of visualLines) {
    const mid = (line.top + line.bottom) / 2
    if (marker.top < mid && mid < marker.bottom) {
      if (!first) first = line
      last = line
    }
  }
  if (!first || !last) return null
  return { top: first.top, bottom: last.bottom }
}

/**
 * 选区矩形由 RectangleMarker 按 coordsAtPos（字形框，比 1.65 行高矮 6px）绘制，
 * 且首行与后续行的 top 语义不同（字形顶 / 行盒顶），CSS 补偿必然错开一种情况。
 * 这里按视觉行盒重设每个矩形的 top/height：既能在未换行与自动换行时都铺满当前视觉行，
 * 也不会把软折行里的局部选区或跨行选区的中间矩形误撑满整段 `.cm-line`。
 */
const snapSelectionToLines = Prec.lowest(
  ViewPlugin.fromClass(
    class {
      private readonly measureReq = {
        read: () => undefined,
        write: () => this.snap(),
      }

      constructor(private readonly view: EditorView) {
        this.schedule()
      }

      update(update: ViewUpdate) {
        if (update.selectionSet || update.docChanged || update.geometryChanged || update.viewportChanged) {
          this.schedule()
        }
      }

      docViewUpdate() {
        this.schedule()
      }

      private schedule() {
        this.view.requestMeasure(this.measureReq)
      }

      private snap() {
        const layer = this.view.dom.querySelector<HTMLElement>('.cm-selectionLayer')
        const markers = layer ? [...layer.querySelectorAll<HTMLElement>('.cm-selectionBackground')] : []
        if (!layer || !markers.length) return

        const layerRect = layer.getBoundingClientRect()
        const scale = layer.offsetHeight ? layerRect.height / layer.offsetHeight : 1
        const markerRects = markers.map((el) => el.getBoundingClientRect())
        const singleLineHeight =
          this.view.defaultLineHeight || parseFloat(getComputedStyle(this.view.contentDOM).lineHeight) || 0
        const wrapping = this.view.lineWrapping

        let range: Range | null = null
        const visualLines: VerticalSpan[] = []
        for (const el of this.view.contentDOM.querySelectorAll('.cm-line')) {
          const lineRect = el.getBoundingClientRect()
          if (!markerRects.some((r) => lineRect.bottom > r.top && lineRect.top < r.bottom)) continue
          if (wrapping && singleLineHeight > 0 && lineRect.height > singleLineHeight * 1.5) {
            range ??= el.ownerDocument.createRange()
            range.selectNodeContents(el)
            visualLines.push(...visualLineBoxes(lineRect, Array.from(range.getClientRects()), singleLineHeight))
          } else {
            visualLines.push({ top: lineRect.top, bottom: lineRect.bottom })
          }
        }
        if (!visualLines.length) return

        const snapped = markerRects.map((rect) => snapMarkerToVisualLines(rect, visualLines))
        for (let i = 0; i < markers.length; i++) {
          const box = snapped[i]
          if (!box) continue
          const top = (box.top - layerRect.top) / scale
          const height = (box.bottom - box.top) / scale
          markers[i]!.style.top = `${top}px`
          markers[i]!.style.height = `${height}px`
        }
      }
    },
  ),
)

/** Colors come from design tokens so both themes work without rebuilding the editor. */
const highlight = HighlightStyle.define([
  { tag: t.tagName, color: 'var(--cm-tag)' },
  { tag: t.attributeName, color: 'var(--cm-attr)' },
  { tag: [t.string, t.attributeValue], color: 'var(--cm-string)' },
  { tag: [t.comment, t.meta], color: 'var(--cm-comment)' },
  { tag: [t.keyword, t.operatorKeyword], color: 'var(--cm-keyword)' },
  { tag: [t.number, t.unit], color: 'var(--cm-number)' },
  { tag: t.propertyName, color: 'var(--cm-tag)' },
  { tag: t.invalid, color: 'var(--status-error-fg)' },
])

export const editorTheme = [
  snapSelectionToLines,
  EditorView.theme({
    '&': {
      height: '100%',
      backgroundColor: 'var(--surface)',
      color: 'var(--text)',
      fontSize: 'var(--editor-font-size, 13px)',
    },
    '.cm-scroller': {
      fontFamily: 'var(--font-mono)',
      lineHeight: '1.65',
      overflow: 'auto',
    },
    '.cm-content': { padding: '18px 28px 40px 8px' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--text-muted)',
      border: 'none',
      paddingLeft: '18px',
      paddingRight: '10px',
    },
    // 选区层在 z-index:-1（文字之下），行背景一定会盖住它，所以当前行不画背景：
    // 行号高亮 + 左侧竖条足够指认当前行，且不会跟选区抢同一块颜色。
    // CodeMirror 自带 &light/&dark 的行底纹特异性更高，必须 !important 才能清掉。
    '.cm-activeLine': {
      backgroundColor: 'transparent !important',
      boxShadow: 'inset 2px 0 0 var(--accent)',
    },
    '.cm-activeLineGutter': { backgroundColor: 'var(--accent-subtle)', color: 'var(--text)' },
    // CodeMirror 自带一条 5 类选择器的选区默认色（#d7d4f0 / #233），特异性压过普通
    // 主题规则，只能 !important 拿回主题色。选中文字保留语法高亮色：drawSelection
    // 用 Prec.highest 强制原本选区透明，文字色改不了，所以这里只设背景。
    // 高度由 snapSelectionToLines 按行盒重设。
    '.cm-selectionBackground': { backgroundColor: 'var(--selection-bg) !important' },
    '.cm-cursor': { borderLeftColor: 'var(--text)' },
    '.cm-matchingBracket': {
      backgroundColor: 'var(--accent-subtle)',
      outline: '1px solid var(--accent)',
    },
    '.cm-searchMatch': { backgroundColor: 'var(--status-warn-bg)', outline: '1px solid var(--status-warn-fg)' },
    '.cm-panels': { backgroundColor: 'var(--surface-raised)', color: 'var(--text)' },
    '.cm-panels input, .cm-panels button': {
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      background: 'var(--surface)',
      color: 'var(--text)',
      padding: '2px 6px',
    },
  }),
  syntaxHighlighting(highlight),
]
