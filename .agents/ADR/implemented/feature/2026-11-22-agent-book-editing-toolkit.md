# ADR: Enhanced Agent book-editing toolkit (batch edits, core structure parity, tool ergonomics, proofreading & vision)

Status: implemented

## Problem

在 [内置单书 EPUB Agent](2026-11-20-builtin-epub-agent.md) 与 [章节拆合与资源工具](2026-11-21-chapter-structure-and-resource-tools.md) 交付 21 个工具后，真实编校整本 EPUB（多章统一校对、转码压缩 XHTML、复杂目录微调、图文核对）仍暴露出四类高频摩擦：

1. **缺少批量编辑能力**：`edit_file` 仅支持单文件单次替换且不回报改动行号，缺少跨文件/全书正则批量替换工具，导致统一术语、标点与格式极易耗尽 `MAX_TOOL_STEPS`。
2. **Core 既有结构能力未对齐暴露**：`@booksmith/core` 已有 `reorderSpine`、`formatXhtml`/`formatCss`、`getLinkedStylesheets`、`listDocumentAnchors` 与 `collectReferences`，但 Agent 无法调用，被迫手改 OPF 或盲猜正则。
3. **工具细节与真实缺陷**：`get_toc` 未附带节点 `path` 下标导致 `edit_toc` 容易算错索引且无法批量执行；`scan_headings` 缺源行号；`search_book` 非法正则静默返回 0 命中；`listWorkspaceEntries` 跳过二进制字节但未把 `byteSize` 传入 `AgentWorkspace`，导致 `list_files` 与 `cleanup_unused_resources` 中图片/字体体积恒为 0；`read_file` 对单行超长压缩 XHTML 无法安全分片；`create_chapter` 对无效 `insertAfter` 静默回退且不继承样式表与对齐目录位置。
4. **缺少校对视角与读图能力**：长章源码含大量内联标签与 `<math>` 消耗 24KB 读窗配额；二进制图片无法被多模态模型查看以编写 `alt` 文本或核对图注。

## Decision

在 `@booksmith/core`、`apps/server` 与 `apps/web` 全链路补齐上述四类能力（总工具数从 21 增至 27：10 只读 + 17 写入），沿用现有沙盒工作副本、即时 XML 校验、流式审阅与浏览器单一保存路径，不引入新数据库表或新运行时依赖。

### 1. 批量编辑与行号反馈

- **`edit_file` 多处原子编辑**：保留原单片段入参兼容性，新增 `edits: Array<{ oldText, newText, replaceAll? }>`，按顺序在内存中执行全部替换并统一校验 XML，任一匹配失败或 XML 非法则整批回滚并指明出错项；返回值附带 `changedRanges`（每处编辑的 1-based `startLine`–`endLine`）。
- **`replace_in_book` 全书批量/正则替换**：支持字面量（免疫 `$1`/`$&` 误解析）与正则（支持捕获组与前瞻/后顾断言）、`scope`（默认 `spine`，可选 `styles`/`all`）、显式 `paths`、`pathFilter` 与 `dryRun: true` 预览（含每文件最多 3 处前后文样本）；所有受影响 XML 文件全部校验通过后才原子提交，任一文件失败即中止回滚。

### 2. 对齐暴露 `@booksmith/core` 既有能力

- **`reorder_spine`**：封装 `reorderSpine` 并校验所有传入路径确实存在于当前 `<spine>`，同步 `dcterms:modified`。
- **`format_file`**：封装 `formatXhtml` / `formatCss`（支持单文件 `path` 与批量 `paths`），原样保留 `<math>`/`<svg>`/`<pre>`/`<style>`/`<script>` 与行内空白，解决单行压缩 XHTML 难以精准编辑的问题。
- **`list_anchors` 与 `find_references`**：分别封装 `listDocumentAnchors`（补充 1-based 源码行号）与 `collectReferences`（支持 `targetPath` 反查与 `fromPath` 出链查询）。
- **`list_files` 信息增强**：顶层附带全书 `stylesheets`，每个 XHTML 文件附带已关联 `stylesheets` 与去除标签后的可见 `charCount`。

### 3. 工具细节打磨与缺陷修复

