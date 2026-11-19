export class InvalidEpubError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidEpubError'
  }
}

/** Raw archive contents, preserving zip entry order. */
export interface EpubArchive {
  order: string[]
  entries: Map<string, Uint8Array>
}

export interface ManifestItem {
  id: string
  href: string
  mediaType: string
  properties: string[]
  /** Absolute path inside the archive. */
  path: string
}

export interface PackageMetadata {
  title: string
  language: string
  identifier: string
  creators: string[]
  publisher: string
  date: string
  description: string
  subjects: string[]
  rights: string
}

export interface EpubPackage {
  version: string
  uniqueIdentifierId: string
  metadata: PackageMetadata
  manifest: ManifestItem[]
  spine: string[]
  opfPath: string
  navPath?: string
  ncxPath?: string
}

export interface EpubIssue {
  code: string
  message: string
  path?: string
  /** 1-based line inside `path`, when the issue points at a specific place. */
  line?: number
}

export type XmlDocumentParser = (xml: string) => Document
