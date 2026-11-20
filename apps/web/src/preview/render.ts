import { dirname, resolvePath, type EpubArchive, type EpubPackage } from '@booksmith/core'
import { extractBodyRange, extractTopLevelIslands, ISLAND_SELECTOR } from '../editor/wysiwygXhtml'

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  css: 'text/css',
  xhtml: 'application/xhtml+xml',
  html: 'text/html',
  js: 'text/javascript',
  otf: 'font/otf',
  ttf: 'font/ttf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
}

/** Sentinel shell loaded once into preview/WYSIWYG iframes so subsequent updates patch in place. */
export const EMPTY_IFRAME_DOC =
  '<!DOCTYPE html><html data-booksmith-shell="ready"><head><meta charset="utf-8"></head><body></body></html>'

export interface PreviewResourceSnapshot {
  bytes: Uint8Array | undefined
  mime: string
}

export interface PreviewDocument {
  html: string
  /** Original raw XML substrings for top-level protection islands inside `<body>` (editable mode only). */
  islands: string[]
  /** Releases blob URLs created for images and fonts. */
  revoke: () => void
}

export interface BuiltPreviewDocument {
  doc: Document
  /** Original raw XML substrings for top-level protection islands inside `<body>` (editable mode only). */
  islands: string[]
  /** Archive resources consulted while building this document (stylesheets, images, fonts). */
  dependencies: Map<string, PreviewResourceSnapshot>
  /** Releases ephemeral blob URLs created when no external `blobCache` was supplied. */
  revoke: () => void
}

/**
 * Caches object URLs keyed by archive path, byte reference, and media type.
 *
 * Reusing the same `blob:` URL whenever an asset's `Uint8Array` reference is unchanged
 * lets the browser keep decoded images and `@font-face` fonts cached across preview updates.
 */
export class PreviewBlobCache {
  private entries = new Map<string, { bytes: Uint8Array; mime: string; url: string }>()
  private obsolete: string[] = []

  urlFor(path: string, bytes: Uint8Array, mime: string): string {
    const cached = this.entries.get(path)
    if (cached && cached.bytes === bytes && cached.mime === mime) {
      return cached.url
    }
    const copy = new Uint8Array(bytes.length)
    copy.set(bytes)
    const url = URL.createObjectURL(new Blob([copy.buffer], { type: mime }))
    if (cached) this.obsolete.push(cached.url)
    this.entries.set(path, { bytes, mime, url })
    return url
  }

  /** Releases replaced URLs (and entries removed from the archive) after the DOM has been patched. */
  flushObsolete(archive?: EpubArchive): void {
    if (archive) {
      for (const [path, entry] of this.entries) {
        if (!archive.entries.has(path)) {
          this.obsolete.push(entry.url)
          this.entries.delete(path)
        }
      }
    }
    for (const url of this.obsolete) URL.revokeObjectURL(url)
    this.obsolete = []
  }

  /** Releases every blob URL owned by this cache. */
  dispose(): void {
    for (const entry of this.entries.values()) URL.revokeObjectURL(entry.url)
    this.entries.clear()
    this.flushObsolete()
  }
}

/** Returns true when any stylesheet, image, or font referenced by a preview changed bytes or MIME type. */
export function previewResourcesChanged(
  dependencies: ReadonlyMap<string, PreviewResourceSnapshot>,
  archive: EpubArchive,
  pkg: EpubPackage,
): boolean {
  for (const [depPath, snapshot] of dependencies) {
    if (archive.entries.get(depPath) !== snapshot.bytes) return true
    if (mediaTypeOf(depPath, pkg) !== snapshot.mime) return true
  }
  return false
}

