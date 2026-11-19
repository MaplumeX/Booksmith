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
export { dirname, relativePath, resolvePath, splitFragment } from './path'
export {
  CONTAINER_PATH,
  browserXmlParser,
  openEpub,
  parsePackage,
  readOpfPath,
  unpackEpub,
} from './unpack'
export { hasPageHistory, isTextEntry } from './text'
export { validateStructure } from './validate'
export { lintBook } from './lint'
export { buildSearchPattern, groupMatches, searchBook } from './search'
export { browserXmlCodec } from './xml'
export type { XmlCodec } from './xml'
export {
  addManifestItem,
  DC_NS as OPF_DC_NS,
  readOpfMeta,
  touchOpfModified,
  writeOpfMeta,
  writeOpfMetadata,
} from './opfWrite'
export type { ManifestItemDraft, MetadataDraft, OpfMetaRow } from './opfWrite'
export {
  addSpineDocument,
  removeManifestEntry,
  renameManifestEntry,
  reorderSpine,
  setManifestMediaType,
} from './opfEdit'
export { collectBrokenReferences, collectReferences, rewriteReferences } from './references'
export type { BookReference } from './references'
export { createEmptyEpub } from './create'
export type { NewBookOptions } from './create'
export {
  cloneToc,
  countTocEntries,
  findBrokenAnchors,
  flattenToc,
  indentTocEntry,
  insertTocEntry,
  moveTocEntry,
  outdentTocEntry,
  removeTocEntry,
  updateTocEntry,
} from './toc'
export type { BrokenAnchor, TocEntry, TocPath } from './toc'
export { readNavToc, writeNavToc } from './nav'
export { readNcxToc, writeNcxToc } from './ncx'
export type { SearchFile, SearchMatch, SearchOptions, SearchResult } from './search'
