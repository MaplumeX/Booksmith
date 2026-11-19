import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTOSAVE_FLOOR_MS, AUTOSAVE_IDLE_MS, createAutosave } from './autosave'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})

afterEach(() => {
  vi.useRealTimers()
})

function harness(options: { idleMs?: number; floorMs?: number } = {}) {
  let dirty = true
  const save = vi.fn(async () => {
    dirty = false
  })
  const autosave = createAutosave({ save, isDirty: () => dirty, ...options })
  return { autosave, save, markDirty: () => { dirty = true } }
}

describe('createAutosave', () => {
  it('waits for the idle delay after the last change', async () => {
    const { autosave, save } = harness()

    autosave.touch()
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS - 1000)
    autosave.touch()
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS - 1000)
    expect(save).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('does nothing while there is nothing to save', async () => {
    const { autosave, save } = harness()
    const clean = createAutosave({ save, isDirty: () => false })

    clean.touch()
    await vi.advanceTimersByTimeAsync(AUTOSAVE_FLOOR_MS * 3)

    expect(save).not.toHaveBeenCalled()
    expect(autosave).toBeDefined()
  })

  it('spaces two automatic saves by the floor, not the idle delay', async () => {
    const { autosave, save, markDirty } = harness()

    autosave.touch()
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS)
    expect(save).toHaveBeenCalledTimes(1)

    markDirty()
    autosave.touch()
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS * 2)
    expect(save).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(AUTOSAVE_FLOOR_MS)
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('saves immediately on flush, even inside the floor', async () => {
    const { autosave, save, markDirty } = harness()

    autosave.touch()
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS)
    markDirty()

    await autosave.flush()
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('stops after cancel', async () => {
    const { autosave, save } = harness()

    autosave.touch()
    autosave.cancel()
    await vi.advanceTimersByTimeAsync(AUTOSAVE_FLOOR_MS * 2)

    expect(save).not.toHaveBeenCalled()
  })
})
