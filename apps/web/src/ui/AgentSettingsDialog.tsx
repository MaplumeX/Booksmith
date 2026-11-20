import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  PlugZap,
  RefreshCw,
  Search,
  ShieldCheck,
  Star,
  Trash2,
  X,
  Zap,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ApiError,
  api,
  type AgentApprovalMode,
  type AgentConnectionTestResult,
  type AgentProfileDto,
  type AgentProviderType,
  type AgentUserSettingsDto,
} from '../api/client'
import { Button } from './Button'
import { Dialog } from './Dialog'

interface AgentSettingsPanelProps {
  active: boolean
  onChanged?: (profiles: AgentProfileDto[]) => void
  onSettingsChanged?: (settings: AgentUserSettingsDto) => void
}

interface AgentSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanged?: (profiles: AgentProfileDto[]) => void
  onSettingsChanged?: (settings: AgentUserSettingsDto) => void
}

interface TemplatePreset {
  id: string
  label: string
  name: string
  provider: AgentProviderType
  baseUrl: string
  model: string
  models: string[]
}

const MAX_CUSTOM_INSTRUCTIONS = 4000

const APPROVAL_OPTIONS: Array<{
  value: AgentApprovalMode
  label: string
  icon: typeof Eye
}> = [
  { value: 'ask', label: '只读', icon: Eye },
  { value: 'review', label: '审阅', icon: ShieldCheck },
  { value: 'auto', label: '自动', icon: Zap },
]

const TEMPLATES: TemplatePreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    name: 'OpenAI',
    provider: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1',
    models: ['gpt-4.1', 'gpt-4.1-mini'],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    name: 'Anthropic Claude',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-20250514',
    models: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514'],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    name: 'DeepSeek',
    provider: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'ollama',
    label: 'Ollama 本地',
    name: 'Ollama 本地模型',
    provider: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:14b',
    models: ['qwen2.5:14b'],
  },
]

interface DraftForm {
  name: string
  provider: AgentProviderType
  baseUrl: string
  model: string
  models: string[]
  apiKey: string
  clearApiKey: boolean
  isDefault: boolean
}

const EMPTY_FORM: DraftForm = {
  name: '',
  provider: 'openai-compatible',
  baseUrl: '',
  model: '',
  models: [],
  apiKey: '',
  clearApiKey: false,
  isDefault: false,
}

const DEFAULT_USER_SETTINGS: AgentUserSettingsDto = {
  defaultApprovalMode: 'review',
  maxSteps: 15,
  customInstructions: '',
  updatedAt: null,
}

function normalizeModelList(primary: string, list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (value: string) => {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) return
    seen.add(trimmed)
    out.push(trimmed)
  }
  for (const item of list) push(item)
  const cleanPrimary = primary.trim()
  if (cleanPrimary && !seen.has(cleanPrimary)) out.unshift(cleanPrimary)
  return out
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

