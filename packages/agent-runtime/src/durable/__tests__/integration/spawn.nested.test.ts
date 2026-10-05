/**
 * P2-11 · J2：嵌套深度 —— 根 → C（nester）→ G（nester）。拥有者链、记录的深度与 canSpawn、派发工具的门控、
 * 每层自己的调用方身份、路由的父子关系与收尾次序。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { answer, callTool } from '../support/faux'
import { registerHostCleanup } from '../support/host'
import { conversationIds } from '../support/spawn'
import { withTimeout } from '../support/wait'
import {
  childOfCall,
  ownerOf,
  recordOf,
  releaseHolds,
  resultOf,
  spawnWorld,
  toolTaskOf
} from './support/spawnWorld'
import { registerWorldCleanup } from './support/world'

registerHostCleanup()
registerWorldCleanup()
afterEach(() => releaseHolds())

const TIMEOUT = 10000

describe('P2-11 · J2 nested depth', () => {
  it(
    'J2-01 root → C (nester) → G (nester): owner chain, depth / canSpawn, the agent tool gate, identities and router lineage',
    async () => {
      const sw = await spawnWorld()
      const { world } = sw
      const session = await sw.open()
      world.chat(
        callTool('agent', { name: 'nester', prompt: 'find X', description: 'nest' }, 'r-agent'),
        answer('done')
      )
      world.model.chatIn(
        'nester',
        callTool('mcp__ctx__whoami', {}, 'c-who'),
        callTool('agent', { name: 'nester', prompt: 'dig deeper', description: 'deeper' }, 'c-agent'),
        answer('c-done')
      )
      world.model.chatIn('g', callTool('mcp__ctx__whoami', {}, 'g-who'), answer('g-found'))
      expect(await withTimeout(session.submitUser('go'), 8000, 'go')).toEqual({})

      // 结构
      expect(await conversationIds(session)).toHaveLength(3)
      const rootDispatch = await toolTaskOf(session, 1, 'r-agent')
      const C = await childOfCall(session, 'r-agent')
      expect(await ownerOf(session, C)).toEqual({ conversationId: 1, taskId: rootDispatch.id })
      const cDispatch = await toolTaskOf(session, C, 'c-agent')
      const G = await childOfCall(session, 'c-agent', C)
      expect(await ownerOf(session, G)).toEqual({ conversationId: C, taskId: cDispatch.id })
      const recordC = (await recordOf(session, C))!
      const recordG = (await recordOf(session, G))!
      expect(recordC).toMatchObject({ depth: 1, canSpawn: true, parentConversationId: 1 })
      expect(recordG).toMatchObject({ depth: 2, canSpawn: false, parentConversationId: C })
      expect(world.model.laneRequests('nester')[0]!.tools).toContain('agent')
      expect(world.model.laneRequests('g')[0]!.tools).not.toContain('agent')
      expect(world.model.laneRequests('g')[0]!.tools).toEqual(['read', 'mcp__ctx__whoami'])

      // 身份与路由
      const A_C = recordC.agentId
      const A_G = recordG.agentId
      const whoami = world.mcpLog.callsOf('whoami', 'ctx').map((call) => call.meta!)
      expect(whoami).toEqual([
        expect.objectContaining({
          'shuvix.dev/toolCallId': 'c-who',
          'shuvix.dev/agentId': A_C,
          'shuvix.dev/conversationId': C
        }),
        expect.objectContaining({
          'shuvix.dev/toolCallId': 'g-who',
          'shuvix.dev/agentId': A_G,
          'shuvix.dev/conversationId': G
        })
      ])
      const registers = sw.router.registers()
      expect(registers).toHaveLength(2)
      expect(registers[1]).toMatchObject({
        sessionId: A_G,
        parentSessionId: A_C,
        parentToolCallId: 'c-agent',
        depth: 2,
        rootSessionId: 's1'
      })
      expect(sw.router.ends().map((end) => [end.sessionId, end.isError])).toEqual([
        [A_G, false],
        [A_C, false]
      ])
      expect(sw.router.task(A_G)).toMatchObject({ status: 'done', sessionId: 's1' })
      expect(sw.router.task(A_C)).toMatchObject({ status: 'done', sessionId: 's1' })

      // 结果
      expect((await resultOf(session, C, 'c-agent')).text).toBe('g-found')
      expect((await resultOf(session, 1, 'r-agent')).text).toBe('c-done')
      expect(sw.router.tasks?.runningCount('s1', 'agent')).toBe(0)
    },
    TIMEOUT
  )
})
