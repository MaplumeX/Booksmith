import { describe, expect, it } from 'vitest'
import { formatShortcut, isMacPlatform, matchHeadingShortcut } from './shortcuts'

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
    expect(formatShortcut('Mod+Alt+0', true)).toBe('⌘⌥0')
    expect(formatShortcut('Mod+Alt+2', true)).toBe('⌘⌥2')

    expect(formatShortcut('Mod+Enter', false)).toBe('Ctrl+Enter')
    expect(formatShortcut('Mod+Shift+Enter', false)).toBe('Ctrl+Shift+Enter')
    expect(formatShortcut('Alt+Shift+F', false)).toBe('Alt+Shift+F')
    expect(formatShortcut('Mod+K', false)).toBe('Ctrl+K')
    expect(formatShortcut('Mod+Shift+F', false)).toBe('Ctrl+Shift+F')
    expect(formatShortcut('Mod+Z', false)).toBe('Ctrl+Z')
    expect(formatShortcut('Mod+Alt+0', false)).toBe('Ctrl+Alt+0')
    expect(formatShortcut('Mod+Alt+2', false)).toBe('Ctrl+Alt+2')
  })

  it('matches Mod+Alt+0..4 heading shortcuts including macOS Option-remapped keys', () => {
    expect(
      matchHeadingShortcut({ metaKey: true, ctrlKey: false, altKey: true, shiftKey: false, key: '¡', code: 'Digit1' }),
    ).toBe('h1')
    expect(
      matchHeadingShortcut({ metaKey: true, ctrlKey: false, altKey: true, shiftKey: false, key: 'º', code: 'Digit0' }),
    ).toBe('p')
    expect(
      matchHeadingShortcut({ metaKey: false, ctrlKey: true, altKey: true, shiftKey: false, key: '2', code: 'Numpad2' }),
    ).toBe('h2')
    expect(
      matchHeadingShortcut({ metaKey: false, ctrlKey: true, altKey: true, shiftKey: false, key: '3', code: '' }),
    ).toBe('h3')
    expect(
      matchHeadingShortcut({ metaKey: false, ctrlKey: true, altKey: true, shiftKey: false, key: '4', code: 'Digit4' }),
    ).toBe('h4')

    expect(
      matchHeadingShortcut({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, key: '1', code: 'Digit1' }),
    ).toBeNull()
    expect(
      matchHeadingShortcut({ metaKey: true, ctrlKey: false, altKey: true, shiftKey: true, key: '1', code: 'Digit1' }),
    ).toBeNull()
    expect(
      matchHeadingShortcut({ metaKey: true, ctrlKey: false, altKey: true, shiftKey: false, key: '5', code: 'Digit5' }),
    ).toBeNull()
  })
})
