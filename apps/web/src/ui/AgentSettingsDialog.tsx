import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  Loader2,
  Plus,
  PlugZap,
  Star,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import {
  ApiError,
  api,
  type AgentConnectionTestResult,
  type AgentProfileDto,
  type AgentProviderType,
} from '../api/client'
import { Button } from './Button'
import { Dialog } from './Dialog'

interface AgentSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanged?: (profiles: AgentProfileDto[]) => void
}

interface TemplatePreset {
  id: string
  label: string
  name: string
  provider: AgentProviderType
  baseUrl: string
  model: string
}

const TEMPLATES: TemplatePreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    name: 'OpenAI GPT',
    provider: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    name: 'Claude Sonnet',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-20250514',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    name: 'DeepSeek Chat',
    provider: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  {
    id: 'ollama',
    label: 'Ollama 本地',
    name: 'Ollama 本地模型',
    provider: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:14b',
  },
]

interface DraftForm {
  name: string
  provider: AgentProviderType
  baseUrl: string
  model: string
  apiKey: string
  clearApiKey: boolean
  isDefault: boolean
}

const EMPTY_FORM: DraftForm = {
  name: '',
  provider: 'openai-compatible',
  baseUrl: '',
  model: '',
  apiKey: '',
  clearApiKey: false,
  isDefault: false,
}

function errorMessageOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const payload = error.payload as { message?: string } | undefined
    if (payload?.message) return payload.message
    if (error.code === 'agent_secret_not_configured') {
      return '服务端未配置 AGENT_SECRET_KEY，暂无法保存加密 API Key。'
    }
    if (error.code === 'unauthenticated') return '登录已过期，请重新登录。'
    return `${fallback}（${error.code}）`
  }
  return error instanceof Error ? error.message : fallback
}

