import {
  Code2,
  FilePenLine,
  Minus,
  Monitor,
  Moon,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Sun,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AgentProfileDto, AgentUserSettingsDto } from '../api/client'
import {
  isDefaultSettings,
  MAX_CODE_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  useSettings,
  type DefaultEditorMode,
  type ThemeMode,
} from '../state/settingsStore'
import { AgentSettingsPanel } from './AgentSettingsDialog'
import { Button } from './Button'
import { Dialog } from './Dialog'

export type SettingsTab = 'general' | 'agent'

interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialTab?: SettingsTab
  onAgentProfilesChanged?: (profiles: AgentProfileDto[]) => void
  onAgentSettingsChanged?: (settings: AgentUserSettingsDto) => void
}

const THEME_OPTIONS: Array<{
  value: ThemeMode
  label: string
  hint: string
  icon: typeof Monitor
}> = [
  { value: 'system', label: '跟随系统', hint: '随系统切换', icon: Monitor },
  { value: 'light', label: '浅色', hint: '日间纸面', icon: Sun },
  { value: 'dark', label: '深色', hint: '夜间护眼', icon: Moon },
]

const MODE_OPTIONS: Array<{
  value: DefaultEditorMode
  label: string
  icon: typeof Code2
}> = [
  { value: 'code', label: '代码', icon: Code2 },
  { value: 'wysiwyg', label: '可视化', icon: FilePenLine },
]

