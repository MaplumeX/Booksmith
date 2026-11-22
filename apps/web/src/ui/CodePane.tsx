import { dirname, resolvePath, SPLIT_MARKER_HTML, splitFragment } from '@booksmith/core'
import { isolateHistory } from '@codemirror/commands'
import { Annotation, Compartment, EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { search, searchKeymap } from '@codemirror/search'
import { basicSetup } from 'codemirror'
import { useCallback, useEffect, useRef } from 'react'
import type { CodeEditResult } from '../editor/codeActions'
import { mapLfOffsetToSource, normalizeEol, restoreEol } from '../editor/eol'
import { languageFor } from '../editor/languages'
import { HEADING_SHORTCUTS, type HeadingShortcutTag } from '../editor/shortcuts'
import { editorTheme } from '../editor/theme'
import { ContextMenu, type ContextMenuEntry } from './ContextMenu'

const externalSyncAnnotation = Annotation.define<boolean>()

export interface RevealTarget {
  line: number
  column: number
  key: number
}

export interface NavigateTarget {
  path: string
  fragment: string
}

export interface CodePaneHandle {
  getCursorOffset: () => number | null
  getSelectionRange: () => { from: number; to: number; text: string } | null
  insertAtCursor: (text: string) => boolean
  applyTransform: (transform: (doc: string, from: number, to: number) => CodeEditResult | null) => boolean
  replaceDocAsTransaction: (nextText: string) => boolean
  focus: () => void
}

interface CodePaneProps {
  path: string
  content: string
  onChange: (value: string) => void
  reveal?: RevealTarget | null
  onNavigate?: (target: NavigateTarget) => void
  onSelectionChange?: (selection: string, range?: { startLine: number; endLine: number } | null) => void
  onSplitAtCursor?: (offset: number) => void
  onInsertSplitMarker?: () => void
  onFormatDocument?: () => void
  onWrapBlock?: (tag: HeadingShortcutTag) => void
  contextMenuItems?: ContextMenuEntry[]
  handleRef?: React.MutableRefObject<CodePaneHandle | null>
  visible?: boolean
  wordWrap?: boolean
  syncMode?: 'reset' | 'transaction'
  resetVersion?: number
}

const LINK_ATTRIBUTE = /(?:href|src|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

/** Follows the `href`/`src` under the pointer, resolved the same way the rest of the book is. */
function navigateTarget(view: EditorView, event: MouseEvent, fromPath: string): NavigateTarget | null {
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
  if (pos === null) return null
  const line = view.state.doc.lineAt(pos)
  const offset = pos - line.from

  for (const match of line.text.matchAll(new RegExp(LINK_ATTRIBUTE.source, 'g'))) {
    const raw = match[1] ?? match[2] ?? ''
    const start = match.index + match[0].length - raw.length - 1
    if (offset < start || offset > start + raw.length) continue

    const { path: target, fragment } = splitFragment(raw)
    // A bare `#frag` stays inside the current document.
    if (!target) return { path: fromPath, fragment }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith('//')) return null
    try {
      return { path: resolvePath(dirname(fromPath), target), fragment }
    } catch {
      return null
    }
  }
  return null
}

export function CodePane({
  path,
  content,
  onChange,
  reveal,
  onNavigate,
  onSelectionChange,
  onSplitAtCursor,
  onInsertSplitMarker,
  onFormatDocument,
  onWrapBlock,
  contextMenuItems,
  handleRef,
  visible = true,
  wordWrap = true,
  syncMode = 'reset',
  resetVersion = 0,
}: CodePaneProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const wrapCompartment = useRef(new Compartment())
  const wordWrapRef = useRef(wordWrap)
  wordWrapRef.current = wordWrap
  /** One state per opened file. The undo stack lives in `EditorState`, so rebuilding on a tab switch
   * silently drops the user's last edit from history.
   * See ADR 2026-11-19-editor-state-per-tab. */
  const states = useRef(new Map<string, EditorState>())
  const seedTexts = useRef(new Map<string, string>())
  const shownPath = useRef<string | null>(null)
  const lastResetVersion = useRef(resetVersion)
  const onChangeRef = useRef(onChange)
  const onNavigateRef = useRef(onNavigate)
  const onSelectionRef = useRef(onSelectionChange)
  const onSplitAtCursorRef = useRef(onSplitAtCursor)
  const onInsertSplitMarkerRef = useRef(onInsertSplitMarker)
  const onFormatDocumentRef = useRef(onFormatDocument)
  const onWrapBlockRef = useRef(onWrapBlock)
  const latest = useRef({ path, content })
  onChangeRef.current = onChange
  onNavigateRef.current = onNavigate
  onSelectionRef.current = onSelectionChange
  onSplitAtCursorRef.current = onSplitAtCursor
  onInsertSplitMarkerRef.current = onInsertSplitMarker
  onFormatDocumentRef.current = onFormatDocument
  onWrapBlockRef.current = onWrapBlock
  latest.current = { path, content }

  const computeSourceOffset = useCallback((instance: EditorView): number => {
    const lfOffset = instance.state.selection.main.head
    const currentPath = shownPath.current ?? latest.current.path
    const seed = seedTexts.current.get(currentPath) ?? latest.current.content
    const sourceText = restoreEol(instance.state.doc.toString(), seed)
    return mapLfOffsetToSource(lfOffset, sourceText)
  }, [])

  useEffect(() => {
    if (!handleRef) return
    handleRef.current = {
      getCursorOffset: () => {
        const instance = view.current
        if (!instance) return null
        return computeSourceOffset(instance)
      },
      getSelectionRange: () => {
        const instance = view.current
        if (!instance) return null
        const { from, to } = instance.state.selection.main
        return { from, to, text: instance.state.sliceDoc(from, to) }
      },
      insertAtCursor: (text: string) => {
        const instance = view.current
        if (!instance) return false
        const { from, to } = instance.state.selection.main
        instance.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length },
          scrollIntoView: true,
        })
        instance.focus()
        return true
      },
      applyTransform: (transform) => {
        const instance = view.current
        if (!instance) return false
        const doc = instance.state.doc.toString()
        const { from, to } = instance.state.selection.main
        const edit = transform(doc, from, to)
        if (!edit) return false
        instance.dispatch({
          changes: { from: edit.from, to: edit.to, insert: edit.insert },
          selection:
            edit.selection.head !== undefined
              ? { anchor: edit.selection.anchor, head: edit.selection.head }
              : { anchor: edit.selection.anchor },
          annotations: isolateHistory.of('full'),
          scrollIntoView: true,
        })
        instance.focus()
        return true
      },
      replaceDocAsTransaction: (nextText: string) => {
        const instance = view.current
        if (!instance) return false
        const normalized = normalizeEol(nextText)
        const current = instance.state.doc.toString()
        if (current === normalized) return false
        // Single isolated undo transaction so one Cmd/Ctrl+Z reverts only the format pass even
        // when triggered immediately after typing. See ADR 2026-11-21-code-productivity-and-command-palette.
        instance.dispatch({
          changes: { from: 0, to: instance.state.doc.length, insert: normalized },
          annotations: isolateHistory.of('full'),
        })
        instance.focus()
        return true
      },
      focus: () => {
        view.current?.focus()
      },
    }
    return () => {
      handleRef.current = null
    }
  }, [handleRef, computeSourceOffset])

  const makeState = useCallback(
    (forPath: string, doc: string): EditorState => {
      seedTexts.current.set(forPath, doc)
      return EditorState.create({
        doc,
        extensions: [
          basicSetup,
          languageFor(forPath),
          editorTheme,
          wrapCompartment.current.of(wordWrapRef.current ? EditorView.lineWrapping : []),
          search({ top: true }),
          keymap.of(searchKeymap),
          // High-precedence Sigil split bindings override CodeMirror's default Mod-Enter insertBlankLine.
          // See ADR 2026-11-21-chapter-structure-and-resource-tools.
          Prec.high(
            keymap.of([
              {
                key: 'Mod-Enter',
                run: (editor) => {
                  if (!onSplitAtCursorRef.current) return false
                  onSplitAtCursorRef.current(computeSourceOffset(editor))
                  return true
                },
              },
              {
                key: 'Mod-Shift-Enter',
                run: (editor) => {
                  if (onInsertSplitMarkerRef.current) {
                    onInsertSplitMarkerRef.current()
                    return true
                  }
                  const { from, to } = editor.state.selection.main
                  editor.dispatch({
                    changes: { from, to, insert: `\n${SPLIT_MARKER_HTML}\n` },
                    selection: { anchor: from + SPLIT_MARKER_HTML.length + 2 },
                    scrollIntoView: true,
                  })
                  return true
                },
              },
              {
                key: 'Alt-Shift-f',
                run: () => {
                  if (!onFormatDocumentRef.current) return false
                  onFormatDocumentRef.current()
                  return true
                },
              },
              ...HEADING_SHORTCUTS.map(({ tag, spec }) => ({
                key: spec.replace(/\+/g, '-'),
                run: () => {
                  if (!onWrapBlockRef.current) return false
                  onWrapBlockRef.current(tag)
                  return true
                },
              })),
            ]),
          ),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              // Ignore programmatic syncs from props so opening CRLF files or returning from
              // WYSIWYG after a save never loops back into `onChange` and marks the file dirty.
              // See ADR 2026-11-20-baseline-derived-dirty-state.
              const isExternal = update.transactions.every((tr) => tr.annotation(externalSyncAnnotation))
              if (!isExternal) {
                const seed = seedTexts.current.get(forPath) ?? ''
                onChangeRef.current(restoreEol(update.state.doc.toString(), seed))
              }
            }
            if (update.selectionSet && onSelectionRef.current) {
              const { from, to } = update.state.selection.main
              if (from === to) {
                onSelectionRef.current('', null)
              } else {
                const startLine = update.state.doc.lineAt(from).number
                const endLine = update.state.doc.lineAt(Math.max(from, to - 1)).number
                onSelectionRef.current(update.state.sliceDoc(from, to), { startLine, endLine })
              }
            }
          }),
          EditorView.domEventHandlers({
            mousedown(event, editor) {
              if (!event.altKey) return false
              const target = navigateTarget(editor, event, forPath)
              if (!target) return false
              event.preventDefault()
              onNavigateRef.current?.(target)
              return true
            },
          }),
        ],
      })
    },
    [editorTheme],
  )

  // A new theme (module hot reload) invalidates every cached state, so the view and the cache are
  // rebuilt together. This is the only path that drops an undo stack.
  useEffect(() => {
    if (!host.current) return
    states.current.clear()
    seedTexts.current.clear()
    const initial = makeState(latest.current.path, latest.current.content)
    const instance = new EditorView({ state: initial, parent: host.current })
    view.current = instance
    states.current.set(latest.current.path, initial)
    shownPath.current = latest.current.path
    return () => {
      instance.destroy()
      view.current = null
    }
    // Rebuilding only on the theme keeps one document per path across tab switches.
  }, [makeState])

  useEffect(() => {
    const instance = view.current
    if (!instance) return
    const previous = shownPath.current
    if (previous && previous !== path) states.current.set(previous, instance.state)

    const cached = states.current.get(path)
    if (cached) {
      instance.setState(cached)
      instance.dispatch({
        effects: wrapCompartment.current.reconfigure(wordWrapRef.current ? EditorView.lineWrapping : []),
      })
    } else {
      const created = makeState(path, content)
      states.current.set(path, created)
      instance.setState(created)
    }
    shownPath.current = path
    if (onSelectionRef.current) {
      const { from, to } = instance.state.selection.main
      if (from === to) {
        onSelectionRef.current('', null)
      } else {
        const startLine = instance.state.doc.lineAt(from).number
        const endLine = instance.state.doc.lineAt(Math.max(from, to - 1)).number
        onSelectionRef.current(instance.state.sliceDoc(from, to), { startLine, endLine })
      }
    }
    // `content` only seeds a file that has never been shown; after that the document owns the text.
  }, [path, makeState])

  useEffect(() => {
    const instance = view.current
    if (!instance) return
    instance.dispatch({
      effects: wrapCompartment.current.reconfigure(wordWrap ? EditorView.lineWrapping : []),
    })
  }, [wordWrap])

  // An outside rewrite (book-wide replace, snapshot restore, reference rename) resets every cached
  // state and drops undo history; switching back from WYSIWYG applies a single transaction instead
  // so one Cmd/Ctrl+Z in code mode reverts the whole visual editing session.
  // See ADR 2026-11-20-wysiwyg-editing-mode.
  useEffect(() => {
    const instance = view.current
    if (!instance || shownPath.current !== path) return

    if (resetVersion !== lastResetVersion.current) {
      lastResetVersion.current = resetVersion
      states.current.clear()
      seedTexts.current.clear()
      const next = makeState(path, content)
      states.current.set(path, next)
      instance.setState(next)
      return
    }

    if (!visible) return
    const normalizedContent = normalizeEol(content)
    if (instance.state.doc.toString() === normalizedContent) return

    if (syncMode === 'transaction') {
      if (!seedTexts.current.has(path)) seedTexts.current.set(path, content)
      instance.dispatch({
        changes: { from: 0, to: instance.state.doc.length, insert: normalizedContent },
        annotations: externalSyncAnnotation.of(true),
      })
      states.current.set(path, instance.state)
      return
    }

    const next = makeState(path, content)
    states.current.set(path, next)
    instance.setState(next)
  }, [content, path, visible, syncMode, resetVersion, makeState])

  useEffect(() => {
    const instance = view.current
    if (!instance || !reveal || !visible) return
    const doc = instance.state.doc
    const line = doc.line(Math.min(Math.max(reveal.line, 1), doc.lines))
    const position = Math.min(line.from + Math.max(reveal.column - 1, 0), line.to)
    instance.dispatch({
      selection: { anchor: position },
      scrollIntoView: true,
    })
    instance.focus()
  }, [reveal?.key, visible])

  const pane = <div className="code-pane" ref={host} data-path={path} hidden={!visible} />
  if (contextMenuItems && contextMenuItems.length > 0) {
    return (
      <ContextMenu ariaLabel="代码编辑器操作" items={contextMenuItems}>
        {pane}
      </ContextMenu>
    )
  }
  return pane
}