/** Media type implied by the file extension alone, ignoring what the manifest claims. */
export function mediaTypeFromExtension(path: string): string {
  return MIME_BY_EXTENSION[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream'
}

/** Media type from the manifest, falling back to the file extension. */
export function mediaTypeOf(path: string, pkg: EpubPackage): string {
  const manifestItem = pkg.manifest.find((item) => item.path === path)
  if (manifestItem?.mediaType) return manifestItem.mediaType
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream'
}

/**
 * Builds a self-contained HTML document for an iframe.
 *
 * srcdoc resolves relative URLs against the host page, so every image, stylesheet
 * and font must be inlined or swapped for a blob URL first. Stylesheets are inlined
 * rather than linked so their own relative `url(...)` references can be rewritten.
 * See ADR 2026-11-19-epub-editor-mvp.
 */
export function buildPreviewThemeCss(theme: 'light' | 'dark'): string {
  const isDark = theme === 'dark'
  const bg = isDark ? '#1a1b24' : '#ffffff'
  const text = isDark ? '#ececf2' : '#202028'
  const link = isDark ? '#9c97f4' : '#4338ca'
  const border = isDark ? '#2c2e3d' : '#e2e2ea'
  const muted = isDark ? '#9e9fb3' : '#5a5a6b'

  return `
:root {
  color-scheme: ${theme};
}
html,
body {
  background-color: ${bg};
  color: ${text};
}
${
  isDark
    ? `a {
  color: ${link};
}
hr,
th,
td,
blockquote {
  border-color: ${border};
}
`
    : ''
}img[data-missing="true"] {
  display: inline-block;
  min-width: 120px;
  min-height: 36px;
  padding: 6px 10px;
  border: 1px dashed ${border};
  border-radius: 4px;
  font-size: 12px;
  color: ${muted};
}
`
}

export function buildEditorStyleCss(paperTheme: 'light' | 'dark'): string {
  const isDark = paperTheme === 'dark'
  const paperBg = isDark ? '#1a1b24' : '#ffffff'
  const paperText = isDark ? '#ececf2' : '#202028'
  const paperBorder = isDark ? '#2c2e3d' : '#e2e2ea'
  const paperShadow = isDark
    ? '0 2px 6px rgb(6 7 12 / 34%), inset 0 1px 0 rgb(255 255 255 / 5%)'
    : '0 2px 6px -1px rgb(18 19 26 / 6%), 0 1px 2px rgb(18 19 26 / 4%)'
  const islandBorder = isDark ? '#464655' : '#afb0bd'
  const accent = isDark ? '#9c97f4' : '#4338ca'
  const muted = isDark ? '#9e9fb3' : '#5a5a6b'

  return `
:root {
  color-scheme: ${paperTheme};
}
html {
  background: transparent !important;
  padding: 24px 16px !important;
  min-height: 100%;
  box-sizing: border-box;
}
body {
  max-width: 760px !important;
  min-height: calc(100vh - 48px);
  margin: 0 auto !important;
  padding: 32px 40px !important;
  box-sizing: border-box;
  background: ${paperBg};
  color: ${paperText};
  border: 1px solid ${paperBorder};
  border-radius: 10px;
  box-shadow: ${paperShadow};
  outline: none;
  overflow-wrap: break-word;
}
${
  isDark
    ? `body a {
  color: ${accent};
}
body hr,
body th,
body td,
body blockquote {
  border-color: ${paperBorder};
}
`
    : ''
}@media (max-width: 640px) {
  html {
    padding: 12px 8px !important;
  }
  body {
    padding: 20px 18px !important;
  }
}
body [data-booksmith-island] {
  outline: 1px dashed transparent;
  border-radius: 3px;
  cursor: default;
}
body [data-booksmith-island]:hover,
body [data-booksmith-island][data-booksmith-selected="true"] {
  outline-color: ${islandBorder};
}
body [data-booksmith-selected="true"] {
  outline: 2px solid ${accent} !important;
  outline-offset: 2px;
}
body img[data-missing="true"] {
  display: inline-block;
  min-width: 120px;
  min-height: 36px;
  padding: 6px 10px;
  border: 1px dashed ${islandBorder};
  border-radius: 4px;
  font-size: 12px;
  color: ${muted};
}
body p:empty::before {
  content: "\\200B";
}
`
}

export function buildPreviewDocument(args: {
  xhtml: string
  path: string
  archive: EpubArchive
  pkg: EpubPackage
  theme?: 'light' | 'dark'
  editable?: { paperTheme?: 'light' | 'dark' }
  blobCache?: PreviewBlobCache
}): BuiltPreviewDocument {
  const { xhtml, path, archive, pkg, theme = 'light', editable, blobCache } = args
  const doc = new DOMParser().parseFromString(xhtml, 'text/html')
  const ephemeralUrls: string[] = []
  const dependencies = new Map<string, PreviewResourceSnapshot>()

  const recordDependency = (targetPath: string): { bytes: Uint8Array | undefined; mime: string } => {
    const bytes = archive.entries.get(targetPath)
    const mime = mediaTypeOf(targetPath, pkg)
    dependencies.set(targetPath, { bytes, mime })
    return { bytes, mime }
  }

  const blobFor = (targetPath: string): string | null => {
    const { bytes, mime } = recordDependency(targetPath)
    if (!bytes) return null
    if (blobCache) return blobCache.urlFor(targetPath, bytes, mime)
    const copy = new Uint8Array(bytes.length)
    copy.set(bytes)
    const url = URL.createObjectURL(new Blob([copy.buffer], { type: mime }))
    ephemeralUrls.push(url)
    return url
  }

  const rewriteCss = (css: string, baseDir: string): string =>
    css.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/g, (match, _quote: string, raw: string) => {
      const target = raw.trim()
      if (/^(data:|https?:|blob:|#)/i.test(target)) return match
      const url = blobFor(resolvePath(baseDir, target))
      return url ? `url("${url}")` : match
    })

  for (const link of Array.from(doc.querySelectorAll('link[rel~="stylesheet"]'))) {
    const href = link.getAttribute('href')
    if (!href) {
      link.remove()
      continue
    }
    const targetPath = resolvePath(dirname(path), href)
    const { bytes } = recordDependency(targetPath)
    if (!bytes) {
      link.remove()
      continue
    }
    const style = doc.createElement('style')
    style.textContent = rewriteCss(new TextDecoder().decode(bytes), dirname(targetPath))
    link.replaceWith(style)
  }

  for (const style of Array.from(doc.querySelectorAll('style'))) {
    style.textContent = rewriteCss(style.textContent ?? '', dirname(path))
  }

  for (const image of Array.from(doc.querySelectorAll('img[src]'))) {
    const src = image.getAttribute('src')
    if (!src) continue
    if (editable) {
      image.setAttribute('data-booksmith-src', src)
    }
    const url = blobFor(resolvePath(dirname(path), src))
    if (url) {
      image.setAttribute('src', url)
    } else {
      const existingAlt = image.getAttribute('alt')
      if (editable) {
        if (existingAlt === null) {
          image.setAttribute('data-booksmith-no-alt', 'true')
        } else {
          image.setAttribute('data-booksmith-orig-alt', existingAlt)
        }
      }
      image.setAttribute('alt', `${existingAlt ?? ''}（缺失图片：${src}）`)
      image.removeAttribute('src')
      image.setAttribute('data-missing', 'true')
    }
  }

  let islands: string[] = []
  if (editable && doc.body) {
    const bodyRange = extractBodyRange(xhtml)
    islands = bodyRange ? extractTopLevelIslands(bodyRange.innerXml) : []

    const domIslands = Array.from(doc.body.querySelectorAll(ISLAND_SELECTOR)).filter((node) => {
      let parent = node.parentElement
      while (parent && parent !== doc.body) {
        if (parent.matches(ISLAND_SELECTOR)) return false
        parent = parent.parentElement
      }
      return true
    })

    domIslands.forEach((node, index) => {
      node.setAttribute('data-booksmith-island', String(index))
      node.setAttribute('contenteditable', 'false')
      if (!node.hasAttribute('tabindex')) {
        node.setAttribute('tabindex', '0')
        node.setAttribute('data-booksmith-tabindex', 'true')
      }
    })

    doc.body.setAttribute('contenteditable', 'true')
    doc.body.setAttribute('spellcheck', 'false')

    const editorStyle = doc.createElement('style')
    editorStyle.setAttribute('data-booksmith-editor-style', 'true')
    editorStyle.textContent = buildEditorStyleCss(editable.paperTheme ?? theme)
    doc.head?.appendChild(editorStyle)
  } else {
    const previewThemeStyle = doc.createElement('style')
    previewThemeStyle.setAttribute('data-booksmith-preview-theme', 'true')
    previewThemeStyle.textContent = buildPreviewThemeCss(theme)
    doc.head?.appendChild(previewThemeStyle)
  }

  return {
    doc,
    islands,
    dependencies,
    revoke: () => {
      for (const url of ephemeralUrls) URL.revokeObjectURL(url)
    },
  }
}

export function buildPreview(args: {
  xhtml: string
  path: string
  archive: EpubArchive
  pkg: EpubPackage
  theme?: 'light' | 'dark'
  editable?: { paperTheme?: 'light' | 'dark' }
}): PreviewDocument {
  const built = buildPreviewDocument(args)
  return {
    html: `<!DOCTYPE html>${built.doc.documentElement.outerHTML}`,
    islands: built.islands,
    revoke: built.revoke,
  }
}
