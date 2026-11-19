import { dirname, resolvePath, type EpubArchive, type EpubPackage } from '@booksmith/core'

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
  /** Releases blob URLs created for images and fonts. */
  revoke: () => void
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
export function buildPreview(args: {
  xhtml: string
  path: string
  archive: EpubArchive
  pkg: EpubPackage
}): PreviewDocument {
  const { xhtml, path, archive, pkg } = args
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
    const url = blobFor(resolvePath(dirname(path), src))
    if (url) {
      image.setAttribute('src', url)
    } else {
      image.setAttribute('alt', `${image.getAttribute('alt') ?? ''}（缺失图片：${src}）`)
      image.removeAttribute('src')
      image.setAttribute('data-missing', 'true')
    }
  }

  const html = `<!DOCTYPE html>${doc.documentElement.outerHTML}`

  return {
    html,
    revoke: () => {
      for (const url of urls) URL.revokeObjectURL(url)
    },
  }
}
