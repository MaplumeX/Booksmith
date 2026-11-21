import { describe, expect, it } from 'vitest'
import {
  adaptColorForDarkBackground,
  adaptColorForDarkBorder,
  adaptColorForDarkForeground,
  adaptCssForDarkTheme,
  adaptInlineStyleForDarkTheme,
  parseCssColor,
} from './darkThemeColor'

function luminanceFromHex(hex: string): number {
  const parsed = parseCssColor(hex)!
  const linear = (c: number) => {
    const n = c / 255
    return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(parsed.r) + 0.7152 * linear(parsed.g) + 0.0722 * linear(parsed.b)
}

function contrastHex(fg: string, bg: string): number {
  const l1 = luminanceFromHex(fg)
  const l2 = luminanceFromHex(bg)
  const hi = Math.max(l1, l2)
  const lo = Math.min(l1, l2)
  return (hi + 0.05) / (lo + 0.05)
}

describe('darkThemeColor', () => {
  it('parses hex, rgb/rgba, hsl/hsla, and named CSS colors', () => {
    expect(parseCssColor('#555')).toEqual({ r: 85, g: 85, b: 85, a: 1 })
    expect(parseCssColor('#1a1b24')).toEqual({ r: 26, g: 27, b: 36, a: 1 })
    expect(parseCssColor('rgba(102, 102, 102, 0.5)')).toEqual({ r: 102, g: 102, b: 102, a: 0.5 })
    expect(parseCssColor('rgb(80 90 100 / 80%)')).toEqual({ r: 80, g: 90, b: 100, a: 0.8 })
    expect(parseCssColor('hsl(0, 0%, 40%)')).toEqual({ r: 102, g: 102, b: 102, a: 1 })
    expect(parseCssColor('dimgray')).toEqual({ r: 105, g: 105, b: 105, a: 1 })
    expect(parseCssColor('transparent')).toBeNull()
    expect(parseCssColor('inherit')).toBeNull()
  })

  it('lifts dark grey and black foreground colors to >= 4.5:1 on dark raised surface', () => {
    for (const darkText of ['#000', '#333333', '#555', '#666', 'dimgray', 'rgb(85, 85, 85)']) {
      const adapted = adaptColorForDarkForeground(darkText)
      expect(adapted).not.toBeNull()
      expect(contrastHex(adapted!, '#222430')).toBeGreaterThanOrEqual(4.5)
    }

    // Already readable light colors remain untouched.
    expect(adaptColorForDarkForeground('#ececf2')).toBeNull()
    expect(adaptColorForDarkForeground('#9c97f4')).toBeNull()
  })

  it('preserves chromatic hue while lifting dark colored text to legible contrast', () => {
    const adaptedBlue = adaptColorForDarkForeground('#003399')
    expect(adaptedBlue).not.toBeNull()
    expect(contrastHex(adaptedBlue!, '#222430')).toBeGreaterThanOrEqual(4.5)

    const parsed = parseCssColor(adaptedBlue!)!
    expect(parsed.b).toBeGreaterThan(parsed.r)
  })

  it('darkens light neutral and pastel backgrounds while keeping dark surfaces', () => {
    expect(adaptColorForDarkBackground('#ffffff')).toBe('#1a1b24')
    expect(adaptColorForDarkBackground('#f5f5f5')).toBe('#222430')
    expect(adaptColorForDarkBackground('whitesmoke')).toBe('#222430')
    expect(adaptColorForDarkBackground('#1a1b24')).toBeNull()

    const pastel = adaptColorForDarkBackground('#eef6ff')
    expect(pastel).not.toBeNull()
    expect(luminanceFromHex(pastel!)).toBeLessThan(0.1)
  })

  it('adapts glaring light or pure black borders to dark surface borders', () => {
    expect(adaptColorForDarkBorder('#cccccc')).toBe('#464655')
    expect(adaptColorForDarkBorder('#eeeeee')).toBe('#2c2e3d')
    expect(adaptColorForDarkBorder('#000000')).toBe('#464655')
  })

  it('rewrites EPUB stylesheet rules including @media blocks while preserving url(...) and !important', () => {
    const input = `
      /* comment with color: #555 */
      blockquote {
        color: #555;
        background-color: #f5f5f5;
        border-left: 4px solid #ccc;
      }
      .banner {
        background: #fff url("blob:http://localhost/bg.png") no-repeat;
        color: black !important;
      }
      @media screen {
        td { border: 1px solid #ddd; color: rgb(68, 68, 68); }
      }
    `
    const adapted = adaptCssForDarkTheme(input)
    expect(adapted).toContain('/* comment with color: #555 */')
    expect(adapted).toContain('color: #b4b5c7')
    expect(adapted).toContain('background-color: #222430')
    expect(adapted).toContain('border-left: 4px solid #464655')
    expect(adapted).toContain('url("blob:http://localhost/bg.png")')
    expect(adapted).toContain('color: #ececf2 !important')
    expect(adapted).toContain('border: 1px solid #2c2e3d')
  })

  it('adapts inline style strings cleanly without touching non-color properties', () => {
    const style = 'color: #666; background: #fafafa; margin-left: 2em; font-style: italic;'
    const adapted = adaptInlineStyleForDarkTheme(style)
    expect(adapted).toContain('color: #b4b5c7')
    expect(adapted).toContain('background: #222430')
    expect(adapted).toContain('margin-left: 2em')
    expect(adapted).toContain('font-style: italic')
  })
})
