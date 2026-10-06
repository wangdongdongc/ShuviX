/**
 * SpawnCoordinator · 提交、等待与结果抽取（P2-03，E 段 28–31）：一条 `agent:<taskId>` 输入；结果从这次
 * 派发的第一条 `pi.user` 起抽（PIN-02：同一消息文本以 '' 拼接、跨消息取最后一条有文本的、注记逐字）；
 * 模型报错 → `error`；软停止保留部分结果、不算失败。
 */
import { fauxText, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai'
import { type AssistantMessage } from '@earendil-works/pi-ai'
import { AssistantEntry, CompactionEntry, type EntryRecord } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { extractSpawnResult } from '../spawn'
import { answer, assistantWith, callTool, modelError } from './support/faux'
import { registerHostCleanup, TEST_SETTINGS_OVERRIDES } from './support/host'
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

// ─── P3-16 裁定：重试收复之后不再带 `error=` 注记（与 J5-02 的压缩收复同一处理） ───

const RETRYABLE = 'overloaded_error: Overloaded'

/** 转写里的一条 assistant 条目（只填抽取会读的字段） */
function assistantEntry(id: number, message: AssistantMessage, byTaskId?: number): EntryRecord {
  return {
    id,
    kind: AssistantEntry.kind,
    model: [message],
    ...(byTaskId === undefined ? {} : { byTaskId })
  } as unknown as EntryRecord
}

function compactionEntry(id: number): EntryRecord {
  return { id, kind: CompactionEntry.kind } as unknown as EntryRecord
}

const failedWith = (text: string, error = RETRYABLE): AssistantMessage =>
  assistantWith(text ? [fauxText(text)] : [], { stopReason: 'error', errorMessage: error })

describe('P3-16 extractSpawnResult · a retry that recovered drops its error note', () => {
  const rows: [string, EntryRecord[], string][] = [
    [
      'a failed attempt, then success in the same task: no note',
      [assistantEntry(1, modelError(RETRYABLE), 7), assistantEntry(2, answer('found'), 7)],
      'found'
    ],
    [
      'two failed attempts with partial text, then success: the partial text never wins, no note',
      [
        assistantEntry(1, failedWith('half'), 7),
        assistantEntry(2, failedWith('half again'), 7),
        assistantEntry(3, answer('found'), 7)
      ],
      'found'
    ],
    [
      'a recovered attempt is not counted and its partial text is not the answer',
      [assistantEntry(1, failedWith('half'), 7), assistantEntry(2, answer(''), 7)],
      'Agent did not produce a final text response (1 assistant message(s), 0 tool call(s)). stopReason=stop.'
    ],
    [
      'the final attempt failed after a retry: the note stays',
      [assistantEntry(1, modelError(RETRYABLE), 7), assistantEntry(2, failedWith('half'), 7)],
      `half\n\n[Note] stopReason=error; error=${RETRYABLE}`
    ],
    [
      'the final attempt failed with no text: the error sentence stays, the retried attempt is not counted',
      [assistantEntry(1, modelError(RETRYABLE), 7), assistantEntry(2, modelError(RETRYABLE), 7)],
      `Agent did not produce a final text response (1 assistant message(s), 0 tool call(s)). stopReason=error. Model errorMessage: ${RETRYABLE}.`
    ],
    [
      'an error in an earlier task is that task’s final attempt: the note stays (only the same task folds)',
      [assistantEntry(1, failedWith('half'), 7), assistantEntry(2, answer('next'), 8)],
      `next\n\n[Note] error=${RETRYABLE}`
    ],
    [
      'entries without byTaskId never fold',
      [assistantEntry(1, failedWith('half')), assistantEntry(2, answer('found'))],
      `found\n\n[Note] error=${RETRYABLE}`
    ],
    [
      'J5-02 unchanged: an error before a compaction entry carries no note',
      [assistantEntry(1, modelError('prompt is too long')), compactionEntry(2), assistantEntry(3, answer('ok'))],
      'ok'
    ]
  ]

  it.each(rows)('P3-16-01 %s', (_row, entries, expected) => {
    expect(extractSpawnResult(entries)).toBe(expected)
  })

  it('P3-16-01 execError is still noted after a recovered retry', () => {
    const entries = [
      assistantEntry(1, modelError(RETRYABLE), 7),
      assistantEntry(2, answer('found'), 7)
    ]
    expect(extractSpawnResult(entries, 'boom')).toBe('found\n\n[Note] execError=boom')
  })
})

describe('P3-16 spawn · a child retry, end to end', () => {
  // 重试退避按 Harness 的 `now` 睡：宿主 D 的定格时钟会让退避永远到不了，这里换成走着的
  const retrying = (maxRetries: number): Parameters<typeof hostD>[0] => ({
    host: {
      now: () => Date.now(),
      settingsOverrides: {
        ...TEST_SETTINGS_OVERRIDES,
        retry: { enabled: true, baseDelayMs: 1, maxRetries }
      }
    }
  })

  it('P3-16-02 the child retries a transient error and recovers: the answer has no note, no error; the failed attempt is in the transcript', async () => {
    const d = await hostD(retrying(3))
    d.t.kit.queue(callAgent('explore', 'find X'), modelError(RETRYABLE), answer('found'), answer('done'))
    expect(await d.session.submitUser('go')).toEqual({})
    const outcome = d.outcomes[0]!
    expect(outcome.result).toBe('found')
    expect('error' in outcome).toBe(false)
    const lines = await transcript((await d.session.harness.conversation(outcome.conversationId!, BG))!)
    expect(lines.filter((line) => line.startsWith('pi.assistant:'))).toHaveLength(2)
  })

  it('P3-16-03 the child’s final attempt fails after retrying: error set, the note stays', async () => {
    const d = await hostD(retrying(1))
    d.t.kit.queue(
      callAgent('explore', 'find X'),
      modelError(RETRYABLE),
      failedWith('half'),
      answer('done')
    )
    expect(await d.session.submitUser('go')).toEqual({})
    const outcome = d.outcomes[0]!
    expect(outcome.error).toBe(RETRYABLE)
    expect(outcome.result).toBe(`half\n\n[Note] stopReason=error; error=${RETRYABLE}`)
  })
})
