export interface XmlCodec {
  parse(xml: string): Document
  serialize(node: Node): string
}

/** Browser implementation; tests pass an @xmldom/xmldom codec instead. */
export const browserXmlCodec: XmlCodec = {
  parse: (xml) => new DOMParser().parseFromString(xml, 'application/xml'),
  serialize: (doc) => new XMLSerializer().serializeToString(doc),
}
