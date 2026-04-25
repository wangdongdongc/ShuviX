---
name: kami
description: "Typeset professional printable documents — resumes, one-pagers, white papers, letters, portfolios, slide decks — with a warm parchment design system (ink-blue accent, serif-led hierarchy, tight editorial spacing). Full bilingual: Chinese docs use TsangerJinKai02 + Source Han, English docs use Newsreader + Inter. TRIGGER whenever the user asks to 做一份 / 写一份 / 生成 / 排版 / 美化 a 简历 / 一页纸 / 执行摘要 / 白皮书 / 报告 / 作品集 / 正式信件 / 辞职信 / 推荐信 / 演示文稿 / 幻灯片 / PPT / PDF / slides / resume / CV / one-pager / white-paper / portfolio / deck — or whenever they hand over raw content and say things like 整理一下 / 变好看 / make it presentable / turn this into a PDF / polish the typography. Load this skill before writing anything; the design language, templates, and build workflow all live here."
---

# kami · 紙 — ShuviX 版

**紙 · かみ** — the paper your deliverables land on. 好内容值得好的排版。

一套设计语言，6 种文档类型（一页纸 / 长文 / 信函 / 作品集 / 简历 / 幻灯片），统一的暖米纸底、油墨蓝重点、serif 主导的字级层级、紧凑的编辑排版。

## 环境先决条件（首次使用必读）

本 skill 产出 **PDF** 靠 ShuviX 的 `browser` 工具（内置 Chromium 通过 `devtools_action: 'print_to_pdf'` 渲染）。

- 若你（agent）发现 `browser` 工具不在可用工具列表：告知用户到 **设置 → 工具** 启用 `browser` 工具（针对当前项目），启用后再继续。仅需一次，之后都能自动调用。
- **不要**尝试安装 weasyprint / wkhtmltopdf / pandoc 或任何系统级 PDF 工具。ShuviX 的 `browser` 工具已完整覆盖此路径。

**PPTX** 产出（slides 类型）走 `python` 工具（Pyodide + 预装 python-pptx）。**关键**：`templates/slides.py` / `slides_en.py` 是**可直接 import 的模块**，通过 `python` 工具的 `modulePaths` 参数挂载 `templates/` 目录后 `from slides import ...` 即可调用。**绝对不要**把 slides.py 的内容整段复制到 `code` 参数里。详见 Step 6B。

## Step 1 · 判断语言

**跟随用户的语言**。中文 → 中文模板（`.html` / `slides.py`）+ 中文 references（`*.md`）；英文 → 英文模板（`-en.html` / `slides-en.py`）+ 英文 references（`*.en.md`）。

语言不明确时（比如用户只说 "resume"），一句话追问一次，不要自己猜。

## Step 2 · 选文档类型

| 用户说 | 文档 | 中文模板 | 英文模板 |
|---|---|---|---|
| "一页纸 / 方案 / 执行摘要 / one-pager / exec summary" | One-Pager | `templates/one-pager.html` | `templates/one-pager-en.html` |
| "白皮书 / 长文 / 年度总结 / white paper / long report" | Long Doc | `templates/long-doc.html` | `templates/long-doc-en.html` |
| "信件 / 辞职信 / 推荐信 / formal letter / memo" | Letter | `templates/letter.html` | `templates/letter-en.html` |
| "作品集 / case studies / portfolio" | Portfolio | `templates/portfolio.html` | `templates/portfolio-en.html` |
| "简历 / 履历 / resume / CV" | Resume | `templates/resume.html` | `templates/resume-en.html` |
| "幻灯片 / 演示 / slides / PPT / deck" | Slides | `templates/slides.py` (模块) | `templates/slides_en.py` (模块) |

不确定就一句话反问；不要默认。

### 图表（嵌入 long-doc / portfolio / slides 里的 SVG 原语）

| 用户说 | 图表 | 模板 |
|---|---|---|
| "架构图 / architecture diagram" | Architecture | `diagrams/architecture.html` |
| "流程图 / flowchart" | Flowchart | `diagrams/flowchart.html` |
| "象限图 / 2×2 matrix / quadrant" | Quadrant | `diagrams/quadrant.html` |

绘图前问自己：**同样的信息，一段写得好的文字能不能讲得更清楚？** 如果能，就不画。

## Step 3 · 按需读规范（按任务 tier 选择最小集合）

