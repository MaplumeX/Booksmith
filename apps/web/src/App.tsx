import { useEffect, useState } from 'react'
import { api, type UserDto } from './api/client'
import { usePathname } from './router'
import { Editor } from './routes/Editor'
import { Library } from './routes/Library'
import { Login } from './routes/Login'
import { initSettings } from './state/settingsStore'

export function App() {
  const pathname = usePathname()
  const [user, setUser] = useState<UserDto | null | undefined>(undefined)

  useEffect(() => {
    initSettings()
  }, [])

  useEffect(() => {
    let cancelled = false
    api
      .me()
      .then((result) => {
        if (!cancelled) setUser(result.user)
      })
      .catch(() => {
        if (!cancelled) setUser(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (user === undefined) {
    return (
      <div className="shell">
        <main className="stage" aria-busy="true">
          <span className="boot-text">正在载入…</span>
        </main>
      </div>
    )
  }

  if (!user) return <Login onSuccess={setUser} />

  const match = /^\/books\/([^/]+)$/.exec(pathname)
  if (match?.[1]) return <Editor bookId={match[1]} />

  return (
    <Library
      user={user}
      onLogout={() => {
        void api.logout().finally(() => setUser(null))
      }}
    />
  )
}
