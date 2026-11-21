export interface SpecialCharItem {
  char: string
  label: string
  /** Optional short badge when the character is invisible or narrow (e.g. NBSP). */
  display?: string
}

export interface SpecialCharGroup {
  id: string
  label: string
  items: SpecialCharItem[]
}

/**
 * Curated CJK, editorial, and mathematical typography symbols for the CodeToolbar picker.
 * See ADR 2026-11-21-code-productivity-and-command-palette.
 */
export const SPECIAL_CHAR_GROUPS: SpecialCharGroup[] = [
  {
    id: 'cjk-punct',
    label: '中文与标点',
    items: [
      { char: '「', label: '左直角引号' },
      { char: '」', label: '右直角引号' },
      { char: '『', label: '左双直角引号' },
      { char: '』', label: '右双直角引号' },
      { char: '《', label: '左书名号' },
      { char: '》', label: '右书名号' },
      { char: '〈', label: '左单书名号' },
      { char: '〉', label: '右单书名号' },
      { char: '“', label: '中文左双引号' },
      { char: '”', label: '中文右双引号' },
      { char: '‘', label: '中文左单引号' },
      { char: '’', label: '中文右单引号' },
      { char: '·', label: '间隔号' },
      { char: '、', label: '顿号' },
      { char: '【', label: '左方头括号' },
      { char: '】', label: '右方头括号' },
    ],
  },
  {
    id: 'dash-space',
    label: '破折号与空白',
    items: [
      { char: '——', label: '中文破折号' },
      { char: '……', label: '中文省略号' },
      { char: '—', label: '全角破折号 (Em dash)' },
      { char: '–', label: '半角连接号 (En dash)' },
      { char: '…', label: '西文省略号' },
      { char: '\u00A0', label: '不间断空格 (NBSP)', display: 'NBSP' },
      { char: '\u3000', label: '全角空格', display: '全角' },
      { char: '\u2009', label: '细空格 (Thin space)', display: '细空' },
    ],
  },
  {
    id: 'editorial',
    label: '出版与注释',
    items: [
      { char: '©', label: '版权符号' },
      { char: '®', label: '注册商标' },
      { char: '™', label: '商标' },
      { char: '§', label: '章节符号' },
      { char: '¶', label: '段落符号' },
      { char: '†', label: '剑号注记' },
      { char: '‡', label: '双剑号注记' },
      { char: '※', label: '参考标记' },
      { char: '•', label: '项目符号' },
      { char: '°', label: '度数' },
      { char: '′', label: '分 / 撇号' },
      { char: '″', label: '秒 / 双撇号' },
    ],
  },
  {
    id: 'math',
    label: '数学与希腊',
    items: [
      { char: '×', label: '乘号' },
      { char: '÷', label: '除号' },
      { char: '±', label: '正负号' },
      { char: '≠', label: '不等于' },
      { char: '≈', label: '约等于' },
      { char: '≤', label: '小于等于' },
      { char: '≥', label: '大于等于' },
      { char: '∞', label: '无穷大' },
      { char: '→', label: '右箭头' },
      { char: '←', label: '左箭头' },
      { char: 'α', label: 'Alpha' },
      { char: 'β', label: 'Beta' },
      { char: 'γ', label: 'Gamma' },
      { char: 'Δ', label: 'Delta' },
      { char: 'π', label: 'Pi' },
      { char: 'Σ', label: 'Sigma' },
    ],
  },
]
