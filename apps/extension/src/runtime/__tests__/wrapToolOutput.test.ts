/**
 * 扩展端工具包装（wrapToolOutput）的 L1 全工具门接线 —— MCP 工具带着可判定的事实过门。
 *
 * 浏览器改成内置 MCP 能力服务器之后，「浏览器的非只读动作要问」这类策略只写得出来一种形态：看
 * `invocation` 客体上的 MCP 事实（server / tool + 可信 server 的 annotations）。这些事实挂在工具的
 * `mcpMeta` 上（McpManager 的桥接层给的），包装层要把它**原样**交给 enforceInvocation —— 与桌面同一口径。
 *
 *   - 接线：mcp 就是 tool.mcpMeta 那个对象；普通工具没有；包两层（Object.create 的原型链）也照样带上；
 *   - 端到端：真的安全上下文（扩展的 provider + 一条用户策略），浏览器的 click（非只读）问、
 *     snapshot（只读）不问 —— 两者的只读与否取自真的浏览器工具目录，不在这里手写。
 */
import { describe, expect, it, vi } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import {
  browserToolsForCaps,
  createSecurityContext,
  type BrowserCaps,
  type McpInvocationFacts,
  type SecurityContext,
  type SpillSink
} from '@shuvix/agent-runtime'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { createExtensionSecurityProvider } from '../securityProvider'
import { wrapToolOutput } from '../wrapToolOutput'

const SINK: SpillSink = { write: async () => null }

/** 一个只回一句话的工具；mcpMeta 给了就挂上（与 McpManager 桥接层产出的形状一致） */
function fakeTool(
  name: string,
  mcpMeta?: McpInvocationFacts
): AgentTool & { execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(async () => ({
    content: [{ type: 'text' as const, text: `${name} ran` }],
    details: undefined as never
  }))
  return {
    name,
    label: name,
    description: name,
    parameters: {} as AgentTool['parameters'],
    execute,
    ...(mcpMeta ? { mcpMeta } : {})
  } as unknown as AgentTool & { execute: ReturnType<typeof vi.fn> }
}

/** 记录 enforceInvocation 入参的假安全上下文（恒放行） */
function recordingSecurity(): {
  security: SecurityContext
  enforceInvocation: ReturnType<typeof vi.fn>
} {
  const enforceInvocation = vi.fn(async () => ({ status: 'allowed' as const }))
  return { security: { enforceInvocation } as unknown as SecurityContext, enforceInvocation }
}

const CLICK_FACTS: McpInvocationFacts = {
  server: 'browser',
  tool: 'click',
  trusted: true,
  readOnly: false,
  destructive: true,
  idempotent: false,
  openWorld: true
}

describe('L1 门的接线：MCP 事实原样交出去', () => {
  it('WTO-1 MCP 工具：mcp 就是 tool.mcpMeta 那个对象；operation 为空；扩展的取消文案与「其它」按结果返回', async () => {
    const tool = fakeTool('mcp__browser__click', CLICK_FACTS)
    const { security, enforceInvocation } = recordingSecurity()
    const wrapped = wrapToolOutput(tool, SINK, security)
    const result = await wrapped.execute('tc-1', { uid: 'e5' }, undefined, undefined)
    expect(enforceInvocation).toHaveBeenCalledTimes(1)
    const opts = enforceInvocation.mock.calls[0][0] as Record<string, unknown>
    expect(opts).toEqual({
      toolCallId: 'tc-1',
      toolName: 'mcp__browser__click',
      operation: undefined,
      abortError: 'TOOL_ABORTED',
      onOther: 'return',
      mcp: CLICK_FACTS
    })
    expect(opts.mcp).toBe((tool as unknown as { mcpMeta: McpInvocationFacts }).mcpMeta)
    // 放行后照常执行
    expect(tool.execute).toHaveBeenCalledTimes(1)
    expect(result.content).toEqual([{ type: 'text', text: 'mcp__browser__click ran' }])
  })

  it('WTO-2 普通工具：没有 mcp 事实（字段是 undefined，不是空对象）', async () => {
    const tool = fakeTool('read')
    const { security, enforceInvocation } = recordingSecurity()
    await wrapToolOutput(tool, SINK, security).execute(
      'tc-2',
      { path: 'a.md' },
      undefined,
      undefined
    )
    const opts = enforceInvocation.mock.calls[0][0] as Record<string, unknown>
    expect(opts.toolName).toBe('read')
    expect(opts.mcp).toBeUndefined()
  })

  it('WTO-3 包了两层（外层的原型是内层）：两层都带上同一份 mcpMeta', async () => {
    const tool = fakeTool('mcp__browser__click', CLICK_FACTS)
    const { security, enforceInvocation } = recordingSecurity()
    const twice = wrapToolOutput(wrapToolOutput(tool, SINK, security), SINK, security)
    // mcpMeta 是继承来的，不是自有属性 —— 读法必须走原型链
    expect(Object.prototype.hasOwnProperty.call(twice, 'mcpMeta')).toBe(false)
    await twice.execute('tc-3', { uid: 'e5' }, undefined, undefined)
    expect(enforceInvocation).toHaveBeenCalledTimes(2)
    for (const [opts] of enforceInvocation.mock.calls) {
      expect((opts as { mcp?: unknown }).mcp).toBe(CLICK_FACTS)
    }
    expect(tool.execute).toHaveBeenCalledTimes(1)
  })
})

