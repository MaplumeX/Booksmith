# ADR: Replacing and deleting binary assets

Status: implemented

## Problem

资源只能进不能改。`Editor.tsx` 的 `importAsset` 能往 `EPUB/media/` 里加图片和字体，之后
`MediaPane` 是纯只读视图（「这是二进制资源，不能在编辑器里修改」）。

校对一版扫描书时最常见的两件事都做不到：

- **换图**：同一张图的新版本（更大的分辨率、修掉的水印）无法替换，只能再导入一份，导致 manifest
  里出现 `fig3.png` 与 `fig3_1.png`，正文还指着旧的。
- **删图**：清掉废弃资源没有入口。文件树里的条目只能看。

## Decision

**在 `MediaPane` 加两个动作，复用已有的两条路径。**

- **替换**：选一个本地文件，覆盖同名归档条目的字节。保留原路径与原 manifest item；`media-type`
  按新文件的扩展名重新推断（不是按 `File.type`，浏览器的 MIME 推断不可靠，且原 mime 对新内容
  可能已经错了）。不进入 `texts`，不产生 tab。
- **删除**：走 [文件结构编辑](2026-11-19-file-structure-editing.md) 的删除流程——从
  manifest 与 spine 移除、从目录移除、列出正文引用并二次确认。资源删除与章节删除是同一件事，
  不应有两套实现。

**替换是覆盖，不是新增。** 想保留旧图的两个版本，应该用「导入」得到两个 manifest item。替换
的语义是「这张图换成新拍的」，历史由 `page_versions` 之外的东西承担——二进制不进页面快照
（见 [页面级快照](2026-11-19-page-level-snapshots.md)），所以替换**不可
通过快照恢复**。UI 上必须在确认框里说清这一点。

## Alternatives considered

**替换时保留原 `media-type`。** 更「安全」，但用户把 `cover.jpg` 换成 `cover.png` 时 manifest
会声明一个错误的类型，阅读器可能拒渲染。按扩展名重新推断是唯一正确的做法，`mediaTypeOf`
（`apps/web/src/preview/render.ts`）已经有这套映射。

**替换时新建一个 manifest item（保留旧图）。** 那用户还得自己改正文引用指向新 item，等于没解决
「换图」这件事。想留旧版就走导入。

**允许替换任意二进制（字体、容器文件）。** 字体替换的收益是真实的（换一个中文字体），但字体被
CSS `@font-face` 引用，替换后体积与家族名都可能变，需要额外的校验。第一版只对 `image/*` 开放
替换，字体仍走「导入 + 手改 CSS」。

## Consequences

**交付实测（2026-11-19）**

- 替换：`cover.jpg` 14.9 KB → 160 B 后预览 `naturalWidth` 由 236 变 1，保存重载仍为新字节（e2e + 浏览器实测）。
- 删除复用文件删除流程，引用清单同样列出（e2e）。
- `media-type` 按目标路径扩展名重推，manifest 随之更新。

**已接受的代价**

- 替换不可恢复是本设计最硬的点：二进制不进页面快照，服务端只存当前整包。缓解只有确认文案。
  若用户强烈需要，那是「二进制快照」这个更大的决策，不在本记录的范围内。
- 替换一张体积大 10 倍的图会显著改变整包体积与保存耗时（每次保存整包 `PUT`），但这是数据本身
  的属性，不是实现问题。
