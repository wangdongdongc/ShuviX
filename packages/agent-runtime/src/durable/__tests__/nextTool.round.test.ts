/**
 * `next` 在真 durable 轮次里（P2-02，D 段 21–25）：结果作 `details: {result}` 记进 `pi.tool-result`
 * 条目、`nextResultOf` 读回；只调了 next 的那一批靠 terminate 一次请求收尾，混批照常续跑但捕获
 * 照样持久；durable 先按 schema 校验（`invalid_arguments`，PIN-06）；同轮两次 next 只认第一次
 * （顺序只在 sequential 下断言，PIN-13）；崩溃后的 next 不重跑、结算成中断，读不出结果。
 *
 * 这里的 next 是 root 锁上的一件宿主工具（`agentTools`）—— 走的是同一条 durable 工具路径，派生 agent
 * 的接线归 P2-03。
 */
import type { EntryRecord, ToolRegistration } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { NextTool, nextResultOf } from '../../subagent/nextTool'
import type { ToolResult } from '../../tools/toolResult'
import { scenarioToolHost } from './support/agentConfig'
import { answer, callTool, callTools } from './support/faux'
import { makeHost, registerHostCleanup, TEST_SETTINGS_OVERRIDES } from './support/host'
import { scenarioW } from './support/scenario'
import { holdTool } from './support/tools'
import { allEntries, requestTexts, transcript } from './support/transcript'
import { aborted, deferred, withTimeout } from './support/wait'

registerHostCleanup()

const RESTART_TIMEOUT = 15000

const S = { type: 'object', required: ['title'], properties: { title: { type: 'string' } } }
const RECORDED = 'Result recorded — the task is complete. Do not call any more tools.'
const ALREADY_RECORDED =
  'Result already recorded — the task is complete. Do not call any more tools.'

const nextOf = (): NextTool => new NextTool(S)
const probe = holdTool('probe', Promise.resolve())

type ToolResultMessage = {
  role: 'toolResult'
  toolCallId: string
  toolName: string
  content: { type: string; text?: string }[]
  details?: unknown
  isError: boolean
}

function toolResultOf(entry: EntryRecord): ToolResultMessage {
  return entry.model![0] as unknown as ToolResultMessage
}

function textOf(entry: EntryRecord): string {
  return toolResultOf(entry)
    .content.map((part) => part.text ?? '')
    .join('')
}

async function toolResults(
  session: Awaited<ReturnType<Awaited<ReturnType<typeof makeHost>>['open']>>
): Promise<EntryRecord[]> {
  return (await allEntries(await session.currentConversation())).filter(
    (entry) => entry.kind === 'pi.tool-result'
  )
}

function captures(entries: readonly EntryRecord[]): Record<string, unknown>[] {
  return entries
    .map((entry) => nextResultOf(entry))
    .filter((value): value is Record<string, unknown> => value !== undefined)
}

async function lockedHost(
  tools: ToolRegistration[],
  sequential = false
): Promise<Awaited<ReturnType<typeof makeHost>>> {
  return makeHost({
    tools,
    ...(sequential
      ? { settingsOverrides: { ...TEST_SETTINGS_OVERRIDES, toolExecution: 'sequential' } }
      : {})
  })
}

