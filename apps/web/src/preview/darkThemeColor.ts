/**
 * Contrast-aware dark mode color adaptation for EPUB stylesheets and inline styles.
 *
 * Maps hardcoded light-mode colors (e.g. `#555` blockquote text, `#f5f5f5` surfaces,
 * `#ccc` borders) into Soft Craft Studio dark surfaces and accessible text tiers while
 * preserving chromatic hues and `url(...)` / `var(...)` expressions.
 * See ADR 2026-11-21-reader-typography-and-dark-adaptation.
 */

interface RgbaColor {
  r: number
  g: number
  b: number
  a: number
}

const DARK_SURFACE: RgbaColor = { r: 0x1a, g: 0x1b, b: 0x24, a: 1 } // #1a1b24
const DARK_SURFACE_RAISED: RgbaColor = { r: 0x22, g: 0x24, b: 0x30, a: 1 } // #222430
const DARK_TEXT = '#ececf2'
const DARK_TEXT_SECONDARY = '#b4b5c7'
const DARK_TEXT_MUTED = '#9e9fb3'
const DARK_BG_BASE = '#1a1b24'
const DARK_BG_RAISED = '#222430'
const DARK_BG_ELEVATED = '#282a38'
const DARK_BORDER = '#2c2e3d'
const DARK_BORDER_STRONG = '#464655'

