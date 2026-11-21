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
    expect(res.xhtml).toContain('data-bs-action="accept-hunk"')
    expect(res.xhtml).toContain('data-bs-action="reject-hunk"')
  })

  it('collapses accepted hunks in-place into clean prose and reverts rejected hunks to original prose', () => {
    const before = [
      '<html><body>',
      '<p>原句甲</p>',
      '<p>不变段</p>',
      '<p>原句乙</p>',
      '</body></html>',
    ].join('\n')
    const after = [
      '<html><body>',
      '<p>改句甲</p>',
      '<p>不变段</p>',
      '<p>改句乙</p>',
      '</body></html>',
    ].join('\n')
    const model = buildFileHunks({ path: 'ch001.xhtml', kind: 'update', beforeText: before, afterText: after })
    const res = buildRevisionXhtml({
      model,
      decisions: { 'hunk-0': 'accepted', 'hunk-1': 'rejected' },
      allowHunkToggle: true,
    })

    // Accepted hunk-0 renders clean final prose without <del>/<ins> highlights, plus undo button.
    expect(res.xhtml).toContain('data-bs-rev="accepted"')
    expect(res.xhtml).toContain('改句甲')
    expect(res.xhtml).not.toContain('原句甲')
    expect(res.xhtml).not.toContain('<del class="bs-rev-del">')
    expect(res.xhtml).not.toContain('<ins class="bs-rev-ins">')
    expect(res.xhtml).toContain('已保留')
    expect(res.xhtml).toContain('data-bs-action="reset-hunk"')

    // Rejected hunk-1 reverts to original prose with restore button.
    expect(res.xhtml).toContain('data-bs-rev="rejected"')
    expect(res.xhtml).toContain('原句乙')
    expect(res.xhtml).not.toContain('改句乙')
    expect(res.xhtml).toContain('已拒绝')
    expect(res.xhtml).toContain('恢复')
  })

  it('protects MathML islands with clean before/after comparison blocks and collapses cleanly when accepted', () => {
    const before = '<html><body>\n<p>公式 <math><mi>x</mi></math> 成立。</p>\n</body></html>'
    const after = '<html><body>\n<p>公式 <math><mi>y</mi></math> 成立。</p>\n</body></html>'
    const model = buildFileHunks({ path: 'ch001.xhtml', kind: 'update', beforeText: before, afterText: after })
    const res = buildRevisionXhtml({ model, allowHunkToggle: true })

    expect(res.xhtml).toContain('bs-rev-compare-before')
    expect(res.xhtml).toContain('bs-rev-compare-after')
    expect(res.xhtml).toContain('<math><mi>x</mi></math>')
    expect(res.xhtml).toContain('<math><mi>y</mi></math>')
    expect(res.xhtml).toContain('公式/媒体结构变更')

    const accepted = buildRevisionXhtml({
      model,
      decisions: { 'hunk-0': 'accepted' },
      allowHunkToggle: true,
    })
    expect(accepted.xhtml).toContain('<math><mi>y</mi></math>')
    expect(accepted.xhtml).not.toContain('bs-rev-compare-before')
    expect(accepted.xhtml).toContain('is-accepted')
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
    expect(res.xhtml).toContain('标签/样式变更 (class)')
    expect(res.xhtml).toContain('data-bs-action="toggle-diff"')
  })

  it('diffs text edits inside nested blockquotes in-place instead of degrading to stacked comparison blocks', () => {
    const before = [
      '<html><body>',
      '<blockquote>',
      '<p>引文第一段保持不变。</p>',
      '<p>引文第二段存在错字。</p>',
      '</blockquote>',
      '</body></html>',
    ].join('\n')
    const after = [
      '<html><body>',
      '<blockquote>',
      '<p>引文第一段保持不变。</p>',
      '<p>引文第二段存在正字。</p>',
      '</blockquote>',
      '</body></html>',
    ].join('\n')

    const model = buildFileHunks({ path: 'ch001.xhtml', kind: 'update', beforeText: before, afterText: after })
    const res = buildRevisionXhtml({ model, allowHunkToggle: true })

    expect(res.xhtml).toContain('<del class="bs-rev-del">错</del><ins class="bs-rev-ins">正</ins>')
    expect(res.xhtml).not.toContain('bs-rev-compare-before')
    expect(res.xhtml).not.toContain('段落结构变更')
    expect(res.xhtml).not.toContain('跨行标签变更')
  })

  it('renders single-line blockquote wrapper edits with recursive in-place diff when outer blockquote is in hunk', () => {
    const before = '<html><body>\n<blockquote><p>引用旧词说明</p></blockquote>\n</body></html>'
    const after = '<html><body>\n<blockquote><p>引用新词说明</p></blockquote>\n</body></html>'
    const model = buildFileHunks({ path: 'ch001.xhtml', kind: 'update', beforeText: before, afterText: after })
    const res = buildRevisionXhtml({ model, allowHunkToggle: true })

    expect(res.xhtml).toContain('<del class="bs-rev-del">旧</del><ins class="bs-rev-ins">新</ins>')
    expect(res.xhtml).not.toContain('bs-rev-compare-before')
  })

  it('renders semantic blockquote wrap/unwrap comparisons with unchanged-text note, char highlights, and inline mini-diff', () => {
    const before = [
      '<html><body>',
      '<p>马克思指出，商品首先是外界的一个对象。</p>',
      '<p>第二段继续阐述使用价值。</p>',
      '</body></html>',
    ].join('\n')
    const after = [
      '<html><body>',
      '<blockquote>',
      '<p>马克思指出，商品首先是外界的一个对象。</p>',
      '<p>第二段继续阐述使用价值。</p>',
      '</blockquote>',
      '</body></html>',
    ].join('\n')

    const model = buildFileHunks({ path: 'EPUB/text/ch001.xhtml', kind: 'update', beforeText: before, afterText: after })
    expect(model.hunks).toHaveLength(1)

    const collapsed = buildRevisionXhtml({ model, allowHunkToggle: true })
    expect(collapsed.xhtml).toContain('包裹为引用 (p×2 → blockquote)')
    expect(collapsed.xhtml).toContain('文字未变 · 仅结构/标签调整')
    expect(collapsed.xhtml).toContain('标签对比')
    expect(collapsed.xhtml).not.toContain('跨行标签变更')
    expect(collapsed.xhtml).not.toContain('bs-rev-minidiff')

    const expanded = buildRevisionXhtml({
      model,
      allowHunkToggle: true,
      expandedDiffHunkIds: new Set(['hunk-0']),
    })
    expect(expanded.xhtml).toContain('收起对比')
    expect(expanded.xhtml).toContain('bs-rev-minidiff')
    expect(expanded.xhtml).toContain('&lt;blockquote&gt;')

    // When both structure and prose change, before/after panels highlight exact text deltas.
    const textChangedAfter = [
      '<html><body>',
      '<blockquote>',
      '<p>马克思指出，商品首先是外界的物品。</p>',
      '<p>第二段继续阐述使用价值。</p>',
      '</blockquote>',
      '</body></html>',
    ].join('\n')
    const textChangedModel = buildFileHunks({
      path: 'EPUB/text/ch001.xhtml',
      kind: 'update',
      beforeText: before,
      afterText: textChangedAfter,
    })
    const textChangedRes = buildRevisionXhtml({ model: textChangedModel, allowHunkToggle: true })
    expect(textChangedRes.xhtml).toContain('包裹为引用')
    expect(textChangedRes.xhtml).not.toContain('文字未变')
    expect(textChangedRes.xhtml).toContain('<del class="bs-rev-del">一个对象</del>')
    expect(textChangedRes.xhtml).toContain('<ins class="bs-rev-ins">物品</ins>')
  })

  it('highlights inline formatting additions in place and renders merge-seam and giant-span tags clearly', () => {
    const fmtBefore = '<html><body>\n<p>这是一段很长的正文，重点在这里。</p>\n</body></html>'
    const fmtAfter = '<html><body>\n<p>这是一段很长的正文，<strong>重点</strong>在这里。</p>\n</body></html>'
    const fmtModel = buildFileHunks({ path: 'ch001.xhtml', kind: 'update', beforeText: fmtBefore, afterText: fmtAfter })
    const fmtRes = buildRevisionXhtml({ model: fmtModel, allowHunkToggle: true })
    expect(fmtRes.xhtml).toContain('bs-rev-fmt-changed')
    expect(fmtRes.xhtml).toContain('行内格式变更 (+strong)')
    expect(fmtRes.xhtml).not.toContain('bs-rev-compare-before')

    // Adjacent blockquote merge seam (`</blockquote>\n<blockquote>` removed).
    const seamBefore = [
      '<html><body>',
      '<blockquote>',
      '<p>引文甲</p>',
      '</blockquote>',
      '<blockquote>',
      '<p>引文乙</p>',
      '</blockquote>',
      '</body></html>',
    ].join('\n')
    const seamAfter = [
      '<html><body>',
      '<blockquote>',
      '<p>引文甲</p>',
      '<p>引文乙</p>',
      '</blockquote>',
      '</body></html>',
    ].join('\n')
    const seamModel = buildFileHunks({ path: 'ch001.xhtml', kind: 'update', beforeText: seamBefore, afterText: seamAfter })
    const seamPending = buildRevisionXhtml({ model: seamModel, allowHunkToggle: true })
    expect(seamPending.xhtml).toContain('bs-rev-seam')
    expect(seamPending.xhtml).toContain('合并相邻引用块')
    expect(seamPending.xhtml).not.toContain('跨行标签变更')

    const seamRejected = buildRevisionXhtml({
      model: seamModel,
      decisions: { 'hunk-0': 'rejected' },
      allowHunkToggle: true,
    })
    expect(seamRejected.xhtml).toContain('已拒绝 · 保持独立引用块')
    expect(seamRejected.xhtml).toContain('data-bs-action="reset-hunk"')

    // Giant-span wrapper beyond 40-line guard keeps directional label and rejected restore button.
    const filler = Array.from({ length: 42 }, (_, idx) => `<p>第 ${idx + 1} 段</p>`)
    const giantBefore = ['<html><body>', ...filler, '</body></html>'].join('\n')
    const giantAfter = ['<html><body>', '<section>', ...filler, '</section>', '</body></html>'].join('\n')
    const giantModel = buildFileHunks({ path: 'ch001.xhtml', kind: 'update', beforeText: giantBefore, afterText: giantAfter })
    expect(giantModel.hunks).toHaveLength(2)
    const giantPending = buildRevisionXhtml({ model: giantModel, allowHunkToggle: true })
    expect(giantPending.xhtml).toContain('+ 跨行开始 &lt;section&gt;')
    expect(giantPending.xhtml).toContain('+ 跨行结束 &lt;/section&gt;')

    const giantRejected = buildRevisionXhtml({
      model: giantModel,
      decisions: { 'hunk-0': 'rejected' },
      allowHunkToggle: true,
    })
    expect(giantRejected.xhtml).toContain('data-bs-action="reset-hunk"')
  })

  it('wraps created chapters and handles single-line XHTML documents', () => {
    const createdModel = buildFileHunks({
      path: 'EPUB/text/afterword.xhtml',
      kind: 'create',
      afterText: '<html><body><h1>后记</h1><p>新增内容</p></body></html>',
    })
    const createdRes = buildRevisionXhtml({ model: createdModel, allowHunkToggle: false })
    expect(createdRes.xhtml).toContain('+ 新增章节')
    expect(createdRes.xhtml).not.toContain('data-bs-action="accept-hunk"')

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
