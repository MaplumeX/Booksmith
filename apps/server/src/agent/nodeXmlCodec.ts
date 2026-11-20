import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import type { XmlCodec } from '@booksmith/core'

/**
 * Node XML codec and strict well-formedness checker backed by `@xmldom/xmldom`.
 * Used by server-side `AgentWorkspace` so malformed XHTML/OPF edits are rejected
 * immediately and returned to the model for self-correction.
 * See ADR 2026-11-20-builtin-epub-agent.
 */

export const nodeXmlCodec: XmlCodec = {
  parse: (xml) => new DOMParser().parseFromString(xml, 'application/xml') as unknown as Document,
  serialize: (node) => new XMLSerializer().serializeToString(node as never),
}

export function nodeCheckXml(xml: string): string | null {
  const errors: string[] = []
  try {
    const parser = new DOMParser({
      onError: (level, message) => {
        if (level === 'error' || level === 'fatalError') errors.push(String(message))
      },
    })
    const doc = parser.parseFromString(xml, 'application/xml') as unknown as Document
    if (errors.length > 0) return errors[0]!
    if (!doc.documentElement) return 'XML document has no root element'
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
