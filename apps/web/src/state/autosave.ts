/**
 * When the editor saves by itself.
 *
 * Two rules, both from ADR 2026-11-19-autosave: save `idleMs` after the last change, and never
 * twice within `floorMs` — every save uploads the whole pack, so an eager timer is a storage bill.
 * The floor is skipped for the first save of a session (there is no previous save to space from).
 */

export const AUTOSAVE_IDLE_MS = 20_000
export const AUTOSAVE_FLOOR_MS = 180_000

export interface AutosaveOptions {
  /** Performs the actual save. Rejections surface to the caller. */
  save: () => Promise<void>
  /** False when there is nothing to write; the timer then does nothing at all. */
  isDirty: () => boolean
  idleMs?: number
  floorMs?: number
  now?: () => number
}

export interface Autosave {
  /** A change happened; (re)arm the idle timer. */
  touch(): void
  /** Save right now if dirty — used by ⌘S and by leaving the editor. */
  flush(): Promise<void>
  cancel(): void
}

export function createAutosave(options: AutosaveOptions): Autosave {
  const { save, isDirty, idleMs = AUTOSAVE_IDLE_MS, floorMs = AUTOSAVE_FLOOR_MS, now = Date.now } = options

  let timer: ReturnType<typeof setTimeout> | null = null
  let lastSave = 0
  let running = false

  const cancel = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  const schedule = () => {
    cancel()
    const earliest = Math.max(now() + idleMs, lastSave === 0 ? 0 : lastSave + floorMs)
    timer = setTimeout(() => void run(), Math.max(0, earliest - now()))
  }

  const run = async (): Promise<void> => {
    timer = null
    if (running || !isDirty()) return
    running = true
    try {
      await save()
      lastSave = now()
    } finally {
      running = false
    }
    if (isDirty()) schedule()
  }

  return {
    touch: schedule,
    async flush() {
      cancel()
      await run()
    },
    cancel,
  }
}