const NAMED_COLORS: Record<string, string> = {
  aliceblue: '#f0f8ff',
  antiquewhite: '#faebd7',
  aqua: '#00ffff',
  aquamarine: '#7fffd4',
  azure: '#f0ffff',
  beige: '#f5f5dc',
  bisque: '#ffe4c4',
  black: '#000000',
  blanchedalmond: '#ffebcd',
  blue: '#0000ff',
  blueviolet: '#8a2be2',
  brown: '#a52a2a',
  burlywood: '#deb887',
  cadetblue: '#5f9ea0',
  chartreuse: '#7fff00',
  chocolate: '#d2691e',
  coral: '#ff7f50',
  cornflowerblue: '#6495ed',
  cornsilk: '#fff8dc',
  crimson: '#dc143c',
  cyan: '#00ffff',
  darkblue: '#00008b',
  darkcyan: '#008b8b',
  darkgoldenrod: '#b8860b',
  darkgray: '#a9a9a9',
  darkgreen: '#006400',
  darkgrey: '#a9a9a9',
  darkkhaki: '#bdb76b',
  darkmagenta: '#8b008b',
  darkolivegreen: '#556b2f',
  darkorange: '#ff8c00',
  darkorchid: '#9932cc',
  darkred: '#8b0000',
  darksalmon: '#e9967a',
  darkseagreen: '#8fbc8f',
  darkslateblue: '#483d8b',
  darkslategray: '#2f4f4f',
  darkslategrey: '#2f4f4f',
  darkturquoise: '#00ced1',
  darkviolet: '#9400d3',
  deeppink: '#ff1493',
  deepskyblue: '#00bfff',
  dimgray: '#696969',
  dimgrey: '#696969',
  dodgerblue: '#1e90ff',
  firebrick: '#b22222',
  floralwhite: '#fffaf0',
  forestgreen: '#228b22',
  fuchsia: '#ff00ff',
  gainsboro: '#dcdcdc',
  ghostwhite: '#f8f8ff',
  gold: '#ffd700',
  goldenrod: '#daa520',
  gray: '#808080',
  green: '#008000',
  greenyellow: '#adff2f',
  grey: '#808080',
  honeydew: '#f0fff0',
  hotpink: '#ff69b4',
  indianred: '#cd5c5c',
  indigo: '#4b0082',
  ivory: '#fffff0',
  khaki: '#f0e68c',
  lavender: '#e6e6fa',
  lavenderblush: '#fff0f5',
  lawngreen: '#7cfc00',
  lemonchiffon: '#fffacd',
  lightblue: '#add8e6',
  lightcoral: '#f08080',
  lightcyan: '#e0ffff',
  lightgoldenrodyellow: '#fafad2',
  lightgray: '#d3d3d3',
  lightgreen: '#90ee90',
  lightgrey: '#d3d3d3',
  lightpink: '#ffb6c1',
  lightsalmon: '#ffa07a',
  lightseagreen: '#20b2aa',
  lightskyblue: '#87cefa',
  lightslategray: '#778899',
  lightslategrey: '#778899',
  lightsteelblue: '#b0c4de',
  lightyellow: '#ffffe0',
  lime: '#00ff00',
  limegreen: '#32cd32',
  linen: '#faf0e6',
  magenta: '#ff00ff',
  maroon: '#800000',
  mediumaquamarine: '#66cdaa',
  mediumblue: '#0000cd',
  mediumorchid: '#ba55d3',
  mediumpurple: '#9370db',
  mediumseagreen: '#3cb371',
  mediumslateblue: '#7b68ee',
  mediumspringgreen: '#00fa9a',
  mediumturquoise: '#48d1cc',
  mediumvioletred: '#c71585',
  midnightblue: '#191970',
  mintcream: '#f5fffa',
  mistyrose: '#ffe4e1',
  moccasin: '#ffe4b5',
  navajowhite: '#ffdead',
  navy: '#000080',
  oldlace: '#fdf5e6',
  olive: '#808000',
  olivedrab: '#6b8e23',
  orange: '#ffa500',
  orangered: '#ff4500',
  orchid: '#da70d6',
  palegoldenrod: '#eee8aa',
  palegreen: '#98fb98',
  paleturquoise: '#afeeee',
  palevioletred: '#db7093',
  papayawhip: '#ffefd5',
  peachpuff: '#ffdab9',
  peru: '#cd853f',
  pink: '#ffc0cb',
  plum: '#dda0dd',
  powderblue: '#b0e0e6',
  purple: '#800080',
  rebeccapurple: '#663399',
  red: '#ff0000',
  rosybrown: '#bc8f8f',
  royalblue: '#4169e1',
  saddlebrown: '#8b4513',
  salmon: '#fa8072',
  sandybrown: '#f4a460',
  seagreen: '#2e8b57',
  seashell: '#fff5ee',
  sienna: '#a0522d',
  silver: '#c0c0c0',
  skyblue: '#87ceeb',
  slateblue: '#6a5acd',
  slategray: '#708090',
  slategrey: '#708090',
  snow: '#fffafa',
  springgreen: '#00ff7f',
  steelblue: '#4682b4',
  tan: '#d2b48c',
  teal: '#008080',
  thistle: '#d8bfd8',
  tomato: '#ff6347',
  turquoise: '#40e0d0',
  violet: '#ee82ee',
  wheat: '#f5deb3',
  white: '#ffffff',
  whitesmoke: '#f5f5f5',
  yellow: '#ffff00',
  yellowgreen: '#9acd32',
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function parseNumberOrPercent(raw: string, percentMax: number): number | null {
  const trimmed = raw.trim()
  if (trimmed.endsWith('%')) {
    const val = Number.parseFloat(trimmed.slice(0, -1))
    return Number.isFinite(val) ? (val / 100) * percentMax : null
  }
  const val = Number.parseFloat(trimmed)
  return Number.isFinite(val) ? val : null
}

function parseAlpha(raw: string | undefined): number {
  if (!raw) return 1
  const trimmed = raw.trim()
  if (trimmed.endsWith('%')) {
    const val = Number.parseFloat(trimmed.slice(0, -1))
    return Number.isFinite(val) ? clamp(val / 100, 0, 1) : 1
  }
  const val = Number.parseFloat(trimmed)
  return Number.isFinite(val) ? clamp(val, 0, 1) : 1
}

function parseHexColor(hex: string): RgbaColor | null {
  const body = hex.slice(1)
  if (body.length === 3 || body.length === 4) {
    const r = Number.parseInt(body[0]! + body[0]!, 16)
    const g = Number.parseInt(body[1]! + body[1]!, 16)
    const b = Number.parseInt(body[2]! + body[2]!, 16)
    const a = body.length === 4 ? Number.parseInt(body[3]! + body[3]!, 16) / 255 : 1
    return Number.isNaN(r + g + b + a) ? null : { r, g, b, a }
  }
  if (body.length === 6 || body.length === 8) {
    const r = Number.parseInt(body.slice(0, 2), 16)
    const g = Number.parseInt(body.slice(2, 4), 16)
    const b = Number.parseInt(body.slice(4, 6), 16)
    const a = body.length === 8 ? Number.parseInt(body.slice(6, 8), 16) / 255 : 1
    return Number.isNaN(r + g + b + a) ? null : { r, g, b, a }
  }
  return null
}

function hslToRgb(hDeg: number, s: number, l: number): { r: number; g: number; b: number } {
  const h = (((hDeg % 360) + 360) % 360) / 360
  if (s === 0) {
    const v = Math.round(l * 255)
    return { r: v, g: v, b: v }
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue2rgb = (t: number) => {
    let n = t
    if (n < 0) n += 1
    if (n > 1) n -= 1
    if (n < 1 / 6) return p + (q - p) * 6 * n
    if (n < 1 / 2) return q
    if (n < 2 / 3) return p + (q - p) * (2 / 3 - n) * 6
    return p
  }
  return {
    r: Math.round(hue2rgb(h + 1 / 3) * 255),
    g: Math.round(hue2rgb(h) * 255),
    b: Math.round(hue2rgb(h - 1 / 3) * 255),
  }
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0)
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  return { h: h * 60, s, l }
}

export function parseCssColor(raw: string): RgbaColor | null {
  const token = raw.trim().toLowerCase()
  if (!token) return null
  if (token.startsWith('#')) return parseHexColor(token)

  const named = NAMED_COLORS[token]
  if (named) return parseHexColor(named)

  const fnMatch = /^(rgba?|hsla?)\((.+)\)$/.exec(token)
  if (!fnMatch) return null
  const fn = fnMatch[1]!
  const inner = fnMatch[2]!.trim()

  let parts: string[]
  let alphaPart: string | undefined

  if (inner.includes(',')) {
    const split = inner.split(',').map((s) => s.trim())
    if (split.length < 3 || split.length > 4) return null
    parts = split.slice(0, 3)
    alphaPart = split[3]
  } else {
    const slashIdx = inner.indexOf('/')
    const main = (slashIdx >= 0 ? inner.slice(0, slashIdx) : inner).trim()
    alphaPart = slashIdx >= 0 ? inner.slice(slashIdx + 1).trim() : undefined
    parts = main.split(/\s+/).filter(Boolean)
    if (parts.length !== 3) return null
  }

  const a = parseAlpha(alphaPart)
  if (fn.startsWith('rgb')) {
    const r = parseNumberOrPercent(parts[0]!, 255)
    const g = parseNumberOrPercent(parts[1]!, 255)
    const b = parseNumberOrPercent(parts[2]!, 255)
    if (r === null || g === null || b === null) return null
    return {
      r: Math.round(clamp(r, 0, 255)),
      g: Math.round(clamp(g, 0, 255)),
      b: Math.round(clamp(b, 0, 255)),
      a,
    }
  }

  let hRaw = parts[0]!.trim()
  if (hRaw.endsWith('deg')) hRaw = hRaw.slice(0, -3)
  const h = Number.parseFloat(hRaw)
  const s = parseNumberOrPercent(parts[1]!, 100)
  const l = parseNumberOrPercent(parts[2]!, 100)
  if (!Number.isFinite(h) || s === null || l === null) return null
  const rgb = hslToRgb(h, clamp(s / 100, 0, 1), clamp(l / 100, 0, 1))
  return { ...rgb, a }
}

function relativeLuminance(color: Pick<RgbaColor, 'r' | 'g' | 'b'>): number {
  const linear = (channel: number) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)
}

