/**
 * P1-12 · 场景 1：完整的上锁生命周期（真锁 + 真文件工具 + 真安全模块 + 真 McpManager + 真包装器）。
 *
 * 单元套件已经各自钉住的（路由、锁的各分支、包装器内核……）这里不再复述；这里看的是**整条链**交出的
 * 跨模块状态：锁记录、请求里的工具、转写、durable 文档、询问广播、锁镜像与运行状态镜像、用量。
 */
import { InboxDoc, LiveDoc, UsageDoc, type EntryRecord } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { formatSize } from '../../../fileTools/truncate'
import { executeTool } from '../../../tools/testing/invokeTool'
import { backgroundContext as BG } from '../../context'
import type { DurableSession } from '../../durableSession'
import { answer, callTool, held } from '../support/faux'
import { registerHostCleanup } from '../support/host'
import { allEntries, toolDeltaCount, transcript } from '../support/transcript'
import { waitFor, withTimeout } from '../support/wait'
import { diagnosticsOf, resultEntry as entryOf, resultMessage } from './support/entries'
import { dumpText, fileSuite, securityFor } from './support/realTools'
import { lines } from './support/scriptedModel'
import { spillPath } from './support/spill'
import {
  allow,
  E_TOOLS,
  makeWorld,
  nextInput,
  registerWorldCleanup,
  type World
} from './support/world'

registerHostCleanup()
registerWorldCleanup()

const TIMEOUT = 10000

async function resultEntry(session: DurableSession, callId: string): Promise<EntryRecord> {
  return entryOf(await session.currentConversation(), callId)
}

async function firstSend(world: World): Promise<DurableSession> {
  const session = await world.open()
  world.chat(callTool('read', { path: 'notes.txt' }, 'c-read'), answer('a1'))
  expect(await withTimeout(session.submitUser('read notes'), 5000, 'first send')).toEqual({})
  return session
}

