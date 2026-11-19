import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { xml } from '@codemirror/lang-xml'
import type { Extension } from '@codemirror/state'
import { extensionOf } from '../state/bookStore'

export function languageFor(path: string): Extension {
  switch (extensionOf(path)) {
    case 'xhtml':
    case 'html':
    case 'htm':
      return html()
    case 'css':
      return css()
    case 'opf':
    case 'ncx':
    case 'xml':
    case 'svg':
      return xml()
    default:
      return []
  }
}