function compositeOver(fg: RgbaColor, bg: RgbaColor): RgbaColor {
  if (fg.a >= 1) return fg
  const a = fg.a
  return {
    r: Math.round(fg.r * a + bg.r * (1 - a)),
    g: Math.round(fg.g * a + bg.g * (1 - a)),
    b: Math.round(fg.b * a + bg.b * (1 - a)),
    a: 1,
  }
}

function contrastRatio(fg: RgbaColor, bg: RgbaColor): number {
  const effectiveFg = compositeOver(fg, bg)
  const l1 = relativeLuminance(effectiveFg)
  const l2 = relativeLuminance(bg)
  const hi = Math.max(l1, l2)
  const lo = Math.min(l1, l2)
  return (hi + 0.05) / (lo + 0.05)
}

function toHex({ r, g, b }: Pick<RgbaColor, 'r' | 'g' | 'b'>): string {
  const byte = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0')
  return `#${byte(r)}${byte(g)}${byte(b)}`
}

function withAlpha(hex: string, alpha: number): string {
  if (alpha >= 0.999) return hex
  const parsed = parseHexColor(hex)!
  const cleanAlpha = Math.round(clamp(alpha, 0, 1) * 1000) / 1000
  return `rgb(${parsed.r} ${parsed.g} ${parsed.b} / ${cleanAlpha})`
}

