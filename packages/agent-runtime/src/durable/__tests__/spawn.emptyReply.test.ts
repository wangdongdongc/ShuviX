/**
 * 派生 agent 的空回复追问（`emptyReply.ts`）：hook 挂在 `shuvix.builtin` 上，派生 agent 的对话同样选中它，
 * 所以子 agent 工具跑完之后的空回复也被追问一次，追问写在**子对话**里、根对话不受影响。
 *
 *   C1 子 agent：T → E∅ → N → found；派发结果 found；子对话一条 N，根对话没有
 *   C2 子 agent 自我封顶：T → E∅ → N → E∅ → 「没有最终正文」（与 spawn.result 的 P2-03-29 同一行）
 *   C3 子 agent 对任务提示的第一次回复就是空的（没有工具）→ 不追问
 *   C4 带结果契约的子 agent：T → E∅ → N → next；结果被捕获，契约的追问（`agent:<id>:nudge:1`）没发生
 */
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { ConversationId } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { EMPTY_REPLY_NOTICE_TEXT as N } from '../emptyReply'
import type { ResultContract } from '../../subagent/nextTool'
import { answer, assistantWith, callTool } from './support/faux'
import { registerHostCleanup } from './support/host'
import {
  callAgent,
  dispatchTask,
  hostD,
  requestsOf,
  submissionByRequest,
  TITLE_SCHEMA,
  type HostD
} from './support/spawn'
import { requestTexts, transcript } from './support/transcript'

registerHostCleanup()

const E0 = (): AssistantMessage => assistantWith([])

async function linesOf(d: HostD, conversation: ConversationId): Promise<string[]> {
  return transcript((await d.session.harness.conversation(conversation, BG))!)
}

const notices = (lines: readonly string[]): number =>
  lines.filter((line) => line === `pi.user:${N}`).length

/** 子 agent 的请求（人设带 explorer） */
const childRequests = (d: HostD): number => requestsOf(d.t.kit, 'explorer').length

describe('SpawnCoordinator · the empty-reply nudge in a spawned child', () => {
  it('C1 a child’s empty reply after its tool result is nudged in the child conversation; the result is the text after the nudge; the root has no notice', async () => {
    const d = await hostD()
    d.t.kit.queue(
      callAgent('explore', 'find X'),
      callTool('probe'),
      E0(),
      answer('found'),
      answer('done')
    )
    expect(await d.session.submitUser('go')).toEqual({})
    const outcome = d.outcomes[0]!
    expect(outcome.result).toBe('found')
    expect(outcome.error).toBeUndefined()
    expect(childRequests(d)).toBe(3)

    const child = await linesOf(d, outcome.conversationId!)
    expect(child).toEqual([
      'pi.user:find X',
      'pi.assistant:[tool:probe]',
      expect.stringMatching(/^pi\.tool-result:/),
      'pi.assistant:',
      `pi.user:${N}`,
      'pi.assistant:found'
    ])
    const root = await linesOf(d, (await d.session.currentConversation()).id)
    expect(notices(root)).toBe(0)
    expect(root.at(-1)).toBe('pi.assistant:done')
    // 根的第二次请求带的工具结果就是子 agent 追问之后的回答
    expect(requestTexts(d.t.kit, d.t.kit.requests.length - 1)).toContain('toolResult:found')
  })

  it('C2 the child is nudged once: a second empty reply after the nudge ends it with "no final text"', async () => {
    const d = await hostD()
    d.t.kit.queue(callAgent('explore', 'find X'), callTool('probe'), E0(), E0(), answer('done'))
    expect(await d.session.submitUser('go')).toEqual({})
    const outcome = d.outcomes[0]!
    expect(outcome.result).toBe(
      'Agent did not produce a final text response (3 assistant message(s), 1 tool call(s)). stopReason=stop.'
    )
    expect(outcome.error).toBeUndefined()
    expect(childRequests(d)).toBe(3)
    expect(notices(await linesOf(d, outcome.conversationId!))).toBe(1)
  })

  it('C3 a child whose first reply to its task prompt is empty (no tool) is not nudged', async () => {
    const d = await hostD()
    d.t.kit.queue(callAgent('explore', 'find X'), E0(), answer('done'))
    expect(await d.session.submitUser('go')).toEqual({})
    const outcome = d.outcomes[0]!
    expect(outcome.result).toBe(
      'Agent did not produce a final text response (1 assistant message(s), 0 tool call(s)). stopReason=stop.'
    )
    expect(childRequests(d)).toBe(1)
    expect(notices(await linesOf(d, outcome.conversationId!))).toBe(0)
  })

  it('C4 a result-contract child: T → E∅ → N → next captures the result; the contract nudge never fires; exactly one N', async () => {
    const contract: ResultContract = { schema: structuredClone(TITLE_SCHEMA) }
    const d = await hostD({ dispatch: { contract } })
    d.t.kit.queue(
      callAgent('explore', 'p'),
      callTool('probe'),
      E0(),
      callTool('next', { title: 'A' }),
      answer('done')
    )
    expect(await d.session.submitUser('go')).toEqual({})
    const outcome = d.outcomes[0]!
    expect(outcome.structured).toEqual({ title: 'A' })
    expect('error' in outcome).toBe(false)
    expect(childRequests(d)).toBe(3)

    const C = outcome.conversationId!
    expect(notices(await linesOf(d, C))).toBe(1)
    const task = await dispatchTask(d.session)
    expect(await submissionByRequest(d.session, C, `agent:${task}`)).toMatchObject({
      status: 'done'
    })
    expect(await submissionByRequest(d.session, C, `agent:${task}:nudge:1`)).toBeUndefined()
  })
})
