import { EditorView } from '@codemirror/view'
import { keymap } from '@codemirror/view'
import { search, searchKeymap } from '@codemirror/search'
import { basicSetup } from 'codemirror'
import { useEffect, useRef } from 'react'
import { languageFor } from '../editor/languages'
import { editorTheme } from '../editor/theme'

export interface RevealTarget {
  line: number
  column: number
  key: number
}

interface CodePaneProps {
  path: string
  content: string
  onChange: (value: string) => void
  reveal?: RevealTarget | null
}

export function CodePane({ path, content, onChange, reveal }: CodePaneProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!host.current) return
    const instance = new EditorView({
      doc: content,
      parent: host.current,
      extensions: [
        basicSetup,
        languageFor(path),
        editorTheme,
        EditorView.lineWrapping,
        search({ top: true }),
        keymap.of(searchKeymap),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString())
        }),
      ],
    })
    view.current = instance
    return () => {
      instance.destroy()
      view.current = null
    }
    // Rebuilding per path keeps one document per file; typing never re-creates the view.
  }, [path])

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
