import type { WorkspaceSnapshot } from './agentProposal'

/**
 * Bounded multi-step workspace undo stack for structural book mutations
 * (chapter split/merge/duplicate, stylesheet linking, unused resource cleanup).
 * See ADR 2026-11-21-chapter-structure-and-resource-tools.
 */

export const MAX_STRUCTURE_HISTORY = 20

export interface StructureHistoryEntry {
  id: number
  label: string
  snapshot: WorkspaceSnapshot
}

export function pushStructureHistory(
  stack: readonly StructureHistoryEntry[],
  entry: StructureHistoryEntry,
  limit = MAX_STRUCTURE_HISTORY,
): StructureHistoryEntry[] {
  const next = [...stack, entry]
  if (next.length > limit) {
    return next.slice(next.length - limit)
  }
  return next
}

export function popStructureHistory(stack: readonly StructureHistoryEntry[]): {
  entry: StructureHistoryEntry | null
  rest: StructureHistoryEntry[]
} {
  if (stack.length === 0) return { entry: null, rest: [] }
  return {
    entry: stack[stack.length - 1] ?? null,
    rest: stack.slice(0, -1),
  }
}
