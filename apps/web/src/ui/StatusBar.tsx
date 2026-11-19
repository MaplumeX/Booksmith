interface StatusBarProps {
  path: string | null
  /** Null for binary entries, which have no character count. */
  characters: number | null
  dirtyCount: number
}

export function StatusBar({ path, characters, dirtyCount }: StatusBarProps) {
  return (
    <footer className="statusbar">
      <span className="status-path">{path ?? '未打开文件'}</span>
      {path && characters !== null ? (
        <>
          <span>{characters.toLocaleString('zh-CN')} 字</span>
          <span>UTF-8</span>
        </>
      ) : null}
      <span className={`status-right${dirtyCount > 0 ? ' is-dirty' : ''}`}>
        {dirtyCount > 0 ? `${dirtyCount} 个文件未保存` : '未修改'}
      </span>
    </footer>
  )
}
