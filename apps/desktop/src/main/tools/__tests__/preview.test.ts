/**
 * preview 工具（桌面装配）单元测试
 * 使用临时目录 + 真实 previewFile 分类内核，mock resolveProjectConfig / toolRegistry / i18n /
 * logger / 渲染验证 broker：验证路径解析（相对→工作目录）、工作目录准入限制、文件存在性、
 * 分类结局（binary→错误）、图表渲染验证分支（失败不发事件 / 成功注记）与 file_preview 事件发射。
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), 'shuvix-preview-test-' + Date.now())
const OUTSIDE_DIR = join(tmpdir(), 'shuvix-preview-outside-' + Date.now())
const SESSION_ID = 'test-session-preview'

// mock toolContext（避免加载 projectDao/sessionService → electron app.getPath）
vi.mock('../../services/toolContext', () => ({
  resolveProjectConfig: () => ({
    workingDirectory: TEST_DIR,
    referenceDirs: []
  }),
  isPathWithinWorkspace: (absolutePath: string, workingDirectory: string) => {
    const r = resolve(absolutePath)
    const base = resolve(workingDirectory)
    return r === base || r.startsWith(base + sep)
  },
  TOOL_ABORTED: 'Aborted'
}))

// mock toolRegistry — 文件底部的 registerBuiltinTool 在测试里是 no-op
vi.mock('../../services/toolRegistry', () => ({
  registerBuiltinTool: () => {}
}))

// mock i18n
vi.mock('../../i18n', () => ({
  t: (key: string) => key
}))

// mock logger
vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {}
  })
}))

// mock 渲染验证 broker（避免加载 electron appEvents 桥；分支语义在共享内核单测覆盖）
const validateMock = vi.fn(
  async (_params: { sessionId: string; absPath: string }): Promise<ChartValidation> => ({
    ok: true,
    verified: true
  })
)
vi.mock('../../services/previewValidationBroker', () => ({
  validateChartViaRenderer: (params: { sessionId: string; absPath: string }) => validateMock(params)
}))

import type { ChartValidation } from '@shuvix/agent-runtime'
import { makePreviewTool } from '../preview'
import type { ToolContext, ChatEventPayload } from '../../services/toolContext'

function makeTool(events?: ChatEventPayload[]): ReturnType<typeof makePreviewTool> {
  const ctx: ToolContext = {
    sessionId: SESSION_ID,
    emitChatEvent: events ? (e) => events.push(e) : undefined
  }
  return makePreviewTool(ctx)
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
}

const CHART = `---
shuvix: chart v1
description: banner
shuvix-chart-requirement: 测试
---

\`\`\`mermaid
flowchart TD
  A --> B
\`\`\`
`

beforeAll(() => {
  mkdirSync(join(TEST_DIR, 'charts'), { recursive: true })
  mkdirSync(OUTSIDE_DIR, { recursive: true })
  writeFileSync(join(TEST_DIR, 'plain.md'), '# 普通文档\n\n正文\n')
  writeFileSync(join(TEST_DIR, 'charts', 'nested-graph.md'), CHART)
  writeFileSync(join(TEST_DIR, 'archive.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))
  writeFileSync(join(OUTSIDE_DIR, 'escape-graph.md'), CHART)
})

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  rmSync(OUTSIDE_DIR, { recursive: true, force: true })
})

describe('PreviewTool（桌面装配）', () => {
  it('相对路径按工作目录解析并发 file_preview 事件', async () => {
    const events: ChatEventPayload[] = []
    const tool = makeTool(events)
    const result = await tool.execute('call-1', { path: 'plain.md' })

    const abs = join(TEST_DIR, 'plain.md')
    expect(events).toEqual([{ type: 'file_preview', absPath: abs }])
    expect(textOf(result)).toContain(abs)
  })

  it('接受工作目录内的绝对路径；图表文件带渲染验证注记', async () => {
    const events: ChatEventPayload[] = []
    const tool = makeTool(events)
    const abs = join(TEST_DIR, 'charts', 'nested-graph.md')
    const result = await tool.execute('call-2', { path: abs })

    expect(events).toEqual([{ type: 'file_preview', absPath: abs }])
    expect(textOf(result)).toMatch(/Chart rendered successfully/)
    expect(validateMock).toHaveBeenCalledWith(expect.objectContaining({ sessionId: SESSION_ID }))
  })

  it('拒绝工作目录之外的路径', async () => {
    const events: ChatEventPayload[] = []
    const tool = makeTool(events)
    await expect(
      tool.execute('call-3', { path: join(OUTSIDE_DIR, 'escape-graph.md') })
    ).rejects.toThrow(/inside the working directory/)
    expect(events).toEqual([])
  })

  it('文件不存在 / 目录路径 → 报错', async () => {
    const tool = makeTool([])
    await expect(tool.execute('call-4', { path: 'not-there-graph.md' })).rejects.toThrow(
      /File not found/
    )
    await expect(tool.execute('call-5', { path: 'charts' })).rejects.toThrow(/Not a regular file/)
  })

  it('binary 分类（.zip）→ 报错且不发事件', async () => {
    const events: ChatEventPayload[] = []
    const tool = makeTool(events)
    await expect(tool.execute('call-6', { path: 'archive.zip' })).rejects.toThrow(
      /Preview not supported/
    )
    expect(events).toEqual([])
  })

  it('图表渲染验证失败 → 报错且不发事件', async () => {
    validateMock.mockResolvedValueOnce({
      ok: false,
      error: 'Parse error on line 2',
      verified: true
    })
    const events: ChatEventPayload[] = []
    const tool = makeTool(events)
    await expect(tool.execute('call-7', { path: 'charts/nested-graph.md' })).rejects.toThrow(
      /Parse error on line 2/
    )
    expect(events).toEqual([])
  })

  it('无前端事件通道时报错', async () => {
    const tool = makeTool(undefined)
    await expect(tool.execute('call-8', { path: 'plain.md' })).rejects.toThrow(
      /no frontend event channel/
    )
  })
})
