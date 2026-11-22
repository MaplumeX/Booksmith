interface NavigatorLike {
  platform?: string
  userAgent?: string
  userAgentData?: { platform?: string }
}

const MAC_PATTERN = /mac|iphone|ipad|ipod/i

/** Detects Apple platforms from Navigator metadata so shortcut hints follow the user's OS. */
export function isMacPlatform(nav?: NavigatorLike): boolean {
  const source: NavigatorLike | undefined =
    nav ?? (typeof navigator !== 'undefined' ? (navigator as unknown as NavigatorLike) : undefined)
  if (!source) return false
  const platform = source.userAgentData?.platform || source.platform || source.userAgent || ''
  return MAC_PATTERN.test(platform)
}

const MAC_TOKENS: Record<string, string> = {
  Mod: '⌘',
  Ctrl: '⌃',
  Alt: '⌥',
  Shift: '⇧',
  Enter: '↩',
}

const NON_MAC_TOKENS: Record<string, string> = {
  Mod: 'Ctrl',
  Ctrl: 'Ctrl',
  Alt: 'Alt',
  Shift: 'Shift',
  Enter: 'Enter',
}

/**
 * Formats a canonical shortcut spec (`Mod+Enter`, `Mod+Shift+Enter`, `Alt+Shift+F`, `Mod+K`, …)
 * into native macOS glyph style (`⌘↩`, `⌥⇧F`) or Windows/Linux style (`Ctrl+Enter`, `Alt+Shift+F`).
 */
export function formatShortcut(spec: string, mac = isMacPlatform()): string {
  const parts = spec
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  if (mac) {
    return parts.map((part) => MAC_TOKENS[part] ?? part).join('')
  }
  return parts.map((part) => NON_MAC_TOKENS[part] ?? part).join('+')
}

export type HeadingShortcutTag = 'p' | 'h1' | 'h2' | 'h3' | 'h4'

export const HEADING_SHORTCUTS: ReadonlyArray<{
  tag: HeadingShortcutTag
  spec: string
  label: string
  codeLabel: string
}> = [
  { tag: 'p', spec: 'Mod+Alt+0', label: '正文', codeLabel: '正文 <p>' },
  { tag: 'h1', spec: 'Mod+Alt+1', label: '一级标题', codeLabel: '一级标题 <h1>' },
  { tag: 'h2', spec: 'Mod+Alt+2', label: '二级标题', codeLabel: '二级标题 <h2>' },
  { tag: 'h3', spec: 'Mod+Alt+3', label: '三级标题', codeLabel: '三级标题 <h3>' },
  { tag: 'h4', spec: 'Mod+Alt+4', label: '四级标题', codeLabel: '四级标题 <h4>' },
]

const DIGIT_TO_HEADING_TAG: Record<string, HeadingShortcutTag> = {
  '0': 'p',
  '1': 'h1',
  '2': 'h2',
  '3': 'h3',
  '4': 'h4',
}

/**
 * Matches `Mod+Alt+0`..`Mod+Alt+4` using physical `code` first so macOS Option-key
 * character remapping (`¡`, `™`, `£`, `¢`, `º`) still triggers heading switches.
 */
export function matchHeadingShortcut(
  event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'key' | 'code'>,
): HeadingShortcutTag | null {
  const mod = event.metaKey || event.ctrlKey
  if (!mod || !event.altKey || event.shiftKey) return null
  const codeMatch = /^(?:Digit|Numpad)([0-4])$/.exec(event.code)
  if (codeMatch?.[1]) return DIGIT_TO_HEADING_TAG[codeMatch[1]] ?? null
  return DIGIT_TO_HEADING_TAG[event.key] ?? null
}