export function adaptColorForDarkForeground(raw: string): string | null {
  const parsed = parseCssColor(raw)
  if (!parsed || parsed.a === 0) return null

  // Checking against DARK_SURFACE_RAISED (#222430) guarantees >= 4.5:1 on both #1a1b24 and #222430.
  if (contrastRatio(parsed, DARK_SURFACE_RAISED) >= 4.5) return null

  const { h, s, l } = rgbToHsl(parsed.r, parsed.g, parsed.b)
  if (s < 0.16) {
    const mapped =
      l <= 0.22 ? DARK_TEXT : l <= 0.42 ? DARK_TEXT_SECONDARY : DARK_TEXT_MUTED
    return withAlpha(mapped, parsed.a)
  }

  // Chromatic dark foreground: preserve hue, moderate saturation, lift lightness until >= 4.6:1.
  const targetS = clamp(s, 0.25, 0.82)
  let lo = Math.max(l, 0.48)
  let hi = 0.92
  for (let i = 0; i < 14; i += 1) {
    const mid = (lo + hi) / 2
    const candidate = { ...hslToRgb(h, targetS, mid), a: parsed.a }
    if (contrastRatio(candidate, DARK_SURFACE_RAISED) >= 4.6) {
      hi = mid
    } else {
      lo = mid
    }
  }
  const lifted = hslToRgb(h, targetS, hi)
  return withAlpha(toHex(lifted), parsed.a)
}

export function adaptColorForDarkBackground(raw: string): string | null {
  const parsed = parseCssColor(raw)
  if (!parsed || parsed.a < 0.12) return null

  const lum = relativeLuminance(parsed)
  const { h, s } = rgbToHsl(parsed.r, parsed.g, parsed.b)

  if (lum <= 0.005) {
    return withAlpha(DARK_BG_BASE, parsed.a)
  }
  if (lum <= 0.22) return null

  if (s < 0.15) {
    const mapped =
      lum >= 0.96 ? DARK_BG_BASE : lum >= 0.65 ? DARK_BG_RAISED : DARK_BG_ELEVATED
    return withAlpha(mapped, parsed.a)
  }

  const tinted = hslToRgb(h, clamp(s, 0.2, 0.52), 0.17)
  return withAlpha(toHex(tinted), parsed.a)
}

export function adaptColorForDarkBorder(raw: string): string | null {
  const parsed = parseCssColor(raw)
  if (!parsed || parsed.a < 0.08) return null

  const lum = relativeLuminance(parsed)
  const { h, s } = rgbToHsl(parsed.r, parsed.g, parsed.b)

  if (s < 0.16) {
    if (lum >= 0.68) return withAlpha(DARK_BORDER, parsed.a)
    if (lum < 0.08 || lum > 0.32) return withAlpha(DARK_BORDER_STRONG, parsed.a)
    return null
  }

  const ratio = contrastRatio(parsed, DARK_SURFACE)
  if (ratio >= 2.5 && lum <= 0.65) return null

  const targetL = lum > 0.65 ? 0.56 : 0.48
  const adjusted = hslToRgb(h, clamp(s, 0.25, 0.72), targetL)
  return withAlpha(toHex(adjusted), parsed.a)
}

