import { AlertCircle, BookOpen } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { ApiError, api, type UserDto } from '../api/client'
import { Button } from '../ui/Button'

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'invalid_credentials') return '邮箱或密码不对'
    if (error.code === 'too_many_attempts') return '尝试次数过多，15 分钟后再试'
    if (error.code === 'invalid_email') return '邮箱格式不对'
    return `登录失败（${error.code}）`
  }
  return '网络异常，请稍后重试'
}

export function Login({ onSuccess }: { onSuccess: (user: UserDto) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setError(null)
    try {
      const { user } = await api.login(email.trim(), password)
      onSuccess(user)
    } catch (cause) {
      setError(messageFor(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="login-shell">
      <main className="login">
        <div className="login-brand">
          <span className="login-mark" aria-hidden="true">
            <BookOpen size={18} strokeWidth={1.75} />
          </span>
          <div>
            <h1>Booksmith</h1>
            <p className="login-sub">登录后管理你的 EPUB 书库。</p>
          </div>
        </div>

        <form onSubmit={submit} noValidate>
          <label className="field">
            <span>邮箱</span>
            <input
              type="email"
              name="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>

          <label className="field">
            <span>密码</span>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>

          {error ? (
            <p className="banner banner-error" role="alert">
              <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{error}</span>
            </p>
          ) : null}

          <Button type="submit" variant="primary" size="lg" disabled={pending} className="login-submit">
            {pending ? '登录中…' : '登录'}
          </Button>
        </form>

        <p className="login-hint">账号由管理员通过 ALLOWED_EMAILS 白名单开通，没有注册入口。</p>
      </main>
    </div>
  )
}
