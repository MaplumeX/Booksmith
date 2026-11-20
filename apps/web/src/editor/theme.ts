import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView, ViewPlugin } from '@codemirror/view'
import type { ViewUpdate } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

/**
 * 选区矩形由 RectangleMarker 按 coordsAtPos（字形框，比 1.65 行高矮 6px）绘制，
 * 且首行与后续行的 top 语义不同（字形顶 / 行盒顶），CSS 补偿必然错开一种情况。
 * 这里按行盒重设每个矩形的 top/height，选区才能真的铺满整行。
 */
const snapSelectionToLines = ViewPlugin.fromClass(
  class {
    private frame = 0

    constructor(private readonly view: EditorView) {
      this.schedule()
    }

    update(update: ViewUpdate) {
      if (update.selectionSet || update.docChanged || update.geometryChanged || update.viewportChanged) {
        this.schedule()
      }
    }

    destroy() {
      cancelAnimationFrame(this.frame)
    }

    private schedule() {
      cancelAnimationFrame(this.frame)
      this.frame = requestAnimationFrame(() => this.snap())
    }

    private snap() {
      const layer = this.view.dom.querySelector<HTMLElement>('.cm-selectionLayer')
      const markers = layer ? [...layer.querySelectorAll<HTMLElement>('.cm-selectionBackground')] : []
      if (!layer || !markers.length) return
      const layerRect = layer.getBoundingClientRect()
      const scale = layer.offsetHeight ? layerRect.height / layer.offsetHeight : 1
      const lines = [...this.view.contentDOM.querySelectorAll('.cm-line')].map((el) => el.getBoundingClientRect())
      for (const marker of markers) {
        const rect = marker.getBoundingClientRect()
        const hit = lines.filter((line) => line.bottom > rect.top + 0.5 && line.top < rect.bottom - 0.5)
        if (!hit.length) continue
        const top = (hit[0]!.top - layerRect.top) / scale
        const bottom = (hit[hit.length - 1]!.bottom - layerRect.top) / scale
        marker.style.setProperty('top', `${top}px`, 'important')
        marker.style.setProperty('height', `${bottom - top}px`, 'important')
      }
    }
  },
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
      fontSize: '13px',
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