- **`entrySizes` 全链路透传**：`AgentWorkspaceOptions` 与 `RunAgentTurnOptions` 新增 `entrySizes?: ReadonlyMap<string, number>`；`apps/server/src/routes/agent.ts` 将 `listWorkspaceEntries` 查得的真实 `byteSize` 传入，并在 `AgentWorkspace` 内随写入/改名/删除同步维护，彻底修复 `list_files` 与 `cleanup_unused_resources` 二进制资源体积显示为 `0` 的问题。
- **`get_toc` 节点路径标注与 `edit_toc` 批量执行**：`get_toc` 递归为每项附带显式 `path: number[]`；`edit_toc` 新增 `actions` 批量原子执行（最多 50 步），且当总目录项 `<= 150` 时直接内联返回更新后的带 `path` 目录树。
- **`scan_headings` 源行号**：`ScannedHeading` 新增可选 `line` 字段，跳过注释与 CDATA 扫描 `<h1..h6` 开始标签并与 DOM 顺序 1:1 对齐。
- **`search_book` 精准报错与过滤**：非法正则返回 `{ ok: false, error }` 而非静默 0 命中；新增 `scope`（`all`/`spine`/`styles`/`metadata`）与 `contextChars`（10–200）。
- **`read_file` 单行超长保护**：当单行超过 `maxChars`（上限 24KB）时安全截断并返回 `lineTruncated`、`nextCharOffset` 与指向 `charOffset` / `format_file` 的提示。
- **`create_chapter` 行为对齐**：`insertAfter` 未命中 spine 时直接报错；`addToToc: true` 且指定 `insertAfter` 时将目录项紧插至对应章后；未传自定义 `content` 时默认继承相邻或首章样式表（亦支持显式 `stylesheets`）。

### 4. 纯文本校对视角与多模态读图

- **`read_file(..., view: "text")`**：按块提取正文纯文本并保留每块精确的 1-based 源行号（`L42|...`），用 `[h1]`–`[h6]`、`[公式]`、`[SVG图像]` 与 `[图片: alt]` 替代冗余标签，兼顾长章低 token 通读与回跳源码精确编辑。
- **`inspect_image` 懒加载多模态读图**：
  - `@booksmith/core` 零依赖实现 `probeImageDimensions`（解析 PNG/JPEG/GIF/WebP 头部像素尺寸），并汇总全书引用位置与所在 `<img alt>`；SVG 直接返回源码文本（上限 24KB）。
  - 服务端 `routes/agent.ts` 通过 `loadBinary` 回调按需调用 `fileStore.getEntry` 懒加载单张光栅图，保持常规回合零 Postgres bytea detoast 优势；单图内联上限 4MB。
  - `runner.ts` 利用 Vercel AI SDK v7 `toModelOutput` 输出 `{ type: 'content', value: [{ type: 'text', ... }, { type: 'file', mediaType, data: { type: 'data', data: base64 } }] }`，并在 `providers.ts` 开启 `createOpenAICompatible({ supportsMultiPartToolContent: true })` 以同时兼容 Anthropic 与 OpenAI-compatible 视觉端点；同时持久化至 `agent_messages.stepsJson` 的步骤仅保留轻量元数据，严禁将 base64 写入数据库或跨轮次历史重放。

## Alternatives considered

**通过 `listWorkspaceEntries` 全量加载书籍二进制字节以供 `inspect_image` 与 `byteSize` 使用。** 会破坏 [entry-level book storage](../architecture/2026-11-20-entry-level-book-storage.md) 避免 Postgres detoast 大图/字体的性能收益，导致每次普通对话回合都拉取几十 MB 二进制。改为透传 `entrySizes` + `loadBinary` 单图按需懒加载。

**将 `inspect_image` 的 base64 图像数据一并持久化在 `stepsJson` 以便跨轮重放。** 会迅速撑爆数据库与后续轮次上下文窗口，且在用户中途切换到不支持视觉的纯文本模型时导致历史重放报错。仅在当轮 `toModelOutput` 附带像素数据，持久化轨迹保留尺寸、体积与引用元数据；后续轮次若需再看可重新调用 `inspect_image`。

**新增独立的 `get_linked_stylesheets` 工具与 `read_chapter_text` 工具。** 会进一步膨胀工具数量与模型选型负担；样式表关联直接并入 `list_files`、纯文本视角通过 `read_file(..., view: "text")` 复用既有分页参数更简洁自然。

## Consequences

- 工具总数扩展为 27 个（10 只读 + 17 写），同步更新了前端 `AGENT_TOOL_LABELS`（[agentTimeline.ts](../../../../apps/web/src/state/agentTimeline.ts)）与系统提示词（[systemPrompt.ts](../../../../apps/server/src/agent/systemPrompt.ts)）；本决策在工具箱层面扩充 [内置单书 EPUB Agent](2026-11-20-builtin-epub-agent.md) 与 [章节拆合与资源工具](2026-11-21-chapter-structure-and-resource-tools.md)，两者核心沙盒、提案审阅与原子应用边界保持不变。
- `ESTIMATED_TOOL_SCHEMA_TOKENS` 维持 `2_400` 以避免在 4K 小上下文本地模型上于首轮误触发 80% 压缩，实际 token 数在首步返回后仍以上游 `usage.inputTokens` 实时校准。
- **已知限制**：`inspect_image` 在不具备多模态能力的纯文本上游端点调用时，上游可能忽略或拒绝 `image_url` / `image` 内容块（取决于中转商实现）；超过 4MB 的超大单图自动降级为仅返回元数据与引用位置，暂不在服务端引入 `sharp` 等原生图片重编码依赖。