| Tier | 何时 | 读 |
|---|---|---|
| Content-only | 改文字、换 bullet、翻译既有文档，CSS 不动 | 只读模板本身（tokens 已内联） |
| Layout tweak | 微调间距、挪 section、调字号（仍在规范内） | 模板 + `references/design.md` |
| New document | 从零或从原始素材新建 | `references/design.md` + `references/writing.md` + 模板 |
| Sources / materials | 涉及公司、产品、发布、品牌主题 | `references/writing.md` 的 source 规则 |
| Long deck (>20 slides) | 需要分节、代码卡片、章节标题 | `references/design.md` §8 Deck Recipe |
| Diagram embed | 嵌入 SVG 图表 | `references/diagrams.md` |
| Troubleshoot | 排版异常、字体、分页 | `references/production.md` |

完整 reference 清单：
- 设计：`references/design.md` / `design.en.md`
- 写作：`references/writing.md` / `writing.en.md`
- 生产：`references/production.md` / `production.en.md`
- 图表：`references/diagrams.md` / `diagrams.en.md`
- 设计 tokens：`references/tokens.json`

## Step 4 · 原始素材蒸馏（如果需要）

当用户丢过来的是**原始材料**（会议纪要、脑暴、散落要点、他处粘贴的文字），**不要**直接塞进模板。先做：

1. **提取**：罗列所有事实、数字、日期、人名、来源、素材
2. **归类**：对到目标模板的 section 上（见 `references/writing.md`）
3. **缺口**：列出模板需要但用户没提供的项（事实缺、证据缺、素材缺）
4. **一次性追问**：把缺口表甩给用户，不要编造填补

如果用户给的已经是结构化内容（小标题、要点、数据齐备），跳过本步。

## Step 5 · 填充模板

1. 把选定的模板 **复制到工作区**（不要在 skill 目录内修改）：
   ```
   cp resources/skills/kami/templates/resume-en.html <workspace>/resume.html
   ```
   （实际用 `read` + `write` 工具完成，不要用 bash cp 触及 skill 只读目录）
2. **只改 `<body>`**，CSS 保持不动
3. 文案遵循 `writing.md` / `writing.en.md`：**数据优先于形容词，独特表达优先于行业套话**

## Step 6A · HTML 文档产出 PDF（走 browser 工具）

适用于 one-pager / letter / long-doc / portfolio / resume。

```
1. browser({ action: "open", url: "file:///<absolute-path-to>/resume.html" })
2. browser({ action: "devtools", devtools_action: "wait_for", devtools_params: { text: "<首屏可见的某段文字>" } })
3. browser({ action: "devtools", devtools_action: "print_to_pdf", devtools_params: {
     outputPath: "resume.pdf",
     printBackground: true
   }})
```

**关键**：Kami 每个 HTML 模板都在 CSS 里定义了 `@page { size: A4; margin: 15mm 18mm }`——这是**精心按 180×267mm 可用区布局的**。`print_to_pdf` 默认 `preferCSSPageSize: true`，会尊重这套 @page 规则。**不要**在 devtools_params 里传 `pageSize` / `margin`——传了会被 CSS 规则覆盖（无害但冗余），或者如果你显式设 `preferCSSPageSize: false`，会破坏 Kami 的布局、导致多出空白页。

何时可以覆盖默认值：
- 用户明确要 Letter 或其他纸张 → 改 HTML 模板里的 `@page { size: ... }`，而不是在 print_to_pdf 里传 `pageSize`
- 横向：同上，改 `@page { size: A4 landscape }`

生成后给用户 PDF 的绝对路径；有需要可追加 `browser({ action: "devtools", devtools_action: "screenshot" })` 供聊天面板预览。

### 常见分页问题

- **多出一页只有页眉**：内容溢出可用区几毫米。先确认你用的是最新版 `print_to_pdf`（默认 preferCSSPageSize: true）；仍溢出则回到 body 删一个无关 section，或把某个 `font-size: 10pt` 的段落改 9.5pt。**不要**靠外层 margin 硬挤。
- **某一页非常单薄（只有标题或一小块）**：`break-inside: avoid` 把一个大 section 踢到下一页，前一页填不满。查 `production.md` 第 4 部分；通常是内容安排问题，不是渲染 bug——拆 section 或调序即可。

## Step 6B · 幻灯片产出 PPTX（走 python 工具 + modulePaths）

适用于 slides。`templates/slides.py`（中文）/ `templates/slides_en.py`（英文）是**可直接被 python 工具加载的函数库**，提供：

