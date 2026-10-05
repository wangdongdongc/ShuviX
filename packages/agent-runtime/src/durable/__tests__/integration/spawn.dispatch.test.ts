/**
 * P2-11 · J1：派发走完整条链 —— 真派发工具 → 真路由 → 真协调器 → 真 ToolHost（真文件套件、真 ask、真
 * McpManager 上的 SDK 服务器）→ 真安全 PEP。只断言跨模块边界的东西（协调器 / 路由的单元逻辑在 P2-03 / P2-05）。
 */
import { describe, expect, it } from 'vitest'
import { executeTool } from '../../../tools/testing/invokeTool'
import { answer, callTool } from '../support/faux'
import { registerHostCleanup } from '../support/host'
import { conversationIds } from '../support/spawn'
import { systemDeltas } from '../support/transcript'
import { waitFor, withTimeout } from '../support/wait'
import { memFs } from './support/memFs'
import { fileSuite, securityFor } from './support/realTools'
import { callTools, lastToolResult, when } from './support/scriptedModel'
import {
  childOfCall,
  recordOf,
  registerSpawnCleanup,
  resultOf,
  spawnWorld,
  toolTaskOf,
  transcriptOf,
  type SpawnWorld
} from './support/spawnWorld'
import { allow, nextInput, NOTES_TXT, registerWorldCleanup, resolvedCount } from './support/world'

registerHostCleanup()
registerWorldCleanup()
registerSpawnCleanup()

const TIMEOUT = 10000

const EXPLORE_TOOLS = [
  'read',
  'write',
  'ask',
  'hold',
  'mcp__docs__lookup',
  'mcp__docs__slow',
  'mcp__ctx__whoami'
]

const meta = (fields: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(fields).map(([key, value]) => [`shuvix.dev/${key}`, value]))

async function transcriptOfRoot(session: Parameters<typeof transcriptOf>[0]): Promise<string[]> {
  return transcriptOf(session, 1)
}

function afterEachHygiene(sw: SpawnWorld, sessionId = 's1'): void {
  expect(sw.router.tasks?.runningCount(sessionId, 'agent') ?? 0).toBe(0)
}

