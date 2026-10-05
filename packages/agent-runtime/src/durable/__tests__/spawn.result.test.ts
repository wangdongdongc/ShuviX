/**
 * SpawnCoordinator · 提交、等待与结果抽取（P2-03，E 段 28–31）：一条 `agent:<taskId>` 输入；结果从这次
 * 派发的第一条 `pi.user` 起抽（PIN-02：同一消息文本以 '' 拼接、跨消息取最后一条有文本的、注记逐字）；
 * 模型报错 → `error`；软停止保留部分结果、不算失败。
 */
import { fauxText, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai'
import { type AssistantMessage } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { answer, assistantWith, callTool, modelError } from './support/faux'
import { registerHostCleanup } from './support/host'
import {
  callAgent,
  dispatchTask,
  firstChild,
  hostD,
  liveTasks,
  submissionByRequest,
  taskRecord,
  tasksOf
} from './support/spawn'
import { holdTool } from './support/tools'
import { requestTexts, transcript } from './support/transcript'
import { deferred, withTimeout } from './support/wait'

registerHostCleanup()

describe('SpawnCoordinator · submit and wait', () => {
  it('P2-03-28 one input under agent:<taskId>, done; the root second request carries the tool result', async () => {
    const d = await hostD()
    d.t.kit.queue(callAgent('explore', 'find X'), answer('found'), answer('done'))
    expect(await d.session.submitUser('go')).toEqual({})
    const C = d.outcomes[0]!.conversationId!
    const task = await dispatchTask(d.session)
    expect(await submissionByRequest(d.session, C, `agent:${task}`)).toMatchObject({
      type: 'input',
      status: 'done'
    })
    const lines = await transcript((await d.session.harness.conversation(C, BG))!)
    expect(lines.filter((line) => line.startsWith('pi.user:'))).toHaveLength(1)
    expect(requestTexts(d.t.kit, 2)).toContain('toolResult:found')
  })

  const rows: [string, AssistantMessage[], string][] = [
    ['a plain answer', [answer('found')], 'found'],
    [
      'stopReason length',
      [assistantWith([fauxText('part')], { stopReason: 'length' })],
      'part\n\n[Note] stopReason=length'
    ],
    [
      'text parts joined with ""',
      [assistantWith([fauxThinking('T'), fauxText('Hel'), fauxText('lo')])],
      'Hello'
    ],
    [
      'the last text wins across messages',
      [
        assistantWith([fauxText('step1'), fauxToolCall('probe', {}, { id: 'p1' })], {
          stopReason: 'toolUse'
        }),
        answer('final')
      ],
      'final'
    ],
    [
      'no final text',
      [callTool('probe'), answer('')],
      'Agent did not produce a final text response (2 assistant message(s), 1 tool call(s)). stopReason=stop.'
    ]
  ]

  it.each(rows)('P2-03-29 extraction: %s', async (_row, child, expected) => {
    const d = await hostD()
    d.t.kit.queue(callAgent('explore', 'find X'), ...child, answer('done'))
    expect(await d.session.submitUser('go')).toEqual({})
    expect(d.outcomes[0]!.result).toBe(expected)
    expect(d.outcomes[0]!.error).toBeUndefined()
  })

  it.each([
    ['boom', 'boom'],
    ['', 'model call failed (stopReason=error)']
  ])(
    'P2-03-30 a model error (%j) → error; the dispatch task completes; root goes on',
    async (message, error) => {
      const d = await hostD()
      d.t.kit.queue(callAgent('explore', 'find X'), modelError(message), answer('done'))
      expect(await d.session.submitUser('go')).toEqual({})
      const outcome = d.outcomes[0]!
      expect(outcome.error).toBe(error)
      expect(outcome.result).toBe(
        `Agent did not produce a final text response (1 assistant message(s), 0 tool call(s)). stopReason=error.${message ? ` Model errorMessage: ${message}.` : ''}`
      )
      const task = await taskRecord(d.session, await dispatchTask(d.session))
      expect(task!.state).toMatchObject({ status: 'terminal', outcome: { status: 'completed' } })
      expect((await transcript(await d.session.currentConversation())).at(-1)).toBe(
        'pi.assistant:done'
      )
      expect(await liveTasks(d.session, outcome.conversationId)).toEqual([])
    }
  )

  it('P2-03-31 a soft interrupt keeps the partial result (no error); the root run goes on', async () => {
    const running = deferred()
    const d = await hostD({
      tools: () => [holdTool('hold', new Promise(() => {}), { onRun: () => running.resolve() })]
    })
    d.t.kit.queue(
      callAgent('explore', 'find X'),
      assistantWith([fauxText('working on it'), fauxToolCall('hold', {}, { id: 'h1' })], {
        stopReason: 'toolUse'
      }),
      answer('done')
    )
    const sent = d.session.submitUser('go')
    await running.promise
    const C = await firstChild(d.session)
    await withTimeout(d.session.agents.interrupt(C), 3000, 'interrupt')
    expect(await withTimeout(sent, 3000, 'root')).toEqual({})
    const outcome = d.outcomes[0]!
    expect(outcome.result).toBe('working on it\n\n[Note] stopReason=toolUse')
    expect('error' in outcome).toBe(false)
    const generations = await tasksOf(d.session, C)
    expect(generations.at(-1)!.state).toMatchObject({ outcome: { status: 'aborted' } })
    const lines = await transcript((await d.session.harness.conversation(C, BG))!)
    expect(lines.at(-1)).toContain('Tool hold was aborted')
    expect(d.t.kit.callCount).toBe(3)
  })
})