| 函数 | 用途 |
|---|---|
| `Presentation()` (from python-pptx) | 新建演示文稿 |
| `SLIDE_W`, `SLIDE_H` | 16:9 画布常量 |
| `cover_slide(prs, title, subtitle, author, date)` | 封面 |
| `toc_slide(prs, items)` | 目录 |
| `chapter_slide(prs, number, title)` | 章节首页 |
| `content_slide(prs, eyebrow, title, body, page_num=None)` | 正文页 |
| `metrics_slide(prs, title, metrics)` | 数据页（metrics 是 `[(value, label), ...]`） |
| `quote_slide(prs, quote, source)` | 引用 |
| `ending_slide(prs, message, contact)` | 结束页 |

**关键**：把 `.py` 文件的绝对路径塞给 `python` 工具的 `modulePaths` 参数，让工具自己读入并装进 REPL。**不要**把 slides.py 的代码拷贝到 `code` 里。

正确调用姿势（中文示例）：

```
python({
  modulePaths: ["<kami-skill-path>/templates/slides.py"],
  code: `
prs = Presentation()
prs.slide_width, prs.slide_height = SLIDE_W, SLIDE_H

cover_slide(prs,
    title="产品路线图 2026",
    subtitle="聚焦三个关键增长引擎",
    author="张三 · 产品部",
    date="2026.04")

toc_slide(prs, items=["现状", "策略", "里程碑", "Q&A"])

chapter_slide(prs, 1, "现状")

content_slide(prs,
    eyebrow="现状 · 本页",
    title="我们在哪里",
    body="三条业务线同时增长，MAU 同比 +38%，但付费转化停滞。",
    page_num=4)

metrics_slide(prs, title="关键结果",
    metrics=[("+38%", "MAU"), ("2.1x", "内容产出"), ("7.8", "NPS"), ("92%", "留存")])

ending_slide(prs, message="Thank you", contact="zhang@example.com")

prs.save("/workspace/deck.pptx")
print("saved deck.pptx")
`
})
```

`<kami-skill-path>` = 你从 skill 工具加载时拿到的 `Base directory for this skill`。首次调用后，slides.py 的定义会一直留在本 session 的 REPL 全局作用域里，后续追加/修改只需改 `code` 即可。

英文文档切换到 `templates/slides_en.py`（注意**下划线**，Python import 约束）。

### 单独要一张图表嵌入到长文 / 作品集里

用 `diagrams/architecture.html` 等：用 `browser` 打开 → `evaluate` 抽出 `<svg>` 节点 → 嵌入到目标 HTML 文档的 `<figure>` 里。详见 `references/diagrams.md`。

## Step 7 · 校验（可选但推荐）

- 页数：简历 1-2 页、一页纸 1 页、信函 1 页、长文 7±2、作品集 6±2
- 字体回退：PDF 里打开应当是 serif（中文是 Source Han / Songti，英文是 Newsreader 或 Charter/Georgia fallback）
- 颜色：底色 `#f5f4ed`，正文 `#1a1a1a`，强调 `#1B365D`
- 溢出：确认没有页面中段被强制截断（`break-inside: avoid` 的 section）

视觉有问题 → 读 `references/production.md` 第 4 部分。

## 常见反模式（Kami 禁忌）

- ❌ 用 rgba 半透明做双层矩形 "tag"
- ❌ 冷灰（偏蓝/偏紫的灰），只用暖灰
- ❌ 合成粗体（`font-weight: bold` 让字体变糊），中文必须切到 W05 字重文件
- ❌ italic（本系统无斜体，强调用字重或色）
- ❌ 多彩色方案（只有一个 accent：油墨蓝）
- ❌ 大写字母（English 文档里的 eyebrow 允许小写字距，不允许 ALL CAPS）

## 模糊反馈的应答协议

用户说 "太挤了 / 不够好看 / 颜色不对" 这种模糊反馈时，**不要自己猜**，用 kami 词汇反问，并给出当前数值：

> "这里 line-height 当前是 1.45，我可以 (a) 调到 1.55（松一点）或 (b) 维持 1.45 但把 section 间距从 24px 加到 32px。你倾向哪个？"

永远不要只说 "我调一下间距" —— 要指明**哪个属性**调到**哪个具体值**。

## 不应使用本 skill 的场景

- 用户明确想要 Material / Fluent / Tailwind 默认视觉 → 不同设计语言
- 需要暗黑 / cyberpunk / 未来主义（本系统刻意反未来主义）
- 需要多彩色方案（本系统只一个 accent）
- 需要卡通 / 动画 / 插画风格（本系统是编辑风）
- Web 动态应用 UI（本系统只服务于静态可打印文档）

---

下一步：按 Step 3 的 tier 表决定读几份 reference，然后 Step 5 填模板、Step 6 出 PDF。
