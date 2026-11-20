import {
  browserXmlCodec,
  dirname,
  listDocumentAnchors,
  relativePath,
  resolvePath,
  splitFragment,
  type DocumentAnchor,
} from '@booksmith/core'
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from './Button'
import { Dialog } from './Dialog'

export interface TocLinkDialogProps {
  open: boolean
  mode: 'add' | 'edit'
  subtitle?: string
  initialLabel: string
  initialHref: string
  tocPath: string
  files: string[]
  texts: ReadonlyMap<string, string>
  suggestTitle: (hrefOrPath: string) => string
  onOpenChange: (open: boolean) => void
  onSubmit: (result: { label: string; href: string }) => void
}

function splitInitialHref(href: string): { file: string; fragment: string } {
  const { path, fragment } = splitFragment(href.trim())
  let decoded = fragment
  try {
    decoded = decodeURIComponent(fragment)
  } catch {
    decoded = fragment
  }
  return { file: path, fragment: decoded }
}

export function TocLinkDialog({
  open,
  mode,
  subtitle,
  initialLabel,
  initialHref,
  tocPath,
  files,
  texts,
  suggestTitle,
  onOpenChange,
  onSubmit,
}: TocLinkDialogProps) {
  const [label, setLabel] = useState(initialLabel)
  const [fileHref, setFileHref] = useState('')
  const [fragment, setFragment] = useState('')

  useEffect(() => {
    if (!open) return
    const parsed = splitInitialHref(initialHref)
    setLabel(initialLabel)
    setFileHref(parsed.file)
    setFragment(parsed.fragment)
  }, [open, initialLabel, initialHref])

  const tocDir = dirname(tocPath)
  const fileOptions = useMemo(() => files.map((file) => relativePath(tocDir, file)), [files, tocDir])

  const resolvedFile = useMemo(() => {
    const clean = fileHref.trim()
    if (!clean) return ''
    return resolvePath(tocDir, clean)
  }, [fileHref, tocDir])

  const targetText = resolvedFile ? texts.get(resolvedFile) : undefined

  const anchors = useMemo<DocumentAnchor[]>(() => {
    if (!targetText) return []
    return listDocumentAnchors(targetText, browserXmlCodec)
  }, [targetText])

  const validation = useMemo(() => {
    const cleanFile = fileHref.trim()
    if (!cleanFile) return null
    if (targetText === undefined) {
      return { kind: 'warn' as const, text: `找不到目标文件：${resolvedFile}` }
    }
    const cleanFrag = fragment.trim()
    if (!cleanFrag) {
      return { kind: 'ok' as const, text: '指向章节开头（目标有效）' }
    }
    const found = anchors.some((anchor) => anchor.id === cleanFrag)
    if (!found) {
      return { kind: 'warn' as const, text: `该章节中未找到锚点 #${cleanFrag}` }
    }
    return { kind: 'ok' as const, text: `锚点 #${cleanFrag} 有效` }
  }, [fileHref, fragment, targetText, resolvedFile, anchors])

  const composedHref = useMemo(() => {
    const cleanFile = fileHref.trim()
    if (!cleanFile) return ''
    const cleanFrag = fragment.trim()
    return cleanFrag ? `${cleanFile}#${encodeURIComponent(cleanFrag)}` : cleanFile
  }, [fileHref, fragment])

  function handleFileChange(value: string) {
    // Allow pasting full `file.xhtml#anchor` directly into the file input.
    if (value.includes('#')) {
      const parsed = splitInitialHref(value)
      setFileHref(parsed.file)
      setFragment(parsed.fragment)
      if (!label.trim() && parsed.file) setLabel(suggestTitle(parsed.file))
      return
    }
    setFileHref(value)
    if (!label.trim() && value.trim()) {
      setLabel(suggestTitle(value.trim()))
    }
  }

  function handleAnchorSelect(nextId: string) {
    setFragment(nextId)
    if (!label.trim() && nextId) {
      const matched = anchors.find((item) => item.id === nextId)
      if (matched?.label) setLabel(matched.label)
    }
  }

  function fillTitleFromTarget() {
    const cleanFrag = fragment.trim()
    if (cleanFrag) {
      const matched = anchors.find((item) => item.id === cleanFrag)
      if (matched?.label) {
        setLabel(matched.label)
        return
      }
    }
    if (fileHref.trim()) {
      setLabel(suggestTitle(fileHref.trim()))
    }
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const cleanLabel = label.trim()
    if (!cleanLabel || !composedHref) return
    onSubmit({ label: cleanLabel, href: composedHref })
    onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={mode === 'add' ? '新增目录条目' : '编辑目录条目'}
      description={subtitle}
      className="toc-link-dialog"
      onSubmit={handleSubmit}
      footer={
        <>
          <Button variant="ghost" size="sm" type="button" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="primary" size="sm" type="submit" disabled={!label.trim() || !composedHref}>
            {mode === 'add' ? '添加' : '保存修改'}
          </Button>
        </>
      }
    >
      <div className="toc-dialog-fields">
        <label className="panel-field">
          <span>目标文件</span>
          <input
            autoFocus
            list="toc-link-files"
            value={fileHref}
            placeholder="例如 text/ch003.xhtml"
            onChange={(event) => handleFileChange(event.target.value)}
          />
          <datalist id="toc-link-files">
            {fileOptions.map((option) => (
              <option key={option} value={option} />
            ))}
          </datalist>
        </label>

        <div className="toc-anchor-row">
          <label className="panel-field">
            <span>章内锚点（可选）</span>
            <select
              aria-label="选择章内锚点"
              value={anchors.some((a) => a.id === fragment) ? fragment : '__custom__'}
              disabled={targetText === undefined}
              onChange={(event) => {
                const val = event.target.value
                if (val !== '__custom__') handleAnchorSelect(val)
              }}
            >
              <option value="">（章节开头）</option>
              {anchors.map((anchor) => (
                <option key={anchor.id} value={anchor.id}>
                  #{anchor.id}
                  {anchor.label ? ` — ${anchor.label.slice(0, 32)}` : ` (${anchor.tag})`}
                </option>
              ))}
              {fragment && !anchors.some((a) => a.id === fragment) ? (
                <option value="__custom__">自定义：#{fragment}</option>
              ) : null}
            </select>
          </label>
          <label className="panel-field">
            <span>锚点 ID</span>
            <input
              value={fragment}
              placeholder="留空指章首"
              onChange={(event) => setFragment(event.target.value.replace(/^#/, ''))}
            />
          </label>
        </div>

        {validation ? (
          <p className={`toc-link-status is-${validation.kind}`} role="status">
            {validation.kind === 'ok' ? (
              <CheckCircle2 size={13} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <AlertTriangle size={13} strokeWidth={1.75} aria-hidden="true" />
            )}
            <span>{validation.text}</span>
          </p>
        ) : null}

        <div className="toc-title-field">
          <label className="panel-field">
            <span>标题</span>
            <input
              value={label}
              placeholder="显示在目录里的章节标题"
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            className="toc-title-suggest-btn"
            disabled={!fileHref.trim()}
            title="从目标章节或锚点读取标题"
            onClick={fillTitleFromTarget}
          >
            <RefreshCw size={12} strokeWidth={1.75} aria-hidden="true" />
            <span>读取标题</span>
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