describe('P2-11 · J1 dispatch through the whole chain', () => {
  it(
    'J1-01 router + coordinator + identity + MCP _meta: the child runs real tools under its own identity on the shared MCP instance',
    async () => {
      const sw = await spawnWorld()
      const { world } = sw
      const session = await sw.open()
      const lockBefore = structuredClone(session.lock)
      const builtinBefore = world.toolHost.builtinCalls.length
      world.chat(
        callTool('mcp__ctx__whoami', {}, 'r-who'),
        callTool('agent', { name: 'explore', prompt: 'find X', description: 'look' }, 'r-agent'),
        answer('done')
      )
      world.model.chatIn(
        'explore',
        callTools(
          ['read', { path: 'notes.txt' }, 'c-read'],
          ['mcp__ctx__whoami', {}, 'c-who'],
          ['mcp__docs__lookup', { q: 'z' }, 'c-look']
        ),
        answer('found')
      )
      expect(await withTimeout(session.submitUser('go'), 8000, 'go')).toEqual({})

      // 结果与路由
      const C = await childOfCall(session, 'r-agent')
      const record = (await recordOf(session, C))!
      const A = record.agentId
      const rAgent = await resultOf(session, 1, 'r-agent')
      expect(rAgent.text).toBe('found')
      expect(rAgent.details).toEqual({ conversationId: C, agentId: A })
      expect((await transcriptOfRoot(session)).at(-1)).toBe('pi.assistant:done')
      const explore = world.model.laneRequests('explore')
      expect(explore).toHaveLength(2)
      expect(explore[0]!.modelId).toBe('faux-1')
      expect(explore[0]!.tools).toEqual(EXPLORE_TOOLS)
      expect(explore[0]!.tools).not.toContain('agent')

      const direct = await executeTool(
        fileSuite(memFs({ '/ws/notes.txt': NOTES_TXT }), securityFor('direct', undefined)).read,
        'c-read',
        { path: 'notes.txt' }
      )
      const cRead = await resultOf(session, C, 'c-read')
      expect(cRead.text).toBe(
        direct.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
      )

      // MCP 调用日志
      const rootTool = await toolTaskOf(session, 1, 'r-who')
      const childTool = await toolTaskOf(session, C, 'c-who')
      expect(childTool.id).not.toBe(rootTool.id)
      const whoami = world.mcpLog.callsOf('whoami', 'ctx')
      expect(whoami.map((call) => call.meta)).toEqual([
        meta({ toolCallId: 'r-who', agentId: 's1', taskId: rootTool.id, conversationId: 1 }),
        meta({ toolCallId: 'c-who', agentId: A, taskId: childTool.id, conversationId: C })
      ])
      expect(world.mcpLog.callsOf('lookup', 'docs').map((call) => call.meta)).toEqual([
        meta({ toolCallId: 'c-look' })
      ])
      expect(world.mcp.sessionConnects.get('ctx#s1')).toBe(1)

      // 记录与接缝
      expect(Object.keys(record.mcp)).toEqual(['docs', 'ctx'])
      expect(record.mcp.docs).toEqual(world.mcp.manager.declarationsOf('docs', 's1'))
      expect(record.mcp.ctx).toEqual(world.mcp.manager.declarationsOf('ctx', 's1'))
      expect(world.toolHost.resolveCalls).toHaveLength(2)
      expect(world.toolHost.resolveCalls[0]!.kind).toBe('root')
      expect(world.toolHost.resolveCalls[1]).toMatchObject({
        kind: 'spawned',
        sessionId: 's1',
        selfSessionId: A
      })
      // 子 agent 与会话共用 shuvix.builtin：派发不重建内置工具
      expect(world.toolHost.builtinCalls).toHaveLength(builtinBefore)
      expect(session.lock).toEqual(lockBefore)
      const rootConversation = await session.currentConversation()
      expect(await systemDeltas(rootConversation)).toHaveLength(1)

      // 路由
      expect(sw.router.registers()).toEqual([
        expect.objectContaining({
          sessionId: A,
          parentSessionId: 's1',
          parentToolCallId: 'r-agent',
          depth: 1
        })
      ])
      expect(sw.router.ends()).toEqual([
        expect.objectContaining({ sessionId: A, result: 'found', isError: false })
      ])
      expect(sw.router.task(A)?.status).toBe('done')
      expect(sw.router.router.locate(A)).toEqual({ sessionId: 's1', conversationId: C })
      afterEachHygiene(sw)
    },
    TIMEOUT
  )

  it(
    "J1-02 a child's ask lands on the session's card; allowing it writes once and the root completes",
    async () => {
      const sw = await spawnWorld()
      const { world } = sw
      const session = await sw.open()
      world.chat(
        callTool('agent', { name: 'explore', prompt: 'write it', description: 'w' }, 'r-agent'),
        answer('done')
      )
      world.model.chatIn(
        'explore',
        callTool('write', { path: 'out.txt', content: 'X' }, 'c-w'),
        answer('wrote')
      )
      const sending = session.submitUser('go')
      const request = await nextInput(world, 'c-w')
      expect(request).toMatchObject({ id: 'c-w', toolName: 'write' })
      expect(world.t.broadcastsOf('input_request')).toEqual([
        expect.objectContaining({ sessionId: 's1' })
      ])
      expect(session.pendingInputCount).toBe(1)
      const C = await childOfCall(session, 'r-agent')
      const A = (await recordOf(session, C))!.agentId
      const event = world.permissions.at(-1)!
      expect(event.conversationId).toBe(C)
      expect(event.taskId).toBe((await toolTaskOf(session, C, 'c-w')).id)
      expect(session.agentIdentity(C)).toMatchObject({
        kind: 'spawned',
        profileName: 'explore',
        callerId: A
      })
      expect(session.runState).toBe('busy')

      allow(world, 'c-w')
      expect(await withTimeout(sending, 5000, 'send')).toEqual({})
      expect(world.fs.files.get('/ws/out.txt')).toBe('X')
      expect(world.fs.writesTo('/ws/out.txt')).toBe(1)
      const direct = await executeTool(
        fileSuite(
          memFs({ '/ws/notes.txt': NOTES_TXT }),
          securityFor('direct', async () => ({ kind: 'ask', allowed: true }))
        ).write,
        'c-w',
        { path: 'out.txt', content: 'X' }
      )
      expect((await resultOf(session, C, 'c-w')).text).toBe(
        direct.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
      )
      expect(resolvedCount(world, 'c-w')).toBe(1)
      expect((await resultOf(session, 1, 'r-agent')).text).toBe('wrote')
      afterEachHygiene(sw)
    },
    TIMEOUT
  )

  it(
    'J1-03 two sessions: each child carries its own agentId, each session has its own ctx instance and its own child',
    async () => {
      const sw = await spawnWorld()
      const { world } = sw
      const s1 = await sw.open('s1')
      const s2 = await sw.open('s2')
      // 两条会话的根与子各走同一条车道：步骤按上下文作答，谁先到都一样
      const rootStep = when((messages) =>
        lastToolResult(messages, 'agent') === undefined
          ? callTool('agent', { name: 'explore', prompt: 'who', description: 'w' }, 'r-agent')
          : answer('done')
      )
      const childStep = when((messages) =>
        lastToolResult(messages, 'mcp__ctx__whoami') === undefined
          ? callTool('mcp__ctx__whoami', {}, 'c-who')
          : answer('found')
      )
      world.chat(rootStep, rootStep, rootStep, rootStep)
      world.model.chatIn('explore', childStep, childStep, childStep, childStep)
      const [r1, r2] = await withTimeout(
        Promise.all([s1.submitUser('go'), s2.submitUser('go')]),
        8000,
        'two sends'
      )
      expect(r1).toEqual({})
      expect(r2).toEqual({})

      const C1 = await childOfCall(s1, 'r-agent')
      const C2 = await childOfCall(s2, 'r-agent')
      const A1 = (await recordOf(s1, C1))!.agentId
      const A2 = (await recordOf(s2, C2))!.agentId
      expect(A1).not.toBe(A2)
      const metas = world.mcpLog.callsOf('whoami', 'ctx').map((call) => call.meta!)
      expect(metas.map((m) => m['shuvix.dev/agentId']).sort()).toEqual([A1, A2].sort())
      expect(world.mcp.sessionConnects.get('ctx#s1')).toBe(1)
      expect(world.mcp.sessionConnects.get('ctx#s2')).toBe(1)
      expect(sw.router.router.locate(A1)).toEqual({ sessionId: 's1', conversationId: C1 })
      expect(sw.router.router.locate(A2)).toEqual({ sessionId: 's2', conversationId: C2 })
      expect(await recordOf(s1, C1)).toMatchObject({ agentId: A1 })
      expect(await recordOf(s2, C2)).toMatchObject({ agentId: A2 })
      // 各自的存储里没有对方的子 agent
      for (const [session, own, other] of [
        [s1, A1, A2],
        [s2, A2, A1]
      ] as const) {
        const agentIds: string[] = []
        for (const id of await conversationIds(session)) {
          const found = await recordOf(session, id)
          if (found !== undefined) agentIds.push(found.agentId)
        }
        expect(agentIds).toEqual([own])
        expect(agentIds).not.toContain(other)
      }
      await waitFor(() => (sw.router.tasks?.runningCount('s2', 'agent') ?? 0) === 0, 1000, 's2')
      afterEachHygiene(sw)
    },
    TIMEOUT
  )
})
