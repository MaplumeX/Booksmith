/** Directory part of an archive path (`a/b/c.xhtml` → `a/b`). */
export function dirname(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

/** Joins archive-relative segments, collapsing `.` and `..`. */
export function resolvePath(baseDir: string, href: string): string {
  const decoded = decodeURIComponent(href.split('#')[0] ?? '')
  const segments = `${baseDir ? `${baseDir}/` : ''}${decoded}`.split('/')
  const out: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') out.pop()
    else out.push(segment)
  }
  return out.join('/')
}

/** Splits `a/b/c.xhtml#frag` into its path and fragment. */
export function splitFragment(href: string): { path: string; fragment: string } {
  const index = href.indexOf('#')
  return index < 0
    ? { path: href, fragment: '' }
    : { path: href.slice(0, index), fragment: href.slice(index + 1) }
}
