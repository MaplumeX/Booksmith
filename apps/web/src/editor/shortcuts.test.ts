import { describe, expect, it } from 'vitest'
import { formatShortcut, isMacPlatform } from './shortcuts'

describe('shortcuts', () => {
  it('detects macOS vs Windows/Linux from navigator metadata', () => {
    expect(isMacPlatform({ platform: 'MacIntel' })).toBe(true)
    expect(isMacPlatform({ userAgentData: { platform: 'macOS' }, platform: 'Linux x86_64' })).toBe(true)
    expect(isMacPlatform({ platform: 'Win32' })).toBe(false)
    expect(isMacPlatform({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })).toBe(false)
  })

  it('formats shortcuts in macOS glyph style or Windows/Linux style consistently', () => {
    expect(formatShortcut('Mod+Enter', true)).toBe('⌘↩')
    expect(formatShortcut('Mod+Shift+Enter', true)).toBe('⌘⇧↩')
    expect(formatShortcut('Alt+Shift+F', true)).toBe('⌥⇧F')
    expect(formatShortcut('Mod+K', true)).toBe('⌘K')
    expect(formatShortcut('Mod+Shift+F', true)).toBe('⌘⇧F')
    expect(formatShortcut('Mod+Z', true)).toBe('⌘Z')

    expect(formatShortcut('Mod+Enter', false)).toBe('Ctrl+Enter')
    expect(formatShortcut('Mod+Shift+Enter', false)).toBe('Ctrl+Shift+Enter')
    expect(formatShortcut('Alt+Shift+F', false)).toBe('Alt+Shift+F')
    expect(formatShortcut('Mod+K', false)).toBe('Ctrl+K')
    expect(formatShortcut('Mod+Shift+F', false)).toBe('Ctrl+Shift+F')
    expect(formatShortcut('Mod+Z', false)).toBe('Ctrl+Z')
  })
})
