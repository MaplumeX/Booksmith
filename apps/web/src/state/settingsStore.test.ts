import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  MAX_CODE_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  isDefaultSettings,
  normalizeSettings,
  resolveTheme,
} from './settingsStore'

describe('settingsStore', () => {
  it('normalizes missing, invalid, and out-of-range settings safely', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings('invalid')).toEqual(DEFAULT_SETTINGS)
    expect(
      normalizeSettings({
        theme: 'sepia',
        codeFontSize: 40,
        codeWordWrap: 'yes',
        showCodeToolbar: 'no',
        defaultEditorMode: 'split',
        defaultPreviewOpen: 1,
      }),
    ).toEqual({
      theme: 'system',
      codeFontSize: MAX_CODE_FONT_SIZE,
      codeWordWrap: true,
      showCodeToolbar: true,
      defaultEditorMode: 'code',
      defaultPreviewOpen: true,
    })

    expect(
      normalizeSettings({
        theme: 'dark',
        codeFontSize: 8.2,
        codeWordWrap: false,
        showCodeToolbar: false,
        defaultEditorMode: 'wysiwyg',
        defaultPreviewOpen: false,
      }),
    ).toEqual({
      theme: 'dark',
      codeFontSize: MIN_CODE_FONT_SIZE,
      codeWordWrap: false,
      showCodeToolbar: false,
      defaultEditorMode: 'wysiwyg',
      defaultPreviewOpen: false,
    })
  })

  it('resolves explicit themes directly and falls back to system preference for system mode', () => {
    expect(resolveTheme('light', 'dark')).toBe('light')
    expect(resolveTheme('dark', 'light')).toBe('dark')
    expect(resolveTheme('system', 'dark')).toBe('dark')
    expect(resolveTheme('system', 'light')).toBe('light')
  })

  it('detects whether settings match defaults', () => {
    expect(isDefaultSettings(DEFAULT_SETTINGS)).toBe(true)
    expect(isDefaultSettings({ ...DEFAULT_SETTINGS, theme: 'dark' })).toBe(false)
    expect(isDefaultSettings({ ...DEFAULT_SETTINGS, codeFontSize: 15 })).toBe(false)
    expect(isDefaultSettings({ ...DEFAULT_SETTINGS, codeWordWrap: false })).toBe(false)
    expect(isDefaultSettings({ ...DEFAULT_SETTINGS, showCodeToolbar: false })).toBe(false)
    expect(isDefaultSettings({ ...DEFAULT_SETTINGS, defaultEditorMode: 'wysiwyg' })).toBe(false)
    expect(isDefaultSettings({ ...DEFAULT_SETTINGS, defaultPreviewOpen: false })).toBe(false)
  })
})
