import { describe, expect, it } from 'vitest'
import {
  indentTocEntry,
  insertTocEntry,
  moveTocEntry,
  outdentTocEntry,
  removeTocEntry,
  updateTocEntry,
  type TocEntry,
} from '../src'

const entry = (label: string, children: TocEntry[] = []): TocEntry => ({
  label,
  href: `text/${label}.xhtml`,
  children,
})

/** 一 / 二(二.1, 二.2) / 三 */
function tree(): TocEntry[] {
  return [entry('一'), entry('二', [entry('二.1'), entry('二.2')]), entry('三')]
}

const labels = (entries: TocEntry[]): string[] =>
  entries.flatMap((item) => [item.label, ...labels(item.children)])

describe('updateTocEntry', () => {
  it('replaces the entry at a nested path', () => {
    const next = updateTocEntry(tree(), [1, 1], (item) => ({ ...item, label: '改名' }))
    expect(labels(next)).toEqual(['一', '二', '二.1', '改名', '三'])
  })

  it('does nothing for a path that does not exist', () => {
    expect(labels(updateTocEntry(tree(), [9], (item) => ({ ...item, label: 'x' })))).toEqual(
      labels(tree()),
    )
  })
})

describe('removeTocEntry', () => {
  it('removes a nested entry and keeps the rest', () => {
    expect(labels(removeTocEntry(tree(), [1, 0]))).toEqual(['一', '二', '二.2', '三'])
  })

  it('removes a whole subtree', () => {
    expect(labels(removeTocEntry(tree(), [1]))).toEqual(['一', '三'])
  })
})

describe('moveTocEntry', () => {
  it('swaps a top-level entry with its neighbour', () => {
    expect(labels(moveTocEntry(tree(), [2], -1))).toEqual(['一', '三', '二', '二.1', '二.2'])
  })

  it('moves inside a nested list', () => {
    expect(labels(moveTocEntry(tree(), [1, 0], 1))).toEqual(['一', '二', '二.2', '二.1', '三'])
  })

  it('refuses to move past either end', () => {
    expect(labels(moveTocEntry(tree(), [0], -1))).toEqual(labels(tree()))
    expect(labels(moveTocEntry(tree(), [2], 1))).toEqual(labels(tree()))
  })
})

describe('insertTocEntry', () => {
  it('inserts after the entry at the path', () => {
    expect(labels(insertTocEntry(tree(), [0], entry('新')))).toEqual(['一', '新', '二', '二.1', '二.2', '三'])
  })

  it('inserts into a nested list', () => {
    const next = insertTocEntry(tree(), [1, 0], entry('插'))
    expect(labels(next)).toEqual(['一', '二', '二.1', '插', '二.2', '三'])
    expect(next[1]?.children.map((item) => item.label)).toEqual(['二.1', '插', '二.2'])
  })

  it('appends at the root for an empty path', () => {
    expect(labels(insertTocEntry(tree(), [], entry('尾')))).toEqual(['一', '二', '二.1', '二.2', '三', '尾'])
  })
})

describe('indentTocEntry', () => {
  it('makes an entry the last child of its previous sibling', () => {
    const next = indentTocEntry(tree(), [2])
    expect(next.map((item) => item.label)).toEqual(['一', '二'])
    expect(next[1]?.children.map((item) => item.label)).toEqual(['二.1', '二.2', '三'])
  })

  it('nests a nested entry under its previous sibling', () => {
    const next = indentTocEntry(tree(), [1, 1])
    expect(next[1]?.children.map((item) => item.label)).toEqual(['二.1'])
    expect(next[1]?.children[0]?.children.map((item) => item.label)).toEqual(['二.2'])
  })

  it('does nothing for the first sibling, which has nothing to nest under', () => {
    expect(labels(indentTocEntry(tree(), [0]))).toEqual(labels(tree()))
    expect(labels(indentTocEntry(tree(), [1, 0]))).toEqual(labels(tree()))
  })
})

describe('outdentTocEntry', () => {
  it('lifts an entry to sit right after its parent', () => {
    const next = outdentTocEntry(tree(), [1, 0])
    expect(next.map((item) => item.label)).toEqual(['一', '二', '二.1', '三'])
    expect(next[1]?.children.map((item) => item.label)).toEqual(['二.2'])
  })

  it('lifts the last child too', () => {
    const next = outdentTocEntry(tree(), [1, 1])
    expect(next.map((item) => item.label)).toEqual(['一', '二', '二.2', '三'])
  })

  it('does nothing at the top level', () => {
    expect(labels(outdentTocEntry(tree(), [1]))).toEqual(labels(tree()))
  })
})

describe('editing round trip', () => {
  it('keeps every entry when indent then outdent is undone in reverse', () => {
    const indented = indentTocEntry(tree(), [2])
    const restored = outdentTocEntry(indented, [1, 2])
    expect(labels(restored)).toEqual(labels(tree()))
  })

  it('does not mutate the input tree', () => {
    const original = tree()
    indentTocEntry(original, [2])
    expect(labels(original)).toEqual(['一', '二', '二.1', '二.2', '三'])
  })
})
