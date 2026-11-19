import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

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
    '.cm-content': { padding: '8px 0' },
    '.cm-gutters': {
      backgroundColor: 'var(--surface-raised)',
      color: 'var(--text-muted)',
      border: 'none',
      borderRight: '1px solid var(--border)',
    },
    '.cm-activeLine': { backgroundColor: 'var(--accent-subtle)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--accent-subtle)', color: 'var(--text)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'var(--selection-bg)',
      color: 'var(--selection-fg)',
    },
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