describe('P1-12 · lifecycle', () => {
  it(
    'I1-01 the first send locks, then a safe tool runs through the real read tool',
    async () => {
      const world = await makeWorld()
      const session = await world.open()
      const mirrorAtOpen = world.t.mirror.length
      expect(world.t.mirror).toEqual([['s1', false]])
      world.chat(callTool('read', { path: 'notes.txt' }, 'c-read'), answer('a1'))
      expect(await session.submitUser('read notes')).toEqual({})

      const lock = session.lock!
      expect(lock.toolNames).toEqual(E_TOOLS)
      expect(lock.mcp.docs).toEqual(world.mcp.manager.declarationsOf('docs'))
      expect(Object.keys(lock.mcp)).toEqual(['docs'])
      expect(world.model.chats[0]!.tools).toEqual(E_TOOLS)
      expect(world.t.configCalls).toEqual(['s1'])
      expect(world.toolHost.resolveCalls).toHaveLength(1)
      expect(world.t.broadcastsOf('agent_created')).toHaveLength(1)
      expect(world.t.mirror.slice(mirrorAtOpen)).toEqual([['s1', true]])
      expect(world.mcp.connectsOf('docs')).toBe(1)

      // 结果条目 = 直接调一次真 read（同一个 MemFs）交回的那一份
      const direct = await executeTool(
        fileSuite(world.fs, securityFor('direct', undefined)).read,
        'c-read',
        { path: 'notes.txt' }
      )
      const entry = await resultEntry(session, 'c-read')
      const message = resultMessage(entry)
      expect(message.content).toEqual(direct.content)
      expect(message.details).toEqual(direct.details)
      expect(message.isError).toBe(false)
      expect(diagnosticsOf(entry)).toEqual([])
      expect(JSON.stringify(message.content)).not.toContain('<harness>')

      expect(await transcript(await session.currentConversation())).toEqual([
        'pi.user:read notes',
        'pi.assistant:[tool:read]',
        `pi.tool-result:${message.content.map((part) => (part.type === 'text' ? part.text : '')).join('')}`,
        'pi.assistant:a1'
      ])
    },
    TIMEOUT
  )

  it(
    'I1-02 an unsafe tool asks; a steer during the ask and a follow-up during the answer land in order',
    async () => {
      const world = await makeWorld()
      const session = await firstSend(world)
      const chatsBefore = world.model.chats.length

      const answer2 = held(answer('a2'))
      world.chat(
        callTool('write', { path: 'out.txt', content: 'X' }, 'c-w'),
        answer2.step,
        answer('a3')
      )
      const saving = session.submitUser('save')
      const request = await nextInput(world, 'c-w')
      expect(request).toMatchObject({ kind: 'ask', toolName: 'write', id: 'c-w' })
      const steered = await session.steer('also Y')
      expect(steered.error).toBeUndefined()
      allow(world, 'c-w')

      await answer2.reached
      const followed = await session.followUp('next')
      expect(followed.error).toBeUndefined()
      expect(
        world
          .recorder()
          .inboxesOf()
          .at(-1)!
          .items.map((item) => item.mode)
      ).toEqual(['followUp'])
      answer2.release()

      expect(await withTimeout(saving, 5000, 'save')).toEqual({})
      const followUp = await session.harness.submission(followed.submissionId!, BG)
      expect(await withTimeout(followUp!.wait(BG), 5000, 'follow-up')).toMatchObject({
        status: 'done'
      })

      expect(world.fs.files.get('/ws/out.txt')).toBe('X')
      expect(world.fs.writesTo('/ws/out.txt')).toBe(1)
      expect(lines(world.model.chats[chatsBefore + 1]!).slice(-2)).toEqual([
        expect.stringMatching(/^toolResult:/),
        'user:also Y'
      ])
      expect(lines(world.model.chats[chatsBefore + 2]!).at(-1)).toBe('user:next')
      const conversation = await session.currentConversation()
      expect((await transcript(conversation)).slice(-7)).toEqual([
        'pi.user:save',
        'pi.assistant:[tool:write]',
        expect.stringMatching(/^pi\.tool-result:/),
        'pi.user:also Y',
        'pi.assistant:a2',
        'pi.user:next',
        'pi.assistant:a3'
      ])
      expect((await session.harness.snapshot(InboxDoc, conversation.id, BG))?.items ?? []).toEqual(
        []
      )
      expect(world.t.configCalls).toHaveLength(1)
      expect(world.toolHost.resolveCalls).toHaveLength(1)
      expect(await toolDeltaCount(conversation, 1)).toBe(0)
    },
    TIMEOUT
  )

  it(
    'I1-03 an MCP tool goes through the real manager: args and the toolCallId reach the server',
    async () => {
      const world = await makeWorld()
      const session = await firstSend(world)
      world.chat(callTool('mcp__docs__lookup', { q: 'z' }, 'c-m'), answer('found'))
      expect(await session.submitUser('look it up')).toEqual({})

      expect(world.mcpLog.callsOf('lookup')).toHaveLength(1)
      const call = world.mcpLog.callsOf('lookup')[0]!
      expect(call.args).toEqual({ q: 'z' })
      expect(call.meta?.['shuvix.dev/toolCallId']).toBe('c-m')
      const message = resultMessage(await resultEntry(session, 'c-m'))
      expect(message.content).toEqual([{ type: 'text', text: 'docs.lookup:z' }])
      expect(message.details).toEqual({ type: 'mcp', server: 'docs', tool: 'lookup' })
      expect(world.mcp.connectsOf('docs')).toBe(1)
    },
    TIMEOUT
  )

  it(
    'I1-04 a thrown tool error (Q12) is the model-visible text itself, with no <harness> block; the run goes on',
    async () => {
      const world = await makeWorld()
      const session = await firstSend(world)
      world.chat(callTool('boom', {}, 'c-b'), answer('recovered'))
      expect(await session.submitUser('explode')).toEqual({})

      const entry = await resultEntry(session, 'c-b')
      const message = resultMessage(entry)
      expect(message.isError).toBe(true)
      expect(message.content).toEqual([{ type: 'text', text: 'boom' }])
      expect(diagnosticsOf(entry)).toEqual([])
      expect((await transcript(await session.currentConversation())).at(-1)).toBe(
        'pi.assistant:recovered'
      )
    },
    TIMEOUT
  )

  it(
    'I1-05 a long output spills when the agent holds read: preview + [info] locator, and read fetches the rest without asking',
    async () => {
      const world = await makeWorld()
      const session = await firstSend(world)
      const path = spillPath('s1', 'c-d')
      world.chat(
        callTool('dump', { lines: 2500 }, 'c-d'),
        callTool('read', { path, offset: 2401, limit: 100 }, 'c-r2'),
        answer('seen')
      )
      expect(await session.submitUser('dump it')).toEqual({})

      const entry = await resultEntry(session, 'c-d')
      const message = resultMessage(entry)
      const [preview, harness, ...rest] = message.content
      expect(rest).toEqual([])
      const previewText = preview?.type === 'text' ? preview.text : ''
      expect(previewText.split('\n').length).toBeLessThanOrEqual(200)
      expect(new TextEncoder().encode(previewText).length).toBeLessThanOrEqual(10 * 1024)
      expect(previewText).toContain('line 1\n')
      expect(previewText).not.toContain(path)
      const info = `Output truncated: 2500 lines / ${formatSize(dumpBytes(2500))}; full output saved to ${path}. Use the read tool (not bash) to view it.`
      expect(harness).toEqual({ type: 'text', text: `<harness>\n[info] ${info}\n</harness>` })
      expect(diagnosticsOf(entry)).toEqual([{ severity: 'info', code: 'spilled', message: info }])
      expect(message.details).toEqual({ type: 'dump', truncated: true, persisted: true })
      expect(world.spill.writes).toEqual([['c-d', dumpText(2500).length]])
      expect(world.fs.files.get(path)).toBe(dumpText(2500))
      expect(JSON.stringify(message.content)).not.toContain('[warn] Output truncated to its')

      const read = resultMessage(await resultEntry(session, 'c-r2'))
      expect(read.isError).toBe(false)
      expect(JSON.stringify(read.content)).toContain('line 2500')
      expect(world.t.broadcastsOf('input_request')).toEqual([])
      expect(world.permissions).toEqual([])
    },
    TIMEOUT
  )

  it(
    'I1-06 without read the same output is only truncated in memory: [info] says nothing was kept, the sink is never called',
    async () => {
      const world = await makeWorld({
        sessions: { s2: { tools: ['write', 'ask', 'dump'], overlay: [] } }
      })
      const session = await world.open('s2')
      world.chat(callTool('dump', { lines: 2500 }, 'c-d'), answer('seen'))
      expect(await session.submitUser('dump it')).toEqual({})
      expect(session.lock!.toolNames).toEqual(['write', 'ask', 'dump'])

      const entry = await resultEntry(session, 'c-d')
      const message = resultMessage(entry)
      const [body, harness, ...rest] = message.content
      expect(rest).toEqual([])
      const bodyText = body?.type === 'text' ? body.text : ''
      expect(bodyText.split('\n').length).toBeLessThanOrEqual(2000)
      expect(bodyText).toContain('line 1\n')
      expect(bodyText).toContain('line 2500')
      const info = `Output truncated: 2500 lines / ${formatSize(dumpBytes(2500))}; showing the beginning and end only. The full output was not kept.`
      expect(harness).toEqual({ type: 'text', text: `<harness>\n[info] ${info}\n</harness>` })
      expect(diagnosticsOf(entry)).toEqual([{ severity: 'info', code: 'truncated', message: info }])
      expect(message.details).toEqual({ type: 'dump', truncated: true, persisted: false })
      expect(world.spill.writes).toEqual([])
      expect([...world.fs.files.keys()].filter((key) => key.startsWith('/tool_results'))).toEqual(
        []
      )
    },
    TIMEOUT
  )

  it(
    'I1-07 end-of-story invariants: usage equals the sum over assistant entries, the live doc is clean, the lock is unchanged, run states pair up',
    async () => {
      const world = await makeWorld()
      const session = await firstSend(world)
      const lock = structuredClone(session.lock)
      world.chat(callTool('mcp__docs__lookup', { q: 'a' }, 'c-m'), answer('m'))
      expect(await session.submitUser('two')).toEqual({})
      world.chat(callTool('boom', {}, 'c-b'), answer('b'))
      expect(await session.submitUser('three')).toEqual({})
      world.chat(callTool('write', { path: 'story.txt', content: 'S' }, 'c-w'), answer('w'))
      const writing = session.submitUser('four')
      await nextInput(world, 'c-w')
      allow(world, 'c-w')
      expect(await writing).toEqual({})

      const conversation = await session.currentConversation()
      const assistants = (await allEntries(conversation)).filter(
        (entry) => entry.kind === 'pi.assistant'
      )
      const sum = assistants.reduce((total, entry) => {
        const message = entry.model?.[0]
        return total + (message?.role === 'assistant' ? message.usage.input : 0)
      }, 0)
      const usage = await session.harness.snapshot(UsageDoc, conversation.id, BG)
      expect(sum).toBeGreaterThan(0)
      expect(usage?.models['faux/faux-1']?.input).toBe(sum)
      expect(Object.keys(usage?.models ?? {})).toEqual(['faux/faux-1'])

      await waitFor(() => session.runState === 'idle', 2000, 'idle')
      const live = (await session.harness.snapshot(LiveDoc, conversation.id, BG)) ?? {}
      expect(live).not.toHaveProperty('run')
      expect(live).not.toHaveProperty('generation')
      expect(live).not.toHaveProperty('tools')
      expect(session.lock).toEqual(lock)

      await waitFor(() => world.t.statesOf('s1').length >= 9, 2000, 'run states')
      expect(world.t.statesOf('s1')).toEqual([
        'idle',
        'busy',
        'idle',
        'busy',
        'idle',
        'busy',
        'idle',
        'busy',
        'idle'
      ])
    },
    TIMEOUT
  )
})

function dumpBytes(count: number): number {
  return new TextEncoder().encode(dumpText(count)).length
}
