import { describe, it, expect } from 'vitest'
import {
  CHART_FILE_MARKER_KEY,
  CHART_FILE_MARKER,
  CHART_FILE_BANNER,
  CHART_FILE_REQUIREMENT_KEY,
  isChartFile,
  extractChartMermaid
} from './chartFileContract'

/** 按契约拼一个合法图表文件（frontmatter 载体） */
function chartFile(code: string, requirement = '展示登录流程'): string {
  return `---\n${CHART_FILE_MARKER_KEY}: ${CHART_FILE_MARKER}\ndescription: ${CHART_FILE_BANNER}\n${CHART_FILE_REQUIREMENT_KEY}: ${requirement}\n---\n\n\`\`\`mermaid\n${code}\n\`\`\`\n`
}

/** 旧载体（HTML 注释）—— 用户磁盘上契约初版留下的文件 */
function legacyChartFile(code: string): string {
  return `<!-- shuvix:chart v1\n${CHART_FILE_BANNER}\nrequirement: 展示登录流程\n-->\n\n\`\`\`mermaid\n${code}\n\`\`\`\n`
}

const FLOW = 'flowchart TD\n  A["开始"] --> B{"判断"}\n  B -->|"是"| C["结束"]'

describe('isChartFile', () => {
  it('识别 frontmatter 标记', () => {
    expect(isChartFile(chartFile(FLOW))).toBe(true)
  })

  it('容忍 BOM 与前导空白', () => {
    expect(isChartFile('﻿' + chartFile(FLOW))).toBe(true)
    expect(isChartFile('\n  ' + chartFile(FLOW))).toBe(true)
  })

  it('容忍标记行的空白 / 引号 / 版本变体', () => {
    expect(isChartFile('---\nshuvix:chart v1\n---\n')).toBe(true)
    expect(isChartFile('---\nshuvix:   chart\n---\n')).toBe(true)
    expect(isChartFile(`---\nshuvix: 'chart v1'\n---\n`)).toBe(true)
  })

  it('标记不必是 frontmatter 首行', () => {
    expect(isChartFile('---\nname: x\nshuvix: chart v1\n---\n')).toBe(true)
  })

  it('旧载体（HTML 注释）仍按图表识别', () => {
    expect(isChartFile(legacyChartFile(FLOW))).toBe(true)
    expect(isChartFile('<!--shuvix:chart v1\n-->')).toBe(true)
    expect(isChartFile('<!--   shuvix:chart\n-->')).toBe(true)
  })

  it('token 出现在正文/代码块中不误判（只认文件开头）', () => {
    expect(isChartFile('# doc\n\n`shuvix: chart v1` 是图表契约的标记\n')).toBe(false)
    expect(isChartFile('```\n<!-- shuvix:chart v1\n```\n')).toBe(false)
    // 正文里的 `---` 分隔线后跟标记行 —— frontmatter 只认文件开头，不误判
    expect(isChartFile('# doc\n\n---\nshuvix: chart v1\n---\n')).toBe(false)
  })

  it('非图表的 frontmatter 与普通注释不误判', () => {
    expect(isChartFile('---\nshuvix: agent v1\nname: explore\n---\n\n正文')).toBe(false)
    expect(isChartFile('---\ntitle: 普通笔记\n---\n\n正文')).toBe(false)
    expect(isChartFile('<!-- just a note -->\n# hi')).toBe(false)
    expect(isChartFile('---\nshuvix: charter\n---\n')).toBe(false) // \b 词边界
  })
})

describe('extractChartMermaid', () => {
  it('提取唯一 mermaid 块', () => {
    expect(extractChartMermaid(chartFile(FLOW))).toBe(FLOW)
    expect(extractChartMermaid(legacyChartFile(FLOW))).toBe(FLOW)
  })

  it('容忍 CRLF 与围栏缩进', () => {
    const crlf = chartFile(FLOW).replace(/\n/g, '\r\n')
    expect(extractChartMermaid(crlf)?.replace(/\r/g, '')).toBe(FLOW)
    const indented = `---\nshuvix: chart v1\n---\n\n  \`\`\`mermaid\n${FLOW}\n  \`\`\`\n`
    expect(extractChartMermaid(indented)).toBe(FLOW)
  })

  it('无标记 → null（即使有 mermaid 块）', () => {
    expect(extractChartMermaid(`\`\`\`mermaid\n${FLOW}\n\`\`\`\n`)).toBeNull()
  })

  it('零个 / 多个 mermaid 块 → null（降级回 markdown 预览）', () => {
    expect(extractChartMermaid('---\nshuvix: chart v1\n---\n\n没有代码块')).toBeNull()
    const two = chartFile(FLOW) + `\n\`\`\`mermaid\npie\n\`\`\`\n`
    expect(extractChartMermaid(two)).toBeNull()
  })

  it('空 mermaid 块 → null', () => {
    expect(extractChartMermaid(chartFile('  '))).toBeNull()
  })

  it('非 mermaid 围栏不计数', () => {
    const withJs = chartFile(FLOW) + '\n```js\nconsole.log(1)\n```\n'
    // 契约本不允许第二个块，但提取器只认 mermaid 围栏 —— js 块不影响唯一性判定
    expect(extractChartMermaid(withJs)).toBe(FLOW)
  })
})
