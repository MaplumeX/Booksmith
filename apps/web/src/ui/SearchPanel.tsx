import { groupMatches, searchBook, type SearchFile, type SearchResult } from '@booksmith/core'
import { useEffect, useMemo, useState } from 'react'
import { basename } from '../state/bookStore'

interface SearchPanelProps {
  files: SearchFile[]
  onOpen: (path: string, line: number, column: number) => void
}

const DEBOUNCE_MS = 200

export function SearchPanel({ files, onOpen }: SearchPanelProps) {
  const [query, setQuery] = useState('')
  const [regex, setRegex] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (!query.trim()) {
      setResult(null)
      setPending(false)
      return
    }
    setPending(true)
    const timer = window.setTimeout(() => {
      setResult(searchBook(files, query, { regex, caseSensitive }))
      setPending(false)
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query, regex, caseSensitive, files])

  const groups = useMemo(() => (result ? groupMatches(result.matches) : []), [result])

  return (
    <div className="search-panel">
      <div className="search-controls">
        <input
          type="search"
          className="search-input"
          value={query}
          placeholder="全书查找"
          aria-label="全书查找"
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="search-options">
          <label className="search-option">
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={(event) => setCaseSensitive(event.target.checked)}
            />
            区分大小写
          </label>
          <label className="search-option">
            <input
              type="checkbox"
              checked={regex}
              onChange={(event) => setRegex(event.target.checked)}
            />
            正则
          </label>
        </div>
        <p className="search-status" role="status">
          {pending
            ? '搜索中…'
            : result
              ? `${result.matches.length} 处${result.truncated ? '（已截断）' : ''} · ${groups.length} 个文件`
              : '在当前书的全部文本文件中查找'}
        </p>
      </div>

      <div className="search-results">
        {result && result.matches.length === 0 ? (
          <p className="sidebar-note">
            没有匹配「{query}」。试试更短的关键词，或关闭区分大小写。
          </p>
        ) : null}

        {groups.map((group) => (
          <section key={group.path} className="search-group">
            <h3 className="search-group-head">
              <span className="search-file">{basename(group.path)}</span>
              <span className="search-count">{group.matches.length}</span>
            </h3>
            <ul className="search-hits">
              {group.matches.map((match) => (
                <li key={`${group.path}:${match.offset}`}>
                  <button
                    type="button"
                    className="search-hit"
                    onClick={() => onOpen(group.path, match.line, match.column)}
                  >
                    <span className="search-line">{match.line}</span>
                    <span className="search-preview">{match.preview}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
