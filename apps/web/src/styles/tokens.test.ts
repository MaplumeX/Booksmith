import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8')

function blockVars(selector: string): Record<string, string> {
  const start = css.indexOf(selector)
  if (start < 0) throw new Error(`missing selector ${selector}`)
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  const body = css.slice(open + 1, close)
  const out: Record<string, string> = {}
  for (const match of body.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)) {
    const name = match[1]
    const value = match[2]
    if (name && value) out[name] = value
  }
  return out
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  const [r = 0, g = 0, b = 0] = channels
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

const PAIRS: Array<[string, string, string]> = [
  ['body text on surface', '--text', '--surface'],
  ['body text on raised', '--text', '--surface-raised'],
  ['secondary text on surface', '--text-secondary', '--surface'],
  ['muted text on surface', '--text-muted', '--surface'],
  ['muted text on raised', '--text-muted', '--surface-raised'],
  ['secondary text on hover', '--text-secondary', '--hover-bg'],
  ['primary button', '--accent-fg', '--accent'],
  ['selection', '--selection-fg', '--selection-bg'],
  ['ok status', '--status-ok-fg', '--status-ok-bg'],
  ['error status', '--status-error-fg', '--status-error-bg'],
  ['warn status', '--status-warn-fg', '--status-warn-bg'],
  ['code tag', '--cm-tag', '--surface'],
  ['code attribute', '--cm-attr', '--surface'],
  ['code string', '--cm-string', '--surface'],
  ['code comment', '--cm-comment', '--surface'],
  ['code keyword', '--cm-keyword', '--surface'],
  ['code number', '--cm-number', '--surface'],
]

const THEMES: Array<[string, string]> = [
  ['light', ':root'],
  ['dark', "[data-theme='dark']"],
]

describe.each(THEMES)('%s theme', (themeName, selector) => {
  const vars = blockVars(selector)

  it.each(PAIRS)('%s is at least 4.5:1', (_label, fg, bg) => {
    const fgValue = vars[fg]
    const bgValue = vars[bg]
    if (!fgValue) throw new Error(`${themeName}: ${fg} is not defined`)
    if (!bgValue) throw new Error(`${themeName}: ${bg} is not defined`)
    expect(contrast(fgValue, bgValue)).toBeGreaterThanOrEqual(4.5)
  })

  it('defines every semantic token', () => {
    const required = [
      '--surface',
      '--surface-raised',
      '--surface-sunken',
      '--hover-bg',
      '--text',
      '--text-secondary',
      '--text-muted',
      '--border',
      '--border-strong',
      '--accent',
      '--accent-hover',
      '--accent-subtle',
      '--accent-fg',
      '--selection-bg',
      '--selection-fg',
      '--status-ok-bg',
      '--status-ok-fg',
      '--status-error-bg',
      '--status-error-fg',
      '--status-warn-bg',
      '--status-warn-fg',
      '--focus-ring',
      '--cm-tag',
      '--cm-attr',
      '--cm-string',
      '--cm-comment',
      '--cm-keyword',
      '--cm-number',
    ]
    const missing = required.filter((token) => !(token in vars))
    expect(missing).toEqual([])
  })
})

it('never uses pure black', () => {
  expect(css.toLowerCase()).not.toMatch(/#000(?![0-9a-f])/)
})
