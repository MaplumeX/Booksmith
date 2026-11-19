export { CORE_VERSION } from './version'
export { InvalidEpubError } from './types'
export type {
  EpubArchive,
  EpubIssue,
  EpubPackage,
  ManifestItem,
  PackageMetadata,
  XmlDocumentParser,
} from './types'
export { unzipArchive, zipArchive, textOf } from './zip'
export { dirname, resolvePath, splitFragment } from './path'
export {
  CONTAINER_PATH,
  browserXmlParser,
  openEpub,
  parsePackage,
  readOpfPath,
  unpackEpub,
} from './unpack'
export { validateStructure } from './validate'
export { buildSearchPattern, groupMatches, searchBook } from './search'
export { browserXmlCodec } from './xml'
export type { XmlCodec } from './xml'
export { addManifestItem, DC_NS as OPF_DC_NS, writeOpfMetadata } from './opfWrite'
export type { ManifestItemDraft, MetadataDraft } from './opfWrite'
export { createEmptyEpub } from './create'
export type { NewBookOptions } from './create'
export { cloneToc, countTocEntries, findBrokenAnchors, flattenToc } from './toc'
export type { BrokenAnchor, TocEntry } from './toc'
export { readNavToc, writeNavToc } from './nav'
export { readNcxToc, writeNcxToc } from './ncx'
export type { SearchFile, SearchMatch, SearchOptions, SearchResult } from './search'
