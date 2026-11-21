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
