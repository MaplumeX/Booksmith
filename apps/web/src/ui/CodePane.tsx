import { dirname, resolvePath, splitFragment } from '@booksmith/core'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { search, searchKeymap } from '@codemirror/search'
import { basicSetup } from 'codemirror'
import { useCallback, useEffect, useRef } from 'react'
import { languageFor } from '../editor/languages'
import { editorTheme } from '../editor/theme'

export interface RevealTarget {
  line: number
  column: number
  key: number
}

export interface NavigateTarget {
  path: string
  fragment: string
}

interface CodePaneProps {
  path: string
  content: string
  onChange: (value: string) => void
  reveal?: RevealTarget | null
  onNavigate?: (target: NavigateTarget) => void
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

export function CodePane({ path, content, onChange, reveal, onNavigate }: CodePaneProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  /** One state per opened file. The undo stack lives in `EditorState`, so rebuilding on a tab switch
   * silently drops the user's last edit from history.
   * See ADR 2026-11-19-editor-state-per-tab. */
  const states = useRef(new Map<string, EditorState>())
  const shownPath = useRef<string | null>(null)
  const onChangeRef = useRef(onChange)
  const onNavigateRef = useRef(onNavigate)
  const latest = useRef({ path, content })
  onChangeRef.current = onChange
  onNavigateRef.current = onNavigate
  latest.current = { path, content }

  const makeState = useCallback(
    (forPath: string, doc: string): EditorState =>
      EditorState.create({
        doc,
        extensions: [
          basicSetup,
          languageFor(forPath),
          editorTheme,
          EditorView.lineWrapping,
          search({ top: true }),
          keymap.of(searchKeymap),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString())
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
      }),
    [editorTheme],
  )

  // A new theme (module hot reload) invalidates every cached state, so the view and the cache are
  // rebuilt together. This is the only path that drops an undo stack.
  useEffect(() => {
    if (!host.current) return
    states.current.clear()
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
    } else {
      const created = makeState(path, content)
      states.current.set(path, created)
      instance.setState(created)
    }
    shownPath.current = path
    // `content` only seeds a file that has never been shown; after that the document owns the text.
  }, [path, makeState])

  // An outside rewrite (book-wide replace, snapshot restore, reference rename) wins over the cached
  // state. Its undo stack is dropped on purpose: undoing it would write pre-rewrite text back.
  useEffect(() => {
    const instance = view.current
    if (!instance || shownPath.current !== path) return
    if (instance.state.doc.toString() === content) return
    const next = makeState(path, content)
    states.current.set(path, next)
    instance.setState(next)
  }, [content, path, makeState])

  useEffect(() => {
    const instance = view.current
    if (!instance || !reveal) return
    const doc = instance.state.doc
    const line = doc.line(Math.min(Math.max(reveal.line, 1), doc.lines))
    const position = Math.min(line.from + Math.max(reveal.column - 1, 0), line.to)
    instance.dispatch({
      selection: { anchor: position },
      scrollIntoView: true,
    })
    instance.focus()
  }, [reveal?.key])

  return <div className="code-pane" ref={host} data-path={path} />
}
