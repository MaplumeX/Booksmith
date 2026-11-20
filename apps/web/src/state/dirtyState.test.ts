import { describe, expect, it } from 'vitest'
import { computeDirtySummary, createSavedBaseline, setsEqual } from './dirtyState'

const encoder = new TextEncoder()

function seedWorkspace() {
  const texts = new Map<string, string>([
    ['EPUB/content.opf', '<package/>'],
    ['EPUB/text/ch001.xhtml', '<html>\r\n<body><p>原文</p></body>\r\n</html>\r\n'],
  ])
  const cover = new Uint8Array([1, 2, 3, 4])
  const entries = new Map<string, Uint8Array>([
    ['EPUB/content.opf', encoder.encode(texts.get('EPUB/content.opf')!)],
    ['EPUB/text/ch001.xhtml', encoder.encode(texts.get('EPUB/text/ch001.xhtml')!)],
    ['EPUB/media/cover.jpg', cover],
  ])
  return { texts, entries, baseline: createSavedBaseline(texts, entries) }
}

describe('dirtyState', () => {
  it('returns empty sets when workspace matches saved baseline', () => {
    const { baseline, texts, entries } = seedWorkspace()
    const summary = computeDirtySummary(baseline, texts, entries)
    expect(summary.all.size).toBe(0)
    expect(summary.texts.size).toBe(0)
    expect(summary.binaries.size).toBe(0)
    expect(summary.deleted.size).toBe(0)
  })

  it('tracks text edits and clears dirty when undone back to saved baseline', () => {
    const { baseline, texts, entries } = seedWorkspace()
    const original = texts.get('EPUB/text/ch001.xhtml')!

    texts.set('EPUB/text/ch001.xhtml', '<html>\r\n<body><p>已改</p></body>\r\n</html>\r\n')
    const dirty = computeDirtySummary(baseline, texts, entries)
    expect([...dirty.all]).toEqual(['EPUB/text/ch001.xhtml'])
    expect([...dirty.texts]).toEqual(['EPUB/text/ch001.xhtml'])

    texts.set('EPUB/text/ch001.xhtml', original)
    const clean = computeDirtySummary(baseline, texts, entries)
    expect(clean.all.size).toBe(0)
    expect(clean.texts.size).toBe(0)
  })

  it('preserves edits made while an in-flight save only advances the uploaded snapshot', () => {
    const { baseline, texts, entries } = seedWorkspace()

    // Snapshot v1 edit uploaded to server
    texts.set('EPUB/text/ch001.xhtml', '<html>\r\n<body><p>第一次修改</p></body>\r\n</html>\r\n')
    const uploadedTexts = new Map(texts)
    const uploadedEntries = new Map(entries)
    uploadedEntries.set('EPUB/text/ch001.xhtml', encoder.encode(uploadedTexts.get('EPUB/text/ch001.xhtml')!))

    // User keeps typing while save request is in flight
    texts.set('EPUB/text/ch001.xhtml', '<html>\r\n<body><p>第一次修改 + 在途输入</p></body>\r\n</html>\r\n')

    // Save completes: baseline advances only to uploaded snapshot
    const nextBaseline = createSavedBaseline(uploadedTexts, uploadedEntries)
    const remaining = computeDirtySummary(nextBaseline, texts, entries)
    expect([...remaining.all]).toEqual(['EPUB/text/ch001.xhtml'])
    expect([...remaining.texts]).toEqual(['EPUB/text/ch001.xhtml'])
    // Old baseline is unaffected
    expect(baseline.texts.get('EPUB/text/ch001.xhtml')).toContain('原文')
  })

  it('marks replaced binary asset dirty without polluting OPF', () => {
    const { baseline, texts, entries } = seedWorkspace()

    // Identical bytes copy stays clean
    entries.set('EPUB/media/cover.jpg', new Uint8Array([1, 2, 3, 4]))
    expect(computeDirtySummary(baseline, texts, entries).all.size).toBe(0)

    // Replaced bytes marks only the binary path dirty, leaving OPF clean
    entries.set('EPUB/media/cover.jpg', new Uint8Array([9, 8, 7]))
    const summary = computeDirtySummary(baseline, texts, entries)
    expect([...summary.all]).toEqual(['EPUB/media/cover.jpg'])
    expect([...summary.binaries]).toEqual(['EPUB/media/cover.jpg'])
    expect(summary.texts.has('EPUB/content.opf')).toBe(false)
  })

  it('tracks newly added and deleted entries accurately', () => {
    const { baseline, texts, entries } = seedWorkspace()

    // Deleting an entry removes it from texts/entries but keeps it in deleted + all
    entries.delete('EPUB/media/cover.jpg')
    const afterDelete = computeDirtySummary(baseline, texts, entries)
    expect([...afterDelete.deleted]).toEqual(['EPUB/media/cover.jpg'])
    expect([...afterDelete.all]).toEqual(['EPUB/media/cover.jpg'])

    // Creating a chapter and deleting it before save leaves no ghost dirty flag
    texts.set('EPUB/text/ch002.xhtml', '<html/>')
    entries.set('EPUB/text/ch002.xhtml', encoder.encode('<html/>'))
    expect(computeDirtySummary(baseline, texts, entries).texts.has('EPUB/text/ch002.xhtml')).toBe(true)

    texts.delete('EPUB/text/ch002.xhtml')
    entries.delete('EPUB/text/ch002.xhtml')
    const afterCancel = computeDirtySummary(baseline, texts, entries)
    expect(afterCancel.texts.has('EPUB/text/ch002.xhtml')).toBe(false)
    expect(afterCancel.deleted.has('EPUB/text/ch002.xhtml')).toBe(false)
  })

  it('compares dirty sets for reference stability', () => {
    expect(setsEqual(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true)
    expect(setsEqual(new Set(['a']), new Set(['a', 'b']))).toBe(false)
    expect(setsEqual(new Set(['a']), new Set(['b']))).toBe(false)
  })
})
