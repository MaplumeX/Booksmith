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

export interface PreviewDocument {
  html: string
  /** Original raw XML substrings for top-level protection islands inside `<body>` (editable mode only). */
  islands: string[]
  /** Releases blob URLs created for images and fonts. */
  revoke: () => void
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
function buildEditorStyleCss(paperTheme: 'light' | 'dark'): string {
  const isDark = paperTheme === 'dark'
  const paperBg = isDark ? '#1b222c' : '#ffffff'
  const paperText = isDark ? '#e9edf2' : '#1b222c'
  const paperBorder = isDark ? '#2d3746' : '#d6dbe0'
  const paperShadow = isDark
    ? '0 1px 2px rgb(7 11 18 / 28%), inset 0 1px 0 rgb(255 255 255 / 4%)'
    : '0 1px 2px rgb(16 24 40 / 6%), 0 1px 1px rgb(16 24 40 / 4%)'
  const islandBorder = isDark ? '#404c5e' : '#aab5c6'
  const accent = isDark ? '#82abd3' : '#35618c'

  return `
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
  border-radius: 6px;
  box-shadow: ${paperShadow};
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
  color: ${isDark ? '#aab5c6' : '#546175'};
}
body p:empty::before {
  content: "\\200B";
}
`
}

export function buildPreview(args: {
  xhtml: string
  path: string
  archive: EpubArchive
  pkg: EpubPackage
  editable?: { paperTheme?: 'light' | 'dark' }
}): PreviewDocument {
  const { xhtml, path, archive, pkg, editable } = args
  const doc = new DOMParser().parseFromString(xhtml, 'text/html')
  const urls: string[] = []

  const blobFor = (targetPath: string): string | null => {
    const bytes = archive.entries.get(targetPath)
    if (!bytes) return null
    const copy = new Uint8Array(bytes.length)
    copy.set(bytes)
    const url = URL.createObjectURL(new Blob([copy.buffer], { type: mediaTypeOf(targetPath, pkg) }))
    urls.push(url)
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
    const bytes = archive.entries.get(targetPath)
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
    editorStyle.textContent = buildEditorStyleCss(editable.paperTheme ?? 'light')
    doc.head?.appendChild(editorStyle)
  }

  const html = `<!DOCTYPE html>${doc.documentElement.outerHTML}`

  return {
    html,
    islands,
    revoke: () => {
      for (const url of urls) URL.revokeObjectURL(url)
    },
  }
}
