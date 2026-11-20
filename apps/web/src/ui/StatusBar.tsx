import { AlertCircle, CheckCircle2, FileText } from 'lucide-react'

interface StatusBarProps {
  path: string | null
  /** Null for binary entries, which have no character count. */
  characters: number | null
  dirtyCount: number
}

export function StatusBar({ path, characters, dirtyCount }: StatusBarProps) {
  return (
    <footer className="statusbar">
      <span className="status-item status-path-wrap">
        <FileText size={12} strokeWidth={1.65} aria-hidden="true" />
        <span className="status-path">{path ?? '未打开文件'}</span>
      </span>
      {path && characters !== null ? (
        <>
          <span className="status-sep" aria-hidden="true" />
          <span className="status-mono">{characters.toLocaleString('zh-CN')} 字</span>
          <span className="status-sep" aria-hidden="true" />
          <span className="status-mono">UTF-8</span>
        </>
      ) : null}
      <span className={`status-item status-right${dirtyCount > 0 ? ' is-dirty' : ''}`}>
        {dirtyCount > 0 ? (
          <AlertCircle size={12} strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <CheckCircle2 size={12} strokeWidth={1.75} aria-hidden="true" />
        )}
        <span>{dirtyCount > 0 ? `${dirtyCount} 个文件未保存` : '未修改'}</span>
      </span>
    </footer>
  )
}
