import { describe, expect, it } from 'vitest'
import {
  getTocEntry,
  indentTocEntries,
  indentTocEntriesWithPaths,
  indentTocEntry,
  insertTocEntry,
  moveTocEntries,
  moveTocEntriesWithPaths,
  moveTocEntry,
  moveTocSubtree,
  moveTocSubtreeWithPath,
  normalizeTocPaths,
  outdentTocEntries,
  outdentTocEntriesWithPaths,
  outdentTocEntry,
  rebaseTocHrefs,
  removeBrokenTocEntries,
  removeTocEntries,
  removeTocEntry,
  updateTocEntry,
  type TocEntry,
} from '../src'

const entry = (label: string, children: TocEntry[] = [], href = `text/${label}.xhtml`): TocEntry => ({
  label,
  href,
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

  it('removes a whole subtree by default', () => {
    expect(labels(removeTocEntry(tree(), [1]))).toEqual(['一', '三'])
  })

  it('lifts children in place when keepChildren is true', () => {
    const next = removeTocEntry(tree(), [1], { keepChildren: true })
    expect(next.map((item) => item.label)).toEqual(['一', '二.1', '二.2', '三'])
    expect(labels(next)).toEqual(['一', '二.1', '二.2', '三'])
  })
})

describe('moveTocEntry', () => {
  it('swaps a top-level entry with its neighbour (carrying subtree)', () => {
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
  it('inserts after the entry at the path by default', () => {
    expect(labels(insertTocEntry(tree(), [0], entry('新')))).toEqual(['一', '新', '二', '二.1', '二.2', '三'])
  })

  it('supports before and inside positions', () => {
    const before = insertTocEntry(tree(), [1], entry('前'), 'before')
    expect(before.map((item) => item.label)).toEqual(['一', '前', '二', '三'])

    const inside = insertTocEntry(tree(), [0], entry('子'), 'inside')
    expect(inside[0]?.children.map((item) => item.label)).toEqual(['子'])
  })

  it('inserts into a nested list', () => {
    const next = insertTocEntry(tree(), [1, 0], entry('插'))
    expect(labels(next)).toEqual(['一', '二', '二.1', '插', '二.2', '三'])
    expect(next[1]?.children.map((item) => item.label)).toEqual(['二.1', '插', '二.2'])
  })

  it('appends or prepends at the root for an empty path', () => {
    expect(labels(insertTocEntry(tree(), [], entry('尾')))).toEqual(['一', '二', '二.1', '二.2', '三', '尾'])
    expect(labels(insertTocEntry(tree(), [], entry('首'), 'before'))).toEqual(['首', '一', '二', '二.1', '二.2', '三'])
  })
})

describe('moveTocSubtree', () => {
  it('moves a parent subtree before/after/inside another branch', () => {
    const afterThree = moveTocSubtree(tree(), [1], [2], 'after')
    expect(afterThree.map((item) => item.label)).toEqual(['一', '三', '二'])
    expect(labels(afterThree)).toEqual(['一', '三', '二', '二.1', '二.2'])

    const insideOne = moveTocSubtree(tree(), [1], [0], 'inside')
    expect(insideOne.map((item) => item.label)).toEqual(['一', '三'])
    expect(insideOne[0]?.children[0]?.label).toBe('二')
    expect(insideOne[0]?.children[0]?.children.map((c) => c.label)).toEqual(['二.1', '二.2'])
  })

  it('refuses drops onto itself or its own descendants', () => {
    expect(labels(moveTocSubtree(tree(), [1], [1], 'inside'))).toEqual(labels(tree()))
    expect(labels(moveTocSubtree(tree(), [1], [1, 0], 'after'))).toEqual(labels(tree()))
  })
})

describe('indentTocEntry', () => {
  it('makes an entry (and its subtree) the last child of its previous sibling', () => {
    const withSub = [entry('一'), entry('二', [entry('二.1')]), entry('三', [entry('三.1')])]
    const next = indentTocEntry(withSub, [2])
    expect(next.map((item) => item.label)).toEqual(['一', '二'])
    expect(next[1]?.children.map((item) => item.label)).toEqual(['二.1', '三'])
    expect(next[1]?.children[1]?.children.map((item) => item.label)).toEqual(['三.1'])
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

describe('outdentTocEntry (order-preserving)', () => {
  it('lifts an entry after its parent and absorbs following siblings to preserve reading order', () => {
    const next = outdentTocEntry(tree(), [1, 0])
    expect(next.map((item) => item.label)).toEqual(['一', '二', '二.1', '三'])
    expect(next[1]?.children).toEqual([])
    expect(next[2]?.children.map((item) => item.label)).toEqual(['二.2'])
    expect(labels(next)).toEqual(['一', '二', '二.1', '二.2', '三'])
  })

  it('preserves existing children ahead of absorbed following siblings', () => {
    const sample = [
      entry('父', [entry('A'), entry('B', [entry('B1')]), entry('C')]),
    ]
    const next = outdentTocEntry(sample, [0, 1])
    expect(next.map((item) => item.label)).toEqual(['父', 'B'])
    expect(next[0]?.children.map((item) => item.label)).toEqual(['A'])
    expect(next[1]?.children.map((item) => item.label)).toEqual(['B1', 'C'])
    expect(labels(next)).toEqual(['父', 'A', 'B', 'B1', 'C'])
  })

  it('lifts the last child cleanly with no siblings to absorb', () => {
    const next = outdentTocEntry(tree(), [1, 1])
    expect(next.map((item) => item.label)).toEqual(['一', '二', '二.2', '三'])
    expect(next[1]?.children.map((item) => item.label)).toEqual(['二.1'])
  })

  it('does nothing at the top level', () => {
    expect(labels(outdentTocEntry(tree(), [1]))).toEqual(labels(tree()))
  })
})

describe('multi-select batch operations', () => {
  it('normalizes overlapping ancestor/descendant selections in document order', () => {
    expect(normalizeTocPaths([[1, 1], [1], [0], [1, 0], [0]])).toEqual([[0], [1]])
  })

  it('batch-indents contiguous siblings together under the preceding sibling', () => {
    const flat = [entry('A'), entry('B'), entry('C'), entry('D')]
    const next = indentTocEntries(flat, [[2], [1]])
    expect(next.map((item) => item.label)).toEqual(['A', 'D'])
    expect(next[0]?.children.map((item) => item.label)).toEqual(['B', 'C'])
  })

  it('does not fold a selected block starting at index 0 into itself', () => {
    const flat = [entry('A'), entry('B'), entry('C')]
    const next = indentTocEntries(flat, [[0], [1]])
    expect(next.map((item) => item.label)).toEqual(['A', 'B', 'C'])
  })

  it('batch-outdents contiguous siblings while keeping reading order intact', () => {
    const nested = [entry('P', [entry('A'), entry('B'), entry('C'), entry('D')])]
    const next = outdentTocEntries(nested, [[0, 1], [0, 2]])
    expect(next.map((item) => item.label)).toEqual(['P', 'B', 'C'])
    expect(next[0]?.children.map((item) => item.label)).toEqual(['A'])
    expect(next[1]?.children).toEqual([])
    expect(next[2]?.children.map((item) => item.label)).toEqual(['D'])
    expect(labels(next)).toEqual(['P', 'A', 'B', 'C', 'D'])
  })

  it('batch-moves contiguous selections up and down as a block', () => {
    const flat = [entry('A'), entry('B'), entry('C'), entry('D')]
    expect(moveTocEntries(flat, [[1], [2]], -1).map((item) => item.label)).toEqual(['B', 'C', 'A', 'D'])
    expect(moveTocEntries(flat, [[1], [2]], 1).map((item) => item.label)).toEqual(['A', 'D', 'B', 'C'])
    expect(moveTocEntries(flat, [[0], [1]], -1).map((item) => item.label)).toEqual(['A', 'B', 'C', 'D'])
  })

  it('batch-removes entries and respects keepChildren', () => {
    const next = removeTocEntries(tree(), [[0], [1]], { keepChildren: true })
    expect(next.map((item) => item.label)).toEqual(['二.1', '二.2', '三'])
  })

  it('tracks updated paths across batch indent, outdent, move, and subtree drop', () => {
    const flat = [entry('A'), entry('B'), entry('C'), entry('D')]
    const indented = indentTocEntriesWithPaths(flat, [[1], [2]])
    expect(indented.changed).toBe(true)
    expect(indented.paths).toEqual([[0, 0], [0, 1]])
    expect(indented.paths.map((p) => getTocEntry(indented.entries, p)?.label)).toEqual(['B', 'C'])

    const outdented = outdentTocEntriesWithPaths(
      [entry('P', [entry('A'), entry('B'), entry('C'), entry('D')])],
      [[0, 1], [0, 2]],
    )
    expect(outdented.changed).toBe(true)
    expect(outdented.paths).toEqual([[1], [2]])
    expect(outdented.paths.map((p) => getTocEntry(outdented.entries, p)?.label)).toEqual(['B', 'C'])

    const moved = moveTocEntriesWithPaths(flat, [[1], [2]], 1)
    expect(moved.changed).toBe(true)
    expect(moved.paths).toEqual([[2], [3]])
    expect(moved.paths.map((p) => getTocEntry(moved.entries, p)?.label)).toEqual(['B', 'C'])

    const noop = moveTocEntriesWithPaths(flat, [[0], [1]], -1)
    expect(noop.changed).toBe(false)
    expect(noop.entries).toBe(flat)

    const dropped = moveTocSubtreeWithPath(tree(), [1], [0], 'inside')
    expect(dropped.changed).toBe(true)
    expect(dropped.path).toEqual([0, 0])
    expect(getTocEntry(dropped.entries, dropped.path ?? [])?.label).toBe('二')
  })
})

describe('rebaseTocHrefs and removeBrokenTocEntries', () => {
  it('rebases relative hrefs across directories while keeping fragments and rawHtml', () => {
    const source: TocEntry[] = [
      {
        label: '含公式',
        href: 'text/ch1.xhtml#s1',
        rawHtml: '含<math/>公式',
        children: [{ label: '子项', href: 'text/ch2.xhtml', children: [] }],
      },
    ]
    const rebased = rebaseTocHrefs(source, 'EPUB/nav.xhtml', 'EPUB/meta/toc.ncx')
    expect(rebased[0]?.href).toBe('../text/ch1.xhtml#s1')
    expect(rebased[0]?.rawHtml).toBe('含<math/>公式')
    expect(rebased[0]?.children[0]?.href).toBe('../text/ch2.xhtml')
  })

  it('removes broken anchors while lifting valid children', () => {
    const sample: TocEntry[] = [
      entry('断链父', [entry('有效子', [], 'text/ok.xhtml#h1')], 'text/missing.xhtml'),
      entry('有效章', [], 'text/ok.xhtml'),
    ]
    const files = new Map([['EPUB/text/ok.xhtml', '<html id="h1"/>']])
    const { entries: cleaned, removedCount } = removeBrokenTocEntries(sample, 'EPUB/nav.xhtml', files)
    expect(removedCount).toBe(1)
    expect(cleaned.map((item) => item.label)).toEqual(['有效子', '有效章'])
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