export function AgentSettingsPanel({ active, onChanged, onSettingsChanged }: AgentSettingsPanelProps) {
  // --- Cloud-synced runtime preferences ---
  const [userSettings, setUserSettings] = useState<AgentUserSettingsDto>(DEFAULT_USER_SETTINGS)
  const [settingsDraft, setSettingsDraft] = useState<AgentUserSettingsDto>(DEFAULT_USER_SETTINGS)
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [settingsSavedNotice, setSettingsSavedNotice] = useState<string | null>(null)

  // --- Provider & multi-model presets ---
  const [profiles, setProfiles] = useState<AgentProfileDto[]>([])
  const [secretConfigured, setSecretConfigured] = useState(true)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  /** Profile id being edited, or null when creating a new preset. */
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [form, setForm] = useState<DraftForm>(EMPTY_FORM)
  const [extraModelInput, setExtraModelInput] = useState('')
  const [fetchingModels, setFetchingModels] = useState(false)
  const [fetchedModels, setFetchedModels] = useState<string[] | null>(null)
  const [fetchModelsError, setFetchModelsError] = useState<string | null>(null)
  const [modelPickerQuery, setModelPickerQuery] = useState('')

  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [savedNotice, setSavedNotice] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<AgentConnectionTestResult | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)

  const populateForm = useCallback((profile: AgentProfileDto | null, totalCount: number) => {
    setFormError(null)
    setSavedNotice(null)
    setTestResult(null)
    setConfirmDelete(false)
    setShowApiKey(false)
    setExtraModelInput('')
    setFetchedModels(null)
    setFetchModelsError(null)
    setModelPickerQuery('')
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
      models: normalizeModelList(profile.model, profile.models),
      apiKey: '',
      clearApiKey: false,
      isDefault: profile.isDefault,
    })
  }, [])

  const loadUserSettings = useCallback(async () => {
    setSettingsLoading(true)
    setSettingsError(null)
    try {
      const res = await api.agentSettings()
      setUserSettings(res.settings)
      setSettingsDraft(res.settings)
      onSettingsChanged?.(res.settings)
    } catch (cause) {
      setSettingsError(errorMessageOf(cause, '加载助手运行偏好失败'))
    } finally {
      setSettingsLoading(false)
    }
  }, [onSettingsChanged])

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
    if (active) {
      void loadProfiles()
      void loadUserSettings()
    }
  }, [active, loadProfiles, loadUserSettings])

  const settingsDirty =
    settingsDraft.defaultApprovalMode !== userSettings.defaultApprovalMode ||
    settingsDraft.maxSteps !== userSettings.maxSteps ||
    settingsDraft.customInstructions !== userSettings.customInstructions

  const handleSaveSettings = async () => {
    if (settingsSaving) return
    setSettingsError(null)
    setSettingsSavedNotice(null)
    setSettingsSaving(true)
    try {
      const res = await api.updateAgentSettings({
        defaultApprovalMode: settingsDraft.defaultApprovalMode,
        maxSteps: settingsDraft.maxSteps,
        customInstructions: settingsDraft.customInstructions,
      })
      setUserSettings(res.settings)
      setSettingsDraft(res.settings)
      onSettingsChanged?.(res.settings)
      setSettingsSavedNotice('运行偏好已同步保存')
    } catch (cause) {
      setSettingsError(errorMessageOf(cause, '保存运行偏好失败'))
    } finally {
      setSettingsSaving(false)
    }
  }

  const selectedProfile = selectedId ? profiles.find((p) => p.id === selectedId) ?? null : null
  const enabledModels = useMemo(() => normalizeModelList(form.model, form.models), [form.model, form.models])

  const filteredFetchedModels = useMemo(() => {
    if (!fetchedModels) return []
    const q = modelPickerQuery.trim().toLowerCase()
    if (!q) return fetchedModels
    return fetchedModels.filter((m) => m.toLowerCase().includes(q))
  }, [fetchedModels, modelPickerQuery])

  const applyTemplate = (tpl: TemplatePreset) => {
    setForm((current) => ({
      ...current,
      name: current.name.trim() ? current.name : tpl.name,
      provider: tpl.provider,
      baseUrl: tpl.baseUrl,
      model: tpl.model,
      models: current.models.length > 0 ? current.models : tpl.models,
    }))
    setFormError(null)
    setTestResult(null)
    setFetchedModels(null)
    setFetchModelsError(null)
  }

  const handlePrimaryModelChange = (nextModel: string) => {
    setForm((current) => {
      const prevPrimary = current.model.trim()
      const nextTrimmed = nextModel.trim()
      // Keep additional models while updating the default slot cleanly when typing.
      const rest = current.models.filter((item) => item !== prevPrimary)
      const nextModels = nextTrimmed ? [nextTrimmed, ...rest.filter((item) => item !== nextTrimmed)] : rest
      return { ...current, model: nextModel, models: nextModels }
    })
  }

  const handleAddExtraModel = (rawValue?: string) => {
    const candidate = (rawValue ?? extraModelInput).trim()
    if (!candidate) return
    setForm((current) => {
      const nextPrimary = current.model.trim() || candidate
      const merged = normalizeModelList(nextPrimary, [...current.models, candidate])
      return { ...current, model: nextPrimary, models: merged }
    })
    if (rawValue === undefined) setExtraModelInput('')
  }

  const handleToggleModelFromFetched = (modelId: string) => {
    setForm((current) => {
      const normalized = normalizeModelList(current.model, current.models)
      if (normalized.includes(modelId)) {
        if (normalized.length <= 1) return current
        const nextList = normalized.filter((item) => item !== modelId)
        const nextPrimary = current.model.trim() === modelId ? nextList[0]! : current.model
        return { ...current, model: nextPrimary, models: nextList }
      }
      const nextPrimary = current.model.trim() || modelId
      return { ...current, model: nextPrimary, models: normalizeModelList(nextPrimary, [...normalized, modelId]) }
    })
  }

  const handleRemoveModel = (modelId: string) => {
    setForm((current) => {
      const normalized = normalizeModelList(current.model, current.models)
      if (normalized.length <= 1) return current
      const nextList = normalized.filter((item) => item !== modelId)
      const nextPrimary = current.model.trim() === modelId ? nextList[0]! : current.model
      return { ...current, model: nextPrimary, models: nextList }
    })
  }

  const handleSetDefaultModel = (modelId: string) => {
    setForm((current) => ({
      ...current,
      model: modelId,
      models: normalizeModelList(modelId, current.models),
    }))
  }

  const handleFetchModels = async () => {
    if (fetchingModels) return
    setFetchModelsError(null)
    setFormError(null)
    if (!form.baseUrl.trim()) {
      setFetchModelsError('拉取模型前请先填写 Base URL。')
      return
    }
    setFetchingModels(true)
    try {
      const result = await api.fetchAgentProfileModels({
        ...(selectedProfile && !form.clearApiKey && !form.apiKey.trim() ? { profileId: selectedProfile.id } : {}),
        provider: form.provider,
        baseUrl: form.baseUrl.trim(),
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      })
      if (!result.ok) {
        setFetchModelsError(result.error ?? '未能从该端点拉取模型列表，请手动添加模型名称。')
        setFetchedModels(null)
      } else {
        setFetchedModels(result.models)
        setModelPickerQuery('')
      }
    } catch (cause) {
      setFetchModelsError(errorMessageOf(cause, '拉取模型列表失败'))
      setFetchedModels(null)
    } finally {
      setFetchingModels(false)
    }
  }

  const handleSave = async () => {
    if (saving) return
    setFormError(null)
    setSavedNotice(null)
    const cleanModel = form.model.trim() || enabledModels[0] || ''
    const finalModels = normalizeModelList(cleanModel, enabledModels)

    if (!form.name.trim()) {
      setFormError('请填写预设名称，例如「Claude 校对」。')
      return
    }
    if (!form.baseUrl.trim()) {
      setFormError('请填写完整的 Base URL（以 http:// 或 https:// 开头）。')
      return
    }
    if (!cleanModel) {
      setFormError('请至少填写一个模型名称。')
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
          model: cleanModel,
          models: finalModels,
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
          model: cleanModel,
          models: finalModels,
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
    const testModel = form.model.trim() || enabledModels[0] || ''
    if (!form.baseUrl.trim() || !testModel) {
      setFormError('测试连接前请先填写 Base URL 和模型名称。')
      return
    }
    setTesting(true)
    try {
      const result = await api.testAgentProfile({
        ...(selectedProfile && !form.clearApiKey && !form.apiKey.trim() ? { profileId: selectedProfile.id } : {}),
        provider: form.provider,
        baseUrl: form.baseUrl.trim(),
        model: testModel,
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
    <div className="agent-settings-panel">
      {/* Cloud-synced Agent runtime preferences. See ADR 2026-11-20-agent-modes-and-multimodel. */}
      <section className="agent-prefs-section" aria-labelledby="agent-prefs-heading">
        <div className="agent-prefs-head">
          <div className="agent-prefs-head-copy">
            <h3 id="agent-prefs-heading" className="settings-section-title">
              运行偏好
            </h3>
            <span className="settings-section-meta">随个人账号云端同步</span>
          </div>
          <Button
            variant={settingsDirty ? 'primary' : 'secondary'}
            size="sm"
            type="button"
            disabled={settingsLoading || settingsSaving || !settingsDirty}
            onClick={() => void handleSaveSettings()}
          >
            {settingsSaving ? '保存中…' : '保存偏好'}
          </Button>
        </div>

        {settingsError ? (
          <p className="banner banner-error" role="alert">
            <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{settingsError}</span>
            <button type="button" className="banner-action" onClick={() => void loadUserSettings()}>
              重试
            </button>
          </p>
        ) : null}

        {settingsSavedNotice ? (
          <p className="banner banner-ok" role="status">
            <Check size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{settingsSavedNotice}</span>
          </p>
        ) : null}

        {settingsLoading ? (
          <div className="agent-profile-skeletons" aria-busy="true" aria-label="正在加载运行偏好">
            <span className="skeleton-line" />
            <span className="skeleton-line short" />
          </div>
        ) : (
          <div className="agent-prefs-body">
            <div className="settings-row">
              <div className="settings-row-copy">
                <span id="agent-default-mode-label" className="settings-row-title">
                  默认审批模式
                </span>
                <span className="settings-row-desc">新建对话时的初始权限级别（对话内可随时覆盖）</span>
              </div>
              <div className="settings-segment" role="radiogroup" aria-labelledby="agent-default-mode-label">
                {APPROVAL_OPTIONS.map((option) => {
                  const Icon = option.icon
                  const selected = settingsDraft.defaultApprovalMode === option.value
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`settings-segment-btn${selected ? ' on' : ''}`}
                      onClick={() => {
                        setSettingsSavedNotice(null)
                        setSettingsDraft((cur) => ({ ...cur, defaultApprovalMode: option.value }))
                      }}
                    >
                      <Icon size={12} strokeWidth={1.75} aria-hidden="true" />
                      <span>{option.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-copy">
                <label htmlFor="agent-max-steps-input" className="settings-row-title">
                  单轮最大工具步数
                </label>
                <span className="settings-row-desc">留空表示不限制（可随时手动停止），或填任意正整数</span>
              </div>
              <div className="agent-steps-input-wrap">
                <input
                  id="agent-max-steps-input"
                  data-testid="agent-max-steps-input"
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  placeholder="不限制"
                  value={settingsDraft.maxSteps > 0 ? String(settingsDraft.maxSteps) : ''}
                  onChange={(event) => {
                    setSettingsSavedNotice(null)
                    const raw = event.target.value.trim()
                    if (!raw) {
                      setSettingsDraft((cur) => ({ ...cur, maxSteps: 0 }))
                      return
                    }
                    const parsed = Number.parseInt(raw, 10)
                    if (Number.isFinite(parsed) && parsed >= 0) {
                      setSettingsDraft((cur) => ({ ...cur, maxSteps: parsed }))
                    }
                  }}
                />
                {settingsDraft.maxSteps > 0 ? (
                  <button
                    type="button"
                    className="agent-steps-clear"
                    aria-label="恢复为不限制步数"
                    title="恢复为不限制"
                    onClick={() => {
                      setSettingsSavedNotice(null)
                      setSettingsDraft((cur) => ({ ...cur, maxSteps: 0 }))
                    }}
                  >
                    <X size={12} strokeWidth={1.85} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            </div>

            <label className="panel-field agent-custom-instructions-field">
              <span className="agent-field-head">
                <span>自定义附加指令</span>
                <span className="agent-field-count">
                  {settingsDraft.customInstructions.length} / {MAX_CUSTOM_INSTRUCTIONS}
                </span>
              </span>
              <textarea
                rows={2}
                maxLength={MAX_CUSTOM_INSTRUCTIONS}
                placeholder="例如：校对学术书籍时保留原文民国纪年、术语译法与所有内联 MathML 公式。"
                value={settingsDraft.customInstructions}
                onChange={(event) => {
                  setSettingsSavedNotice(null)
                  setSettingsDraft((cur) => ({ ...cur, customInstructions: event.target.value }))
                }}
              />
            </label>
          </div>
        )}
      </section>

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
        <section className="agent-profile-list-pane" aria-label="已保存供应商预设">
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
            <p className="agent-profile-empty">暂无已保存供应商，在右侧填写并保存第一套配置即可启用助手。</p>
          ) : (
            <ul className="agent-profile-list">
              {profiles.map((profile) => {
                const isSelected = selectedId === profile.id
                const modelCount = profile.models?.length ?? 1
                return (
                  <li key={profile.id}>
                    <button
                      type="button"
                      className={`agent-profile-item${isSelected ? ' on' : ''}`}
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
                      <span className="agent-profile-meta-row">
                        <span className="agent-profile-provider">
                          {profile.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'}
                        </span>
                        <span className="agent-profile-meta" title={`${profile.model} · ${profile.baseUrl}`}>
                          {profile.model}
                        </span>
                        {modelCount > 1 ? (
                          <span className="agent-profile-model-count" title={`共启用 ${modelCount} 个模型`}>
                            +{modelCount - 1}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className="agent-profile-form-pane" aria-label="编辑供应商与模型">
          <div className="agent-template-bar">
            <span className="agent-section-label">快捷模板</span>
            <div className="agent-template-chips">
              {TEMPLATES.map((tpl) => {
                const isMatched = form.provider === tpl.provider && form.baseUrl.trim() === tpl.baseUrl
                return (
                  <button
                    key={tpl.id}
                    type="button"
                    className={`agent-template-chip${isMatched ? ' on' : ''}`}
                    onClick={() => applyTemplate(tpl)}
                  >
                    {tpl.label}
                  </button>
                )
              })}
            </div>
          </div>

          <form
            className="agent-profile-form"
            onSubmit={(event) => {
              event.preventDefault()
              void handleSave()
            }}
          >
            <label className="panel-field">
              <span>预设名称</span>
              <input
                type="text"
                value={form.name}
                placeholder="例如：Claude 主力 / DeepSeek"
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </label>

            <div className="panel-field">
              <span id="agent-provider-label">接口协议</span>
              <div
                className="agent-provider-segment"
                role="radiogroup"
                aria-labelledby="agent-provider-label"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={form.provider === 'openai-compatible'}
                  className={`agent-provider-option${form.provider === 'openai-compatible' ? ' on' : ''}`}
                  onClick={() => setForm({ ...form, provider: 'openai-compatible' })}
                >
                  <span className="agent-provider-option-title">OpenAI 兼容</span>
                  <span className="agent-provider-option-sub">OpenAI · DeepSeek · Ollama</span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={form.provider === 'anthropic'}
                  className={`agent-provider-option${form.provider === 'anthropic' ? ' on' : ''}`}
                  onClick={() => setForm({ ...form, provider: 'anthropic' })}
                >
                  <span className="agent-provider-option-title">Anthropic 原生</span>
                  <span className="agent-provider-option-sub">Claude Messages API</span>
                </button>
              </div>
            </div>

            <div className="agent-form-grid">
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
                  onChange={(event) => handlePrimaryModelChange(event.target.value)}
                />
              </label>
            </div>

            <label className="panel-field">
              <span>API Key（本地模型可留空）</span>
              <span className="agent-secret-input-wrap">
                <input
                  type={showApiKey ? 'text' : 'password'}
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
                <button
                  type="button"
                  className="agent-secret-toggle"
                  disabled={form.clearApiKey}
                  aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}
                  title={showApiKey ? '隐藏 API Key' : '显示 API Key'}
                  onClick={() => setShowApiKey((v) => !v)}
                >
                  {showApiKey ? (
                    <EyeOff size={14} strokeWidth={1.7} aria-hidden="true" />
                  ) : (
                    <Eye size={14} strokeWidth={1.7} aria-hidden="true" />
                  )}
                </button>
              </span>
            </label>

            {/* Multi-model management under the same provider & API key. See ADR 2026-11-20-agent-modes-and-multimodel. */}
            <div className="panel-field agent-models-manager">
              <div className="agent-models-head">
                <span>同供应商启用模型（{enabledModels.length}）</span>
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  disabled={fetchingModels}
                  onClick={() => void handleFetchModels()}
                >
                  {fetchingModels ? (
                    <Loader2 size={12} strokeWidth={1.8} className="spin" aria-hidden="true" />
                  ) : (
                    <RefreshCw size={12} strokeWidth={1.75} aria-hidden="true" />
                  )}
                  <span>{fetchingModels ? '拉取中…' : '拉取模型列表'}</span>
                </Button>
              </div>

              {enabledModels.length > 0 ? (
                <ul className="agent-model-chips" aria-label="已启用的模型">
                  {enabledModels.map((modelId) => {
                    const isDefaultModel = modelId === form.model.trim()
                    return (
                      <li key={modelId} className={`agent-model-chip${isDefaultModel ? ' is-default' : ''}`}>
                        <button
                          type="button"
                          className="agent-model-chip-main"
                          title={isDefaultModel ? '当前默认模型' : `将 ${modelId} 设为默认模型`}
                          onClick={() => handleSetDefaultModel(modelId)}
                        >
                          {isDefaultModel ? (
                            <Star size={10} strokeWidth={2.2} fill="currentColor" aria-hidden="true" />
                          ) : null}
                          <span>{modelId}</span>
                        </button>
                        {enabledModels.length > 1 ? (
                          <button
                            type="button"
                            className="agent-model-chip-remove"
                            aria-label={`移除模型 ${modelId}`}
                            title={`移除 ${modelId}`}
                            onClick={() => handleRemoveModel(modelId)}
                          >
                            <X size={11} strokeWidth={1.9} aria-hidden="true" />
                          </button>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              ) : null}

              <div className="agent-model-add-row">
                <input
                  type="text"
                  aria-label="添加同供应商模型"
                  placeholder="输入额外模型 ID 并回车添加，如 gpt-4.1-mini"
                  value={extraModelInput}
                  onChange={(event) => setExtraModelInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      handleAddExtraModel()
                    }
                  }}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  disabled={!extraModelInput.trim()}
                  onClick={() => handleAddExtraModel()}
                >
                  <Plus size={12} strokeWidth={1.8} aria-hidden="true" />
                  <span>添加</span>
                </Button>
              </div>

              {fetchModelsError ? (
                <p className="banner banner-warn agent-inline-banner" role="status">
                  <AlertTriangle size={13} strokeWidth={1.75} aria-hidden="true" />
                  <span>{fetchModelsError}</span>
                </p>
              ) : null}

              {fetchedModels ? (
                <div className="agent-fetched-models" aria-label="从接口拉取的模型列表">
                  <div className="agent-fetched-models-bar">
                    <span className="agent-fetched-search-wrap">
                      <Search size={12} strokeWidth={1.75} aria-hidden="true" />
                      <input
                        type="text"
                        aria-label="筛选拉取的模型"
                        placeholder={`筛选 ${fetchedModels.length} 个可用模型…`}
                        value={modelPickerQuery}
                        onChange={(event) => setModelPickerQuery(event.target.value)}
                      />
                    </span>
                    <button
                      type="button"
                      className="agent-link-btn"
                      onClick={() => setFetchedModels(null)}
                    >
                      收起
                    </button>
                  </div>
                  {filteredFetchedModels.length === 0 ? (
                    <p className="agent-fetched-empty">没有匹配「{modelPickerQuery}」的模型</p>
                  ) : (
                    <ul className="agent-fetched-list">
                      {filteredFetchedModels.map((modelId) => {
                        const checked = enabledModels.includes(modelId)
                        return (
                          <li key={modelId}>
                            <button
                              type="button"
                              className={`agent-fetched-item${checked ? ' on' : ''}`}
                              aria-pressed={checked}
                              onClick={() => handleToggleModelFromFetched(modelId)}
                            >
                              <span className="agent-fetched-check" aria-hidden="true">
                                {checked ? <Check size={12} strokeWidth={2.2} /> : <Plus size={11} strokeWidth={1.8} />}
                              </span>
                              <span className="agent-fetched-id" title={modelId}>
                                {modelId}
                              </span>
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              ) : null}
            </div>

            <div className="agent-form-checks">
              <label className="agent-checkbox-row">
                <input
                  type="checkbox"
                  checked={form.isDefault}
                  onChange={(event) => setForm({ ...form, isDefault: event.target.checked })}
                />
                <span>设为默认供应商</span>
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
    </div>
  )
}

export function AgentSettingsDialog({
  open,
  onOpenChange,
  onChanged,
  onSettingsChanged,
}: AgentSettingsDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="模型设置"
      title="助手模型与偏好设置"
      description="按个人账号保存运行偏好与多套供应商模型配置，API Key 由服务端加密存储，仅回显末四位。"
      className="agent-settings-dialog"
    >
      <AgentSettingsPanel active={open} onChanged={onChanged} onSettingsChanged={onSettingsChanged} />
    </Dialog>
  )
}