describe('next · durable rounds', () => {
  it('P2-02-21 next alone: one request; the result entry carries details.result; nextResultOf reads it back', async () => {
    const t = await lockedHost([nextOf()])
    const session = await t.open()
    await session.createAgent()
    expect(session.lock!.toolNames).toContain('next')
    t.kit.queue(callTool('next', { title: 'Fix login bug' }))
    expect(await session.submitUser('go')).toEqual({})
    expect(t.kit.callCount).toBe(1)
    expect(await transcript(await session.currentConversation())).toEqual([
      'pi.user:go',
      'pi.assistant:[tool:next]',
      `pi.tool-result:${RECORDED}`
    ])
    const [entry] = await toolResults(session)
    expect(toolResultOf(entry!)).toMatchObject({
      toolName: 'next',
      isError: false,
      details: { result: { title: 'Fix login bug' } }
    })
    expect(nextResultOf(entry!)).toEqual({ title: 'Fix login bug' })
  })

  it('P2-02-22 a mixed batch (next + probe) runs on, but the capture is durable', async () => {
    const t = await lockedHost([nextOf(), probe])
    const session = await t.open()
    t.kit.queue(
      callTools([
        ['next', { title: 'A' }, 'c1'],
        ['probe', {}, 'c2']
      ]),
      answer('after')
    )
    expect(await session.submitUser('go')).toEqual({})
    expect(t.kit.callCount).toBe(2)
    const second = requestTexts(t.kit, 1)
    expect(second).toContain(`toolResult:${RECORDED}`)
    expect(second).toContain('toolResult:probe done')
    const lines = await transcript(await session.currentConversation())
    expect(lines).toContain('pi.assistant:[tool:next][tool:probe]')
    expect(lines).toContain(`pi.tool-result:${RECORDED}`)
    expect(lines).toContain('pi.tool-result:probe done')
    expect(lines.at(-1)).toBe('pi.assistant:after')
    expect(captures(await toolResults(session))).toEqual([{ title: 'A' }])
  })

  it('P2-02-23 a valid and an invalid next in one round: durable rejects the invalid one before execute (PIN-06)', async () => {
    const t = await lockedHost([nextOf()])
    const session = await t.open()
    t.kit.queue(
      callTools([
        ['next', { title: 'A' }, 'c1'],
        ['next', {}, 'c2']
      ]),
      answer('after')
    )
    expect(await session.submitUser('go')).toEqual({})
    expect(t.kit.callCount).toBe(2)
    const entries = await toolResults(session)
    const c2 = entries.find((entry) => toolResultOf(entry).toolCallId === 'c2')!
    expect(toolResultOf(c2).isError).toBe(true)
    expect(textOf(c2)).toContain('Validation failed for tool "next"')
    expect(textOf(c2)).toContain('title')
    expect((c2.data as { diagnostics: { code: string }[] }).diagnostics[0]!.code).toBe(
      'invalid_arguments'
    )
    expect('details' in toolResultOf(c2)).toBe(false)
    expect(captures(entries)).toEqual([{ title: 'A' }])
  })

  it('P2-02-24 two valid next calls in one round (sequential): one request; only the first carries the result', async () => {
    const t = await lockedHost([nextOf()], true)
    const session = await t.open()
    t.kit.queue(
      callTools([
        ['next', { title: 'A' }, 'c1'],
        ['next', { title: 'B' }, 'c2']
      ])
    )
    expect(await session.submitUser('go')).toEqual({})
    expect(t.kit.callCount).toBe(1)
    const entries = await toolResults(session)
    const c1 = entries.find((entry) => toolResultOf(entry).toolCallId === 'c1')!
    const c2 = entries.find((entry) => toolResultOf(entry).toolCallId === 'c2')!
    expect(toolResultOf(c1).details).toEqual({ result: { title: 'A' } })
    expect(textOf(c2)).toBe(ALREADY_RECORDED)
    expect('details' in toolResultOf(c2)).toBe(false)
    expect(captures(entries)[0]).toEqual({ title: 'A' })
  })

  it('P2-02-24 two valid next calls in one round (parallel): one request; exactly one capture (PIN-13)', async () => {
    const t = await lockedHost([nextOf()])
    const session = await t.open()
    t.kit.queue(
      callTools([
        ['next', { title: 'A' }, 'c1'],
        ['next', { title: 'B' }, 'c2']
      ])
    )
    expect(await session.submitUser('go')).toEqual({})
    expect(t.kit.callCount).toBe(1)
    expect(captures(await toolResults(session))).toHaveLength(1)
  })

  it(
    'P2-02-25 a next interrupted by a crash is not rerun; it settles interrupted and reads as no result',
    async () => {
      const running = deferred()
      const gated: ToolRegistration = {
        ...nextOf(),
        execute: async (_args, _api, context) => {
          running.resolve()
          return aborted(context.abortSignal!)
        }
      }
      const first = await scenarioW({ toolHost: scenarioToolHost({ agentTools: [gated] }) })
      const session = await first.t.open()
      first.t.kit.queue(callTool('next', { title: 'x' }))
      void session.submitUser('go')
      await running.promise

      let runs = 0
      class Counting extends NextTool {
        protected override async executeInternal(
          toolCallId: string,
          params: Record<string, unknown>
        ): Promise<ToolResult> {
          runs++
          return super.executeInternal(toolCallId, params)
        }
      }
      const t2 = await first.t.restart({
        toolHost: scenarioToolHost({ agentTools: [new Counting(S)] })
      })
      const reopened = await t2.open()
      t2.kit.queue(answer('after'))
      expect(await withTimeout(reopened.continue(), 5000, 'continue')).toEqual({})
      expect(runs).toBe(0)
      const entry = (await toolResults(reopened)).find(
        (candidate) => toolResultOf(candidate).toolName === 'next'
      )!
      expect(toolResultOf(entry).isError).toBe(true)
      expect(textOf(entry)).toContain('was interrupted and may have partially run')
      expect('details' in toolResultOf(entry)).toBe(false)
      expect(nextResultOf(entry)).toBeUndefined()
      expect(t2.kit.requests).toHaveLength(1)
      expect((await transcript(await reopened.currentConversation())).at(-1)).toBe(
        'pi.assistant:after'
      )
    },
    RESTART_TIMEOUT
  )
})
