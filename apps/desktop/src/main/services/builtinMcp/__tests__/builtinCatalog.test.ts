/**
 * 内置能力服务器的清单对账 —— 「有哪些内置 server、它们各有哪些工具」写在三个地方，
 * 任何一处漏改都是**静默**的：
 *   BC-1  工厂表（builtinMcp/index.ts）的键 = 呈现表（chat-protocol builtinMcpPresentations）的键。
 *         有 server 没呈现 = 它的工具在界面上只剩扳手图标与原始工具名。
 *   BC-2  呈现表里 browser 的工具名单 = server 目录（browserToolsForCaps，端能力全开）的工具名。
 *         名单是防冒名的白名单（一台叫 `browser__x` 的自定义 server 靠它认不出来），不在单子上的
 *         一律不认 —— 目录里新加一个工具而名单没跟上，那个工具就丢了图标、标签与折叠摘要。
 *
 * chat-protocol 不能依赖 agent-runtime，所以这份对账放在桌面这边。ssh 那一份在 sshServer.test.ts
 * （它的工具面要真的起一台 server 才列得出来）。
 */
import { describe, expect, it, vi } from 'vitest'
import { browserToolsForCaps, type BrowserCaps } from '@shuvix/agent-runtime'
import {
  BUILTIN_MCP_PRESENTATIONS,
  parseBuiltinMcpToolName
} from '@shuvix/chat-protocol/builtinMcpPresentations'

// 工厂表只要键：两台 server 的桌面接线会拉进 Electron 的面板与 toolContext，换成空工厂
vi.mock('../sshServer', () => ({ createSshMcpServerFactory: () => () => undefined }))
vi.mock('../browserServer', () => ({
  createDesktopBrowserMcpServerFactory: () => () => undefined
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { BUILTIN_MCP_FACTORIES } from '../index'

/** 端能力全开 —— 目录里的每一个工具都在（BrowserCaps 新增一项时这里编译不过，逼着补上） */
const ALL_CAPS: BrowserCaps = {
  pdf: true,
  fullPageScreenshot: true,
  elementScreenshot: true,
  screenshotToFile: true,
  evaluate: true,
  network: true,
  console: true,
  rawCdp: true,
  upload: true
}

describe('内置能力服务器的清单对账', () => {
  it('BC-1 每台内置 server 都有专属呈现：工厂表的键 = 呈现表的键', () => {
    expect(Object.keys(BUILTIN_MCP_PRESENTATIONS).sort()).toEqual(
      Object.keys(BUILTIN_MCP_FACTORIES).sort()
    )
  })

  it('BC-2 呈现表里 browser 的工具名单 = server 目录（能力全开）的全部工具名，不多不少、没有重复', () => {
    const catalog = browserToolsForCaps(ALL_CAPS).map((t) => t.name)
    const listed = BUILTIN_MCP_PRESENTATIONS.browser.toolNames
    expect(new Set(listed).size).toBe(listed.length)
    expect([...listed].sort()).toEqual([...catalog].sort())
  })

  it('BC-2 目录里的每个工具都认得出是内置 browser 的（界面拿到图标、标签与摘要）', () => {
    for (const tool of browserToolsForCaps(ALL_CAPS)) {
      expect(parseBuiltinMcpToolName(`mcp__browser__${tool.name}`), tool.name).toEqual({
        server: 'browser',
        tool: tool.name
      })
    }
  })
})
