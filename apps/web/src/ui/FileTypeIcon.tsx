import { FileCode2, FileText, Image, Package } from 'lucide-react'
import { extensionOf, type FileGroup } from '../state/bookStore'

interface FileTypeIconProps {
  path: string
  group?: FileGroup
  size?: number
  className?: string
}

/** Maps an EPUB archive path to a consistent 1.5px-stroke icon across tree, tabs, and menus. */
export function FileTypeIcon({ path, group, size = 14, className = '' }: FileTypeIconProps) {
  const ext = extensionOf(path)

  if (group === 'Images' || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) {
    return <Image size={size} strokeWidth={1.6} className={className} aria-hidden="true" />
  }
  if (group === 'Text' || ext === 'xhtml' || ext === 'html' || ext === 'htm') {
    return <FileText size={size} strokeWidth={1.6} className={className} aria-hidden="true" />
  }
  if (group === 'Styles' || ['css', 'xml', 'opf', 'ncx'].includes(ext)) {
    return <FileCode2 size={size} strokeWidth={1.6} className={className} aria-hidden="true" />
  }
  return <Package size={size} strokeWidth={1.6} className={className} aria-hidden="true" />
}
