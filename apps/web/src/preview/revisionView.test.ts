import { describe, expect, it } from 'vitest'
import { buildFileHunks } from '../state/proposalReview'
import { buildRevisionStyleCss, buildRevisionXhtml } from './revisionView'

describe('revisionView XHTML annotator', () => {
  it('renders inline character-level del/ins inside matching paragraphs and preserves inline tags', () => {
    const before = [
      '<html xmlns="http://www.w3.org/1999/xhtml">',
      '<head><title>第一章</title></head>',
      '<body>',
      '<p>马克思在<em>《资本论》</em>中指出错字。</p>',
      '<p>第二段保持原样。</p>',
      '</body>',
      '</html>',
    ].join('\n')
    const after = [
      '<html xmlns="http://www.w3.org/1999/xhtml">',
      '<head><title>第一章</title></head>',
      '<body>',
      '<p>马克思在<em>《资本论》</em>中指出正字。</p>',
      '<p>第二段保持原样。</p>',
      '</body>',
      '</html>',
    ].join('\n')

    const model = buildFileHunks({
      path: 'EPUB/text/ch001.xhtml',
      kind: 'update',
      beforeText: before,
      afterText: after,
    })
    const res = buildRevisionXhtml({ model, allowHunkToggle: true, activeHunkId: 'hunk-0' })

    expect(res.headHunkIds).toEqual([])
    expect(res.hunkLocations.get('hunk-0')).toBe('body')
    expect(res.xhtml).toContain('<em>《资本论》</em>')
    expect(res.xhtml).toContain('<del class="bs-rev-del">错</del><ins class="bs-rev-ins">正</ins>')
    expect(res.xhtml).toContain('data-bs-hunk="hunk-0"')
    expect(res.xhtml).toContain('data-bs-active="true"')
    expect(res.xhtml).toContain('data-bs-action="toggle-hunk"')
  })

  it('reverts skipped hunks to original prose with a restore pill', () => {
    const before = '<html><body>\n<p>原句甲</p>\n<p>原句乙</p>\n</body></html>'
    const after = '<html><body>\n<p>改句甲</p>\n<p>改句乙</p>\n</body></html>'
    const model = buildFileHunks({ path: 'ch001.xhtml', kind: 'update', beforeText: before, afterText: after })
    const res = buildRevisionXhtml({
      model,
      skippedHunkIds: new Set(['hunk-0']),
      allowHunkToggle: true,
    })

    expect(res.xhtml).toContain('原句甲')
    expect(res.xhtml).toContain('恢复保留')
    expect(res.xhtml).not.toContain('改句甲')
  })

  it('protects MathML islands with clean before/after comparison blocks', () => {
    const before = '<html><body>\n<p>公式 <math><mi>x</mi></math> 成立。</p>\n</body></html>'
    const after = '<html><body>\n<p>公式 <math><mi>y</mi></math> 成立。</p>\n</body></html>'
    const model = buildFileHunks({ path: 'ch001.xhtml', kind: 'update', beforeText: before, afterText: after })
    const res = buildRevisionXhtml({ model, allowHunkToggle: true })

    expect(res.xhtml).toContain('bs-rev-compare-before')
    expect(res.xhtml).toContain('bs-rev-compare-after')
    expect(res.xhtml).toContain('<math><mi>x</mi></math>')
    expect(res.xhtml).toContain('<math><mi>y</mi></math>')
    expect(res.xhtml).toContain('公式/媒体结构变更')
  })

  it('marks pure attribute/class changes and tracks head-only hunks separately', () => {
    const before = [
      '<html>',
      '<head><title>旧标题</title></head>',
      '<body>',
      '<p class="normal">正文文字没变</p>',
      '</body>',
      '</html>',
    ].join('\n')
    const after = [
      '<html>',
      '<head><title>新标题</title></head>',
      '<body>',
      '<p class="lead">正文文字没变</p>',
      '</body>',
      '</html>',
    ].join('\n')

    const model = buildFileHunks({ path: 'ch001.xhtml', kind: 'update', beforeText: before, afterText: after })
    const res = buildRevisionXhtml({ model, allowHunkToggle: true })

    expect(res.headHunkIds).toEqual(['hunk-0'])
    expect(res.hunkLocations.get('hunk-0')).toBe('head')
    expect(res.hunkLocations.get('hunk-1')).toBe('body')
    expect(res.xhtml).toContain('data-bs-rev="attr"')
    expect(res.xhtml).toContain('标签/样式变更')
  })

  it('wraps created chapters and handles single-line XHTML documents', () => {
    const createdModel = buildFileHunks({
      path: 'EPUB/text/afterword.xhtml',
      kind: 'create',
      afterText: '<html><body><h1>后记</h1><p>新增内容</p></body></html>',
    })
    const createdRes = buildRevisionXhtml({ model: createdModel, allowHunkToggle: false })
    expect(createdRes.xhtml).toContain('+ 新增章节')
    expect(createdRes.xhtml).not.toContain('data-bs-action="toggle-hunk"')

    const singleLineModel = buildFileHunks({
      path: 'EPUB/text/ch001.xhtml',
      kind: 'update',
      beforeText: '<html><head><title>A</title></head><body><p>未保存测试错字</p></body></html>',
      afterText: '<html><head><title>A</title></head><body><p>已校对正确文本</p></body></html>',
    })
    const singleRes = buildRevisionXhtml({ model: singleLineModel, allowHunkToggle: true })
    expect(singleRes.xhtml).toContain('<del class="bs-rev-del">')
    expect(singleRes.xhtml).toContain('<ins class="bs-rev-ins">')
  })

  it('emits distinct light and dark revision styles aligned with Soft Craft tokens', () => {
    const lightCss = buildRevisionStyleCss('light')
    const darkCss = buildRevisionStyleCss('dark')
    expect(lightCss).toContain('#e6f2e8')
    expect(lightCss).toContain('max-width: 760px')
    expect(darkCss).toContain('#16301f')
    expect(darkCss).toContain('#1a1b24')
  })
})