export function AgentSettingsDialog({ open, onOpenChange, onChanged }: AgentSettingsDialogProps) {
  const [profiles, setProfiles] = useState<AgentProfileDto[]>([])
  const [secretConfigured, setSecretConfigured] = useState(true)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  /** Profile id being edited, or null when creating a new preset. */
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [form, setForm] = useState<DraftForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [savedNotice, setSavedNotice] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<AgentConnectionTestResult | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const populateForm = useCallback((profile: AgentProfileDto | null, totalCount: number) => {
    setFormError(null)
    setSavedNotice(null)
    setTestResult(null)
    setConfirmDelete(false)
    if (!profile) {
      setSelectedId(null)
      setForm({ ...EMPTY_FORM, isDefault: totalCount === 0 })
      return
    }
    setSelectedId(profile.id)
    setForm({
      name: profile.name,
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiKey: '',
      clearApiKey: false,
      isDefault: profile.isDefault,
    })
  }, [])

  const loadProfiles = useCallback(
    async (preferId?: string | null) => {
      setLoading(true)
      setLoadError(null)
      try {
        const res = await api.agentProfiles()
        setProfiles(res.profiles)
        setSecretConfigured(res.secretConfigured)
        onChanged?.(res.profiles)
        const target =
          (preferId ? res.profiles.find((p) => p.id === preferId) : null) ??
          res.profiles.find((p) => p.isDefault) ??
          res.profiles[0] ??
          null
        populateForm(target, res.profiles.length)
      } catch (cause) {
        setLoadError(errorMessageOf(cause, '加载模型预设失败'))
      } finally {
        setLoading(false)
      }
    },
    [onChanged, populateForm],
  )

  useEffect(() => {
    if (open) void loadProfiles()
  }, [open, loadProfiles])

  const selectedProfile = selectedId ? profiles.find((p) => p.id === selectedId) ?? null : null

  const applyTemplate = (tpl: TemplatePreset) => {
    setForm((current) => ({
      ...current,
      name: current.name.trim() ? current.name : tpl.name,
      provider: tpl.provider,
      baseUrl: tpl.baseUrl,
      model: tpl.model,
    }))
    setFormError(null)
    setTestResult(null)
  }

  const handleSave = async () => {
    if (saving) return
    setFormError(null)
    setSavedNotice(null)
    if (!form.name.trim()) {
      setFormError('请填写预设名称，例如「Claude 校对」。')
      return
    }
    if (!form.baseUrl.trim()) {
      setFormError('请填写完整的 Base URL（以 http:// 或 https:// 开头）。')
      return
    }
    if (!form.model.trim()) {
      setFormError('请填写模型名称。')
      return
    }

    setSaving(true)
    try {
      let savedId: string
      if (selectedProfile) {
        const res = await api.updateAgentProfile(selectedProfile.id, {
          name: form.name.trim(),
          provider: form.provider,
          baseUrl: form.baseUrl.trim(),
          model: form.model.trim(),
          ...(form.clearApiKey
            ? { clearApiKey: true }
            : form.apiKey.trim()
              ? { apiKey: form.apiKey.trim() }
              : {}),
          isDefault: form.isDefault,
        })
        savedId = res.profile.id
      } else {
        const res = await api.createAgentProfile({
          name: form.name.trim(),
          provider: form.provider,
          baseUrl: form.baseUrl.trim(),
          model: form.model.trim(),
          apiKey: form.apiKey.trim(),
          isDefault: form.isDefault,
        })
        savedId = res.profile.id
      }
      await loadProfiles(savedId)
      setSavedNotice('预设已保存')
    } catch (cause) {
      setFormError(errorMessageOf(cause, '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    if (testing) return
    setFormError(null)
    setTestResult(null)
    if (!form.baseUrl.trim() || !form.model.trim()) {
      setFormError('测试连接前请先填写 Base URL 和模型名称。')
      return
    }
    setTesting(true)
    try {
      const result = await api.testAgentProfile({
        ...(selectedProfile && !form.clearApiKey && !form.apiKey.trim() ? { profileId: selectedProfile.id } : {}),
        provider: form.provider,
        baseUrl: form.baseUrl.trim(),
        model: form.model.trim(),
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      })
      setTestResult(result)
    } catch (cause) {
      setFormError(errorMessageOf(cause, '测试连接失败'))
    } finally {
      setTesting(false)
    }
  }

  const handleDelete = async () => {
    if (!selectedProfile || deleting) return
    setDeleting(true)
    setFormError(null)
    try {
      await api.deleteAgentProfile(selectedProfile.id)
      await loadProfiles(null)
    } catch (cause) {
      setFormError(errorMessageOf(cause, '删除失败'))
    } finally {
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="模型设置"
      title="助手模型预设"
      description="按个人账号保存多套模型配置，API Key 由服务端加密存储，仅回显末四位。"
      className="agent-settings-dialog"
    >
      {loadError ? (
        <p className="banner banner-error" role="alert">
          <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>{loadError}</span>
          <button type="button" className="banner-action" onClick={() => void loadProfiles()}>
            重试
          </button>
        </p>
      ) : null}

      {!secretConfigured ? (
        <p className="banner banner-warn" role="status">
          <AlertTriangle size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>
            服务端尚未配置 <code>AGENT_SECRET_KEY</code>，含 API Key 的预设暂无法保存；本地无密钥模型（如 Ollama）可正常使用。
          </span>
        </p>
      ) : null}

      <div className="agent-settings-layout">
        <section className="agent-profile-list-pane" aria-label="已保存模型预设">
          <div className="agent-profile-list-head">
            <span className="agent-section-label">预设列表</span>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => populateForm(null, profiles.length)}
            >
              <Plus size={13} strokeWidth={1.75} aria-hidden="true" />
              <span>新增</span>
            </Button>
          </div>

          {loading ? (
            <div className="agent-profile-skeletons" aria-busy="true" aria-label="正在加载预设">
              <span className="skeleton-line" />
              <span className="skeleton-line" />
              <span className="skeleton-line short" />
            </div>
          ) : profiles.length === 0 ? (
            <p className="agent-profile-empty">暂无已保存预设，在右侧填写并保存第一套模型即可启用助手。</p>
          ) : (
            <ul className="agent-profile-list">
              {profiles.map((profile) => {
                const active = selectedId === profile.id
                return (
                  <li key={profile.id}>
                    <button
                      type="button"
                      className={`agent-profile-item${active ? ' on' : ''}`}
                      onClick={() => populateForm(profile, profiles.length)}
                    >
                      <span className="agent-profile-item-top">
                        <span className="agent-profile-name" title={profile.name}>
                          {profile.name}
                        </span>
                        {profile.isDefault ? (
                          <span className="agent-badge-default">
                            <Star size={10} strokeWidth={2} aria-hidden="true" />
                            <span>默认</span>
                          </span>
                        ) : null}
                      </span>
                      <span className="agent-profile-meta" title={`${profile.model} · ${profile.baseUrl}`}>
                        {profile.model}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className="agent-profile-form-pane" aria-label="编辑模型预设">
          <div className="agent-template-bar">
            <span className="agent-section-label">快捷模板</span>
            <div className="agent-template-chips">
              {TEMPLATES.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  className="agent-template-chip"
                  onClick={() => applyTemplate(tpl)}
                >
                  {tpl.label}
                </button>
              ))}
            </div>
          </div>

          <form
            className="agent-profile-form"
            onSubmit={(event) => {
              event.preventDefault()
              void handleSave()
            }}
          >
            <div className="agent-form-grid">
              <label className="panel-field">
                <span>预设名称</span>
                <input
                  type="text"
                  value={form.name}
                  placeholder="例如：Claude 校对"
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                />
              </label>

              <label className="panel-field">
                <span>接口协议</span>
                <select
                  value={form.provider}
                  onChange={(event) =>
                    setForm({ ...form, provider: event.target.value as AgentProviderType })
                  }
                >
                  <option value="openai-compatible">OpenAI 兼容（OpenAI / DeepSeek / Ollama 等）</option>
                  <option value="anthropic">Anthropic 原生（Claude Messages）</option>
                </select>
              </label>
            </div>

            <label className="panel-field">
              <span>Base URL</span>
              <input
                type="url"
                value={form.baseUrl}
                placeholder="https://api.openai.com/v1"
                onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
              />
            </label>

            <label className="panel-field">
              <span>模型名称</span>
              <input
                type="text"
                value={form.model}
                placeholder="gpt-4.1 / claude-sonnet-4-20250514"
                onChange={(event) => setForm({ ...form, model: event.target.value })}
              />
            </label>

            <label className="panel-field">
              <span>API Key（本地模型可留空）</span>
              <input
                type="password"
                autoComplete="off"
                value={form.apiKey}
                disabled={form.clearApiKey}
                placeholder={
                  selectedProfile?.hasApiKey
                    ? `已保存（末尾 ${selectedProfile.apiKeyLast4 ?? '••••'}），留空则保持不变`
                    : 'sk-...'
                }
                onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
              />
            </label>

            <div className="agent-form-checks">
              <label className="agent-checkbox-row">
                <input
                  type="checkbox"
                  checked={form.isDefault}
                  onChange={(event) => setForm({ ...form, isDefault: event.target.checked })}
                />
                <span>设为默认预设</span>
              </label>

              {selectedProfile?.hasApiKey ? (
                <label className="agent-checkbox-row">
                  <input
                    type="checkbox"
                    checked={form.clearApiKey}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        clearApiKey: event.target.checked,
                        apiKey: event.target.checked ? '' : form.apiKey,
                      })
                    }
                  />
                  <span>清除已保存的 API Key</span>
                </label>
              ) : null}
            </div>

            {formError ? (
              <p className="banner banner-error" role="alert">
                <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{formError}</span>
              </p>
            ) : null}

            {savedNotice ? (
              <p className="banner banner-ok" role="status">
                <Check size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{savedNotice}</span>
              </p>
            ) : null}

            {testResult ? (
              <p
                className={`banner ${testResult.ok ? 'banner-ok' : 'banner-error'}`}
                role={testResult.ok ? 'status' : 'alert'}
              >
                {testResult.ok ? (
                  <CheckCircle2 size={14} strokeWidth={1.75} aria-hidden="true" />
                ) : (
                  <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" />
                )}
                <span>
                  {testResult.ok
                    ? `连接成功（${testResult.latencyMs}ms）${testResult.reply ? `：${testResult.reply}` : ''}`
                    : testResult.error ?? '连接失败'}
                </span>
              </p>
            ) : null}

            <div className="agent-form-footer">
              <div className="agent-form-footer-left">
                {selectedProfile ? (
                  confirmDelete ? (
                    <>
                      <Button
                        variant="danger"
                        size="sm"
                        type="button"
                        disabled={deleting}
                        onClick={() => void handleDelete()}
                      >
                        {deleting ? '删除中…' : '确认删除'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        onClick={() => setConfirmDelete(false)}
                      >
                        取消
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      onClick={() => setConfirmDelete(true)}
                    >
                      <Trash2 size={13} strokeWidth={1.7} aria-hidden="true" />
                      <span>删除预设</span>
                    </Button>
                  )
                ) : null}
              </div>

              <div className="agent-form-footer-right">
                <Button
                  variant="secondary"
                  type="button"
                  disabled={testing || saving}
                  onClick={() => void handleTest()}
                >
                  {testing ? (
                    <Loader2 size={14} strokeWidth={1.75} className="spin" aria-hidden="true" />
                  ) : (
                    <PlugZap size={14} strokeWidth={1.75} aria-hidden="true" />
                  )}
                  <span>{testing ? '测试中…' : '测试连接'}</span>
                </Button>
                <Button variant="primary" type="submit" disabled={saving || testing}>
                  {saving ? '保存中…' : selectedProfile ? '保存修改' : '添加预设'}
                </Button>
              </div>
            </div>
          </form>
        </section>
      </div>
    </Dialog>
  )
}
