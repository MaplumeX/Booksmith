# ADR: A structure check panel fed by the same linter the server uses

Status: implemented

## Problem

结构问题只能在保存被拒时看到。`packages/core/src/validate.ts` 的 `validateStructure` 已经在跑
（`apps/server/src/epub/ingest.ts:61`），但它只在 `PUT` 之后返回 400 `invalid_epub`。用户看
到的是「保存失败 · 重试」或一句「保存的内容不是有效 EPUB，检查刚才的修改」，不知道是哪一条、
在哪个文件。清单本身在响应体里（`issues`），前端从未展示。

同时有四类问题它根本不查，而它们正是手工编辑 EPUB 最容易造出来的：

- 正文引用了归档里不存在的文件（断链 `<img src>` / `<a href>`），预览里表现为空白。
- manifest 里存在从未被任何正文引用、也不在 spine 里的资源（死资源，占体积）。
- spine 为空（整本书没有阅读顺序）。
- 目录条目指向的锚点在目标文件里不存在（`findBrokenAnchors` 已实现，但只在目录面板里提示）。

## Decision

**侧栏第五个 tab「检查」，复用现有校验，加一个纯函数 linter。**

- `packages/core/src/lint.ts` 的 `lintBook(files, pkg, archive)` 返回 `EpubIssue[]`，在
  `validateStructure` 之外追加：`broken-reference`（用
  [引用扫描](2026-11-19-file-structure-editing.md)）、`unused-resource`、`empty-spine`、
  `broken-anchor`。每条 `issue` 带 `path` 与可选的 `line`。
- `CheckPanel` 按严重度分组（错误 / 警告），每条一行，点击跳到对应文件与行。
- 面板在文件树变化后重算（用编辑中的 `texts`，不是磁盘上的版本），这样改一次引用就能看到
  断链消失。
- 保存被拒时，`saveError` 里的 `issues` 同时灌进检查面板并把侧栏切到该 tab——错误不再只活在
  顶栏一行字里。

**不引入 EPUBCheck。** 它要 Java 运行时，且报告与编辑器动作之间没有桥。第一版用自己的结构
检查，定位是「编辑时能立刻看见的本地问题」，不是发布前的合规认证。

## Alternatives considered

**接入 EPUBCheck（Java / epubcheck.jar）。** 合规检查最权威，也是 [MVP 决策](2026-11-19-epub-editor-mvp.md)
里已否决的方案，否决理由仍然成立：容器里多一个 JVM，报告结构（XML 的 messages）与编辑器
的动作模型对不上，且它只能在保存后跑。不重开。

**保存前强制跑检查并阻止保存。** 会更早拦住问题，但会挡住「先存一版再修」的正常工作流，
也会让一次实验性编辑变成不可保存。检查面板是只读建议，保存校验仍然只在服务端做结构性拦截。

**把问题显示在状态栏里。** 状态栏只有一行 28px，放不下「23 处断链、4 个死资源」。而且这类
信息需要可点击定位，状态栏没有这个空间。

## Consequences

**交付实测（2026-11-19）**

- `lintBook` 7 个单测覆盖断链、未引用资源、空 spine、失效锚点与正常书零问题；真实书 0 条误报。
- 面板点击跳到对应文件与行，修掉引用后条目立即消失（3 条 e2e）。
- **实现中确认的边界**：OPF 的 `manifest href` 是声明而不是引用。统计「未引用资源」与「断链引用」时必须排除 OPF 自身，否则每个 manifest 项都会被当成已被引用，检查永远为空。

**已接受的代价**

- 断链检查与 `rewriteReferences` 共用解析逻辑，两处对「什么算引用」的口径必须一致，否则会出现
  「重命名时改了但检查说没断」或反之。口径只有一处：`collectReferences`。
- `unused-resource` 容易误报：字体常由 CSS `@font-face` 引用，图片可能由 JS 生成路径。第一版
  只对 `image/*` 与 `text/css` 之外的 manifest 项报警告，且措辞是「未发现引用」而非「无用」。
