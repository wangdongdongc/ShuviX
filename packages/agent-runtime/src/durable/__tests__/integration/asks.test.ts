/**
 * P1-12 · 场景 2：询问 —— 真 write / ask 工具、真安全模块的 PEP、会话的挂起询问表，一路到转写。
 *
 * 允许 / 拒绝 / 卡片挂着时中止（不死锁，PIN-4：断言实现给出的那段确定的文字，并重复几遍证明不赛跑）/
 * 同一轮里两张卡 / 两张卡挂着时崩溃、重开、继续（ask 重问同一个 id，write 记为「中断，可能已部分执行」）/
 * taskId 一路穿到审查接缝（P1-06）/ 没有前端。
 */
import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { LiveDoc, type EntryRecord } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { executeTool, failureText } from '../../../tools/testing/invokeTool'
import { backgroundContext as BG } from '../../context'
import type { DurableSession } from '../../durableSession'
import { answer, callTool } from '../support/faux'
import { registerHostCleanup } from '../support/host'
import { transcript } from '../support/transcript'
import { sleep, waitFor, withTimeout } from '../support/wait'
import {
  diagnosticsOf,
  harnessErrorText,
  resultEntries,
  resultEntry,
  resultMessage,
  resultText
} from './support/entries'
import { memFs } from './support/memFs'
import { fileSuite, securityFor } from './support/realTools'
import { callTools, lastToolResult, lines, when } from './support/scriptedModel'
import {
  allow,
  choose,
  deny,
  makeWorld,
  nextInput,
  NOTES_TXT,
  registerWorldCleanup,
  resolvedCount,
  type World
} from './support/world'

registerHostCleanup()
registerWorldCleanup()

const TIMEOUT = 10000
const RECOVERY_TIMEOUT = 20000

const WRITE_ARGS = { path: 'out.txt', content: 'X' }
const ASK_ARGS = {
  question: 'Q',
  options: [
    { label: 'A', description: 'first' },
    { label: 'B', description: 'second' }
  ]
}

/** 直接调一次真 write（另一块干净的「磁盘」、另一个安全上下文），卡片按给定的应答回 */
function directWrite(
  response: InputResponse,
  args: { path: string; content: string } = WRITE_ARGS
): ReturnType<typeof executeTool> {
  const suite = fileSuite(
    memFs({ '/ws/notes.txt': NOTES_TXT }),
    securityFor('direct', async () => response)
  )
  return executeTool(suite.write, 'c-w', args)
}

function textOfContent(result: Awaited<ReturnType<typeof executeTool>>): string {
  return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
}

async function entryFor(session: DurableSession, callId: string): Promise<EntryRecord> {
  return resultEntry(await session.currentConversation(), callId)
}

/** 先上锁（第一次发送只要一个回答），后面的用例只看询问 */
async function lockedSession(world: World): Promise<DurableSession> {
  const session = await world.open()
  world.chat(answer('ready'))
  expect(await session.submitUser('hello')).toEqual({})
  return session
}