export function SettingsDialog({
  open,
  onOpenChange,
  initialTab = 'general',
  onAgentProfilesChanged,
  onAgentSettingsChanged,
}: SettingsDialogProps) {
  const { settings, resolvedTheme, updateSettings, resetSettings } = useSettings()
  const [tab, setTab] = useState<SettingsTab>(initialTab)
  const atDefaults = isDefaultSettings(settings)

  useEffect(() => {
    if (open) setTab(initialTab)
  }, [open, initialTab])

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="应用设置"
      title="应用设置"
      description={
        tab === 'agent'
          ? '按个人账号保存多套模型配置，API Key 由服务端加密存储，仅回显末四位。'
          : '主题与编辑器偏好保存在当前浏览器，修改后立即生效。'
      }
      className="settings-dialog"
      footer={
        tab === 'general' ? (
          <div className="settings-footer">
            <Button
              variant="ghost"
              size="sm"
              type="button"
              disabled={atDefaults}
              onClick={() => resetSettings()}
            >
              <RotateCcw size={13} strokeWidth={1.75} aria-hidden="true" />
              <span>恢复默认</span>
            </Button>
            <Button variant="primary" type="button" onClick={() => onOpenChange(false)}>
              完成
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="settings-tabs" role="tablist" aria-label="设置分类">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'general'}
          className={`settings-tab${tab === 'general' ? ' on' : ''}`}
          onClick={() => setTab('general')}
        >
          <SlidersHorizontal size={13} strokeWidth={1.75} aria-hidden="true" />
          <span>通用</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'agent'}
          className={`settings-tab${tab === 'agent' ? ' on' : ''}`}
          onClick={() => setTab('agent')}
        >
          <Sparkles size={13} strokeWidth={1.75} aria-hidden="true" />
          <span>AI 助手</span>
        </button>
      </div>

      {tab === 'general' ? (
        <div className="settings-general-panel" role="tabpanel" aria-label="通用">
          <section className="settings-section" aria-labelledby="settings-appearance-heading">
            <div className="settings-section-head">
              <h3 id="settings-appearance-heading" className="settings-section-title">
                外观主题
              </h3>
              {settings.theme === 'system' ? (
                <span className="settings-section-meta">
                  当前系统：{resolvedTheme === 'dark' ? '深色' : '浅色'}
                </span>
              ) : null}
            </div>

            <div
              className="settings-theme-group"
              role="radiogroup"
              aria-labelledby="settings-appearance-heading"
            >
              {THEME_OPTIONS.map((option) => {
                const Icon = option.icon
                const selected = settings.theme === option.value
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={`settings-theme-option${selected ? ' on' : ''}`}
                    onClick={() => updateSettings({ theme: option.value })}
                  >
                    <span className="settings-theme-icon" aria-hidden="true">
                      <Icon size={16} strokeWidth={1.75} />
                    </span>
                    <span className="settings-theme-label">{option.label}</span>
                    <span className="settings-theme-hint">{option.hint}</span>
                  </button>
                )
              })}
            </div>

            <p className="settings-note">
              界面、代码编辑器、实时书页预览与可视化纸面统一跟随全局主题。
            </p>
          </section>

          <section className="settings-section" aria-labelledby="settings-editor-heading">
            <h3 id="settings-editor-heading" className="settings-section-title">
              编辑器
            </h3>

            <div className="settings-rows">
              <div className="settings-row">
                <div className="settings-row-copy">
                  <span id="settings-fontsize-label" className="settings-row-title">
                    代码字号
                  </span>
                  <span className="settings-row-desc">调整源码编辑区等宽字号（12–18px）</span>
                </div>
                <div className="settings-stepper" role="group" aria-labelledby="settings-fontsize-label">
                  <button
                    type="button"
                    className="settings-stepper-btn"
                    aria-label="减小代码字号"
                    disabled={settings.codeFontSize <= MIN_CODE_FONT_SIZE}
                    onClick={() => updateSettings({ codeFontSize: settings.codeFontSize - 1 })}
                  >
                    <Minus size={13} strokeWidth={1.85} aria-hidden="true" />
                  </button>
                  <span className="settings-stepper-value" data-testid="code-font-size-value">
                    {settings.codeFontSize}px
                  </span>
                  <button
                    type="button"
                    className="settings-stepper-btn"
                    aria-label="增大代码字号"
                    disabled={settings.codeFontSize >= MAX_CODE_FONT_SIZE}
                    onClick={() => updateSettings({ codeFontSize: settings.codeFontSize + 1 })}
                  >
                    <Plus size={13} strokeWidth={1.85} aria-hidden="true" />
                  </button>
                </div>
              </div>

              <div className="settings-row">
                <div className="settings-row-copy">
                  <span id="settings-wrap-label" className="settings-row-title">
                    代码自动换行
                  </span>
                  <span className="settings-row-desc">超长段落按视口宽度折行，减少横向滚动</span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-labelledby="settings-wrap-label"
                  aria-checked={settings.codeWordWrap}
                  className={`settings-switch${settings.codeWordWrap ? ' on' : ''}`}
                  onClick={() => updateSettings({ codeWordWrap: !settings.codeWordWrap })}
                >
                  <span className="settings-switch-thumb" aria-hidden="true" />
                </button>
              </div>

              <div className="settings-row">
                <div className="settings-row-copy">
                  <span id="settings-code-toolbar-label" className="settings-row-title">
                    显示代码工具条
                  </span>
                  <span className="settings-row-desc">在代码区顶部显示单行快捷拆章、标签包裹、插图与格式化工具条</span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-labelledby="settings-code-toolbar-label"
                  aria-checked={settings.showCodeToolbar}
                  className={`settings-switch${settings.showCodeToolbar ? ' on' : ''}`}
                  onClick={() => updateSettings({ showCodeToolbar: !settings.showCodeToolbar })}
                >
                  <span className="settings-switch-thumb" aria-hidden="true" />
                </button>
              </div>

              <div className="settings-row">
                <div className="settings-row-copy">
                  <span id="settings-mode-label" className="settings-row-title">
                    默认编辑模式
                  </span>
                  <span className="settings-row-desc">打开新书时优先进入的章节编辑视图</span>
                </div>
                <div className="settings-segment" role="radiogroup" aria-labelledby="settings-mode-label">
                  {MODE_OPTIONS.map((option) => {
                    const Icon = option.icon
                    const selected = settings.defaultEditorMode === option.value
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className={`settings-segment-btn${selected ? ' on' : ''}`}
                        onClick={() => updateSettings({ defaultEditorMode: option.value })}
                      >
                        <Icon size={13} strokeWidth={1.75} aria-hidden="true" />
                        <span>{option.label}</span>
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="settings-row">
                <div className="settings-row-copy">
                  <span id="settings-preview-label" className="settings-row-title">
                    默认开启对照预览
                  </span>
                  <span className="settings-row-desc">代码模式下打开书籍时自动展开右侧书页预览</span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-labelledby="settings-preview-label"
                  aria-checked={settings.defaultPreviewOpen}
                  className={`settings-switch${settings.defaultPreviewOpen ? ' on' : ''}`}
                  onClick={() => updateSettings({ defaultPreviewOpen: !settings.defaultPreviewOpen })}
                >
                  <span className="settings-switch-thumb" aria-hidden="true" />
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : (
        <div role="tabpanel" aria-label="AI 助手">
          <AgentSettingsPanel
            active={open && tab === 'agent'}
            onChanged={onAgentProfilesChanged}
            onSettingsChanged={onAgentSettingsChanged}
          />
        </div>
      )}
    </Dialog>
  )
}
