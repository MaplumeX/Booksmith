# ADR: Baseline-derived dirty state and external-sync isolation

Status: implemented

## Problem

编辑器当前使用手工维护的 `dirty: Set<string>` 标记未保存修改，在以下五类场景中出现系统性错误：

1. **打开含 CRLF（`\r\n`）的章节即虚假标脏并触发自动保存**：`loadBook` 原样解码字节，而 CodeMirror 6 在 `EditorState.create({ doc })` 时将 `\r\n` 规范化为 `\n`。随后 `CodePane` 的同步 `useEffect` 比较 `instance.state.doc.toString() === content` 必然不相等；由于所有可预览章节的 `syncMode` 均为 `'transaction'`，组件立刻执行全量替换 `instance.dispatch(...)`。`EditorView.updateListener` 未区分用户编辑与编程式外部同步，直接回调 `onChange` → `handleChange`，导致只打开页面就出现「1 处未保存」、写入本地草稿、20 秒后自动保存整本 EPUB 并递增版本，还向撤销栈注入无意义替换记录。
2. **可视化模式保存后切回代码模式再次虚假标脏**：在可视化模式下修改并保存后，隐藏中的 `CodePane` 仍持有旧文档；切回代码模式时 `visible` 变为 `true`，同一段无注解的 `instance.dispatch(...)` 再次触发 `onChange`，把刚刚保存干净的章节重新标脏。
3. **撤销回原文永远无法恢复「未修改」**：`handleChange` 只会往 `dirty` 中 `add`，不与已保存基线比对；输入后按 Backspace 或 `⌘Z` 回到原状，仍停留在未保存态并继续触发草稿与自动保存。
4. **保存请求在途期间继续输入会丢失未保存标记**：`save()` 完成后无条件 `setDirty(new Set())` 与 `clearDraft()`，在整包上传期间产生的新编辑被清掉脏标记，不再触发自动保存。
5. **结构/二进制变更与文本 `dirty` 语义混用且存在漏标**：`confirmDelete` 修改 OPF/TOC 并删除文件后仅执行 `dirty.delete(path)`，漏标删除与结构变更导致「保存」按钮保持禁用；`replaceAsset` 为让二进制替换可保存而强行把 `opfPath` 标脏，导致文件树红点错位且保存时误刷新 `dcterms:modified`（违背 [the OPF meta editing decision](../../implemented/feature/2026-11-19-opf-meta-editing.md)）；此外部分变更入口未同步更新 `dirtyRef.current`，且 `App.tsx` 渲染 `<Editor>` 缺少 `key={bookId}`。

## Decision

以**服务端已保存基线（Saved Baseline）作为未保存状态的单一真相源**，并在编辑器组件边界隔离外部同步与行尾风格。本决策延续并收紧 [the autosave decision](../../implemented/feature/2026-11-19-autosave.md) 的客户端零空转闸门、[the per-tab editor state decision](../../implemented/bug-fix/2026-11-19-editor-state-per-tab.md) 的多标签状态缓存、[the OPF meta editing decision](../../implemented/feature/2026-11-19-opf-meta-editing.md) 的 `dcterms:modified` 更新边界，以及 [the WYSIWYG chapter editing decision](../../implemented/feature/2026-11-20-wysiwyg-editing-mode.md) 的单步 `⌘Z` 撤回契约。

### 核心机制

- **已保存基线与纯函数差异推导**（`apps/web/src/state/dirtyState.ts`）：
  - 编辑器维护 `SavedBaseline`（`texts: Map<string, string>` + `entries: Map<string, Uint8Array>`），在 `applyBook` 与 `reload` 时初始化。
  - `computeDirtySummary(baseline, currentTexts, currentEntries)` 实时计算 `{ all, texts, binaries, deleted }`：文本条目按字符串精确比对，非文本条目先走引用相等快路径再做字节比对，基线中存在而当前缺失的条目进入 `deleted`。
  - 所有变更与撤销入口统一经 `syncDirtyFromBaseline()` 同步更新 `dirtyRef.current` 与 `dirty` state（集合成员未变时复用原 `Set` 引用，保持打字期无多余重渲染）。
  - 按真实变动条目计脏与标点：替换同格式图片时仅图片自身进入 `binaries` 与 `all`（红点亮在图片上，`opfPath` 未变则不标脏、不刷新 `dcterms:modified`）；删除文件通过 `deleted`（及实际改动的 OPF/TOC 文本）保证 `all.size > 0`、「保存」按钮可用并触发自动保存。
- **在途保存基线推进**：
  - `save()` 从 `bookRef.current` 读取最新状态，仅当 `summary.texts.has(opfPath)` 时执行 `touchOpfModified`，并记录本次实际上传的 `uploadedTexts` 与 `uploadedEntries`。
  - 保存成功后仅将基线推进到已上传快照，再结合当前内存工作区重算剩余脏集合；若用户在上传期间继续输入，新编辑自然留在 `dirty` 中并由 `autosave` 自动重新排期。
- **本地草稿与自动保存联动**：
  - 延续 [the autosave decision](../../implemented/feature/2026-11-19-autosave.md)，IndexedDB 草稿仅存储 `summary.texts` 中真实变动的文本文件，不存二进制或删除清单。
  - 当撤销/还原使 `summary.texts.size === 0` 时，主动取消草稿定时器并 `clearDraft(bookId)`；当 `summary.all.size === 0` 时取消自动保存计时器。