/** 扩展的浏览器能力（与 ExtensionBrowserBackend.caps 同值；只用来取工具目录里的 annotations） */
const EXTENSION_CAPS: BrowserCaps = {
  pdf: false,
  fullPageScreenshot: false,
  elementScreenshot: false,
  screenshotToFile: false,
  evaluate: true,
  network: true,
  console: true,
  rawCdp: true,
  upload: false
}

/** 按真的工具目录给浏览器工具拼 mcpMeta（与 McpManager 对可信 server 的做法一致） */
function browserFacts(tool: string): McpInvocationFacts {
  const spec = browserToolsForCaps(EXTENSION_CAPS).find((t) => t.name === tool)
  expect(spec, `浏览器工具目录里应有 ${tool}`).toBeDefined()
  const a = spec!.annotations ?? {}
  return {
    server: 'browser',
    tool,
    trusted: true,
    readOnly: a.readOnlyHint,
    destructive: a.destructiveHint,
    idempotent: a.idempotentHint,
    openWorld: a.openWorldHint
  }
}

describe('端到端：一条「浏览器的非只读动作要问」的用户策略', () => {
  const RULE = {
    effect: 'ask' as const,
    match:
      "has(object.mcpServer) && object.mcpServer == 'browser' && object.mcpTrusted && !object.readOnly"
  }

  function realSecurity(): {
    security: SecurityContext
    requestUserInput: ReturnType<typeof vi.fn>
  } {
    const requestUserInput = vi.fn(
      async (_req: InputRequest): Promise<InputResponse> => ({ kind: 'ask', allowed: true })
    )
    const provider = {
      ...createExtensionSecurityProvider(requestUserInput),
      getUserPolicies: () => [
        {
          name: 'browser-writes',
          displayName: 'browser-writes',
          description: '',
          rules: [RULE],
          body: ''
        }
      ]
    }
    const security = createSecurityContext(
      { kind: 'agent', sessionId: 'wto-e2e', agentKind: 'root' },
      { host: 'extension' },
      provider
    )
    return { security, requestUserInput }
  }

  it('WTO-4 语料自检：目录里 click 不是只读、snapshot 是只读', () => {
    expect(browserFacts('click').readOnly).toBe(false)
    expect(browserFacts('snapshot').readOnly).toBe(true)
  })

  it('WTO-5 click（非只读）→ 弹询问（点名 mcp__browser__click），允许后执行', async () => {
    const { security, requestUserInput } = realSecurity()
    const tool = fakeTool('mcp__browser__click', browserFacts('click'))
    await wrapToolOutput(tool, SINK, security).execute('tc-c', { uid: 'e1' }, undefined, undefined)
    expect(requestUserInput).toHaveBeenCalledTimes(1)
    expect(requestUserInput.mock.calls[0][0]).toMatchObject({
      kind: 'ask',
      id: 'tc-c',
      toolName: 'mcp__browser__click'
    })
    expect(tool.execute).toHaveBeenCalledTimes(1)
  })

  it('WTO-6 snapshot（只读）→ 不问，直接执行；普通工具与不可信 server 的同名工具也不问', async () => {
    const { security, requestUserInput } = realSecurity()
    const snapshot = fakeTool('mcp__browser__snapshot', browserFacts('snapshot'))
    await wrapToolOutput(snapshot, SINK, security).execute('tc-s', {}, undefined, undefined)
    expect(snapshot.execute).toHaveBeenCalledTimes(1)

    const read = fakeTool('read')
    await wrapToolOutput(read, SINK, security).execute('tc-r', { path: 'a' }, undefined, undefined)
    expect(read.execute).toHaveBeenCalledTimes(1)

    const untrusted = fakeTool('mcp__other__click', {
      server: 'other',
      tool: 'click',
      trusted: false
    })
    await wrapToolOutput(untrusted, SINK, security).execute('tc-u', {}, undefined, undefined)
    expect(untrusted.execute).toHaveBeenCalledTimes(1)

    expect(requestUserInput).not.toHaveBeenCalled()
  })
})
