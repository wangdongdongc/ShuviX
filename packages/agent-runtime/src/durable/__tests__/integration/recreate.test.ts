/**
 * P1-12 · 场景 7：销毁与重建。忙着（卡片挂着）时销毁 → 中止、解锁；改了会话的选择（模型 / 勾选 / 人设变量）
 * 之后的下一次发送按那时的配置重建 —— 新锁、新工具（一个 `pi.system` 工具增减）、重新冻结的人设、按新模型
 * 窗口算的压缩余量；被中止的那次调用与结果留在上下文里。重启之后按**新**锁重建。
 */
import { getCurrentSystemPrompt } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../../context'
import { AgentStateDoc } from '../../docs'
import type { DurableSession } from '../../durableSession'
import { answer, callTool, stalled } from '../support/faux'
import { registerHostCleanup } from '../support/host'
import { systemDeltas, transcript } from '../support/transcript'
import { withTimeout } from '../support/wait'
import { harnessErrorText, resultEntry, resultText } from './support/entries'
import { lines } from './support/scriptedModel'
import {
  makeWorld,
  nextInput,
  registerWorldCleanup,
  resolvedCount,
  type World
} from './support/world'

registerHostCleanup()
registerWorldCleanup()

const TIMEOUT = 10000
const RECOVERY_TIMEOUT = 20000
const WRITE_ARGS = { path: 'out.txt', content: 'X' }
const ABORTED = harnessErrorText('Tool write was aborted')

async function destroyWhileAsking(world: World): Promise<DurableSession> {
  const session = await world.open()
  world.chat(answer('ready'))
  expect(await session.submitUser('hello')).toEqual({})
  // 锁在 faux-1（窗口 40000）上：压缩余量 10000（K14）
  expect(session.effectiveSettings.compaction?.reserveTokens).toBe(10000)
  world.chat(callTool('write', WRITE_ARGS, 'c-w'))
  const saving = session.submitUser('save')
  await nextInput(world, 'c-w')
  await withTimeout(session.destroyAgent(), 3000, 'destroy')
  expect(await withTimeout(saving, 2000, 'save')).toEqual({})
  return session
}

/** 改选择：模型 tiny、勾选 [mcp:notes]、人设变量 v2 */
function changeSelection(world: World): void {
  world.config.model = { provider: 'faux', modelId: 'tiny' }
  world.config.toolOverlay = ['mcp:notes']
  world.vars.state.marker = 'v2'
}

describe('P1-12 · destroy and recreate', () => {
  it(
    'I7-01 destroy while a card is pending, change the selection, and the next send recreates the agent from the new selection',
    async () => {
      const world = await makeWorld()
      const session = await destroyWhileAsking(world)
      expect(resolvedCount(world, 'c-w')).toBe(1)
      expect(session.pendingInputCount).toBe(0)
      const conversation = await session.currentConversation()
      expect(resultText(await resultEntry(conversation, 'c-w'))).toBe(ABORTED)
      expect(session.lock).toBeUndefined()
      expect(world.t.mirror.at(-1)).toEqual(['s1', false])
      expect(
        world.t
          .broadcastsOf('agent_closing')
          .map((event) => (event as { closing: boolean }).closing)
      ).toEqual([true, false])
      expect(world.fs.writes).toEqual([])
      expect(session.effectiveSettings.compaction?.reserveTokens).toBe(32768)

      const personaBefore = getCurrentSystemPrompt(world.model.chats.at(-1)!.messages)
      expect(personaBefore).toContain('You are M1')
      changeSelection(world)
      world.chat(answer('recreated'))
      expect(await session.submitUser('again')).toEqual({})

      expect(world.t.configCalls).toHaveLength(2)
      expect(world.toolHost.resolveCalls).toHaveLength(2)
      expect(world.t.broadcastsOf('agent_created')).toHaveLength(2)
      const lock = session.lock!
      expect(lock.model).toEqual({ provider: 'faux', modelId: 'tiny' })
      expect(lock.toolNames.at(-1)).toBe('mcp__notes__search')
      expect(lock.toolNames.filter((name) => name.startsWith('mcp__docs__'))).toEqual([])
      expect(Object.keys(lock.mcp)).toEqual(['notes'])
      expect(lock.mcp.notes!.map((decl) => decl.name)).toEqual(['search'])
      expect(world.mcp.connectsOf('notes')).toBe(1)

      const deltas = await systemDeltas(conversation)
      const last = deltas
        .filter((delta) => delta.toolsAdded.length + delta.toolsRemoved.length > 0)
        .at(-1)!
      expect(last.toolsAdded).toContain('mcp__notes__search')
      expect(last.toolsRemoved).toEqual(
        expect.arrayContaining(['mcp__docs__lookup', 'mcp__docs__slow'])
      )

      const persona = (await session.harness.snapshot(AgentStateDoc, conversation.id, BG))?.persona
      expect(persona).toContain('v2')
      const request = world.model.chats.at(-1)!
      expect(request.modelId).toBe('tiny')
      const personaAfter = getCurrentSystemPrompt(request.messages)
      expect(personaAfter).toContain('You are v2')
      expect(personaAfter).not.toBe(personaBefore)
      expect(session.effectiveSettings.compaction?.reserveTokens).toBe(750)
      expect(lines(request)).toEqual(
        expect.arrayContaining(['assistant:[tool:write]', `toolResult:${ABORTED}`])
      )
      expect((await transcript(conversation)).at(-1)).toBe('pi.assistant:recreated')
    },
    TIMEOUT
  )

  it(
    'I7-02 a restart (with interrupted work) after the recreate fully initializes the new lock: notes offered and connected at open (option A), docs gone (tool not available)',
    async () => {
      const world = await makeWorld()
      const session = await destroyWhileAsking(world)
      changeSelection(world)
      world.chat(answer('recreated'))
      expect(await session.submitUser('again')).toEqual({})
      const lock = structuredClone(session.lock)
      const stall = stalled()
      world.chat(stall.step)
      void session.submitUser('use them')
      await withTimeout(stall.reached, 3000, 'request reached')
      await withTimeout(world.restart(), 10000, 'restart')

      const reopened = await world.open()
      expect(reopened.lock).toEqual(lock)
      expect(world.mcp.connectsOf('notes')).toBe(1)
      world.chat(
        callTool('mcp__notes__search', { q: 'n' }, 'c-n'),
        callTool('mcp__docs__lookup', { q: 'd' }, 'c-d'),
        answer('done')
      )
      expect(await withTimeout(reopened.continue(), 5000, 'continue')).toEqual({})
      const offered = world.model.chats[0]!.tools
      expect(offered).toContain('mcp__notes__search')
      expect(offered.filter((name) => name.startsWith('mcp__docs__'))).toEqual([])
      expect(world.mcp.connectsOf('notes')).toBe(1)
      expect(world.mcp.connectsOf('docs')).toBe(0)
      const conversation = await reopened.currentConversation()
      expect(resultText(await resultEntry(conversation, 'c-n'))).toBe('notes.search:n')
      expect(resultText(await resultEntry(conversation, 'c-d'))).toBe(
        harnessErrorText('Tool mcp__docs__lookup is not available')
      )
      expect(world.mcpLog.callsOf('lookup')).toEqual([])
      expect((await transcript(conversation)).at(-1)).toBe('pi.assistant:done')
    },
    RECOVERY_TIMEOUT
  )
})
