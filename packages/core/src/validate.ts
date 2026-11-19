import type { EpubArchive, EpubIssue, EpubPackage } from './types'

export function validateStructure(archive: EpubArchive, pkg: EpubPackage): EpubIssue[] {
  const issues: EpubIssue[] = []
  const mimetype = archive.entries.get('mimetype')
  const mimetypeText = mimetype ? new TextDecoder().decode(mimetype) : ''

  if (mimetypeText !== 'application/epub+zip') {
    issues.push({ code: 'mimetype', message: 'mimetype 内容不是 application/epub+zip' })
  }
  if (archive.order[0] !== 'mimetype') {
    issues.push({ code: 'mimetype-order', message: 'mimetype 必须是第一个 zip 条目' })
  }
  if (!archive.entries.has('META-INF/container.xml')) {
    issues.push({ code: 'container', message: '缺少 META-INF/container.xml' })
  }
  if (!archive.entries.has(pkg.opfPath)) {
    issues.push({ code: 'opf-missing', message: `缺少 OPF：${pkg.opfPath}` })
  }

  for (const item of pkg.manifest) {
    if (!archive.entries.has(item.path)) {
      issues.push({ code: 'manifest-missing-file', message: `manifest 引用了不存在的文件：${item.href}`, path: item.path })
    }
  }

  const ids = new Set(pkg.manifest.map((item) => item.id))
  for (const idref of pkg.spine) {
    if (!ids.has(idref)) {
      issues.push({ code: 'spine-unknown-idref', message: `spine 引用了不存在的 id：${idref}` })
    }
  }

  if (pkg.version.startsWith('3') && !pkg.navPath) {
    issues.push({ code: 'nav-missing', message: 'EPUB 3 需要带 properties="nav" 的导航文档' })
  }
  if (pkg.version.startsWith('2') && !pkg.ncxPath) {
    issues.push({ code: 'ncx-missing', message: 'EPUB 2 需要 NCX 目录' })
  }

  return issues
}
