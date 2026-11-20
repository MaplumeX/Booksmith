import { describe, expect, it } from 'vitest'
import { snapMarkerToVisualLines, visualLineBoxes } from './theme'

const ROW = 21.45

describe('visualLineBoxes', () => {
  it('returns the full line rect directly for a single unwrapped line', () => {
    const boxes = visualLineBoxes({ top: 100, bottom: 100 + ROW }, [], ROW)
    expect(boxes).toEqual([{ top: 100, bottom: 100 + ROW }])
  })

  it('splits a wrapped .cm-line into contiguous visual line boxes from glyph rects', () => {
    // 4 wrapped visual rows, each 21.45px tall, with 3px top/bottom half-leading
    const lineRect = { top: 100, bottom: 100 + 4 * ROW }
    const glyphRects = [
      // Row 0: multiple syntax-highlight spans (Latin tag + CJK text with slightly taller glyph box)
      { top: 103, bottom: 118.45 },
      { top: 102.5, bottom: 118.95 },
      // Row 1
      { top: 100 + ROW + 3, bottom: 100 + 2 * ROW - 3 },
      // Row 2
      { top: 100 + 2 * ROW + 3, bottom: 100 + 3 * ROW - 3 },
      // Row 3: text + closing tag spans
      { top: 100 + 3 * ROW + 3, bottom: 100 + 4 * ROW - 3 },
      { top: 100 + 3 * ROW + 3.5, bottom: 100 + 4 * ROW - 3.5 },
    ]

    const boxes = visualLineBoxes(lineRect, glyphRects, ROW)
    expect(boxes).toHaveLength(4)
    expect(boxes[0]!.top).toBeCloseTo(100, 5)
    expect(boxes[3]!.bottom).toBeCloseTo(lineRect.bottom, 5)
    // Contiguous with zero gaps or overlaps
    for (let i = 0; i < boxes.length - 1; i++) {
      expect(boxes[i]!.bottom).toBeCloseTo(boxes[i + 1]!.top, 5)
    }
    // Each row matches approximately one line-height
    for (const box of boxes) {
      expect(box.bottom - box.top).toBeGreaterThan(ROW - 1)
      expect(box.bottom - box.top).toBeLessThan(ROW + 1)
    }
  })

  it('falls back to uniform row subdivision when glyph rects cannot separate wrapped rows', () => {
    const lineRect = { top: 50, bottom: 50 + 3 * ROW }
    const boxes = visualLineBoxes(lineRect, [], ROW)
    expect(boxes).toHaveLength(3)
    expect(boxes[0]!.top).toBeCloseTo(50, 5)
    expect(boxes[0]!.bottom).toBeCloseTo(50 + ROW, 5)
    expect(boxes[1]!.top).toBeCloseTo(50 + ROW, 5)
    expect(boxes[2]!.bottom).toBeCloseTo(50 + 3 * ROW, 5)
  })
})

describe('snapMarkerToVisualLines', () => {
  const visualLines = Array.from({ length: 4 }, (_, i) => ({
    top: 100 + i * ROW,
    bottom: 100 + (i + 1) * ROW,
  }))

  it('snaps a partial single-visual-row marker only to that visual row (not the whole wrapped line)', () => {
    const marker = { top: 100 + ROW + 3, bottom: 100 + 2 * ROW - 3 }
    const snapped = snapMarkerToVisualLines(marker, visualLines)
    expect(snapped).toEqual(visualLines[1])
  })

  it('snaps adjacent visual-row markers (CodeMirror 2-row selection) without bleeding into other rows', () => {
    const midBoundary = 100 + 2 * ROW
    const topPiece = { top: 100 + ROW + 3, bottom: midBoundary }
    const bottomPiece = { top: midBoundary, bottom: 100 + 3 * ROW - 3 }

    expect(snapMarkerToVisualLines(topPiece, visualLines)).toEqual(visualLines[1])
    expect(snapMarkerToVisualLines(bottomPiece, visualLines)).toEqual(visualLines[2])
  })

  it('keeps CodeMirror between-marker confined to middle rows instead of expanding onto start/end rows', () => {
    // 4-row selection from middle of row 0 to middle of row 3:
    // CodeMirror's between rectangle starts at row 0 glyph bottom and ends at row 3 glyph top.
    const topPiece = { top: 103, bottom: 100 + ROW - 3 }
    const betweenPiece = { top: 100 + ROW - 3, bottom: 100 + 3 * ROW + 3 }
    const bottomPiece = { top: 100 + 3 * ROW + 3, bottom: 100 + 4 * ROW - 3 }

    const sTop = snapMarkerToVisualLines(topPiece, visualLines)!
    const sBetween = snapMarkerToVisualLines(betweenPiece, visualLines)!
    const sBottom = snapMarkerToVisualLines(bottomPiece, visualLines)!

    expect(sTop).toEqual(visualLines[0])
    expect(sBetween).toEqual({ top: visualLines[1]!.top, bottom: visualLines[2]!.bottom })
    expect(sBottom).toEqual(visualLines[3])
    expect(sTop.bottom).toBeCloseTo(sBetween.top, 5)
    expect(sBetween.bottom).toBeCloseTo(sBottom.top, 5)
  })

  it('is idempotent when run repeatedly on already-snapped markers', () => {
    const firstPass = snapMarkerToVisualLines(
      { top: 100 + ROW - 3, bottom: 100 + 3 * ROW + 3 },
      visualLines,
    )!
    const secondPass = snapMarkerToVisualLines(firstPass, visualLines)
    expect(secondPass).toEqual(firstPass)
  })

  it('returns null for empty / zero-height markers', () => {
    expect(snapMarkerToVisualLines({ top: 110, bottom: 110 }, visualLines)).toBeNull()
  })
})
