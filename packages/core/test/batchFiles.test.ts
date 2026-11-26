import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import {
  CONTAINER_PATH,
  computeBatchSpineMove,
  deleteFilesInBook,
  getBatchSpineMoveCapability,
  inspectBatchDelete,
  isProtectedArchivePath,
  parsePackage,
  planBatchRename,
  readNavToc,
  renameFilesInBook,
  type EpubArchive,
  type XmlCodec,
} from '../src'

const codec: XmlCodec = {
  parse: (xml) => new DOMParser().parseFromString(xml, 'application/xml') as unknown as Document,
  serialize: (doc) =>
    new XMLSerializer().serializeToString(doc as unknown as Parameters<XMLSerializer['serializeToString']>[0]),
}

const encoder = new TextEncoder()

function makeSampleBook() {
  const opfPath = 'OEBPS/content.opf'
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">book-1</dc:identifier>
    <dc:title>Sample</dc:title>
    <dc:language>zh</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="text/ch001.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/ch002.xhtml" media-type="application/xhtml+xml"/>
    <item id="c3" href="text/ch003.xhtml" media-type="application/xhtml+xml"/>
    <item id="css1" href="styles/main.css" media-type="text/css"/>
    <item id="img1" href="images/fig01.png" media-type="image/png"/>
    <item id="cover" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
    <itemref idref="c3"/>
  </spine>
</package>`

  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>TOC</title></head>
<body>
<nav epub:type="toc">
  <ol>
    <li><a href="text/ch001.xhtml">第一章</a></li>
    <li><a href="text/ch002.xhtml">第二章</a></li>
    <li><a href="text/ch003.xhtml">第三章</a></li>
  </ol>
</nav>
</body>
</html>`

  const ch1 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><link rel="stylesheet" href="../styles/main.css"/></head>
<body><p><a href="ch002.xhtml#sec1">Next</a><img src="../images/fig01.png" alt="f1"/></p></body>
</html>`

  const ch2 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><link rel="stylesheet" href="../styles/main.css"/></head>
<body><p id="sec1"><a href="ch001.xhtml">Prev</a><img src="../images/fig01.png" alt="f1"/></p></body>
</html>`

  const ch3 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><link rel="stylesheet" href="../styles/main.css"/></head>
<body><p>Third chapter</p></body>
</html>`

  const css1 = `body { background: url("../images/fig01.png"); }`
  const container = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`

  const files = new Map<string, string>([
    [CONTAINER_PATH, container],
    [opfPath, opf],
    ['OEBPS/nav.xhtml', nav],
    ['OEBPS/text/ch001.xhtml', ch1],
    ['OEBPS/text/ch002.xhtml', ch2],
    ['OEBPS/text/ch003.xhtml', ch3],
    ['OEBPS/styles/main.css', css1],
  ])

  const entries = new Map<string, Uint8Array>()
  entries.set('mimetype', encoder.encode('application/epub+zip'))
  for (const [path, text] of files) entries.set(path, encoder.encode(text))
  entries.set('OEBPS/images/fig01.png', new Uint8Array([1, 2, 3]))
  entries.set('OEBPS/images/cover.jpg', new Uint8Array([4, 5, 6]))

  const archive: EpubArchive = { order: Array.from(entries.keys()), entries }
  const pkg = parsePackage(opf, opfPath, codec.parse)
  return { files, archive, pkg }
}

describe('isProtectedArchivePath', () => {
  it('protects container.xml, mimetype, and the OPF package file only', () => {
    const { pkg } = makeSampleBook()
    expect(isProtectedArchivePath(CONTAINER_PATH, pkg)).toBe(true)
    expect(isProtectedArchivePath('mimetype', pkg)).toBe(true)
    expect(isProtectedArchivePath('OEBPS/content.opf', pkg)).toBe(true)
    expect(isProtectedArchivePath('OEBPS/nav.xhtml', pkg)).toBe(false)
    expect(isProtectedArchivePath('OEBPS/text/ch001.xhtml', pkg)).toBe(false)
    expect(isProtectedArchivePath('OEBPS/images/cover.jpg', pkg)).toBe(false)
  })
})

