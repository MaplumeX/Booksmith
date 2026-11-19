import { readFileSync } from 'node:fs'
import { DOMParser } from '@xmldom/xmldom'
import type { XmlDocumentParser } from '../src/types'

export const FIXTURE_NAME = '马克思经济学与数理分析.epub'

export function readFixture(): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`../../../fixtures/${FIXTURE_NAME}`, import.meta.url)))
}

export const nodeXmlParser: XmlDocumentParser = (xml) =>
  new DOMParser().parseFromString(xml, 'application/xml') as unknown as Document

/** Reads the compression method (0 = stored, 8 = deflate) of the first local file header. */
export function firstEntryCompression(zip: Uint8Array): number {
  if (zip[0] !== 0x50 || zip[1] !== 0x4b || zip[2] !== 0x03 || zip[3] !== 0x04) {
    throw new Error('not a local file header')
  }
  return new DataView(zip.buffer, zip.byteOffset, zip.byteLength).getUint16(8, true)
}

/** Reads the filename of the first local file header. */
export function firstEntryName(zip: Uint8Array): string {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  const nameLength = view.getUint16(26, true)
  return new TextDecoder().decode(zip.subarray(30, 30 + nameLength))
}
