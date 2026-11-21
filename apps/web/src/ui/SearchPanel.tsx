import { groupMatches, searchBook, type SearchFile, type SearchResult } from '@booksmith/core'
import { FileText, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { basename } from '../state/bookStore'
import { planReplace, type ReplacePlan } from '../state/replacePlan'
import { Button } from './Button'

interface SearchPanelProps {
  files: SearchFile[]
  initialQuery?: string
  onOpen: (path: string, line: number, column: number) => void
  onReplace: (plan: ReplacePlan) => void
  onReplaceUndo: () => void
}

const DEBOUNCE_MS = 200

export function SearchPanel({ files, initialQuery = '', onOpen, onReplace, onReplaceUndo }: SearchPanelProps) {
  const [query, setQuery] = useState(initialQuery)
  const [replacement, setReplacement] = useState('')
  const [regex, setRegex] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [pending, setPending] = useState(false)
  const [confirming, setConfirming] = useState<ReplacePlan | null>(null)
  const [applied, setApplied] = useState<number | null>(null)

  useEffect(() => {
    if (initialQuery) setQuery(initialQuery)
  }, [initialQuery])

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

  const plan = () => {
    const texts = new Map(files.map((file) => [file.path, file.text]))
    return planReplace(texts, { query, replacement, regex, caseSensitive })
  }

  const startReplace = () => {
    const next = plan()
    if (next.total === 0) return
    setApplied(null)
    setConfirming(next)
  }

  const runReplace = () => {
    if (!confirming) return
    const count = confirming.total
    onReplace(confirming)
    setConfirming(null)
    setApplied(count)
  }

  const undoReplace = () => {
    onReplaceUndo()
    setApplied(null)
  }

  return (
    <div className="search-panel">
      <div className="search-controls">
        <div className="search-input-wrap">
          <Search size={13} strokeWidth={1.75} className="search-input-icon" aria-hidden="true" />
          <input
            type="search"
            className="search-input has-icon"
            value={query}
            placeholder="全书查找"
            aria-label="全书查找"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="search-options">
          <label className="search-option">
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={(event) => setCaseSensitive(event.target.checked)}
            />
            <span>区分大小写</span>
          </label>
          <label className="search-option">
            <input
              type="checkbox"
              checked={regex}
              onChange={(event) => setRegex(event.target.checked)}
            />
            <span>正则</span>
          </label>
        </div>
        <div className="search-replace">
          <input
            type="text"
            className="search-input"
            value={replacement}
            placeholder={regex ? '替换为（可用 $1）' : '替换为'}
            aria-label="替换为"
            onChange={(event) => {
              setReplacement(event.target.value)
              setConfirming(null)
              setApplied(null)
            }}
          />
          <Button variant="secondary" size="sm" disabled={!query.trim()} onClick={startReplace}>
            替换全部
          </Button>
        </div>
        <p className="search-status" role="status">
          {pending
            ? '搜索中…'
            : result
              ? `${result.matches.length} 处${result.truncated ? '（已截断）' : ''} · ${groups.length} 个文件`
              : '在当前书的全部文本文件中查找'}
        </p>
        {confirming ? (
          <p className="search-confirm" role="status">
            <span>
              将替换 {confirming.total} 处，涉及 {confirming.files.length} 个文件
            </span>
            <span className="search-confirm-actions">
              <button type="button" className="banner-action" onClick={runReplace}>
                执行
              </button>
              <button type="button" className="banner-action" onClick={() => setConfirming(null)}>
                取消
              </button>
            </span>
          </p>
        ) : null}
        {applied !== null ? (
          <p className="search-confirm" role="status">
            <span>已替换 {applied} 处</span>
            <span className="search-confirm-actions">
              <button type="button" className="banner-action" onClick={undoReplace}>
                撤销
              </button>
            </span>
          </p>
        ) : null}
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
              <span className="search-file-wrap">
                <FileText size={12} strokeWidth={1.65} aria-hidden="true" />
                <span className="search-file">{basename(group.path)}</span>
              </span>
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
