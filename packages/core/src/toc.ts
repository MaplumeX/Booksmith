import { dirname, splitFragment, resolvePath } from './path'

export interface TocEntry {
  label: string
  /** href as written in the nav/ncx document (fragment included, percent-encoded). */
  href: string
  /** Serialized inner markup of the label anchor, kept so inline MathML survives a rebuild. */
  rawHtml?: string
  children: TocEntry[]
}

export function cloneToc(entries: TocEntry[]): TocEntry[] {
  return entries.map((entry) => ({ ...entry, children: cloneToc(entry.children) }))
}

export function countTocEntries(entries: TocEntry[]): number {
  return entries.reduce((sum, entry) => sum + 1 + countTocEntries(entry.children), 0)
}

export function flattenToc(entries: TocEntry[], depth = 0): Array<{ entry: TocEntry; depth: number }> {
  return entries.flatMap((entry) => [{ entry, depth }, ...flattenToc(entry.children, depth + 1)])
}

export interface BrokenAnchor {
  label: string
  href: string
  reason: 'missing-file' | 'missing-fragment'
}

/**
 * Checks every toc href against the archive. Fragments are matched by scanning for
 * `id="…"` / `name="…"`, which is enough for EPUB content and avoids parsing 25 chapters.
 */
export function findBrokenAnchors(
  entries: TocEntry[],
  tocPath: string,
  files: Map<string, string>,
): BrokenAnchor[] {
  const broken: BrokenAnchor[] = []
  const baseDir = dirname(tocPath)

  for (const { entry } of flattenToc(entries)) {
    if (!entry.href) continue
    const { path, fragment } = splitFragment(entry.href)
    const target = resolvePath(baseDir, path)
    const text = files.get(target)
    if (text === undefined) {
      broken.push({ label: entry.label, href: entry.href, reason: 'missing-file' })
      continue
    }
    if (!fragment) continue
    const decoded = decodeURIComponent(fragment)
    const pattern = new RegExp(`(?:id|name)\\s*=\\s*["']${escapeRegExp(decoded)}["']`)
    if (!pattern.test(text)) {
      broken.push({ label: entry.label, href: entry.href, reason: 'missing-fragment' })
    }
  }

  return broken
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function elementChildrenOf(node: Element): Element[] {
  const out: Element[] = []
  for (let index = 0; index < node.childNodes.length; index += 1) {
    const child = node.childNodes.item(index)
    if (child && child.nodeType === 1) out.push(child as Element)
  }
  return out
}
