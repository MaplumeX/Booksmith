import { describe, expect, it } from 'vitest'
import { applyEol, detectEol, normalizeEol, restoreEol } from './eol'

describe('eol', () => {
  it('normalizes CRLF and lone CR to LF', () => {
    expect(normalizeEol('a\r\nb\rc\n')).toBe('a\nb\nc\n')
    expect(normalizeEol('plain')).toBe('plain')
  })

  it('detects dominant line ending style', () => {
    expect(detectEol('a\r\nb\r\n')).toBe('\r\n')
    expect(detectEol('a\nb\n')).toBe('\n')
    expect(detectEol('no-newlines')).toBe('\n')
    expect(detectEol('a\r\nb\nc\r\n')).toBe('\r\n')
    expect(detectEol('a\nb\nc\r\n')).toBe('\n')
    expect(detectEol('a\r\nb\n')).toBe('\r\n')
  })

  it('applies target EOL consistently', () => {
    expect(applyEol('a\nb\n', '\r\n')).toBe('a\r\nb\r\n')
    expect(applyEol('a\r\nb\r\n', '\n')).toBe('a\nb\n')
    expect(applyEol('a\r\nb\n', '\r\n')).toBe('a\r\nb\r\n')
  })

  it('restores original EOL on edits and exact seed on undo even for mixed-EOL files', () => {
    const crlfSeed = '<?xml version="1.0"?>\r\n<html>\r\n<body>hi</body>\r\n</html>\r\n'
    expect(restoreEol('<?xml version="1.0"?>\n<html>\n<body>edited</body>\n</html>\n', crlfSeed)).toBe(
      '<?xml version="1.0"?>\r\n<html>\r\n<body>edited</body>\r\n</html>\r\n',
    )
    expect(restoreEol(normalizeEol(crlfSeed), crlfSeed)).toBe(crlfSeed)

    const mixedSeed = 'line1\r\nline2\nline3\r\n'
    expect(restoreEol('line1\nline2\nline3\n', mixedSeed)).toBe(mixedSeed)
    expect(restoreEol('line1\nchanged\nline3\n', mixedSeed)).toBe('line1\r\nchanged\r\nline3\r\n')

    const lfSeed = 'a\nb\n'
    expect(restoreEol('a\nc\n', lfSeed)).toBe('a\nc\n')
  })
})
