import { readNavToc } from './nav'
import { collectBrokenReferences, collectReferences } from './references'
import { findBrokenAnchors } from './toc'
import { validateStructure } from './validate'
import type { EpubArchive, EpubIssue, EpubPackage } from './types'
import type { XmlCodec } from './xml'

/**
 * Everything the editor can say about the book's structure without leaving the browser.
 * `validateStructure` is the server's save-time gate; the rest is what hand-editing breaks most.
 * See ADR 2026-11-19-structure-check-panel.
 */

const RESOURCE_TYPES = /^(image\/|font\/|application\/(?:font|vnd\.ms-opentype|x-font))/

function lineOf(text: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === '\n') line += 1
  }
  return line
}

function unusedResources(
  files: Map<string, string>,
  pkg: EpubPackage,
  archive: EpubArchive,
): EpubIssue[] {
  // The OPF's manifest *declares* entries with `href`, which is not a reference to them. Counting it
  // would mark every resource as referenced and make this check useless.
  const referenced = new Set(
    collectReferences(files)
      .filter((reference) => reference.from !== pkg.opfPath)
      .map((reference) => reference.targetPath),
  )
  const inSpine = new Set(
    pkg.spine
      .map((id) => pkg.manifest.find((item) => item.id === id)?.path)
      .filter((path): path is string => typeof path === 'string'),
  )

  const issues: EpubIssue[] = []
  for (const item of pkg.manifest) {
    if (!RESOURCE_TYPES.test(item.mediaType)) continue
    if (!archive.entries.has(item.path)) continue
    if (inSpine.has(item.path) || referenced.has(item.path)) continue
    // Worded as "not found a reference", not "unused": a stylesheet or script can build a path
    // the scanner cannot see, and a wrong accusation costs more than a missed warning.
    issues.push({
      code: 'unused-resource',
      message: `没找到对这个资源的引用：${item.href}`,
      path: item.path,
    })
  }
  return issues
}

export function lintBook(
  files: Map<string, string>,
  pkg: EpubPackage,
  archive: EpubArchive,
  codec: XmlCodec,
): EpubIssue[] {
  const issues = validateStructure(archive, pkg)

  // A missing manifest target is already `manifest-missing-file`; reporting it twice is noise.
  const broken = collectBrokenReferences(files, new Set(archive.entries.keys())).filter(
    (reference) => reference.from !== pkg.opfPath,
  )
  for (const reference of broken) {
    issues.push({
      code: 'broken-reference',
      message: `引用的文件不存在：${reference.raw}`,
      path: reference.from,
      line: lineOf(files.get(reference.from) ?? '', reference.offset),
    })
  }

  if (pkg.spine.length === 0) {
    issues.push({ code: 'empty-spine', message: '阅读顺序是空的，这本书没有正文入口' })
  }

  issues.push(...unusedResources(files, pkg, archive))

  if (pkg.navPath) {
    const navXml = files.get(pkg.navPath)
    if (navXml) {
      try {
        const entries = readNavToc(navXml, codec)
        for (const broken of findBrokenAnchors(entries, pkg.navPath, files)) {
          issues.push({
            code: 'broken-anchor',
            message: `目录项「${broken.label}」找不到目标：${broken.href}`,
            path: pkg.navPath,
          })
        }
      } catch {
        issues.push({ code: 'nav-unreadable', message: 'nav 文档无法解析', path: pkg.navPath })
      }
    }
  }

  return issues
}