describe('planBatchRename', () => {
  it('plans sequential renames while preserving extensions and allowing chained targets', () => {
    const existing = new Set(['OEBPS/text/ch001.xhtml', 'OEBPS/text/ch002.xhtml', 'OEBPS/text/ch003.xhtml'])
    // Shift ch002 -> ch001, ch003 -> ch002 while ch001 is NOT moving => conflict on ch001
    const blocked = planBatchRename(
      ['OEBPS/text/ch002.xhtml', 'OEBPS/text/ch003.xhtml'],
      { mode: 'sequence', prefix: 'ch', start: 1, padWidth: 3, preserveExtension: true },
      existing,
    )
    expect(blocked.canApply).toBe(false)
    expect(blocked.items[0]?.status).toBe('conflict')
    expect(blocked.items[1]?.status).toBe('changed')

    // Shift ch001 -> ch000, ch002 -> ch001, ch003 -> ch002 => valid chain
    const chained = planBatchRename(
      ['OEBPS/text/ch001.xhtml', 'OEBPS/text/ch002.xhtml', 'OEBPS/text/ch003.xhtml'],
      { mode: 'sequence', prefix: 'ch', start: 0, padWidth: 3, preserveExtension: true },
      existing,
    )
    expect(chained.canApply).toBe(true)
    expect(chained.changedCount).toBe(3)
    expect(chained.renames.get('OEBPS/text/ch001.xhtml')).toBe('OEBPS/text/ch000.xhtml')
    expect(chained.renames.get('OEBPS/text/ch002.xhtml')).toBe('OEBPS/text/ch001.xhtml')
    expect(chained.renames.get('OEBPS/text/ch003.xhtml')).toBe('OEBPS/text/ch002.xhtml')
  })

  it('supports find-replace, affix, invalid-name blocking, and duplicate-target detection', () => {
    const existing = new Set(['OEBPS/images/fig01.png', 'OEBPS/images/fig02.png'])
    const replaced = planBatchRename(
      ['OEBPS/images/fig01.png', 'OEBPS/images/fig02.png'],
      { mode: 'replace', find: 'fig', replace: 'img', preserveExtension: true },
      existing,
    )
    expect(replaced.canApply).toBe(true)
    expect(replaced.renames.get('OEBPS/images/fig01.png')).toBe('OEBPS/images/img01.png')
    expect(replaced.renames.get('OEBPS/images/fig02.png')).toBe('OEBPS/images/img02.png')

    const affixed = planBatchRename(
      ['OEBPS/images/fig01.png'],
      { mode: 'affix', prefix: 'p1_', suffix: '_hd', preserveExtension: true },
      existing,
    )
    expect(affixed.canApply).toBe(true)
    expect(affixed.renames.get('OEBPS/images/fig01.png')).toBe('OEBPS/images/p1_fig01_hd.png')

    const invalidSlash = planBatchRename(
      ['OEBPS/images/fig01.png'],
      { mode: 'affix', prefix: 'bad/', suffix: '', preserveExtension: true },
      existing,
    )
    expect(invalidSlash.canApply).toBe(false)
    expect(invalidSlash.items[0]?.status).toBe('invalid')

    const duplicate = planBatchRename(
      ['OEBPS/images/fig01.png', 'OEBPS/images/fig02.png'],
      { mode: 'replace', find: '02', replace: '01', preserveExtension: true },
      existing,
    )
    expect(duplicate.canApply).toBe(false)
    expect(duplicate.items.every((item) => item.status === 'conflict')).toBe(true)
  })
})

describe('renameFilesInBook', () => {
  it('handles chained and swapped renames atomically across OPF, chapters, CSS, and nav', () => {
    const { files, archive, pkg } = makeSampleBook()
    // Swap ch001 <-> ch002 and rename fig01.png -> photo01.png in one batch.
    const renames = new Map<string, string>([
      ['OEBPS/text/ch001.xhtml', 'OEBPS/text/ch002.xhtml'],
      ['OEBPS/text/ch002.xhtml', 'OEBPS/text/ch001.xhtml'],
      ['OEBPS/images/fig01.png', 'OEBPS/images/photo01.png'],
    ])

    const result = renameFilesInBook({ files, pkg, archive, renames, codec })

    // Verify OPF manifest was updated once without double-swapping back.
    const c1 = result.pkg.manifest.find((item) => item.id === 'c1')
    const c2 = result.pkg.manifest.find((item) => item.id === 'c2')
    const img1 = result.pkg.manifest.find((item) => item.id === 'img1')
    expect(c1?.path).toBe('OEBPS/text/ch002.xhtml')
    expect(c2?.path).toBe('OEBPS/text/ch001.xhtml')
    expect(img1?.path).toBe('OEBPS/images/photo01.png')

    // Old ch001 (now at ch002) pointed at ch002#sec1 -> should now point at ch001#sec1 and photo01.png.
    const movedCh1 = result.files.get('OEBPS/text/ch002.xhtml') ?? ''
    expect(movedCh1).toContain('href="ch001.xhtml#sec1"')
    expect(movedCh1).toContain('src="../images/photo01.png"')

    // Old ch002 (now at ch001) pointed at ch001 -> should now point at ch002 and photo01.png.
    const movedCh2 = result.files.get('OEBPS/text/ch001.xhtml') ?? ''
    expect(movedCh2).toContain('href="ch002.xhtml"')
    expect(movedCh2).toContain('src="../images/photo01.png"')

    // CSS url() and nav.xhtml hrefs are rewritten too.
    expect(result.files.get('OEBPS/styles/main.css')).toContain('url("../images/photo01.png")')
    const navEntries = readNavToc(result.files.get('OEBPS/nav.xhtml') ?? '', codec)
    expect(navEntries.map((entry) => entry.href)).toEqual([
      'text/ch002.xhtml',
      'text/ch001.xhtml',
      'text/ch003.xhtml',
    ])
    expect(result.archive.entries.has('OEBPS/images/photo01.png')).toBe(true)
    expect(result.archive.entries.has('OEBPS/images/fig01.png')).toBe(false)
  })
})

