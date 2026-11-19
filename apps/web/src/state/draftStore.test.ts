import { describe, expect, it } from 'vitest'
import { planDraftRestore, type LocalDraft } from './draftStore'

function draft(overrides: Partial<LocalDraft> = {}): LocalDraft {
  return {
    baseVersion: 3,
    savedAt: 1_700_000_000_000,
    files: { 'EPUB/text/ch001.xhtml': '改过的一章', 'EPUB/content.opf': '<package/>' },
    ...overrides,
  }
}

describe('planDraftRestore', () => {
  it('applies every draft file the book still has', () => {
    const plan = planDraftRestore(draft(), 3, new Set(['EPUB/text/ch001.xhtml', 'EPUB/content.opf']))
    expect(plan.files).toEqual([
      ['EPUB/text/ch001.xhtml', '改过的一章'],
      ['EPUB/content.opf', '<package/>'],
    ])
    expect(plan.dropped).toEqual([])
    expect(plan.stale).toBe(false)
  })

  it('drops files the book no longer contains', () => {
    const plan = planDraftRestore(draft(), 3, new Set(['EPUB/text/ch001.xhtml']))
    expect(plan.files).toHaveLength(1)
    expect(plan.dropped).toEqual(['EPUB/content.opf'])
  })

  it('marks the draft stale when the server moved on', () => {
    expect(planDraftRestore(draft(), 5, new Set(['EPUB/text/ch001.xhtml'])).stale).toBe(true)
  })

  it('yields nothing for an empty draft', () => {
    const plan = planDraftRestore(draft({ files: {} }), 3, new Set())
    expect(plan.files).toEqual([])
    expect(plan.dropped).toEqual([])
  })
})