type ColorRole = 'fg' | 'bg' | 'border'

const FG_PROPS = new Set([
  'color',
  'text-decoration-color',
  'column-rule-color',
  'caret-color',
  'fill',
  'stroke',
])

const BG_PROPS = new Set(['background-color', 'background'])

const BORDER_COLOR_PROPS = new Set([
  'border-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline-color',
])

const BORDER_SHORTHAND_PROPS = new Set([
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'outline',
  'column-rule',
])

function roleForProperty(prop: string): ColorRole | null {
  const lower = prop.trim().toLowerCase()
  if (FG_PROPS.has(lower)) return 'fg'
  if (BG_PROPS.has(lower)) return 'bg'
  if (BORDER_COLOR_PROPS.has(lower) || BORDER_SHORTHAND_PROPS.has(lower)) return 'border'
  return null
}

function adaptSingleColor(token: string, role: ColorRole): string | null {
  if (role === 'fg') return adaptColorForDarkForeground(token)
  if (role === 'bg') return adaptColorForDarkBackground(token)
  return adaptColorForDarkBorder(token)
}

/** Replaces color tokens inside a single CSS declaration value, preserving `url(...)`, `var(...)`, and quotes. */
function adaptValueColors(value: string, role: ColorRole): string {
  let out = ''
  let i = 0

  while (i < value.length) {
    const ch = value[i]!

    // Preserve quoted strings verbatim.
    if (ch === '"' || ch === "'") {
      const start = i
      i += 1
      while (i < value.length && value[i] !== ch) {
        if (value[i] === '\\' && i + 1 < value.length) i += 2
        else i += 1
      }
      if (i < value.length) i += 1
      out += value.slice(start, i)
      continue
    }

    // Preserve url(...) and var(...) verbatim (do not touch URLs or custom property names).
    const rest = value.slice(i)
    const protectedFn = /^(?:url|var|env|calc|attr)\s*\(/i.exec(rest)
    if (protectedFn) {
      const start = i
      i += protectedFn[0].length
      let depth = 1
      while (i < value.length && depth > 0) {
        const innerCh = value[i]
        if (innerCh === '"' || innerCh === "'") {
          i += 1
          while (i < value.length && value[i] !== innerCh) {
            if (value[i] === '\\' && i + 1 < value.length) i += 2
            else i += 1
          }
          if (i < value.length) i += 1
          continue
        }
        if (innerCh === '(') depth += 1
        else if (innerCh === ')') depth -= 1
        i += 1
      }
      out += value.slice(start, i)
      continue
    }

    // Hex color token: #rgb / #rgba / #rrggbb / #rrggbbaa
    if (ch === '#') {
      const hexMatch = /^#[0-9a-fA-F]{3,8}\b/.exec(rest)
      if (hexMatch) {
        const adapted = adaptSingleColor(hexMatch[0], role)
        out += adapted ?? hexMatch[0]
        i += hexMatch[0].length
        continue
      }
    }

    // Functional color: rgb(...) / rgba(...) / hsl(...) / hsla(...)
    const colorFn = /^(?:rgba?|hsla?)\([^)]*\)/i.exec(rest)
    if (colorFn) {
      const adapted = adaptSingleColor(colorFn[0], role)
      out += adapted ?? colorFn[0]
      i += colorFn[0].length
      continue
    }

    // Bare identifier (could be named color like `black`, `gray`, `whitesmoke`, etc.)
    if (/[a-zA-Z]/.test(ch)) {
      const prev = i > 0 ? value[i - 1]! : ' '
      const wordMatch = /^[a-zA-Z-]+/.exec(rest)
      if (wordMatch && !/[a-zA-Z0-9_-]/.test(prev)) {
        const word = wordMatch[0]
        const nextChar = value[i + word.length] ?? ''
        // Skip function calls or dashed identifiers or property-like tokens.
        if (nextChar !== '(' && !word.includes('-') && word.toLowerCase() in NAMED_COLORS) {
          const adapted = adaptSingleColor(word, role)
          out += adapted ?? word
          i += word.length
          continue
        }
        out += word
        i += word.length
        continue
      }
    }

    out += ch
    i += 1
  }

  return out
}

