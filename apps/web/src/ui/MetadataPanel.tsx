import {
  browserXmlCodec,
  readOpfMeta,
  type MetadataDraft,
  type OpfMetaRow,
  type PackageMetadata,
} from '@booksmith/core'
import { Plus, RotateCcw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from './Button'

interface MetadataPanelProps {
  metadata: PackageMetadata
  /** The package document as it stands, so `<meta>` rows read from the current text. */
  opfXml: string
  /** Changes after a save or restore, which is when the rows should be re-read. */
  version: number
  onApply: (draft: MetadataDraft) => void
  onApplyMeta: (rows: OpfMetaRow[]) => void
}

interface DraftState {
  title: string
  creators: string
  language: string
  identifier: string
  publisher: string
  date: string
  description: string
  subjects: string
  rights: string
}

function toDraft(metadata: PackageMetadata): DraftState {
  return {
    title: metadata.title,
    creators: metadata.creators.join(', '),
    language: metadata.language,
    identifier: metadata.identifier,
    publisher: metadata.publisher,
    date: metadata.date,
    description: metadata.description,
    subjects: metadata.subjects.join(', '),
    rights: metadata.rights,
  }
}

function splitList(value: string): string[] {
  return value
    .split(/[,，;；]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

const FIELDS: Array<{ key: keyof DraftState; label: string; multiline?: boolean }> = [
  { key: 'title', label: '书名' },
  { key: 'creators', label: '作者（逗号分隔）' },
  { key: 'language', label: '语言' },
  { key: 'identifier', label: '标识符' },
  { key: 'publisher', label: '出版者' },
  { key: 'date', label: '日期' },
  { key: 'subjects', label: '主题（逗号分隔）' },
  { key: 'description', label: '简介', multiline: true },
  { key: 'rights', label: '版权' },
]

export function MetadataPanel({ metadata, opfXml, version, onApply, onApplyMeta }: MetadataPanelProps) {
  const [draft, setDraft] = useState<DraftState>(() => toDraft(metadata))
  const [rows, setRows] = useState<OpfMetaRow[]>(() => readOpfMeta(opfXml, browserXmlCodec))

  // The package document can change underneath us (reload, restore), so resync.
  useEffect(() => {
    setDraft(toDraft(metadata))
  }, [metadata])

  // Resync on a reload or a structural change, not on every keystroke: writing the OPF back on each
  // input would re-read the file and drop the half-filled row the user is typing into.
  useEffect(() => {
    setRows(readOpfMeta(opfXml, browserXmlCodec))
  }, [metadata, version])

  function applyRows(next: OpfMetaRow[]) {
    setRows(next)
    onApplyMeta(next)
  }

  function apply(next: DraftState) {
    setDraft(next)
    onApply({
      title: next.title.trim(),
      creators: splitList(next.creators),
      language: next.language.trim(),
      identifier: next.identifier.trim(),
      publisher: next.publisher.trim(),
      date: next.date.trim(),
      description: next.description.trim(),
      subjects: splitList(next.subjects),
      rights: next.rights.trim(),
    })
  }

  return (
    <div className="panel-form">
      <p className="panel-note">修改直接写入 OPF 并标脏，⌘S 保存后生效。</p>
      {FIELDS.map((field) => (
        <label key={field.key} className="panel-field">
          <span>{field.label}</span>
          {field.multiline ? (
            <textarea
              rows={4}
              value={draft[field.key]}
              onChange={(event) => apply({ ...draft, [field.key]: event.target.value })}
            />
          ) : (
            <input
              type="text"
              value={draft[field.key]}
              onChange={(event) => apply({ ...draft, [field.key]: event.target.value })}
            />
          )}
        </label>
      ))}
      <Button variant="ghost" size="sm" onClick={() => setDraft(toDraft(metadata))}>
        <RotateCcw size={13} strokeWidth={1.7} aria-hidden="true" />
        <span>还原未修改的值</span>
      </Button>

      <section className="meta-section">
        <h3 className="meta-section-label">
          <span>META</span>
          <span className="meta-count">{rows.length}</span>
        </h3>
        <p className="panel-note">
          `dcterms:modified` 在你改动 OPF 任意字段后自动更新；只改正文的保存不会动它。
        </p>
        <ul className="meta-rows">
          {rows.map((row, index) => (
            <li className="meta-row" key={index}>
              <div className="meta-row-head">
                <input
                  aria-label={`meta ${index + 1} property`}
                  value={row.property}
                  placeholder="property"
                  onChange={(event) => {
                    const next = [...rows]
                    next[index] = { ...row, property: event.target.value }
                    applyRows(next)
                  }}
                />
                <input
                  aria-label={`meta ${index + 1} refines`}
                  value={row.refines}
                  placeholder="#creator"
                  onChange={(event) => {
                    const next = [...rows]
                    next[index] = { ...row, refines: event.target.value }
                    applyRows(next)
                  }}
                />
                <button
                  type="button"
                  className="meta-remove"
                  aria-label={`删除 meta ${index + 1}`}
                  onClick={() => applyRows(rows.filter((_, at) => at !== index))}
                >
                  <X size={13} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </div>
              <input
                aria-label={`meta ${index + 1} 值`}
                value={row.value}
                placeholder="值"
                onChange={(event) => {
                  const next = [...rows]
                  next[index] = { ...row, value: event.target.value }
                  applyRows(next)
                }}
              />
            </li>
          ))}
        </ul>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => applyRows([...rows, { property: '', refines: '', value: '' }])}
        >
          <Plus size={13} strokeWidth={1.75} aria-hidden="true" />
          <span>加一行 meta</span>
        </Button>
      </section>
    </div>
  )
}
