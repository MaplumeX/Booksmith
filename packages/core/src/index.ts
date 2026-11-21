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
  insertSpineDocumentsAfter,
  removeManifestEntry,
  renameManifestEntry,
  reorderSpine,
  setManifestMediaType,
  setSpineToc,
} from './opfEdit'
export {
  collectBrokenReferences,
  collectDocumentIds,
  collectReferences,
  rewriteAnchorReferences,
  rewriteReferences,
} from './references'
export type { AnchorRewriteOptions, BookReference, WholeFileMove } from './references'
export {
  SPLIT_MARKER_CLASS,
  SPLIT_MARKER_HTML,
  countSplitMarkers,
  detectDominantEol,
  extractBodyBounds,
  findSplitMarkerLines,
  nextSplitChapterPath,
  splitChapterAtMarkersInBook,
  splitChapterByHeadingLevelInBook,
  splitChapterInBook,
  splitXhtmlAtMarkers,
  splitXhtmlAtOffset,
  splitXhtmlByHeadingLevel,
} from './chapterSplit'
export type { BodyBounds, SplitChapterResult } from './chapterSplit'
export { duplicateChapterInBook, mergeChaptersInBook } from './chapterMerge'
export type { DuplicateChapterResult, MergeChaptersResult } from './chapterMerge'
export {
  createBlankStylesheet,
  deleteUnusedResourcesInBook,
  findUnusedResources,
  getLinkedStylesheets,
  listBookStylesheets,
  setChapterStylesheets,
  updateChaptersStylesheets,
} from './stylesheets'
export type {
  CreateStylesheetResult,
  DeleteUnusedResourcesResult,
  UnusedResource,
  UnusedResourceCategory,
  UpdateChaptersStylesheetsOptions,
} from './stylesheets'
export { formatCss, formatXhtml } from './formatCode'
export { createEmptyEpub } from './create'
export type { NewBookOptions } from './create'
export {
  cloneToc,
  compareTocPaths,
  countTocEntries,
  findBrokenAnchors,
  flattenToc,
  getTocEntry,
  indentTocEntries,
  indentTocEntry,
  insertTocEntry,
  isSameOrDescendantTocPath,
  moveTocEntries,
  moveTocEntry,
  moveTocSubtree,
  normalizeTocPaths,
  outdentTocEntries,
  outdentTocEntry,
  rebaseTocHrefs,
  removeBrokenTocEntries,
  removeTocEntries,
  removeTocEntry,
  updateTocEntry,
} from './toc'
export type { BrokenAnchor, TocEntry, TocInsertPosition, TocPath } from './toc'
export { initializeBookToc } from './tocInit'
export type { InitializeBookTocResult } from './tocInit'
export {
  generateTocFromHeadings,
  listDocumentAnchors,
  refreshTocLabelsFromHeadings,
  scanBookHeadings,
} from './tocGenerate'
export type {
  DocumentAnchor,
  GeneratedTocCandidate,
  GenerateTocOptions,
  GenerateTocResult,
  RefreshTocLabelsOptions,
  RefreshTocLabelsResult,
  ScanHeadingsOptions,
  ScannedHeading,
} from './tocGenerate'
export { readNavToc, writeNavToc } from './nav'
export { readNcxToc, writeNcxToc } from './ncx'
export type { SearchFile, SearchMatch, SearchOptions, SearchResult } from './search'
export {
  AGENT_READ_ONLY_TOOL_NAMES,
  AGENT_TOOL_NAMES,
  AgentWorkspace,
  diffProposalSnapshots,
  isReadOnlyAgentTool,
} from './agentTools'
export type {
  AgentProposal,
  AgentProposalDelta,
  AgentProposalFile,
  AgentToolName,
  AgentToolResult,
  AgentWorkspaceOptions,
  AgentWorkspaceOverlay,
} from './agentTools'
