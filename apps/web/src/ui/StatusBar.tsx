interface StatusBarProps {
  path: string | null
  characters: number
  dirtyCount: number
}

export function StatusBar({ path, characters, dirtyCount }: StatusBarProps) {
  return (
    <footer className="statusbar">
      <span className="status-path">{path ?? '未打开文件'}</span>
      {path ? <span>{characters.toLocaleString('zh-CN')} 字</span> : null}
      {path ? <span>UTF-8</span> : null}
      <span className={`status-right${dirtyCount > 0 ? ' is-dirty' : ''}`}>
        {dirtyCount > 0 ? `${dirtyCount} 个文件未保存` : '未修改'}
      </span>
    </footer>
  )
}
