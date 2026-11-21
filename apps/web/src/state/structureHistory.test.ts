import { describe, expect, it } from 'vitest'
import type { WorkspaceSnapshot } from './agentProposal'
import {
  MAX_STRUCTURE_HISTORY,
  popStructureHistory,
  pushStructureHistory,
  type StructureHistoryEntry,
} from './structureHistory'

function fakeSnapshot(tag: string): WorkspaceSnapshot {
  return {
    book: {} as WorkspaceSnapshot['book'],
    texts: new Map([['ch.xhtml', tag]]),
    dirty: new Set(),
    tabs: ['ch.xhtml'],
    active: 'ch.xhtml',
  }
}

describe('structureHistory', () => {
  it('pushes entries up to MAX_STRUCTURE_HISTORY and pops in LIFO order', () => {
    let stack: StructureHistoryEntry[] = []
    for (let i = 1; i <= MAX_STRUCTURE_HISTORY + 5; i += 1) {
      stack = pushStructureHistory(stack, { id: i, label: `op-${i}`, snapshot: fakeSnapshot(`v${i}`) })
    }
    expect(stack).toHaveLength(MAX_STRUCTURE_HISTORY)
    expect(stack[0]?.label).toBe('op-6')
    expect(stack[stack.length - 1]?.label).toBe(`op-${MAX_STRUCTURE_HISTORY + 5}`)

    const firstPop = popStructureHistory(stack)
    expect(firstPop.entry?.label).toBe(`op-${MAX_STRUCTURE_HISTORY + 5}`)
    expect(firstPop.rest).toHaveLength(MAX_STRUCTURE_HISTORY - 1)
  })

  it('returns null entry when popping an empty stack', () => {
    expect(popStructureHistory([])).toEqual({ entry: null, rest: [] })
  })
})
