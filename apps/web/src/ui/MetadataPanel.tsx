import type { MetadataDraft, PackageMetadata } from '@booksmith/core'
import { useEffect, useState } from 'react'
import { Button } from './Button'

interface MetadataPanelProps {
  metadata: PackageMetadata
  onApply: (draft: MetadataDraft) => void
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

export function MetadataPanel({ metadata, onApply }: MetadataPanelProps) {
  const [draft, setDraft] = useState<DraftState>(() => toDraft(metadata))

  // The package document can change underneath us (reload, restore), so resync.
  useEffect(() => {
    setDraft(toDraft(metadata))
  }, [metadata])

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
      <Button variant="ghost" onClick={() => setDraft(toDraft(metadata))}>
        还原未修改的值
      </Button>
    </div>
  )
}