function adaptDeclarationList(declarations: string): string {
  let out = ''
  let i = 0

  while (i < declarations.length) {
    // Copy whitespace & comments verbatim.
    if (declarations.startsWith('/*', i)) {
      const end = declarations.indexOf('*/', i + 2)
      const close = end >= 0 ? end + 2 : declarations.length
      out += declarations.slice(i, close)
      i = close
      continue
    }

    const start = i
    let parenDepth = 0
    let quote: string | null = null
    while (i < declarations.length) {
      const ch = declarations[i]!
      if (quote) {
        if (ch === '\\' && i + 1 < declarations.length) {
          i += 2
          continue
        }
        if (ch === quote) quote = null
        i += 1
        continue
      }
      if (ch === '"' || ch === "'") {
        quote = ch
        i += 1
        continue
      }
      if (declarations.startsWith('/*', i)) {
        const end = declarations.indexOf('*/', i + 2)
        i = end >= 0 ? end + 2 : declarations.length
        continue
      }
      if (ch === '(') parenDepth += 1
      else if (ch === ')' && parenDepth > 0) parenDepth -= 1
      else if (ch === ';' && parenDepth === 0) {
        i += 1
        break
      }
      i += 1
    }

    const segment = declarations.slice(start, i)
    const colon = segment.indexOf(':')
    if (colon < 0) {
      out += segment
      continue
    }

    const propRaw = segment.slice(0, colon)
    const role = roleForProperty(propRaw)
    if (!role) {
      out += segment
      continue
    }

    const valPart = segment.slice(colon + 1)
    out += `${propRaw}:${adaptValueColors(valPart, role)}`
  }

  return out
}

/**
 * Rewrites color, background, and border declarations in an EPUB CSS string
 * so hardcoded light-mode colors remain legible on Booksmith's dark paper (`#1a1b24`).
 */
export function adaptCssForDarkTheme(css: string): string {
  let out = ''
  let i = 0

  while (i < css.length) {
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2)
      const close = end >= 0 ? end + 2 : css.length
      out += css.slice(i, close)
      i = close
      continue
    }

    const ch = css[i]!
    if (ch === '"' || ch === "'") {
      const start = i
      i += 1
      while (i < css.length && css[i] !== ch) {
        if (css[i] === '\\' && i + 1 < css.length) i += 2
        else i += 1
      }
      if (i < css.length) i += 1
      out += css.slice(start, i)
      continue
    }

    // Handle rule blocks `{ ... }` while recursively descending into nested at-rules (`@media`, `@supports`).
    if (ch === '{') {
      const open = i
      i += 1
      let depth = 1
      let quote: string | null = null
      let hasNestedBrace = false
      while (i < css.length && depth > 0) {
        const cur = css[i]!
        if (quote) {
          if (cur === '\\' && i + 1 < css.length) {
            i += 2
            continue
          }
          if (cur === quote) quote = null
          i += 1
          continue
        }
        if (cur === '"' || cur === "'") {
          quote = cur
          i += 1
          continue
        }
        if (css.startsWith('/*', i)) {
          const end = css.indexOf('*/', i + 2)
          i = end >= 0 ? end + 2 : css.length
          continue
        }
        if (cur === '{') {
          depth += 1
          hasNestedBrace = true
        } else if (cur === '}') {
          depth -= 1
        }
        i += 1
      }

      const innerEnd = depth === 0 ? i - 1 : i
      const inner = css.slice(open + 1, innerEnd)
      const adaptedInner = hasNestedBrace ? adaptCssForDarkTheme(inner) : adaptDeclarationList(inner)
      out += `{${adaptedInner}${depth === 0 ? '}' : ''}`
      continue
    }

    out += ch
    i += 1
  }

  return out
}

/** Rewrites an element's inline `style` attribute for dark paper legibility. */
export function adaptInlineStyleForDarkTheme(styleText: string): string {
  return adaptDeclarationList(styleText)
}
