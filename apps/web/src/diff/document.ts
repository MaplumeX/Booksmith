import type { EpubArchive, EpubPackage } from '@booksmith/core'

/**
 * Source-level diff for snapshot history.
 *
 * Every spine document is concatenated in reading order into one text, then aligned line
 * by line. Where a single removed line meets a single added line, the two are character-
 * diffed, so changing one word in a paragraph marks that word rather than the whole line.
 *
 * Source over rendered markup is deliberate: it is the only way a changed `class`, image
 * path or OPF attribute becomes visible at all. See ADR 2026-11-19-document-diff.
 */

export interface DiffSegment {
  kind: 'same' | 'removed' | 'added'
  text: string
}

export type LineDiff =
  | { kind: 'same'; text: string }
  | { kind: 'removed'; text: string }
  | { kind: 'added'; text: string }
  | { kind: 'changed'; segments: DiffSegment[] }

/** Above this many DP cells the middle section degrades to remove-all/add-all. */
const MAX_ALIGN_CELLS = 4_000_000

const NON_PROSE_EXTENSIONS = new Set(['css', 'opf', 'ncx', 'xml', 'svg', 'js', 'txt'])

type AlignStep =
  | { kind: 'same'; ai: number; bi: number }
  | { kind: 'removed'; ai: number }
  | { kind: 'added'; bi: number }

function lcsSteps<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): AlignStep[] {
  const width = b.length + 1
  const dp = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i * width + j] = eq(a[i]!, b[j]!)
        ? dp[(i + 1) * width + j + 1]! + 1
        : Math.max(dp[(i + 1) * width + j]!, dp[i * width + j + 1]!)
    }
  }

  const steps: AlignStep[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (eq(a[i]!, b[j]!)) {
      steps.push({ kind: 'same', ai: i, bi: j })
      i += 1
      j += 1
    } else if (dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!) {
      steps.push({ kind: 'removed', ai: i })
      i += 1
    } else {
      steps.push({ kind: 'added', bi: j })
      j += 1
    }
  }
  while (i < a.length) {
    steps.push({ kind: 'removed', ai: i })
    i += 1
  }
  while (j < b.length) {
    steps.push({ kind: 'added', bi: j })
    j += 1
  }
  return steps
}

/** Trims the shared prefix and suffix first, so the LCS only sees what actually moved. */
function alignSequence<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): AlignStep[] {
  let head = 0
  while (head < a.length && head < b.length && eq(a[head]!, b[head]!)) head += 1

  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    eq(a[a.length - 1 - tail]!, b[b.length - 1 - tail]!)
  ) {
    tail += 1
  }

  const steps: AlignStep[] = []
  for (let i = 0; i < head; i += 1) steps.push({ kind: 'same', ai: i, bi: i })

  const aMid = a.slice(head, a.length - tail)
  const bMid = b.slice(head, b.length - tail)
  if (aMid.length * bMid.length > MAX_ALIGN_CELLS) {
    aMid.forEach((_, index) => steps.push({ kind: 'removed', ai: head + index }))
    bMid.forEach((_, index) => steps.push({ kind: 'added', bi: head + index }))
  } else {
    for (const step of lcsSteps(aMid, bMid, eq)) {
      steps.push(
        step.kind === 'same'
          ? { kind: 'same', ai: head + step.ai, bi: head + step.bi }
          : step.kind === 'removed'
            ? { kind: 'removed', ai: head + step.ai }
            : { kind: 'added', bi: head + step.bi },
      )
    }
  }

  const tailStart = a.length - tail
  for (let i = tailStart; i < a.length; i += 1) {
    steps.push({ kind: 'same', ai: i, bi: b.length - tail + (i - tailStart) })
  }
  return steps
}

function pushSegment(segments: DiffSegment[], kind: DiffSegment['kind'], text: string): void {
  if (text.length === 0) return
  const last = segments.at(-1)
  if (last?.kind === kind) last.text += text
  else segments.push({ kind, text })
}

