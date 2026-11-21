import { useSyncExternalStore } from 'react'

export type ThemeMode = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'
export type DefaultEditorMode = 'code' | 'wysiwyg'

export interface AppSettings {
  theme: ThemeMode
  codeFontSize: number
  codeWordWrap: boolean
  showCodeToolbar: boolean
  defaultEditorMode: DefaultEditorMode
  defaultPreviewOpen: boolean
}

export const SETTINGS_STORAGE_KEY = 'booksmith:settings:v1'
export const MIN_CODE_FONT_SIZE = 12
export const MAX_CODE_FONT_SIZE = 18

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  codeFontSize: 13,
  codeWordWrap: true,
  showCodeToolbar: true,
  defaultEditorMode: 'code',
  defaultPreviewOpen: true,
}

type Listener = () => void

const listeners = new Set<Listener>()
let currentSettings: AppSettings = readSettingsFromStorage()
let systemTheme: ResolvedTheme = readSystemTheme()
let browserListenersAttached = false

function readSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function normalizeSettings(raw: unknown): AppSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS }
  const obj = raw as Record<string, unknown>

  const theme: ThemeMode =
    obj.theme === 'light' || obj.theme === 'dark' || obj.theme === 'system'
      ? obj.theme
      : DEFAULT_SETTINGS.theme

  const parsedFontSize =
    typeof obj.codeFontSize === 'number' && Number.isFinite(obj.codeFontSize)
      ? Math.round(obj.codeFontSize)
      : DEFAULT_SETTINGS.codeFontSize
  const codeFontSize = Math.min(MAX_CODE_FONT_SIZE, Math.max(MIN_CODE_FONT_SIZE, parsedFontSize))

  const codeWordWrap =
    typeof obj.codeWordWrap === 'boolean' ? obj.codeWordWrap : DEFAULT_SETTINGS.codeWordWrap

  const showCodeToolbar =
    typeof obj.showCodeToolbar === 'boolean' ? obj.showCodeToolbar : DEFAULT_SETTINGS.showCodeToolbar

  const defaultEditorMode: DefaultEditorMode =
    obj.defaultEditorMode === 'code' || obj.defaultEditorMode === 'wysiwyg'
      ? obj.defaultEditorMode
      : DEFAULT_SETTINGS.defaultEditorMode

  const defaultPreviewOpen =
    typeof obj.defaultPreviewOpen === 'boolean'
      ? obj.defaultPreviewOpen
      : DEFAULT_SETTINGS.defaultPreviewOpen

  return {
    theme,
    codeFontSize,
    codeWordWrap,
    showCodeToolbar,
    defaultEditorMode,
    defaultPreviewOpen,
  }
}

function readSettingsFromStorage(): AppSettings {
  if (typeof window === 'undefined') return { ...DEFAULT_SETTINGS }
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    return normalizeSettings(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

function persistSettings(settings: AppSettings): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Ignore quota or private browsing storage restrictions; in-memory state still works.
  }
}

export function resolveTheme(mode: ThemeMode, system: ResolvedTheme = systemTheme): ResolvedTheme {
  return mode === 'system' ? system : mode
}

export function getSettings(): AppSettings {
  return currentSettings
}

export function getResolvedTheme(): ResolvedTheme {
  return resolveTheme(currentSettings.theme, systemTheme)
}

export function isDefaultSettings(settings: AppSettings): boolean {
  return (
    settings.theme === DEFAULT_SETTINGS.theme &&
    settings.codeFontSize === DEFAULT_SETTINGS.codeFontSize &&
    settings.codeWordWrap === DEFAULT_SETTINGS.codeWordWrap &&
    settings.showCodeToolbar === DEFAULT_SETTINGS.showCodeToolbar &&
    settings.defaultEditorMode === DEFAULT_SETTINGS.defaultEditorMode &&
    settings.defaultPreviewOpen === DEFAULT_SETTINGS.defaultPreviewOpen
  )
}

export function applySettingsToDom(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.theme = getResolvedTheme()
  root.style.setProperty('--editor-font-size', `${currentSettings.codeFontSize}px`)
}

function emit(): void {
  applySettingsToDom()
  for (const listener of listeners) listener()
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const next = normalizeSettings({ ...currentSettings, ...patch })
  if (
    next.theme === currentSettings.theme &&
    next.codeFontSize === currentSettings.codeFontSize &&
    next.codeWordWrap === currentSettings.codeWordWrap &&
    next.showCodeToolbar === currentSettings.showCodeToolbar &&
    next.defaultEditorMode === currentSettings.defaultEditorMode &&
    next.defaultPreviewOpen === currentSettings.defaultPreviewOpen
  ) {
    return currentSettings
  }
  currentSettings = next
  persistSettings(next)
  emit()
  return currentSettings
}

export function resetSettings(): AppSettings {
  currentSettings = { ...DEFAULT_SETTINGS }
  persistSettings(currentSettings)
  emit()
  return currentSettings
}

export function subscribeSettings(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Syncs DOM attributes immediately and subscribes to OS theme & cross-tab storage changes. */
export function initSettings(): void {
  currentSettings = readSettingsFromStorage()
  systemTheme = readSystemTheme()
  applySettingsToDom()

  if (browserListenersAttached || typeof window === 'undefined') return
  browserListenersAttached = true

  if (typeof window.matchMedia === 'function') {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onMediaChange = () => {
      const nextSystem: ResolvedTheme = media.matches ? 'dark' : 'light'
      if (nextSystem === systemTheme) return
      systemTheme = nextSystem
      emit()
    }
    media.addEventListener('change', onMediaChange)
  }

  window.addEventListener('storage', (event) => {
    if (event.key !== SETTINGS_STORAGE_KEY && event.key !== null) return
    currentSettings = readSettingsFromStorage()
    emit()
  })
}

export function useSettings() {
  const settings = useSyncExternalStore(subscribeSettings, getSettings, () => DEFAULT_SETTINGS)
  const resolvedTheme = useSyncExternalStore(subscribeSettings, getResolvedTheme, () => 'light')
  return {
    settings,
    resolvedTheme,
    updateSettings,
    resetSettings,
  }
}

export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribeSettings, getResolvedTheme, () => 'light')
}
