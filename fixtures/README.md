# fixtures

回归测试使用一本真实的中文 EPUB，随仓库提交，测试通过 `readFixture()` 直接读取
`fixtures/` 下的同名文件，无需额外准备。

已知结构（断言依据，见 `packages/core/test/parse.test.ts`）：

- EPUB 3.0，55 个 zip 条目，2.1MB
- OPF：`EPUB/content.opf`，manifest 51 项，spine 28 项（含 `nav`）
- `EPUB/nav.xhtml`（179 项三层嵌套，标题内嵌 MathML）与 `EPUB/toc.ncx` 同时存在
- 最大单章 `EPUB/text/ch010.xhtml`：174KB，328 个 `<math>`
