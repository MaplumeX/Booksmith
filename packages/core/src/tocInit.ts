import { setSpineToc } from './opfEdit'
import { addManifestItem, OPF_NS } from './opfWrite'
import { dirname, relativePath } from './path'
import type { EpubPackage } from './types'
import type { XmlCodec } from './xml'

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function uniquePath(dir: string, stem: string, ext: string, existing: ReadonlyMap<string, string>): string {
  const prefix = dir ? `${dir}/` : ''
  let candidate = `${prefix}${stem}.${ext}`
  let index = 1
  while (existing.has(candidate)) {
    candidate = `${prefix}${stem}-${index}.${ext}`
    index += 1
  }
  return candidate
}

function findManifestIdByHref(opfXml: string, href: string, codec: XmlCodec): string | null {
  const doc = codec.parse(opfXml)
  const items = Array.from(doc.getElementsByTagNameNS(OPF_NS, 'item'))
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (item?.getAttribute('href') === href) return item.getAttribute('id')
  }
  return null
}

export interface InitializeBookTocResult {
  created: boolean
  kind: 'nav' | 'ncx'
  tocPath: string
  tocContent: string
  opfXml: string
}

/**
 * Bootstraps a standard TOC document when a book has neither `nav.xhtml` nor `toc.ncx`.
 * EPUB 3 packages get a `properties="nav"` XHTML document; EPUB 2 packages get a `toc.ncx`
 * linked via `<spine toc="...">`.
 */
export function initializeBookToc(
  pkg: EpubPackage,
  texts: ReadonlyMap<string, string>,
  codec: XmlCodec,
): InitializeBookTocResult {
  const opfXml = texts.get(pkg.opfPath)
  if (!opfXml) throw new Error(`OPF file missing: ${pkg.opfPath}`)

  if (pkg.navPath) {
    return {
      created: false,
      kind: 'nav',
      tocPath: pkg.navPath,
      tocContent: texts.get(pkg.navPath) ?? '',
      opfXml,
    }
  }
  if (pkg.ncxPath) {
    return {
      created: false,
      kind: 'ncx',
      tocPath: pkg.ncxPath,
      tocContent: texts.get(pkg.ncxPath) ?? '',
      opfXml,
    }
  }

  const opfDir = dirname(pkg.opfPath)
  const title = escapeXml(pkg.metadata.title.trim() || '目录')
  const language = escapeXml(pkg.metadata.language.trim() || 'zh-CN')
  const identifier = escapeXml(pkg.metadata.identifier.trim() || 'booksmith-book')
  const isEpub3 = pkg.version.trim().startsWith('3')

  if (isEpub3) {
    const tocPath = uniquePath(opfDir, 'nav', 'xhtml', texts)
    const href = relativePath(opfDir, tocPath)
    const tocContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${language}">
<head>
  <meta charset="utf-8"/>
  <title>${title}</title>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>目录</h1>
    <ol class="toc"/>
  </nav>
</body>
</html>
`
    const nextOpf = addManifestItem(
      opfXml,
      { id: 'nav', href, mediaType: 'application/xhtml+xml', properties: ['nav'] },
      codec,
    )
    return { created: true, kind: 'nav', tocPath, tocContent, opfXml: nextOpf }
  }

  const tocPath = uniquePath(opfDir, 'toc', 'ncx', texts)
  const href = relativePath(opfDir, tocPath)
  const tocContent = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${identifier}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${title}</text></docTitle>
  <navMap/>
</ncx>
`
  let nextOpf = addManifestItem(
    opfXml,
    { id: 'ncx', href, mediaType: 'application/x-dtbncx+xml' },
    codec,
  )
  const ncxId = findManifestIdByHref(nextOpf, href, codec) ?? 'ncx'
  nextOpf = setSpineToc(nextOpf, ncxId, codec)
  return { created: true, kind: 'ncx', tocPath, tocContent, opfXml: nextOpf }
}