describe('inspectBatchDelete & deleteFilesInBook', () => {
  it('filters mutual references inside the deleted batch and reports external refs + risks', () => {
    const { files, pkg } = makeSampleBook()
    // Deleting ch001 + ch002 + fig01 together: mutual refs between ch001/ch002/fig01 are excluded,
    // leaving nav.xhtml references to ch001/ch002 and main.css reference to fig01.png.
    const inspection = inspectBatchDelete({
      files,
      pkg,
      paths: ['OEBPS/text/ch001.xhtml', 'OEBPS/text/ch002.xhtml', 'OEBPS/images/fig01.png', 'OEBPS/images/cover.jpg'],
    })

    const refSources = inspection.referenceGroups.flatMap((g) => g.references.map((r) => `${r.from}->${g.targetPath}`))
    expect(refSources).toContain('OEBPS/nav.xhtml->OEBPS/text/ch001.xhtml')
    expect(refSources).toContain('OEBPS/nav.xhtml->OEBPS/text/ch002.xhtml')
    expect(refSources).toContain('OEBPS/styles/main.css->OEBPS/images/fig01.png')
    // Mutual references between deleted ch001 & ch002 and their refs to deleted fig01 are filtered out.
    expect(refSources.some((s) => s.startsWith('OEBPS/text/ch001.xhtml->'))).toBe(false)
    expect(refSources.some((s) => s.startsWith('OEBPS/text/ch002.xhtml->'))).toBe(false)

    expect(inspection.coverPaths).toEqual(['OEBPS/images/cover.jpg'])
    expect(inspection.includesNav).toBe(false)
    expect(inspection.emptiesAllChapters).toBe(false)

    const emptyCheck = inspectBatchDelete({
      files,
      pkg,
      paths: ['OEBPS/text/ch001.xhtml', 'OEBPS/text/ch002.xhtml', 'OEBPS/text/ch003.xhtml', 'OEBPS/nav.xhtml'],
    })
    expect(emptyCheck.emptiesAllChapters).toBe(true)
    expect(emptyCheck.includesNav).toBe(true)
  })

  it('atomically deletes selected files, prunes nav TOC, and refuses protected files', () => {
    const { files, archive, pkg } = makeSampleBook()
    const result = deleteFilesInBook({
      files,
      pkg,
      archive,
      paths: ['OEBPS/text/ch002.xhtml', 'OEBPS/images/fig01.png', 'OEBPS/content.opf', CONTAINER_PATH],
      codec,
    })

    expect(result.removedPaths).toEqual(['OEBPS/text/ch002.xhtml', 'OEBPS/images/fig01.png'])
    expect(result.archive.entries.has('OEBPS/content.opf')).toBe(true)
    expect(result.archive.entries.has(CONTAINER_PATH)).toBe(true)
    expect(result.archive.entries.has('OEBPS/text/ch002.xhtml')).toBe(false)
    expect(result.archive.entries.has('OEBPS/images/fig01.png')).toBe(false)
    expect(result.pkg.spine).toEqual(['c1', 'c3'])
    const navEntries = readNavToc(result.files.get('OEBPS/nav.xhtml') ?? '', codec)
    expect(navEntries.map((e) => e.href)).toEqual(['text/ch001.xhtml', 'text/ch003.xhtml'])
  })
})

describe('computeBatchSpineMove', () => {
  it('shifts non-contiguous chapters by 1 preserving relative spacing and is cleanly reversible', () => {
    const spine = ['ch1', 'ch2', 'ch3', 'ch4', 'ch5']
    const selected = new Set(['ch2', 'ch4'])

    expect(getBatchSpineMoveCapability(spine, selected)).toEqual({ canMoveUp: true, canMoveDown: true })

    const movedUp = computeBatchSpineMove(spine, selected, -1)
    expect(movedUp).toEqual(['ch2', 'ch1', 'ch4', 'ch3', 'ch5'])
    // Top selected item is now at index 0 -> cannot move up further without collapsing spacing.
    expect(getBatchSpineMoveCapability(movedUp!, selected)).toEqual({ canMoveUp: false, canMoveDown: true })
    expect(computeBatchSpineMove(movedUp!, selected, -1)).toBeNull()

    // Moving down restores the exact original order.
    const movedBack = computeBatchSpineMove(movedUp!, selected, 1)
    expect(movedBack).toEqual(spine)
  })

  it('shifts contiguous blocks cleanly and rejects non-spine selections', () => {
    const spine = ['ch1', 'ch2', 'ch3', 'ch4']
    expect(computeBatchSpineMove(spine, new Set(['ch2', 'ch3']), -1)).toEqual(['ch2', 'ch3', 'ch1', 'ch4'])
    expect(computeBatchSpineMove(spine, new Set(['ch2', 'ch3']), 1)).toEqual(['ch1', 'ch4', 'ch2', 'ch3'])
    expect(getBatchSpineMoveCapability(spine, new Set(['ch2', 'images/fig01.png']))).toEqual({
      canMoveUp: false,
      canMoveDown: false,
    })
  })
})
