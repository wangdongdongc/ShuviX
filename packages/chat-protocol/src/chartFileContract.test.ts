import { describe, it, expect } from 'vitest'
import {
  CHART_FILE_MARKER_LINE,
  CHART_FILE_BANNER,
  isChartFile,
  extractChartMermaid
} from './chartFileContract'

/** 按契约拼一个合法图表文件 */
function chartFile(code: string, requirement = '展示登录流程'): string {
  return `${CHART_FILE_MARKER_LINE}\n${CHART_FILE_BANNER}\nrequirement: ${requirement}\n-->\n\n\`\`\`mermaid\n${code}\n\`\`\`\n`
}

const FLOW = 'flowchart TD\n  A["开始"] --> B{"判断"}\n  B -->|"是"| C["结束"]'

describe('isChartFile', () => {
  it('识别规范首行标记', () => {
    expect(isChartFile(chartFile(FLOW))).toBe(true)
  })

  it('容忍 BOM 与前导空白', () => {
    expect(isChartFile('﻿' + chartFile(FLOW))).toBe(true)
    expect(isChartFile('\n  ' + chartFile(FLOW))).toBe(true)
  })

  it('容忍注释内空白变体', () => {
    expect(isChartFile('<!--shuvix:chart v1\n-->')).toBe(true)
    expect(isChartFile('<!--   shuvix:chart\n-->')).toBe(true)
  })

  it('token 出现在正文/代码块中不误判（只认文件开头）', () => {
    expect(isChartFile('# doc\n\n`<!-- shuvix:chart v1` 是图表契约的标记\n')).toBe(false)
    expect(isChartFile('```\n<!-- shuvix:chart v1\n```\n')).toBe(false)
  })

  it('普通注释开头不误判', () => {
    expect(isChartFile('<!-- just a note -->\n# hi')).toBe(false)
    expect(isChartFile('<!-- shuvix:charter -->\n')).toBe(false) // \b 词边界
  })
})

describe('extractChartMermaid', () => {
  it('提取唯一 mermaid 块', () => {
    expect(extractChartMermaid(chartFile(FLOW))).toBe(FLOW)
  })

  it('容忍 CRLF 与围栏缩进', () => {
    const crlf = chartFile(FLOW).replace(/\n/g, '\r\n')
    expect(extractChartMermaid(crlf)?.replace(/\r/g, '')).toBe(FLOW)
    const indented = `${CHART_FILE_MARKER_LINE}\n-->\n\n  \`\`\`mermaid\n${FLOW}\n  \`\`\`\n`
    expect(extractChartMermaid(indented)).toBe(FLOW)
  })

  it('无标记 → null（即使有 mermaid 块）', () => {
    expect(extractChartMermaid(`\`\`\`mermaid\n${FLOW}\n\`\`\`\n`)).toBeNull()
  })

  it('零个 / 多个 mermaid 块 → null（降级回 markdown 预览）', () => {
    expect(extractChartMermaid(`${CHART_FILE_MARKER_LINE}\n-->\n\n没有代码块`)).toBeNull()
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
