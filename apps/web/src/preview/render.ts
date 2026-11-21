import { dirname, resolvePath, type EpubArchive, type EpubPackage } from '@booksmith/core'
import { extractBodyRange, extractTopLevelIslands, ISLAND_SELECTOR } from '../editor/wysiwygXhtml'
import { adaptCssForDarkTheme, adaptInlineStyleForDarkTheme } from './darkThemeColor'

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

export type PreviewAsset =
  | { kind: 'bytes'; bytes: Uint8Array; mime: string }
  | { kind: 'url'; url: string; key: string; mime: string }

export type PreviewAssetResolver = (path: string) => PreviewAsset | null

export interface PreviewResourceSnapshot {
  bytes: Uint8Array | undefined
  assetKey?: string
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

/** Returns true when any stylesheet, image, or font referenced by a preview changed bytes, remote key, or MIME type. */
export function previewResourcesChanged(
  dependencies: ReadonlyMap<string, PreviewResourceSnapshot>,
  archive: EpubArchive,
  pkg: EpubPackage,
  resolveAsset?: PreviewAssetResolver,
): boolean {
  for (const [depPath, snapshot] of dependencies) {
    const resolved = resolveAsset?.(depPath)
    if (resolved?.kind === 'url') {
      if (snapshot.assetKey !== resolved.key) return true
      if (resolved.mime !== snapshot.mime) return true
      continue
    }
    if (snapshot.assetKey !== undefined) return true
    const bytes = resolved?.kind === 'bytes' ? resolved.bytes : archive.entries.get(depPath)
    if (bytes !== snapshot.bytes) return true
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

interface ReaderThemePalette {
  bg: string
  raised: string
  text: string
  textSecondary: string
  muted: string
  link: string
  border: string
  borderStrong: string
  markBg: string
  paperShadow: string
}

function getReaderPalette(theme: 'light' | 'dark'): ReaderThemePalette {
  if (theme === 'dark') {
    return {
      bg: '#1a1b24',
      raised: '#222430',
      text: '#ececf2',
      textSecondary: '#b4b5c7',
      muted: '#9e9fb3',
      link: '#9c97f4',
      border: '#2c2e3d',
      borderStrong: '#464655',
      markBg: '#3a2c14',
      paperShadow: '0 2px 6px rgb(6 7 12 / 34%), inset 0 1px 0 rgb(255 255 255 / 5%)',
    }
  }
  return {
    bg: '#ffffff',
    raised: '#f4f4f6',
    text: '#202028',
    textSecondary: '#464655',
    muted: '#5a5a6b',
    link: '#4338ca',
    border: '#e2e2ea',
    borderStrong: '#afb0bd',
    markBg: '#fdf1dc',
    paperShadow: '0 2px 6px -1px rgb(18 19 26 / 6%), 0 1px 2px rgb(18 19 26 / 4%)',
  }
}

function buildSharedOverlayCss(palette: ReaderThemePalette, scopePrefix = ''): string {
  const imgSelector = scopePrefix ? `${scopePrefix} img[data-missing="true"]` : 'img[data-missing="true"]'
  const hrSelector = scopePrefix ? `${scopePrefix} hr.sigil_split_marker` : 'hr.sigil_split_marker'
  const missingBorder = scopePrefix ? palette.borderStrong : palette.border

  return `${imgSelector} {
  display: inline-block;
  min-width: 120px;
  min-height: 36px;
  padding: 6px 10px;
  border: 1px dashed ${missingBorder};
  border-radius: 4px;
  font-size: 12px;
  color: ${palette.muted};
}
${hrSelector} {
  position: relative;
  height: 0;
  margin: 20px 0;
  border: 0;
  border-top: 2px dashed ${palette.link};
  overflow: visible;
}
${hrSelector}::after {
  content: "✂ 拆分点";
  position: absolute;
  top: -10px;
  right: 8px;
  padding: 1px 8px;
  border-radius: 999px;
  background: ${palette.bg};
  border: 1px solid ${palette.link};
  color: ${palette.link};
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
}
`
}

/**
 * Zero-specificity (`:where(...)`) baseline typography shared by Preview and WYSIWYG.
 *
 * Prepended before the EPUB's own stylesheets so any author-defined rule naturally
 * takes precedence while unstyled or partially styled chapters stay crisp and legible.
 * See ADR 2026-11-21-reader-typography-and-dark-adaptation.
 */
export function buildReaderBaseCss(
  theme: 'light' | 'dark',
  options: { mode?: 'preview' | 'editable' } = {},
): string {
  const p = getReaderPalette(theme)
  const isEditable = options.mode === 'editable'

  return `
:where(html) {
  font-size: 16px;
  -webkit-text-size-adjust: 100%;
}
:where(body) {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", "Helvetica Neue", sans-serif;
  font-size: 1rem;
  line-height: 1.72;
  color: ${p.text};
  background-color: ${p.bg};
  overflow-wrap: break-word;
${isEditable ? '' : '  margin: 0;\n  padding: 20px 24px;\n'}}
:where(h1, h2, h3, h4, h5, h6) {
  font-weight: 600;
  line-height: 1.3;
  margin: 1.4em 0 0.6em;
  color: ${p.text};
}
:where(h1) { font-size: 1.65em; }
:where(h2) { font-size: 1.38em; }
:where(h3) { font-size: 1.2em; }
:where(h4) { font-size: 1.08em; }
:where(h5) { font-size: 1em; }
:where(h6) { font-size: 0.94em; color: ${p.textSecondary}; }
:where(body > :first-child:is(h1, h2, h3, h4, h5, h6)) {
  margin-top: 0.2em;
}
:where(p) {
  margin: 0.75em 0;
}
:where(a) {
  color: ${p.link};
  text-decoration: underline;
  text-underline-offset: 0.18em;
  text-decoration-thickness: 1px;
}
:where(blockquote) {
  margin: 1.1em 0;
  padding: 0.75em 1em;
  border-left: 3px solid ${p.borderStrong};
  border-radius: 0 6px 6px 0;
  background-color: ${p.raised};
  color: ${p.textSecondary};
}
:where(blockquote > :first-child) {
  margin-top: 0;
}
:where(blockquote > :last-child) {
  margin-bottom: 0;
}
:where(blockquote cite, blockquote footer) {
  display: block;
  margin-top: 0.5em;
  font-size: 0.88em;
  font-style: normal;
  color: ${p.muted};
}
:where(code, kbd, samp) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans Mono CJK SC", monospace;
  font-size: 0.88em;
  padding: 0.12em 0.35em;
  border-radius: 4px;
  background-color: ${p.raised};
  color: ${p.text};
}
:where(pre) {
  margin: 1.1em 0;
  padding: 0.85em 1.05em;
  border: 1px solid ${p.border};
  border-radius: 6px;
  background-color: ${p.raised};
  color: ${p.text};
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans Mono CJK SC", monospace;
  font-size: 0.88em;
  line-height: 1.55;
  overflow-x: auto;
}
:where(pre code) {
  padding: 0;
  border-radius: 0;
  background: transparent;
  font-size: inherit;
}
:where(ul, ol) {
  margin: 0.75em 0;
  padding-left: 1.6em;
}
:where(li + li) {
  margin-top: 0.3em;
}
:where(dl) {
  margin: 0.9em 0;
}
:where(dt) {
  font-weight: 600;
  margin-top: 0.6em;
}
:where(dd) {
  margin-left: 1.4em;
  color: ${p.textSecondary};
}
:where(hr) {
  border: 0;
  border-top: 1px solid ${p.border};
  margin: 1.5em 0;
}
:where(table) {
  border-collapse: collapse;
  margin: 1.1em 0;
  max-width: 100%;
  font-size: 0.94em;
}
:where(th, td) {
  padding: 0.5em 0.75em;
  border: 1px solid ${p.border};
  text-align: left;
  vertical-align: top;
}
:where(th) {
  background-color: ${p.raised};
  font-weight: 600;
  color: ${p.text};
}
:where(caption) {
  margin-bottom: 0.45em;
  font-size: 0.88em;
  color: ${p.muted};
  text-align: left;
}
:where(figure) {
  margin: 1.1em 0;
  text-align: center;
}
:where(figcaption) {
  margin-top: 0.45em;
  font-size: 0.88em;
  line-height: 1.5;
  color: ${p.muted};
}
:where(img, svg, video) {
  max-width: 100%;
  height: auto;
}
:where(sup, sub) {
  font-size: 0.75em;
  line-height: 0;
}
:where(mark) {
  background-color: ${p.markBg};
  color: ${p.text};
  padding: 0 0.2em;
  border-radius: 3px;
}
:where(math[display="block"]) {
  margin: 0.9em 0;
}
`
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
  const p = getReaderPalette(theme)

  return `
:root {
  color-scheme: ${theme};
}
html,
body {
  background-color: ${p.bg};
  color: ${p.text};
}
${buildSharedOverlayCss(p)}`
}

export function buildEditorStyleCss(paperTheme: 'light' | 'dark'): string {
  const p = getReaderPalette(paperTheme)

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
  background: ${p.bg};
  color: ${p.text};
  border: 1px solid ${p.border};
  border-radius: 10px;
  box-shadow: ${p.paperShadow};
  outline: none;
  overflow-wrap: break-word;
}
@media (max-width: 640px) {
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
  outline-color: ${p.borderStrong};
}
body [data-booksmith-selected="true"] {
  outline: 2px solid ${p.link} !important;
  outline-offset: 2px;
}
body p:empty::before {
  content: "\\200B";
}
${buildSharedOverlayCss(p, 'body')}`
}

/**
 * Adapts or restores inline `style` attributes inside `body` for the active theme.
 *
 * In editable mode, original inline styles are preserved in `data-booksmith-orig-style`
 * so XHTML serialization and light-mode toggling never leak dark-adapted colors.
 * See ADR 2026-11-21-reader-typography-and-dark-adaptation.
 */
export function adaptDocumentBodyInlineStyles(
  body: Element,
  theme: 'light' | 'dark',
  trackOriginal: boolean,
): void {
  const candidates = [
    body,
    ...Array.from(body.querySelectorAll('[style], [data-booksmith-orig-style]')),
  ]

  for (const el of candidates) {
    if (el !== body && el.closest('math, svg, video, audio')) continue

    if (theme === 'light') {
      if (!el.hasAttribute('data-booksmith-orig-style')) continue
      const orig = el.getAttribute('data-booksmith-orig-style') ?? ''
      if (orig) el.setAttribute('style', orig)
      else el.removeAttribute('style')
      el.removeAttribute('data-booksmith-orig-style')
      continue
    }

    const orig = el.hasAttribute('data-booksmith-orig-style')
      ? el.getAttribute('data-booksmith-orig-style') ?? ''
      : el.getAttribute('style') ?? ''
    if (!orig) continue

    const adapted = adaptInlineStyleForDarkTheme(orig)
    if (adapted !== orig) {
      if (trackOriginal && !el.hasAttribute('data-booksmith-orig-style')) {
        el.setAttribute('data-booksmith-orig-style', orig)
      }
      el.setAttribute('style', adapted)
    }
  }
}

export function buildPreviewDocument(args: {
  xhtml: string
  path: string
  archive: EpubArchive
  pkg: EpubPackage
  theme?: 'light' | 'dark'
  editable?: { paperTheme?: 'light' | 'dark' }
  blobCache?: PreviewBlobCache
  resolveAsset?: PreviewAssetResolver
}): BuiltPreviewDocument {
  const { xhtml, path, archive, pkg, theme = 'light', editable, blobCache, resolveAsset } = args
  const doc = new DOMParser().parseFromString(xhtml, 'text/html')
  const ephemeralUrls: string[] = []
  const dependencies = new Map<string, PreviewResourceSnapshot>()

  const recordDependency = (targetPath: string): { bytes: Uint8Array | undefined; mime: string } => {
    const bytes = archive.entries.get(targetPath)
    const mime = mediaTypeOf(targetPath, pkg)
    dependencies.set(targetPath, { bytes, mime })
    return { bytes, mime }
  }

  const assetUrlFor = (targetPath: string): string | null => {
    const resolved = resolveAsset?.(targetPath)
    if (resolved?.kind === 'url') {
      dependencies.set(targetPath, { bytes: undefined, assetKey: resolved.key, mime: resolved.mime })
      return resolved.url
    }
    const bytes = resolved?.kind === 'bytes' ? resolved.bytes : archive.entries.get(targetPath)
    const mime = resolved?.kind === 'bytes' ? resolved.mime : mediaTypeOf(targetPath, pkg)
    dependencies.set(targetPath, { bytes, mime })
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
      const url = assetUrlFor(resolvePath(baseDir, target))
      return url ? `url("${url}")` : match
    })

  const effectiveTheme = editable ? (editable.paperTheme ?? theme) : theme
  const inlinedFromLink = new Set<Element>()

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
    const rewritten = rewriteCss(new TextDecoder().decode(bytes), dirname(targetPath))
    style.textContent = effectiveTheme === 'dark' ? adaptCssForDarkTheme(rewritten) : rewritten
    inlinedFromLink.add(style)
    link.replaceWith(style)
  }

  for (const style of Array.from(doc.querySelectorAll('style'))) {
    if (inlinedFromLink.has(style)) continue
    const rewritten = rewriteCss(style.textContent ?? '', dirname(path))
    style.textContent = effectiveTheme === 'dark' ? adaptCssForDarkTheme(rewritten) : rewritten
  }

  for (const image of Array.from(doc.querySelectorAll('img[src]'))) {
    const src = image.getAttribute('src')
    if (!src) continue
    if (editable) {
      image.setAttribute('data-booksmith-src', src)
    }
    const url = assetUrlFor(resolvePath(dirname(path), src))
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

  if (doc.head) {
    const baseStyle = doc.createElement('style')
    baseStyle.setAttribute('data-booksmith-base-style', 'true')
    baseStyle.textContent = buildReaderBaseCss(effectiveTheme, {
      mode: editable ? 'editable' : 'preview',
    })
    doc.head.insertBefore(baseStyle, doc.head.firstChild)
  }

  if (doc.body && effectiveTheme === 'dark') {
    adaptDocumentBodyInlineStyles(doc.body, 'dark', Boolean(editable))
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
    editorStyle.textContent = buildEditorStyleCss(effectiveTheme)
    doc.head?.appendChild(editorStyle)
  } else {
    const previewThemeStyle = doc.createElement('style')
    previewThemeStyle.setAttribute('data-booksmith-preview-theme', 'true')
    previewThemeStyle.textContent = buildPreviewThemeCss(effectiveTheme)
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
