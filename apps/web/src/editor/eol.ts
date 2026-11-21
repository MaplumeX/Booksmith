export type EolStyle = '\r\n' | '\n'

export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

export function detectEol(text: string): EolStyle {
  let crlf = 0
  let lf = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\r' && text[i + 1] === '\n') {
      crlf += 1
      i += 1
    } else if (text[i] === '\n') {
      lf += 1
    }
  }
  return crlf > 0 && crlf >= lf ? '\r\n' : '\n'
}

export function applyEol(text: string, eol: EolStyle): string {
  const normalized = normalizeEol(text)
  return eol === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized
}

export function restoreEol(lfText: string, seedText: string): string {
  // Returning the verbatim seed when normalized text matches guarantees that undoing back to the
  // opening state restores byte-for-byte equality even on mixed-EOL files.
  // See ADR 2026-11-20-baseline-derived-dirty-state.
  if (lfText === normalizeEol(seedText)) return seedText
  return applyEol(lfText, detectEol(seedText))
}

/** Maps a character offset in LF-normalized CodeMirror text back to the exact offset in `sourceText`. */
export function mapLfOffsetToSource(lfOffset: number, sourceText: string): number {
  let lfPos = 0
  let srcPos = 0
  while (srcPos < sourceText.length && lfPos < lfOffset) {
    if (sourceText[srcPos] === '\r' && sourceText[srcPos + 1] === '\n') {
      srcPos += 2
    } else {
      srcPos += 1
    }
    lfPos += 1
  }
  return srcPos
}
