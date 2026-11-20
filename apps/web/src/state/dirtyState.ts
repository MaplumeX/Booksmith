export interface SavedBaseline {
  texts: Map<string, string>
  entries: Map<string, Uint8Array>
}

export interface DirtySummary {
  all: Set<string>
  texts: Set<string>
  binaries: Set<string>
  deleted: Set<string>
}

function bytesEqual(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === b) return true
  if (!a || !b || a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export function createSavedBaseline(
  texts: ReadonlyMap<string, string>,
  entries: ReadonlyMap<string, Uint8Array>,
): SavedBaseline {
  return {
    texts: new Map(texts),
    entries: new Map(entries),
  }
}

export function computeDirtySummary(
  baseline: SavedBaseline,
  currentTexts: ReadonlyMap<string, string>,
  currentEntries: ReadonlyMap<string, Uint8Array>,
): DirtySummary {
  // Deriving dirty sets strictly against the last saved baseline prevents false dirty states
  // (e.g. external editor sync or undo back to original) and missed structural deletions.
  // See ADR 2026-11-20-baseline-derived-dirty-state.
  const all = new Set<string>()
  const texts = new Set<string>()
  const binaries = new Set<string>()
  const deleted = new Set<string>()

  for (const [path, text] of currentTexts) {
    if (!baseline.texts.has(path) || baseline.texts.get(path) !== text) {
      texts.add(path)
      all.add(path)
    }
  }

  for (const [path, bytes] of currentEntries) {
    if (currentTexts.has(path)) continue
    if (!baseline.entries.has(path) || !bytesEqual(baseline.entries.get(path), bytes)) {
      binaries.add(path)
      all.add(path)
    }
  }

  for (const path of baseline.entries.keys()) {
    if (!currentEntries.has(path) && !currentTexts.has(path)) {
      deleted.add(path)
      all.add(path)
    }
  }

  for (const path of baseline.texts.keys()) {
    if (!currentTexts.has(path) && !currentEntries.has(path)) {
      deleted.add(path)
      all.add(path)
    }
  }

  return { all, texts, binaries, deleted }
}

export function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const item of a) {
    if (!b.has(item)) return false
  }
  return true
}
