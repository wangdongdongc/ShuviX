/**
 * CM-CL-01（桌面侧）：验证 `tool_search`、`ask`、`suggest`、`next` 均声明 `callers: ['model']`，
 * 且经 `wrapDurableTool` 包装后 `callers` 属性完整保留。
 */
import { describe, expect, it, vi } from 'vitest'
import { createAskTool, createSuggestTool, NextTool } from '@shuvix/agent-runtime'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/shuvix-callers-test', isPackaged: false },
  BrowserWindow: class {},
  session: {}
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))
vi.mock('../../i18n', () => ({
  t: (key: string) => key
}))
vi.mock('../../services/toolRegistry', () => ({
  registerBuiltinTool: () => {}
}))
vi.mock('../../services/mcpService', () => ({
  mcpService: {
    configuredServers: () => [],
    ensureServerByName: vi.fn(),
    getError: vi.fn()
  }
}))
vi.mock('../../services/sessionService', () => ({
  sessionService: {
    rootToolState: vi.fn(),
    previewAgentChange: vi.fn(),
    enableServer: vi.fn(),
    lockedServerTools: vi.fn()
  }
}))
vi.mock('../../services/toolContext', () => ({
  assertExtensionAccess: vi.fn()
}))
vi.mock('../../services/widget/widgetRegistry', () => ({
  widgetRegistry: { findById: () => undefined }
}))

import { ToolSearchTool } from '../toolSearch'
import type { ToolContext } from '../../services/toolContext'
import { wrapDurableTool } from '../../services/wrapToolOutput'

describe('CM-CL-01 · model-only 工具的 callers 声明与 wrapDurableTool 透传', () => {
  it('ask / suggest / next / tool_search 均声明 callers: ["model"]，经 wrapDurableTool 包装后仍完整保留', () => {
    const toolSearch = new ToolSearchTool({ sessionId: 's-callers' } as unknown as ToolContext)
    const ask = createAskTool({
      requestUserInput: async () => ({ kind: 'choice', selections: ['A'] })
    })
    const suggest = createSuggestTool()
    const next = new NextTool({
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok']
    })

    for (const tool of [ask, suggest, next, toolSearch] as const) {
      expect(tool.callers, tool.name).toEqual(['model'])
      const wrapped = wrapDurableTool(tool, { sessionId: 's-callers', spill: false })
      expect(wrapped.callers, `wrapped ${tool.name}`).toEqual(['model'])
    }
  })
})