describe('P1-12 · asks', () => {
  it(
    'I2-01 allow: the card is broadcast then resolved, the result is the direct success text, the file is written',
    async () => {
      const world = await makeWorld()
      const session = await lockedSession(world)
      world.chat(callTool('write', WRITE_ARGS, 'c-w'), answer('saved'))
      const saving = session.submitUser('save')
      await nextInput(world, 'c-w')
      expect(session.pendingInputCount).toBe(1)
      expect(resolvedCount(world, 'c-w')).toBe(0)
      allow(world, 'c-w')
      expect(session.pendingInputCount).toBe(0)
      expect(await withTimeout(saving, 5000, 'save')).toEqual({})

      const order = world.t.asks.map((event) => event.type)
      expect(order).toEqual(['input_request', 'input_request_resolved'])
      // 询问不再上前端线路（P3-08）：只经钩子
      expect(
        world.t.broadcasts.filter((event) => (event.type as string).startsWith('input_request'))
      ).toEqual([])
      const direct = await directWrite({ kind: 'ask', allowed: true })
      const entry = await entryFor(session, 'c-w')
      expect(resultMessage(entry).isError).toBe(false)
      expect(resultText(entry)).toBe(textOfContent(direct))
      expect(diagnosticsOf(entry)).toEqual([])
      expect(world.fs.files.get('/ws/out.txt')).toBe('X')
    },
    TIMEOUT
  )

  it(
    'I2-02 deny: the entry is the direct denial text with no diagnostics, nothing is written, the model reads it and answers',
    async () => {
      const world = await makeWorld()
      const session = await lockedSession(world)
      const denied = await failureText(directWrite({ kind: 'ask', allowed: false }))
      expect(denied).toMatch(/^User denied access to /)

      world.chat(callTool('write', WRITE_ARGS, 'c-w'), answer('understood'))
      const saving = session.submitUser('save')
      await nextInput(world, 'c-w')
      deny(world, 'c-w')
      expect(await withTimeout(saving, 5000, 'save')).toEqual({})

      const entry = await entryFor(session, 'c-w')
      expect(resultMessage(entry).isError).toBe(true)
      expect(resultMessage(entry).content).toEqual([{ type: 'text', text: denied }])
      expect(diagnosticsOf(entry)).toEqual([])
      expect(world.fs.files.has('/ws/out.txt')).toBe(false)
      expect(world.fs.writes).toEqual([])
      expect(lines(world.model.chats.at(-1)!).at(-1)).toBe(`toolResult:${denied}`)
      expect((await transcript(await session.currentConversation())).at(-1)).toBe(
        'pi.assistant:understood'
      )

      // 带理由的拒绝：模型读到的就是那句理由
      world.chat(callTool('write', WRITE_ARGS, 'c-w2'), answer('ok'))
      const again = session.submitUser('save again')
      await nextInput(world, 'c-w2')
      deny(world, 'c-w2', 'not now')
      expect(await withTimeout(again, 5000, 'save again')).toEqual({})
      expect(resultMessage(await entryFor(session, 'c-w2')).content).toEqual([
        { type: 'text', text: 'not now' }
      ])
    },
    TIMEOUT
  )

  it(
    'I2-03 abort while the card is pending: no deadlock, a deterministic aborted result (PIN-4, five rounds), and the next send works',
    async () => {
      const world = await makeWorld()
      const session = await lockedSession(world)
      const texts: string[] = []
      for (let round = 1; round <= 5; round++) {
        const id = `c-w${round}`
        world.chat(callTool('write', WRITE_ARGS, id))
        const saving = session.submitUser(`save ${round}`)
        await nextInput(world, id)
        expect(session.pendingInputCount).toBe(1)
        await withTimeout(session.abort(), 2000, `abort ${round}`)
        expect(session.pendingInputCount).toBe(0)
        expect(resolvedCount(world, id)).toBe(1)
        expect(await withTimeout(saving, 2000, `save ${round}`)).toEqual({})
        const entry = await entryFor(session, id)
        expect(resultMessage(entry).isError).toBe(true)
        texts.push(resultText(entry))
      }
      // PIN-4：durable 的 abort 标记先于工具自己的 `Aborted` 结果排上串行线 —— 恒为 harness 的那段
      expect(texts).toEqual(
        Array.from({ length: 5 }, () => harnessErrorText('Tool write was aborted'))
      )
      expect(world.fs.writes).toEqual([])

      world.chat(answer('fresh'))
      expect(await session.submitUser('after the aborts')).toEqual({})
      const last = lines(world.model.chats.at(-1)!)
      expect(last).toContain('assistant:[tool:write]')
      expect(last).toContain(`toolResult:${harnessErrorText('Tool write was aborted')}`)
      expect(last.at(-1)).toBe('user:after the aborts')
    },
    TIMEOUT
  )

  it(
    'I2-04 two cards pending in one parallel round: answered out of order, the results go back in call order',
    async () => {
      const world = await makeWorld()
      const session = await lockedSession(world)
      world.chat(
        callTools(['ask', ASK_ARGS, 'c-a'], ['write', WRITE_ARGS, 'c-w']),
        answer('both done')
      )
      const sending = session.submitUser('ask and save')
      await nextInput(world, 'c-a')
      await nextInput(world, 'c-w')
      expect(session.pendingInputCount).toBe(2)
      allow(world, 'c-w')
      choose(world, 'c-a', ['B'])
      expect(await withTimeout(sending, 5000, 'send')).toEqual({})

      const direct = await directWrite({ kind: 'ask', allowed: true })
      const results = lines(world.model.chats.at(-1)!).filter((line) =>
        line.startsWith('toolResult:')
      )
      expect(results).toEqual([
        'toolResult:User selected: B',
        `toolResult:${textOfContent(direct)}`
      ])
    },
    TIMEOUT
  )

  it(
    'I2-05 a crash with both cards pending: reopen stays put, continue re-asks the same ask id, the write is interrupted and retried once',
    async () => {
      const world = await makeWorld()
      const session = await lockedSession(world)
      world.chat(callTools(['ask', ASK_ARGS, 'c-a'], ['write', WRITE_ARGS, 'c-w']))
      void session.submitUser('ask and save')
      await nextInput(world, 'c-a')
      await nextInput(world, 'c-w')
      expect(session.pendingInputCount).toBe(2)

      const t1 = world.t
      await withTimeout(world.restart(), 10000, 'restart')
      const resolved = t1.asksOf('input_request_resolved')
      expect(resolved.map((event) => event.requestId).sort()).toEqual(['c-a', 'c-w'])
      expect(world.fs.writes).toEqual([])

      const reopened = await world.open()
      expect(reopened.isInterrupted()).toBe(true)
      expect(world.t.statesOf('s1')).toEqual(['interrupted'])
      expect(reopened.pendingInputCount).toBe(0)
      await sleep(150)
      expect(world.t.asksOf('input_request')).toEqual([])
      expect(world.t.kit.callCount).toBe(0)

      world.chat(
        when((messages) =>
          lastToolResult(messages, 'write')?.includes('was interrupted')
            ? callTool('write', WRITE_ARGS, 'c-w2')
            : answer('the write was not interrupted?')
        ),
        answer('all done')
      )
      const continuing = reopened.continue()
      const reasked = await nextInput(world, 'c-a')
      expect(reasked).toMatchObject({ kind: 'choice', question: 'Q', options: ASK_ARGS.options })
      expect(world.t.asksOf('input_request')).toHaveLength(1)
      choose(world, 'c-a', ['A'])
      await nextInput(world, 'c-w2')
      const conversation = await reopened.currentConversation()
      const interrupted = await resultEntry(conversation, 'c-w')
      expect(resultText(interrupted)).toBe(
        harnessErrorText('Tool write was interrupted and may have partially run')
      )
      expect(resultMessage(interrupted).isError).toBe(true)
      const firstRequest = lines(world.model.chats[0]!).filter((line) =>
        line.startsWith('toolResult:')
      )
      expect(firstRequest).toEqual([
        'toolResult:User selected: A',
        `toolResult:${harnessErrorText('Tool write was interrupted and may have partially run')}`
      ])
      allow(world, 'c-w2')
      expect(await withTimeout(continuing, 5000, 'continue')).toEqual({})

      expect(world.fs.writesTo('/ws/out.txt')).toBe(1)
      expect(world.fs.files.get('/ws/out.txt')).toBe('X')
      const writes = (await resultEntries(conversation)).filter(
        (entry) => resultMessage(entry).toolName === 'write'
      )
      expect(writes.map((entry) => resultMessage(entry).isError)).toEqual([true, false])
      expect((await transcript(conversation)).at(-1)).toBe('pi.assistant:all done')
    },
    RECOVERY_TIMEOUT
  )

  it(
    'I2-06 taskId threading (P1-06): the review seam sees the call’s conversation and the live slot’s task id; the card still shows',
    async () => {
      const world = await makeWorld()
      const session = await lockedSession(world)
      world.chat(callTool('write', WRITE_ARGS, 'c-w'), answer('saved'))
      const saving = session.submitUser('save')
      await nextInput(world, 'c-w')
      const conversation = await session.currentConversation()
      const live = await session.harness.snapshot(LiveDoc, conversation.id, BG)
      const slot = live?.tools?.find((candidate) => candidate.callId === 'c-w')
      expect(slot?.taskId).toBeDefined()
      expect(world.permissions).toHaveLength(1)
      expect(world.permissions[0]).toMatchObject({
        toolCallId: 'c-w',
        conversationId: 1,
        taskId: slot!.taskId
      })
      allow(world, 'c-w')
      expect(await withTimeout(saving, 5000, 'save')).toEqual({})
    },
    TIMEOUT
  )

  it(
    'I2-07 no frontend: the write fails fast with the abort text, nothing is broadcast, the run goes on',
    async () => {
      const world = await makeWorld()
      const session = await lockedSession(world)
      world.t.capability = false
      world.chat(callTool('write', WRITE_ARGS, 'c-w'), answer('no card'))
      expect(await withTimeout(session.submitUser('save'), 5000, 'save')).toEqual({})
      const entry = await entryFor(session, 'c-w')
      expect(resultMessage(entry).isError).toBe(true)
      expect(resultMessage(entry).content).toEqual([{ type: 'text', text: 'Aborted' }])
      expect(world.t.asksOf('input_request')).toEqual([])
      expect(world.fs.writes).toEqual([])
      await waitFor(() => session.runState === 'idle', 1000, 'idle')
    },
    TIMEOUT
  )
})