export function diffChars(before: string, after: string): DiffSegment[] {
  const a = Array.from(before)
  const b = Array.from(after)

  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1

  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail += 1
  }

  const segments: DiffSegment[] = []
  pushSegment(segments, 'same', a.slice(0, head).join(''))

  const aMid = a.slice(head, a.length - tail)
  const bMid = b.slice(head, b.length - tail)
  if (aMid.length * bMid.length > MAX_ALIGN_CELLS) {
    pushSegment(segments, 'removed', aMid.join(''))
    pushSegment(segments, 'added', bMid.join(''))
  } else {
    for (const step of lcsSteps(aMid, bMid, (x, y) => x === y)) {
      if (step.kind === 'same') pushSegment(segments, 'same', aMid[step.ai]!)
      else if (step.kind === 'removed') pushSegment(segments, 'removed', aMid[step.ai]!)
      else pushSegment(segments, 'added', bMid[step.bi]!)
    }
  }

  pushSegment(segments, 'same', a.slice(a.length - tail).join(''))
  return segments
}

/**
 * Aligns two source texts line by line. A lone removed line facing a lone added line
 * collapses into one `changed` entry so the reader sees the edited words, not two
 * near-identical red and green lines.
 */
export function diffLines(before: string, after: string): LineDiff[] {
  const a = before.split('\n')
  const b = after.split('\n')

  const steps = alignSequence(a, b, (x, y) => x === y)
  const result: LineDiff[] = []
  let index = 0
  while (index < steps.length) {
    const step = steps[index]!
    if (step.kind === 'same') {
      result.push({ kind: 'same', text: b[step.bi]! })
      index += 1
      continue
    }

    const removed: string[] = []
    const added: string[] = []
    while (index < steps.length && steps[index]!.kind !== 'same') {
      const current = steps[index]!
      if (current.kind === 'removed') removed.push(a[current.ai]!)
      else if (current.kind === 'added') added.push(b[current.bi]!)
      index += 1
    }

    if (removed.length === 1 && added.length === 1) {
      result.push({ kind: 'changed', segments: diffChars(removed[0]!, added[0]!) })
    } else {
      for (const line of removed) result.push({ kind: 'removed', text: line })
      for (const line of added) result.push({ kind: 'added', text: line })
    }
  }
  return result
}

/** Reading order of the book, resolving spine idrefs to archive paths. */
export function spinePaths(pkg: EpubPackage): string[] {
  return pkg.spine
    .map((id) => pkg.manifest.find((item) => item.id === id)?.path)
    .filter((path): path is string => typeof path === 'string')
}

/**
 * Concatenates every spine document into one source text, with the file it came from left
 * as an XHTML comment. Without that comment a 28-document dump is unreadable; with it the
 * reader can still tell which chapter a change belongs to.
 */
export function sourceDocument(paths: string[], texts: Map<string, string>): string {
  const parts: string[] = []
  for (const path of paths) {
    const text = texts.get(path)
    if (text === undefined) continue
    parts.push(`<!-- ${path} -->`, text)
  }
  return parts.join('\n')
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false
  }
  return true
}

/**
 * Names every non-spine text file that differs, so a snapshot that also touched the OPF
 * or a stylesheet is not mistaken for a prose-only edit. Deliberately a filename list:
 * the diff body stays document-level.
 */
export function changedNonProseFiles(
  before: EpubArchive,
  after: EpubArchive,
  prosePaths: Set<string>,
): string[] {
  const candidates = new Set([...before.entries.keys(), ...after.entries.keys()])
  const changed: string[] = []
  for (const path of candidates) {
    if (prosePaths.has(path)) continue
    const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
    if (!NON_PROSE_EXTENSIONS.has(extension)) continue
    const a = before.entries.get(path)
    const b = after.entries.get(path)
    if (!a || !b || !sameBytes(a, b)) changed.push(path)
  }
  return changed.sort()
}
