import { zipArchive } from './zip'
import type { EpubArchive } from './types'

const encoder = new TextEncoder()

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export interface NewBookOptions {
  title: string
  author?: string
  language?: string
}

/** Builds the smallest valid EPUB 3 package: one chapter, one stylesheet, a nav document. */
export function createEmptyEpub(options: NewBookOptions): Uint8Array {
  const title = escapeXml(options.title.trim() || '未命名')
  const author = escapeXml(options.author?.trim() ?? '')
  const language = options.language?.trim() || 'zh-CN'
  const uuid = `urn:uuid:${crypto.randomUUID()}`

  const entries: Array<[string, string]> = [
    [
      'META-INF/container.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="EPUB/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`,
    ],
    [
      'EPUB/content.opf',
      `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${uuid}</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:language>${language}</dc:language>${author ? `\n    <dc:creator>${author}</dc:creator>` : ''}
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="styles/stylesheet1.css" media-type="text/css"/>
    <item id="ch001" href="text/ch001.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch001"/>
  </spine>
</package>
`,
    ],
    [
      'EPUB/nav.xhtml',
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${language}">
<head><meta charset="utf-8"/><title>${title}</title></head>
<body>
<nav epub:type="toc" id="toc">
  <h1>${title}</h1>
  <ol><li><a href="text/ch001.xhtml">第一章</a></li></ol>
</nav>
</body>
</html>
`,
    ],
    [
      'EPUB/text/ch001.xhtml',
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${language}">
<head><meta charset="utf-8"/><title>第一章</title><link rel="stylesheet" type="text/css" href="../styles/stylesheet1.css"/></head>
<body>
<h1>第一章</h1>
<p>从这里开始写。</p>
</body>
</html>
`,
    ],
    ['EPUB/styles/stylesheet1.css', `body { margin: 5%; line-height: 1.6; }\nh1 { font-size: 1.4em; }\n`],
  ]

  const archive: EpubArchive = {
    order: ['mimetype', ...entries.map(([path]) => path)],
    entries: new Map<string, Uint8Array>([
      ['mimetype', encoder.encode('application/epub+zip')],
      ...entries.map(([path, text]) => [path, encoder.encode(text)] as [string, Uint8Array]),
    ]),
  }

  return zipArchive(archive)
}