- **`CodePane` 外部同步隔离与行尾保真**（`apps/web/src/editor/eol.ts`、`apps/web/src/ui/CodePane.tsx`、`apps/web/src/editor/wysiwygXhtml.ts`）：
  - 为 props 驱动的 `instance.dispatch` 附加自定义 `Annotation`（`externalSyncAnnotation`）；`updateListener` 忽略纯外部同步事务，同时事务仍进入 CodeMirror 历史栈，保留从可视化切回代码一键 `⌘Z` 撤回能力。
  - 同步检查使用 `instance.state.doc.toString() === normalizeEol(content)`，打开 CRLF 章节时不触发无意义 `dispatch`。
  - 每个打开路径记录初始种子文本 `seedTexts`：用户真实编辑时若归一化文本回到种子文本则原样返回种子串（确保混合行尾文件撤销后字节一致），否则按原文件主导行尾（`\r\n` 或 `\n`）还原写回。`replaceBodyInXhtml` 同步按原文主导行尾写回 `<body>`，避免修改 CRLF 章节一处错字造成整章 diff。
- **切书隔离**：`App.tsx` 为 `<Editor key={match[1]} bookId={match[1]} />` 补充 `key`，避免直达切换 `bookId` 时复用旧书状态。

## Alternatives considered

**仅在 `CodePane` 和 `confirmDelete` 上做局部补丁。** 改动面最小（2–3 个文件），能止住“点开就标脏”与“删文件漏标脏”，但撤销回原样仍不消脏、保存中继续打字仍会丢失脏标记、替换图片仍借 `opfPath` 占位误改 `dcterms:modified`，且未来新增任何编辑入口仍可能重复漏标或误标。

**使用 CodeMirror 的 `EditorState.lineSeparator.of('\r\n')` 保留 CRLF。** 实测 `@codemirror/state` 在配置 `lineSeparator` 后 `doc.toString()` 仍硬编码以 `\n` 拼接，且对混合 `\r\n` 与 `\n` 的文件会把孤立 `\n` 吞进同一行导致显示与编辑错乱。在 `CodePane` 读写边界做归一化比对与行尾还原更安全且兼容混合行尾。

**只要用户实际编辑 CRLF 文件，就统一规范化为 LF（`\n`）。** 实现省去行尾检测与还原函数，但首次修改 CRLF 章节中的单个错字就会使页面级快照 diff 把整章每一行标记为改动，违背 [the MVP editor decision](../../implemented/feature/2026-11-19-epub-editor-mvp.md) 的最小 diff 与保真原则。

**沿用仅对文本文件计脏，换图继续借 `opfPath` 占位。** 无需区分文本与二进制变更，但会继续让同格式换图误触发 `touchOpfModified` 并把红点标在错误的 OPF 文件上，也无法覆盖非 manifest 条目的删除。

**扩展 `draftStore`（IndexedDB）一并保存二进制字节与删除清单。** 能为换图与删文件增加 1 秒本地崩溃恢复，但大图片/字体写入 IndexedDB 存在配额与序列化开销，且需重做 `planDraftRestore` 与恢复横幅冲突语义，与 [the autosave decision](../../implemented/feature/2026-11-19-autosave.md) 的轻量纯文本草稿边界冲突。

## Consequences

- **交付验收**（`pnpm typecheck && pnpm build && pnpm test` 全绿：3 个包 typecheck/build 干净，262 tests / 28 files）：打开含 `\r\n`（CRLF）或混合行尾的章节、标签页与代码/可视化模式间切换均不再触发虚假未保存提示、不写本地草稿、不触发自动保存；两种模式编辑 CRLF 章节保存后刷新内容持久化且保留原 `\r\n`；可视化保存后切回代码保持「未修改」态，未保存前切回仍可单步 `⌘Z` 撤回；`⌘Z` 或改回基线内容自动恢复「未修改」并清理草稿；删除文本或图片后状态栏显示未保存、「保存」可用且刷新后生效；替换同扩展名图片仅该图片亮红点，`content.opf` 与 `dcterms:modified` 不受影响；保存在途期间的新编辑在保存完成后仍保持未保存并继续被保存。
- **E2E 已知缺口**：全量 `pnpm e2e` 为 79/80，唯一失败项 `e2e/panels.spec.ts:43`（`.toc-label` 单击已改为跳转章节而非内联改名）是本决策之前于 `b1c0990` 引入的既有失败，不由本次变更修复；本次新增的 `e2e/dirty.spec.ts` 与相关四个 spec（19 passed）覆盖上述全部行尾与标脏场景。验收由用户在本地实测确认（2026-11-21），未重跑全量 E2E。
- **大文件二进制字节比对开销**：`computeDirtySummary` 对未修改条目先做 `Uint8Array` 引用相等检查（`O(1)`），只有替换生成新缓冲区时才逐字节比对；正常编辑文本时不会遍历二进制字节。
- **`touchOpfModified` 在保存开始时同步改写 `texts.current`**：若用户在 `api.save()` 失败（如 409 或网络错误）前并未手动编辑时间戳，时间戳变更已写入内存 OPF；仅在 `summary.texts.has(opfPath)` 为真时才执行该写入（且 `uploadedTexts` 仅在成功时升为基线），与既有失败语义一致且不比现状更糟。
- **现有 E2E 对精确未保存文件数的断言**：已在规划期核查全库 E2E 用例（`asset.spec.ts` 替换同扩展名图片仍为 `1 个文件未保存`，`panels.spec.ts` 改目录同步 nav+ncx 仍为 `2 个文件未保存`），实测时需跑全量 E2E 防止遗漏。
