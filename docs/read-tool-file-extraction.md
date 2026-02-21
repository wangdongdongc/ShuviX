# Read 工具文字提取方案

## 背景

智能体需要从用户提供的各种文件中提取文字内容。目标是在 `read` 工具中一站式支持纯文本和富文本格式，让 agent 通过同一个工具即可读取所有常见文件。

## 调研过程

### 需求

- 支持 PDF、Office（新版 + 旧版）、HTML、Jupyter Notebook 等格式
- 纯 JavaScript/TypeScript 实现，不依赖外部系统工具（antiword、LibreOffice 等）
- 适合 Electron 桌面端环境
- 对不支持的二进制格式给出明确错误提示，避免乱码

### 候选方案对比

| 方案 | 支持格式 | `.doc` | `.ppt` | 输出质量 | 外部依赖 | 维护状态 |
|------|---------|--------|--------|---------|---------|---------|
| **markitdown-ts** | pdf, docx, xlsx, pptx, html, ipynb, zip | ❌ | ❌ | Markdown（结构保留好） | 无 | 活跃 |
| **officeParser** | docx, pptx, xlsx, odt, odp, ods, pdf, rtf | ❌ | ❌ | AST / 纯文本 | 无 | 活跃 |
| **word-extractor** | doc, docx | ✅ | ❌ | 纯文本 | 无 | 一般 |
| **textract** | doc, docx, ppt, pptx, pdf, xls, xlsx... | ✅ | ✅ | 纯文本 | **需要 antiword、pdftotext 等** | 7年未更新 |
| **office-text-extractor** | docx, pptx, xlsx, pdf | ❌ | ❌ | 纯文本 | 无 | 一般 |
| **js-ppt** (SheetJS) | ppt | - | ⚠️ 质量差 | 纯文本 | 无 | 不活跃 |

### 关键结论

1. **没有一个纯 JS 库能同时覆盖所有格式**
   - `.docx/.pptx/.xlsx` 是 ZIP+XML 格式，纯 JS 解析无压力
   - `.doc/.ppt` 是微软 OLE2 二进制格式，业界公认难解析
   - `.doc` 有 `word-extractor`（纯 JS，质量可靠）
   - `.ppt` 没有可靠的纯 JS 方案

2. **markitdown-ts 的 Markdown 输出质量最优**，保留标题、列表、表格结构，对 LLM 理解文档最有利。其他方案只输出纯文本。

3. **自行组装多个单格式库**（mammoth + pdf-parse + xlsx + ...）工作量大，且输出只是纯文本，不如 markitdown-ts。

### MCP 方案评估

也评估了通过 MCP（Model Context Protocol）机制让用户自行接入 markitdown MCP Server 的方案。结论是**暂不引入**：

- pi-agent-core 的设计哲学明确反对 MCP：MCP Server 会把所有工具描述一次性注入 context，Token 开销高（如 Playwright MCP 21 个工具 / 13.7k tokens）
- pi 推荐用 CLI 工具 + README 的方式实现按需加载（progressive disclosure）
- 为 markitdown 一个用途引入整套 MCP 机制，投入产出比不高
- 如果未来需要通用扩展性（数据库、浏览器自动化等），可再考虑

## 最终方案

**markitdown-ts 为主 + word-extractor 补 `.doc`**

### 依赖

```json
{
  "markitdown-ts": "^0.0.10",
  "word-extractor": "^1.x"
}
```

### 格式覆盖

| 格式 | 处理方式 | 输出 |
|------|---------|------|
| `.pdf` `.docx` `.xlsx` `.xls` `.pptx` `.html` `.htm` `.ipynb` `.zip` | markitdown-ts | Markdown |
| `.doc` | word-extractor | 纯文本 |
| `.ppt` + 其他已知二进制 | 直接 throw 错误 | 错误提示 |
| 未知扩展名但检测为二进制 | 读取前 8KB 检测 NULL 字节 | 错误提示 |
| 纯文本文件 | 原有逻辑 | 带行号的文本 |

### 实现架构

`read` 工具 execute 流程：

```
resolve path → sandbox check → stat file
  → 扩展名 in RICH_FILE_EXTENSIONS? → markitdown-ts → Markdown
  → 扩展名 == '.doc'?              → word-extractor → 纯文本
  → 扩展名 in KNOWN_BINARY?        → throw unsupported
  → 读取文件 → isBinaryBuffer?     → throw unsupported
  → 纯文本逻辑（行号、分页、截断）
```

### 关键实现细节

- **单例实例**：MarkItDown 和 WordExtractor 各使用单例，避免重复创建
- **二进制检测双保险**：已知扩展名快速拒绝 + 未知扩展名读取前 8KB 检测 NULL 字节
- **统一截断**：所有路径（Markdown / 纯文本）都经过 `truncateHead` 处理，防止超大文件撑爆 context
- **文件信息头**：转换后的文件附带格式和大小信息，如 `文件: report.pdf (PDF, 1.2MB) — 已转换为 Markdown`

### 涉及文件

- `src/main/tools/read.ts` — 核心实现
- `src/shared/i18n/locales/zh.json` — 中文翻译
- `src/shared/i18n/locales/en.json` — 英文翻译
- `src/shared/i18n/locales/ja.json` — 日文翻译
- `package.json` — 新增依赖

### i18n Key

| Key | 用途 |
|-----|------|
| `tool.readDesc` | 工具描述（列出支持的格式） |
| `tool.convertedHeader` | 转换后的文件头 |
| `tool.convertFailed` | 转换失败提示 |
| `tool.unsupportedFormat` | 不支持格式的错误提示 |
